/**
 * 緊急事件狀態的**唯一持有者**——一個 Durable Object 實例（`idFromName('v1')`）裝全部 7 台伺服器。
 *
 * 為什麼不分片：量體是「每台伺服器每小時最多幾筆」，單實例的序列化完全吃得下；
 * 而 fan-out 必須跨伺服器讀訂閱表，分片只會把簡單的事變複雜。
 *
 * 所有判斷都在 `logic.js`（純函式、node 可測），這裡只負責 SQLite 與對外發請求。
 */

import { DurableObject } from 'cloudflare:workers';
import * as L from './logic.js';

/** Discord 一次最多同時打幾條 webhook。小數字即可——訂閱者數量本來就不大。 */
const FANOUT_CONCURRENCY = 5;

/** 單條 webhook 的逾時。Discord 正常 < 300ms；卡住的那條不該拖住其他人。 */
const WEBHOOK_TIMEOUT_MS = 4000;

export class CosmicEventsDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY,
      world      TEXT NOT NULL,
      source     TEXT NOT NULL,
      startAt    INTEGER NOT NULL,
      endAt      INTEGER NOT NULL,
      startExact INTEGER NOT NULL DEFAULT 0,
      createdAt  INTEGER NOT NULL,
      reporter   TEXT NOT NULL DEFAULT '',
      confirms   TEXT NOT NULL DEFAULT '[]',
      disputes   TEXT NOT NULL DEFAULT '[]',
      status     TEXT NOT NULL DEFAULT 'active'
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subs (
      uuid       TEXT PRIMARY KEY,
      worlds     TEXT NOT NULL DEFAULT '[]',
      webhookUrl TEXT NOT NULL DEFAULT '',
      failCount  INTEGER NOT NULL DEFAULT 0,
      broken     INTEGER NOT NULL DEFAULT 0,
      updatedAt  INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS blocked (
      uuid TEXT PRIMARY KEY, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT ''
    )`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');

    // 票數獨立成欄：去識別（7 天後清掉 UUID 陣列）之後，歷史仍要看得出有幾個人證實。
    // `CREATE TABLE IF NOT EXISTS` 不會補欄位到既有表，所以用 ALTER；已經有了就會丟錯，吞掉即可
    // （父層鐵則例外 a：窄的、預期內的 schema 既存檢查）。
    // `notifyAt`：待推播的時間戳；0 ＝ 沒有待推播的東西（已送出或不需延遲）。
    // **一個 ALTER 一個 try**。兩句共用一個 try 會出事：先加的那欄已經存在時第一句就丟例外，
    // 於是後面的欄位**永遠不會被建立**，而 catch 把它吞得無聲無息——症狀是部署後
    // 「table events has no column named X」的 500，本機全新 DB 反而測不出來
    // （2026-08-03 實測：variant 已存在的 DO 上，weather 就是這樣沒建起來）。
    const columns = [
      // 事件變體（storm-a／meteor-b…）。插件比對 client 的開始通告得來；
      // 沒偵測到就維持 NULL——空字串會讓「沒偵測到」與「偵測到但空」分不開（鐵則 §2）。
      ['variant', 'TEXT'],
      // 天氣種類（storm／meteor／spore）。插件由 variant 前綴推導，手動通報由使用者選（選填）。
      ['weather', 'TEXT'],
      ['nConfirm', 'INTEGER NOT NULL DEFAULT 0'],
      ['nDispute', 'INTEGER NOT NULL DEFAULT 0'],
      ['warnedAt', 'INTEGER NOT NULL DEFAULT 0'],
      ['notifyAt', 'INTEGER NOT NULL DEFAULT 0'],
      // 插件在任務板上看到的任務 id（JSON 陣列）。與 `variant` **同時**存在的那一筆
      // 就是「哪則通告對應哪一組任務」的證據（B-023）；原本只驗不存＝每次事件都把答案丟掉。
      ['missionIds', 'TEXT'],
      // 這次事件實際是哪一組（`storm-α`…），由 `missionIds` 判出來。**這才是地圖該用的欄位**
      // ——原本繞道「開始通告 → 變體 → 推定組別」，而 2026-08-03 利維坦實測發現聊天欄
      // 根本沒有那六句（只有一句「發生了緊急情況。」）⇒ 那條路是死的。任務板直接就是答案。
      ['groupKey', 'TEXT'],
    ];
    for (const [col, type] of columns) {
      try {
        this.sql.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
      } catch {
        // 欄位已存在（父層鐵則例外 a：窄的、預期內的 schema 既存檢查）
      }
    }

    // 訂閱者的 @ 對象（B-062）。同樣**一個 ALTER 一個 try**，理由見上方那段。
    // 存的是**正規化後**的 {type,id}：訂閱裡沒有 userId，「mentionType 空但有 userId」
    // 那條舊值相容在瀏覽器端（discordMentionTarget）就解完了。
    // 既有訂閱升級後兩欄為預設值 ⇒ 語意是「不提及」，與升級前的行為一致（本工具從來沒有 @ 過）。
    const subColumns = [
      ['mentionType', "TEXT NOT NULL DEFAULT 'none'"],
      ['mentionTargetId', "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [col, type] of subColumns) {
      try {
        this.sql.exec(`ALTER TABLE subs ADD COLUMN ${col} ${type}`);
      } catch {
        // 欄位已存在（同上）
      }
    }

    // 「開始通告 ↔ 任務組」的定案表。**一個變體只寫一次**——第一次拿到證據就定下來，
    // 之後的事件不再改寫（改寫代表兩次證據互相矛盾，那要人去看，不該自動選一個）。
    this.sql.exec(`CREATE TABLE IF NOT EXISTS variant_map (
      variant   TEXT PRIMARY KEY,
      groupKey  TEXT NOT NULL,
      source    TEXT NOT NULL,
      eventId   INTEGER,
      decidedAt INTEGER NOT NULL
    )`);
  }

  /**
   * 用任務板看到的任務 id 補上這筆事件的組別（與 `missionIds` 本身）。
   *
   * **只補空欄**：先到的值贏，後來的不改寫。判不出組（`resolveGroup` 回 null）就只補
   * `missionIds`，組別留空——寧可留白也不寫一個「比較像」的答案。
   */
  _fillFromBoard(eventId, input, now) {
    // 變體已經有定案的對應 ⇒ **光靠通告就判得出組**，不必等任務板。
    // 這是 B-023 解出來之後才可能的路：2026-08-05 伊弗利特磁暴同時拿到
    // `storm-b` 與任務板的 α 組 ⇒ 對應定案 ⇒ 之後同天氣的事件只要抓到通告就夠了。
    if (input.variant) {
      const known = this.sql
        .exec('SELECT groupKey FROM variant_map WHERE variant = ?', input.variant).toArray();
      if (known.length) {
        this.sql.exec(
          'UPDATE events SET groupKey = COALESCE(groupKey, ?) WHERE id = ?',
          known[0].groupKey, eventId,
        );
      }
    }

    const ids = input.missionIds;
    if (!Array.isArray(ids) || ids.length === 0) return;
    const rows = this.sql
      .exec('SELECT missionIds, groupKey, weather FROM events WHERE id = ?', eventId).toArray();
    if (!rows.length) return;
    const cur = rows[0];
    const group = cur.groupKey
      ?? L.resolveGroup(ids, cur.weather ?? L.weatherKindOf(input.variant) ?? undefined);
    this.sql.exec(
      'UPDATE events SET missionIds = COALESCE(missionIds, ?), groupKey = COALESCE(groupKey, ?) WHERE id = ?',
      JSON.stringify(ids), group ?? null, eventId,
    );
    if (!cur.groupKey && group) this._bump('group_resolved');
  }

  /**
   * 天氣與變體不同種 ⇒ **把變體與已定的組別一起清掉**。
   *
   * 這兩欄的可信度不對等：`weather` 來自遊戲的 ActiveWeather（直接觀測），
   * `variant` 來自畫面通告文字比對（會殘留上一場的值）。不同種時只有一個可能對，
   * 而留著錯的變體代價最大——它會經由 `variant_map` 讓地圖指向**另外半張圖**。
   *
   * **清空而不是改成推導值**：我們知道「這個變體是錯的」，不知道「正確的是哪一個」。
   * 留白＝「還不知道是哪一組」，那是本站處理得了的狀態（鐵則 §2）。
   * 之後任何一筆帶對變體的回報會把它補回來。
   */
  _dropConflictingVariant(eventId) {
    const rows = this.sql
      .exec('SELECT variant, weather, groupKey FROM events WHERE id = ?', eventId).toArray();
    if (!rows.length) return;
    const { variant, weather } = rows[0];
    if (!variant || !weather) return;
    if (L.weatherKindOf(variant) === weather) return;
    this.sql.exec('UPDATE events SET variant = NULL, groupKey = NULL WHERE id = ?', eventId);
    this._bump('variant_weather_conflict');
  }

  /**
   * 拿「通告變體 ＋ 任務板上的任務 id」定案一次對應。
   *
   * **只在兩者都有、而且判得出組時才寫**（`resolveGroup` 判不出來會回 null，不回「比較像」的）；
   * **已經定過的不改寫**——同一個變體出現兩種答案代表資料互相矛盾，那要人去看。
   */
  _learnVariantMap(variant, missionIds, eventId, now) {
    if (!variant || !Array.isArray(missionIds) || missionIds.length === 0) return;
    const exists = this.sql
      .exec('SELECT variant FROM variant_map WHERE variant = ?', variant).toArray();
    if (exists.length) return;
    const group = L.resolveGroup(missionIds, L.weatherKindOf(variant));
    if (!group) return;
    this.sql.exec(
      'INSERT INTO variant_map (variant, groupKey, source, eventId, decidedAt) VALUES (?, ?, ?, ?, ?)',
      variant, group, 'plugin', eventId, now,
    );
    this._bump('variant_map_learned');
  }

  /** 已定案的對應（`{'storm-a': 'storm-β'}`）。沒定案的變體不出現在裡面。 */
  _variantMap() {
    const out = {};
    for (const r of this.sql.exec('SELECT variant, groupKey FROM variant_map').toArray()) {
      out[r.variant] = r.groupKey;
    }
    return out;
  }

  /** 管理端人工定案（Owner 在遊戲裡看到就能直接寫，不必等插件剛好覆蓋到那一台）。 */
  setVariantMap(variant, group, now) {
    if (!L.VARIANTS.includes(variant)) return { ok: false, reason: 'bad_variant' };
    if (!L.VARIANT_MISSIONS[group]) return { ok: false, reason: 'bad_group' };
    if (L.kindOfGroup(group) !== L.weatherKindOf(variant)) return { ok: false, reason: 'kind_mismatch' };
    this.sql.exec(
      `INSERT INTO variant_map (variant, groupKey, source, eventId, decidedAt) VALUES (?, ?, 'manual', NULL, ?)
       ON CONFLICT(variant) DO UPDATE SET groupKey = excluded.groupKey, source = 'manual', decidedAt = excluded.decidedAt`,
      variant, group, now,
    );
    return { ok: true, variant, group };
  }

  // ── 小工具 ──

  _bump(key, by = 1) {
    this.sql.exec(
      'INSERT INTO stats (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + ?',
      key, by, by,
    );
  }

  /**
   * 保留期清理。掛在每次寫入路徑上——不值得為它排一支 cron。
   *
   * 兩段：**7 天後去識別**（清掉 UUID，只留 `nConfirm`／`nDispute` 計數）、**90 天後刪列**。
   * 歷史要的是「什麼時候、哪一台、幾個人證實」，不需要知道是誰。
   */
  _sweep(now) {
    this.sql.exec(
      `UPDATE events SET reporter = '', confirms = '[]', disputes = '[]'
       WHERE endAt < ? AND (reporter != '' OR confirms != '[]' OR disputes != '[]')`,
      now - L.DEIDENTIFY_AFTER,
    );
    this.sql.exec('DELETE FROM events WHERE endAt < ?', now - L.RETENTION);
  }

  /**
   * 把 alarm 排到「最早那一筆待推播」的時間。
   *
   * 單一 DO 只有一個 alarm 槽 ⇒ 不能一筆一個，必須取最小值；`alarm()` 送完後會再排一次，
   * 剩下的自然接上。沒有待推播就不排（也不清既有的——`alarm()` 空跑一次無害，
   * 而清掉它需要知道沒有別人在等，多一個會錯的條件）。
   */
  async _scheduleNotify() {
    const rows = this.sql
      .exec("SELECT MIN(notifyAt) AS t FROM events WHERE notifyAt > 0 AND status = 'active'")
      .toArray();
    const t = rows.length ? rows[0].t : null;
    if (t) await this.ctx.storage.setAlarm(t * 1000);
  }

  /**
   * 靜置期滿 → 推播。
   *
   * **這裡是整個延遲機制唯一有價值的一行**：送之前重讀狀態，已撤回／已撤銷的就跳過。
   * 誤按的通報在這一刻被攔下來，訂閱者從頭到尾不會知道有這回事。
   *
   * 用 DO alarm 而不是在 `waitUntil` 裡睡 30 秒：DO 隨時可能被回收，睡到一半通知就消失，
   * **而且沒有任何訊號**——沒有錯誤、沒有警告，只是通知沒來。alarm 由平台保證會被叫到。
   */
  async alarm() {
    const now = Math.floor(Date.now() / 1000);
    const due = this.sql
      .exec('SELECT * FROM events WHERE notifyAt > 0 AND notifyAt <= ?', now)
      .toArray();
    for (const r of due) {
      // 先清 notifyAt：無論送不送得出去都只嘗試一次，避免 alarm 重試變成重複推播
      this.sql.exec('UPDATE events SET notifyAt = 0 WHERE id = ?', r.id);
      const ev = this._rowToEvent(r);
      if (ev.status !== 'active' || ev.endAt <= now) {
        this._bump('notify_skipped');   // 靜置期內被撤回／撤銷，這正是延遲的目的
        continue;
      }
      this._bump('notify_delayed_sent');
      await this._fanout({ ...ev, notifyAt: 0 }, now);
    }
    await this._scheduleNotify();
  }

  /** 待推播的那一筆現在就送（插件回報把它證實了 ⇒ 不必再等）。 */
  _notifyNow(id, now) {
    const rows = this.sql.exec('SELECT * FROM events WHERE id = ? AND notifyAt > 0', id).toArray();
    if (!rows.length) return;
    this.sql.exec('UPDATE events SET notifyAt = 0 WHERE id = ?', id);
    this._bump('notify_promoted');
    this.ctx.waitUntil(this._fanout(this._rowToEvent(rows[0]), now));
  }

  _rowToEvent(r) {
    return {
      id: r.id,
      world: r.world,
      source: r.source,
      startAt: r.startAt,
      endAt: r.endAt,
      startExact: r.startExact === 1,
      warnedAt: r.warnedAt ?? 0,
      createdAt: r.createdAt,
      confirms: JSON.parse(r.confirms),
      disputes: JSON.parse(r.disputes),
      status: r.status,
      variant: r.variant ?? null,
      weather: r.weather ?? null,
    };
  }

  _activeEvent(world, now) {
    const rows = this.sql
      .exec(
        "SELECT * FROM events WHERE world = ? AND status = 'active' AND endAt > ? ORDER BY id DESC LIMIT 1",
        world, now,
      )
      .toArray();
    return rows.length ? this._rowToEvent(rows[0]) : null;
  }

  isBlocked(uuid) {
    return this.sql.exec('SELECT 1 FROM blocked WHERE uuid = ?', uuid).toArray().length > 0;
  }

  // ── 通報 ──

  /**
   * @param input {{source:'plugin'|'manual', world:string, startAt:number, phase?:string, reporter?:string}}
   * @returns {{ok:true, eventId:number, duplicate:boolean}|{ok:false, reason:string}}
   */
  async report(input, now) {
    this._sweep(now);
    const { source, world, reporter = '' } = input;
    const existing = this._activeEvent(world, now);

    // ── 預告（聊天欄的預兆通告）──
    // 這一刻天氣還沒翻轉，**不知道確切何時開始**。所以 startAt 留 0（＝未知），
    // endAt 先給一個寬鬆的兜底期限，等真的開始再改寫成精確值。
    // 刻意不猜倒數：只有一個提前量樣本，寫個看起來精確的數字只會在下次不準時失去信任。
    if (input.phase === 'warn') {
      if (existing) {
        // 預告階段也可能帶著任務板內容進來（插件在那 5 分鐘內讀到的）⇒ 一樣補空欄
        this._fillFromBoard(existing.id, input, now);
        return { ok: true, eventId: existing.id, duplicate: true };
      }
      this.sql.exec(
        `INSERT INTO events (world, source, startAt, endAt, startExact, createdAt, reporter, warnedAt, variant, weather)
         VALUES (?, ?, 0, ?, 0, ?, '', ?, ?, ?)`,
        world, source, now + L.WARN_TTL, now, now, input.variant ?? null,
        // ⚠️ **預告階段不由 variant 推天氣**（2026-08-08）。`validatePluginReport` 刻意把
        // warn 的 weather 設成 null，理由是那一刻 `weatherId` 還是上一場的殘留值——
        // 但 `variant` 是**同一個殘留問題**（來自畫面通告比對），從它推導等於把剛擋掉的
        // 錯值從後門放進來。實證：2026-08-06 15:09 的預告帶著上一場的 `spore-`，
        // 20 分鐘後那場其實是磁暴，而站上 id=94 就這樣被記成孢子霧。
        input.weather ?? null,
      );
      const wid = this.sql.exec('SELECT last_insert_rowid() AS id').toArray()[0].id;
      this._bump('warn_ok');
      // 預告就帶著任務板內容的話，事件還沒開始就知道是哪一組
      this._fillFromBoard(wid, input, now);
      // ⚠️ **預告一律不推播**（Owner 2026-08-03：「預告也不要先通知，大約 1~3 分鐘內確定了才通知」）。
      //
      // 由來：2026-08-03 一晚出現三筆假預告，全部**立刻**推播給訂閱者，而通知送出去就收不回來
      // （撤銷只影響網站顯示）。預告是所有訊號裡**最不可靠**的一種——它來自畫面上的通告文字比對，
      // 而那個彈窗同時放著分頁標籤（`EMERGENCY`）、倒數與三種不同事件的文案，誤判成本卻是
      // 「已經吵到所有人」。
      //
      // 事件本身**立刻**就在網站上看得到，延後的只有推播。真正該觸發通知的是**確定發生**：
      // 天氣真的翻轉（`start`）或有第二個人附議 —— 那兩條路徑各自會送。
      return { ok: true, eventId: wid, duplicate: false };
    }

    // 插件回報「事件結束」：把 endAt 收到現在。這是本站唯一能拿到**實際時長**的管道
    // （Owner 2026-08-02：插件的功用是累積數據量），所以即使 UI 用不到也要收。
    if (input.phase === 'end') {
      if (!existing) return { ok: false, reason: 'no_active_event' };
      this.sql.exec('UPDATE events SET endAt = ? WHERE id = ?', now, existing.id);
      this._bump('event_end_plugin');
      return { ok: true, eventId: existing.id, duplicate: false };
    }

    // 先前只收到預告、現在天氣真的翻轉了 ⇒ **就地把同一筆升級成「進行中」**，
    // 不開新事件（開新的會讓同一起事件在歷史裡變成兩筆，提前量就算不出來了）。
    // 這是唯一會對同一筆事件推播第二次的情況，而且是刻意的：預告與開始是兩則不同的資訊。
    if (existing && source === 'plugin' && input.phase === 'start' && !existing.startAt) {
      this.sql.exec(
        // 變體只有**開始通告**帶得出來（預告階段兩個變體共用同一句），所以是在升級這一刻
        // 才寫得進去。`COALESCE` ＝插件沒偵測到就保持原值，不要用 null 蓋掉已知的。
        //
        // ⚠️ **`weather` 一定要在這裡寫**（2026-08-08 補）。這一段原本完全沒碰它，於是
        // 預告那一刻寫進去的天氣（那時只可能是推導或殘留的）**永遠沒有被改正的機會**——
        // 天氣真的翻轉、插件讀到了 ActiveWeather，卻沒有任何一條路把它寫回去。
        // 這正是 id=94 被記成孢子霧的原因：20 分鐘內三筆回報都帶著正確的 196（磁暴），
        // 一次都沒寫進去。這一筆是插件的 start ⇒ 天氣是觀測值，直接覆寫。
        `UPDATE events SET startAt = ?, endAt = ?, startExact = 1, weather = COALESCE(?, weather),
           variant = COALESCE(?, variant), missionIds = COALESCE(?, missionIds) WHERE id = ?`,
        now, now + L.EVENT_DURATION, input.weather ?? null, input.variant ?? null,
        input.missionIds?.length ? JSON.stringify(input.missionIds) : null, existing.id,
      );
      // 升級後才判衝突：這時 weather 是觀測值、variant 可能還是預告階段殘留的那個
      this._dropConflictingVariant(existing.id);
      this._bump('warn_to_start');
      this.ctx.waitUntil(this._fanout(this._activeEvent(world, now), now));
      return { ok: true, eventId: existing.id, duplicate: false };
    }

    // 已經有進行中的事件 ⇒ 這一筆是附議，不是新事件。**不再推播一次**。
    if (existing) {
      if (reporter) {
        const v = L.applyVote(existing, reporter, 'confirm');
        this.sql.exec(
          'UPDATE events SET confirms = ?, disputes = ?, status = ?, nConfirm = ?, nDispute = ? WHERE id = ?',
          JSON.stringify(v.confirms), JSON.stringify(v.disputes), v.status,
          v.confirms.length, v.disputes.length, existing.id,
        );
      }
      // 附議者可能比第一個人知道得多：只看到預告的人選不出 α／β，事件開始後才進來的人選得出。
      // **只補空欄**（`COALESCE(舊, 新)` — 舊值非空就贏），後到的人不能改寫已經定下來的變體。
      //
      // ⚠️ **天氣是例外：直接觀測到的值會覆寫**（2026-08-08）。COALESCE 的語意是「先到的贏」，
      // 而事件的第一筆常常是預告——那時天氣還沒翻轉、值是推導或殘留的。等真正的 `start`
      // 帶著讀自 ActiveWeather 的天氣進來時，先到的錯值反而把它擋掉了。
      // 實證＝id=94：預告記成孢子霧，20 分鐘裡三筆 start/end 都送 `weatherId=196`（磁暴），
      // 一次都沒有機會改正。**觀測 > 推導**，不管誰先到。
      if (input.variant || input.weather) {
        this.sql.exec(
          'UPDATE events SET variant = COALESCE(variant, ?) WHERE id = ?',
          input.variant ?? null, existing.id,
        );
        // ⚠️ **覆寫權只給「觀測到的」天氣**（插件 start/end 讀 ActiveWeather）。
        // 手動通報的天氣是使用者自己選的，跟先到的值同一個等級 ⇒ 照舊 COALESCE，
        // 否則「第三個人選錯」會蓋掉前面兩個人的正確值（既有測試正是守這件事）。
        if (input.weatherObserved && input.weather) {
          this.sql.exec('UPDATE events SET weather = ? WHERE id = ?', input.weather, existing.id);
          this._dropConflictingVariant(existing.id);
        } else {
          this.sql.exec(
            'UPDATE events SET weather = COALESCE(weather, ?) WHERE id = ?',
            input.weather ?? L.weatherKindOf(input.variant) ?? null, existing.id,
          );
        }
      }
      // **補送路徑**：事件開始那一秒任務板多半沒開，插件讀不到 `missionIds`。
      // 玩家之後打開任務板時插件會再送一次，這裡把當時空著的欄位補起來
      // （Owner 2026-08-03：「不可能一直開任務板」——把偵測綁在翻轉那一秒本來就會漏）。
      this._fillFromBoard(existing.id, input, now);
      // 兩個欄位齊了就定案一次「通告↔任務組」（同一個變體只會學一次）
      this._learnVariantMap(input.variant, input.missionIds, existing.id, now);
      // 插件回報既有事件時，把來源升級成 plugin（可信度較高的那個要贏）
      if (source === 'plugin' && existing.source !== 'plugin') {
        this.sql.exec("UPDATE events SET source = 'plugin' WHERE id = ?", existing.id);
        // 遊戲天氣證實了這筆手動通報 ⇒ 沒有再靜置的理由，立刻送
        this._notifyNow(existing.id, now);
      }
      this._bump('report_dup');
      return { ok: true, eventId: existing.id, duplicate: true };
    }

    // per-UUID 冷卻：只擋「開新事件」，附議不受限（上面那段已經先回了）
    if (reporter) {
      const last = this.sql
        .exec(
          'SELECT createdAt FROM events WHERE world = ? AND reporter = ? ORDER BY id DESC LIMIT 1',
          world, reporter,
        )
        .toArray();
      if (last.length && L.inCooldown(last[0].createdAt, now)) {
        return { ok: false, reason: 'cooldown' };
      }
    }

    const startAt = input.startAt;
    const delay = L.notifyDelayFor(source);
    this.sql.exec(
      `INSERT INTO events (world, source, startAt, endAt, startExact, createdAt, reporter, notifyAt, variant, weather, missionIds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      world, source, startAt, startAt + L.EVENT_DURATION,
      source === 'plugin' ? 1 : 0, now, reporter, delay ? now + delay : 0,
      input.variant ?? null,
      // 手動＝使用者選的（選填）；插件＝由變體前綴推導，不必兩邊都送
      input.weather ?? L.weatherKindOf(input.variant) ?? null,
      input.missionIds?.length ? JSON.stringify(input.missionIds) : null,
    );
    const id = this.sql.exec('SELECT last_insert_rowid() AS id').toArray()[0].id;
    this._fillFromBoard(id, input, now);
    this._learnVariantMap(input.variant, input.missionIds, id, now);
    this._bump(source === 'plugin' ? 'report_ok_plugin' : 'report_ok_manual');

    if (delay) {
      // 手動通報靜置 30 秒再推播，讓誤按的人來得及撤回（見 logic.MANUAL_NOTIFY_DELAY）。
      // 事件本身**立刻**就在網站上看得到——延遲的只有推播，不是狀態。
      this.ctx.waitUntil(this._scheduleNotify());
    } else {
      // fan-out 不擋回應：通報者按下去就該立刻得到結果，Discord 送得如何是我們的事。
      this.ctx.waitUntil(this._fanout(this._activeEvent(world, now), now));
    }
    return { ok: true, eventId: id, duplicate: false };
  }

  // ── 投票 ──

  vote({ uuid, eventId, kind }, now) {
    this._sweep(now);
    const rows = this.sql.exec('SELECT * FROM events WHERE id = ?', eventId).toArray();
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const ev = this._rowToEvent(rows[0]);
    if (ev.status === 'revoked') return { ok: false, reason: 'revoked' };

    const v = L.applyVote(ev, uuid, kind);
    this.sql.exec(
      'UPDATE events SET confirms = ?, disputes = ?, status = ?, nConfirm = ?, nDispute = ? WHERE id = ?',
      JSON.stringify(v.confirms), JSON.stringify(v.disputes), v.status,
      v.confirms.length, v.disputes.length, eventId,
    );
    this._bump(kind === 'confirm' ? 'vote_confirm' : 'vote_dispute');
    if (v.changed) this._bump('event_disputed');
    // 有別人證實了 ⇒ 靜置期沒有意義了，立刻送。
    // 靜置期擋的是「沒人確認的孤例」，不是「已經有第二個人看到的事件」。
    if (kind === 'confirm' && v.status === 'active') this._notifyNow(eventId, now);
    return { ok: true, status: v.status, confirms: v.confirms.length, disputes: v.disputes.length };
  }

  /**
   * 通報者放棄靜置期、要求立刻推播（「我確定，馬上通知」）。
   *
   * <b>只有通報者本人、只在靜置期內有效</b>。這不會削弱靜置期的保護：誤按的人不會來按這顆，
   * 而有惡意的人本來就等得起 30 秒。它換到的是「確定的人不必為了不確定的人等」。
   *
   * 送出即不可逆——`canWithdraw` 之外再加這一條：通知已經在別人手機上了。
   */
  notifyNow({ uuid, eventId }, now) {
    const rows = this.sql.exec('SELECT * FROM events WHERE id = ?', eventId).toArray();
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const ev = this._rowToEvent(rows[0]);
    if (rows[0].reporter !== uuid) return { ok: false, reason: 'not_reporter' };
    if (ev.status !== 'active' || ev.endAt <= now) return { ok: false, reason: 'not_active' };
    if (!rows[0].notifyAt) return { ok: false, reason: 'already_sent' };
    this._notifyNow(eventId, now);
    return { ok: true, note: '已送出通知 — 從現在起無法撤回' };
  }

  /**
   * 通報者撤回自己那一筆（誤按用）。判斷全在 `logic.canWithdraw`。
   *
   * 狀態刻意用 `withdrawn` 而不是沿用管理端的 `revoked`——歷史表要分得出
   * 「本人自己收回」與「管理端下架」，那是兩件性質完全不同的事。
   */
  withdraw({ uuid, eventId }, now) {
    this._sweep(now);
    const rows = this.sql.exec('SELECT * FROM events WHERE id = ?', eventId).toArray();
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const ev = { ...this._rowToEvent(rows[0]), reporter: rows[0].reporter };

    const verdict = L.canWithdraw(ev, uuid, now);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    // 還在靜置期內＝推播根本還沒送出去，這是延遲機制存在的理由，要如實告訴撤回的人
    const stillPending = rows[0].notifyAt > 0;
    this.sql.exec("UPDATE events SET status = 'withdrawn', notifyAt = 0 WHERE id = ?", eventId);
    this._bump(stillPending ? 'event_withdrawn_before_notify' : 'event_withdrawn');
    return {
      ok: true,
      note: stillPending
        ? '已取消，通知還沒送出去 — 沒有人會收到'
        : '已從網站下架；先前送出的通知無法收回',
    };
  }

  // ── 訂閱 ──

  putSub({ uuid, worlds, webhookUrl, mentionType = 'none', mentionTargetId = '' }, now) {
    // 退訂＝實體刪列，不是留一列空的（保留期鐵則：不留不需要的識別資料）
    if (worlds.length === 0) {
      this.sql.exec('DELETE FROM subs WHERE uuid = ?', uuid);
      return { ok: true, worlds: [], webhookUrl: '' };
    }
    this.sql.exec(
      `INSERT INTO subs (uuid, worlds, webhookUrl, failCount, broken, updatedAt, mentionType, mentionTargetId)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET worlds = ?, webhookUrl = ?, failCount = 0, broken = 0, updatedAt = ?,
         mentionType = ?, mentionTargetId = ?`,
      uuid, JSON.stringify(worlds), webhookUrl, now, mentionType, mentionTargetId,
      JSON.stringify(worlds), webhookUrl, now, mentionType, mentionTargetId,
    );
    // 重存即解除熔斷：使用者換了 webhook 或確認過設定，本來就該重新開始算
    return { ok: true, worlds, webhookUrl: L.maskWebhook(webhookUrl), mentionType, mentionTargetId };
  }

  getSub(uuid) {
    const rows = this.sql.exec('SELECT * FROM subs WHERE uuid = ?', uuid).toArray();
    if (!rows.length) return { worlds: [], webhookUrl: '', broken: false, mentionType: 'none', mentionTargetId: '' };
    const r = rows[0];
    // **只回遮罩值**：webhook 是能直接對外發訊息的憑證，讀路徑不該把它交出去
    return {
      worlds: JSON.parse(r.worlds),
      webhookUrl: L.maskWebhook(r.webhookUrl),
      broken: r.broken === 1,
      // 舊列（ALTER 前寫入的）在 SQLite 補上的是 DEFAULT 值，但仍以 ?? 兜底：
      // 這條讀路徑會餵回前端畫面，undefined 會讓「不提及」顯示成空白而不是選項
      mentionType: r.mentionType ?? 'none',
      mentionTargetId: r.mentionTargetId ?? '',
    };
  }

  // ── 讀取 ──

  state(now) {
    this._sweep(now);
    const rows = this.sql
      .exec("SELECT * FROM events WHERE status = 'active' AND endAt > ? ORDER BY id DESC", now)
      .toArray();
    const byWorld = {};
    for (const r of rows) {
      const ev = this._rowToEvent(r);
      if (byWorld[ev.world]) continue;   // 每台只回最新的那一個
      byWorld[ev.world] = {
        id: ev.id,
        world: ev.world,
        source: ev.source,
        startAt: ev.startAt,
        endAt: ev.endAt,
        startExact: ev.startExact,
        warnedAt: ev.warnedAt,
        confirms: ev.confirms.length,
        disputes: ev.disputes.length,
        // 還在靜置期＝通知尚未送出。前端靠它決定要不要給「我確定，馬上通知」，
        // 以及撤回時該說「沒有人會收到」還是「無法收回」。不回這欄前端只能猜。
        pendingNotify: (r.notifyAt ?? 0) > 0,
        variant: r.variant ?? null,
        weather: r.weather ?? null,
        // 這次實際是哪一組（任務板判出來的）。有值＝地圖可以直接開那一組，不必猜。
        group: r.groupKey ?? null,
      };
    }
    // 前端要在事件列上顯示「否認 2／3 就下架」。門檻是後端的判斷依據，
    // 前端自己寫一份 3 就是兩份真相——哪天改門檻，畫面會安靜地說錯話。
    return {
      now,
      events: byWorld,
      disputeThreshold: L.DISPUTE_THRESHOLD,
      lastEnded: this._lastEnded(now),
      // 已定案的「通告↔任務組」。**沒定案的變體不會出現在這裡**——回一個空物件與回一個猜的值，
      // 差別就是使用者知不知道。2026-08-06 起六個變體全部定案，因此這一欄目前恆滿。
      // ⚠️ 前端目前**不消費這一欄**（事件的組別走 `events[].group`，後端已填好）。
      // 保留它是給管理端與除錯用；要在畫面上標「※ 待實測確認」的話才會用到。
      variantMap: this._variantMap(),
    };
  }

  /**
   * 每台伺服器**上一次事件結束的時間**（Owner 2026-08-03：想看間隔，實測約 4 小時以上）。
   *
   * <b>只算真的發生過的</b>：`status='active'` 且已經過了 `endAt`。撤回／撤銷／被否認的
   * 不是事件，拿它們當「上次」會讓間隔看起來比實際短——而這一欄的用途正是估間隔。
   * （過期不會改 status，是 lazy 判定，所以真實跑完的事件狀態仍是 active。）
   *
   * <b>不放進 `/history` 讓前端自己算</b>：那支預設只回 50 筆，久沒事件的伺服器會直接落到
   * 範圍外，前端算出來的「上次」會是**靜默的錯**（看起來有值、其實漏掉更早的那筆）。
   */
  _lastEnded(now) {
    const rows = this.sql
      .exec(
        "SELECT world, MAX(endAt) AS t FROM events WHERE status = 'active' AND endAt <= ? GROUP BY world",
        now,
      )
      .toArray();
    const out = {};
    for (const r of rows) out[r.world] = r.t;
    return out;
  }

  /**
   * 歷史紀錄：已經結束（或被撤銷）的事件，新→舊。
   *
   * **撤銷的也列出來並標明**——把它們藏起來，歷史就會變成一份「看起來很乾淨但被修過」的表；
   * 誰在什麼時候撤掉了什麼，本來就是這份資料的一部分。
   *
   * 回的是**計數**不是 UUID 陣列：7 天後 UUID 會被清掉，計數則靠 `nConfirm`／`nDispute` 兩欄留著。
   */
  history(now, { world = '', limit = 50 } = {}) {
    this._sweep(now);
    const n = Math.max(1, Math.min(L.HISTORY_LIMIT, limit | 0));
    const rows = world
      ? this.sql.exec(
        'SELECT * FROM events WHERE world = ? AND (endAt <= ? OR status != ?) ORDER BY startAt DESC LIMIT ?',
        world, now, 'active', n,
      ).toArray()
      : this.sql.exec(
        'SELECT * FROM events WHERE endAt <= ? OR status != ? ORDER BY startAt DESC LIMIT ?',
        now, 'active', n,
      ).toArray();

    return {
      now,
      retentionDays: Math.round(L.RETENTION / 86400),
      rows: rows.map((r) => ({
        id: r.id,
        world: r.world,
        startAt: r.startAt,
        endAt: r.endAt,
        status: r.status,
        // 舊列的 UUID 已被清空，所以一律以計數欄為準（新列在投票當下就同步維護）
        warnedAt: r.warnedAt ?? 0,
        // 提前量＝預告到實際開始的秒數。累積幾筆之後這才是有依據的數字，
        // 而不是拿單一觀察去猜（本 repo 已為此吃過一次虧）。
        leadSeconds: (r.warnedAt && r.startAt) ? r.startAt - r.warnedAt : null,
        variant: r.variant ?? null,
        weather: r.weather ?? null,
        confirms: r.nConfirm ?? 0,
        disputes: r.nDispute ?? 0,
      })),
    };
  }

  // ── 管理 ──

  revoke(eventId, now) {
    const rows = this.sql.exec('SELECT id FROM events WHERE id = ?', eventId).toArray();
    if (!rows.length) return { ok: false, reason: 'not_found' };
    this.sql.exec("UPDATE events SET status = 'revoked', notifyAt = 0 WHERE id = ?", eventId);
    this._bump('event_revoked');
    return { ok: true, note: '已推播的 Discord 訊息無法收回，撤銷只影響網站顯示與後續推播', now };
  }

  /**
   * 校正事件的開始時間（管理端）。
   *
   * **為什麼需要**：通報時間只可能是「送出的那一刻」，發現得晚就整段偏。插件在事件進行到
   * 一半才啟用時也一樣（它只知道自己何時第一次看到，不知道實際何時開始）。
   * 2026-08-02 實測：真實 17:52 開始、18:02 才被回報，倒數整整偏 10 分鐘且當下無法修正。
   *
   * `endAt` 一律跟著重算成 `startAt + 20 分鐘`——事件長度是 client 寫死的常數，不是可調的東西。
   * `startExact` 改為 0：這是人工校正的估計值，不該冒充精確。
   */
  adjustStart(eventId, startAt, now) {
    const rows = this.sql.exec('SELECT id FROM events WHERE id = ?', eventId).toArray();
    if (!rows.length) return { ok: false, reason: 'not_found' };
    this.sql.exec(
      'UPDATE events SET startAt = ?, endAt = ?, startExact = 0 WHERE id = ?',
      startAt, startAt + L.EVENT_DURATION, eventId,
    );
    this._bump('event_adjusted');
    return { ok: true, startAt, endAt: startAt + L.EVENT_DURATION, now };
  }

  /**
   * 清掉已撤銷／已撤回的事件（管理端）。
   *
   * **為什麼可以刪**：歷史表刻意保留「被撤銷的也列出來」，那條原則是為了**不隱藏真實事件**——
   * 誰在什麼時候撤掉了什麼，本來就是資料的一部分。但測試資料與誤按不是真實事件，
   * 留著只會讓「緊急事件實際何時發生」這份唯一能累積的資料被雜訊稀釋。
   *
   * **判準用狀態、不用時間或 id 範圍**：真實事件跑完之後狀態仍是 `active`（過期是用 `endAt`
   * lazy 判定的，不會改狀態），所以只有被人明確撤銷／撤回的才會被刪到。
   */
  purgeRevoked(now) {
    const rows = this.sql
      .exec("SELECT id, world, startAt, status FROM events WHERE status IN ('revoked','withdrawn')")
      .toArray();
    this.sql.exec("DELETE FROM events WHERE status IN ('revoked','withdrawn')");
    this._bump('event_purged', rows.length);
    return { ok: true, deleted: rows.length, rows, now };
  }

  block(uuid, note, now) {
    this.sql.exec(
      'INSERT INTO blocked (uuid, at, note) VALUES (?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET at = ?, note = ?',
      uuid, now, note, now, note,
    );
    this.sql.exec('DELETE FROM subs WHERE uuid = ?', uuid);
    this._bump('uuid_blocked');
    return { ok: true };
  }

  stats() {
    const out = {};
    for (const r of this.sql.exec('SELECT k, v FROM stats').toArray()) out[r.k] = r.v;
    out.subs = this.sql.exec('SELECT COUNT(*) AS n FROM subs').toArray()[0].n;
    out.blocked = this.sql.exec('SELECT COUNT(*) AS n FROM blocked').toArray()[0].n;
    out.events = this.sql.exec('SELECT COUNT(*) AS n FROM events').toArray()[0].n;
    return out;
  }

  // ── Discord fan-out ──
  //
  // 下面兩支是模組級 helper（見檔尾），刻意不掛在 class 上：它們不碰任何狀態。

  /**
   * **不重試、不做 outbox**。事件只有 20 分鐘，一則遲到的通知比沒有更糟
   * （sub-timer 之所以需要重試，是因為它送的是排程提醒，遲到仍有價值——形態不同，不要照抄）。
   * 失敗只累計 `failCount`；連續 4 次標 `broken` 停送，防 runaway 燒額度。
   */
  async _fanout(ev, now) {
    if (!ev) return;
    const subs = this.sql
      .exec('SELECT uuid, worlds, webhookUrl, failCount, broken, mentionType, mentionTargetId FROM subs')
      .toArray()
      .map((r) => ({ ...r, worlds: JSON.parse(r.worlds) }));
    const targets = L.fanoutTargets(subs, ev.world);
    if (targets.length === 0) return;

    // ⚠️ **payload 改成 per-target 組**（B-062）：@ 對象是每個訂閱者自己的設定，
    // 沿用舊的「組一份大家共用」等於所有人都吃到某一個人的 @ 設定。
    // 代價只是 N 次字串組裝——fan-out 的成本本來就在那 N 次 HTTP 上。
    for (let i = 0; i < targets.length; i += FANOUT_CONCURRENCY) {
      const batch = targets.slice(i, i + FANOUT_CONCURRENCY);
      await Promise.all(batch.map((t) => this._send(
        t,
        JSON.stringify(L.discordPayload(ev, now, t)),
        // 退回用的純 embed 版本（Discord 若拒收 Components V2 才會用到，見 _send）
        JSON.stringify(L.legacyEmbedPayload(ev, now, t)),
      )));
    }
  }

  async _send(target, payload, legacy) {
    // 白名單在寫入時已驗過一次，這裡再驗一次：DB 若被別的路徑寫髒，這是最後一道 SSRF 防線
    if (!L.isAllowedWebhook(target.webhookUrl)) {
      this.sql.exec("UPDATE subs SET broken = 1 WHERE uuid = ?", target.uuid);
      return;
    }
    try {
      const res = await postWebhook(withComponents(target.webhookUrl), payload);
      if (res.ok) {
        this.sql.exec('UPDATE subs SET failCount = 0 WHERE uuid = ?', target.uuid);
        return;
      }
      // Components V2 對 non-application-owned webhook **沒有官方明文保證**（我們是靠
      // 2026-08-05 實測知道它可行的）。哪天 Discord 收緊，這裡會連續 400 → 熔斷 →
      // 使用者被告知「你的 webhook 已被暫停」，**而它根本沒壞**，症狀完全指向錯的方向。
      // 退回純 embed：**版面退化，通知不中斷**。
      // 只退一次、不做指數重試——400 是確定性拒絕，重送同一份 payload 沒有意義。
      if (res.status === 400 && legacy) {
        this._bump('fanout_v2_reject');
        // ⚠️ **自己的 timer**，不能沿用第一發的（外審 2026-08-05 抓到）：
        // 共用的話，第一發拖到 3.9 秒才回 400 時，退回這一發只剩 0.1 秒就被 abort
        // ——正好在最需要它的時候失效，而且症狀是「退回也失敗」，看不出是逾時被砍。
        const res2 = await postWebhook(target.webhookUrl, legacy);
        if (res2.ok) {
          this.sql.exec('UPDATE subs SET failCount = 0 WHERE uuid = ?', target.uuid);
          return;
        }
      }
      this._fail(target);
    } catch (err) {
      // 網路錯誤／逾時。不能靜默（父層鐵則），但也不能讓它影響通報者的回應
      console.warn('[fanout] webhook 送出失敗:', (err && err.name) || 'error');
      this._fail(target);
    }
  }

  _fail(target) {
    const n = (target.failCount || 0) + 1;
    this.sql.exec(
      'UPDATE subs SET failCount = ?, broken = ? WHERE uuid = ?',
      n, n >= L.BROKEN_AFTER ? 1 : 0, target.uuid,
    );
    this._bump('fanout_fail');
    if (n >= L.BROKEN_AFTER) this._bump('sub_broken');
  }
}

/**
 * 把 `?with_components=true` 掛上去。**用 URL 物件不用字串相接**（外審 2026-08-05）：
 * 相接的寫法假設 webhook URL 永遠沒有 query／fragment，而那個不變量我們並沒有強制
 * （`isAllowedWebhook` 只驗 scheme／hostname／長度）。使用者貼進來的網址若帶了 `?`，
 * 第二個 `?` 會讓參數解析不出來 ⇒ 退回「204 但按鈕全部消失」的靜默失敗。
 */
function withComponents(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('with_components', 'true');
    return u.toString();
  } catch {
    // 走不到（白名單已驗過是合法 URL），但這裡不能 throw：fan-out 失敗要走既有計數路徑
    return url;
  }
}

/**
 * 送一發 webhook，**每次呼叫自己一組 controller/timer**。
 * 共用 timer 會讓退回那一發繼承第一發已經燒掉的時間（見 `_send` 內註解）。
 */
async function postWebhook(url, body) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }
}
