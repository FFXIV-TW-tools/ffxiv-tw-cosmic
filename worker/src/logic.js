/**
 * 緊急事件通報的**純決策層**——沒有 I/O、沒有 Cloudflare API、沒有時鐘讀取，
 * 所有跟「現在幾點」有關的東西都由呼叫端傳 `now` 進來。因此 node 可以直接測，
 * 而測試不必依賴牆鐘（外審前閘 finding 6）。
 *
 * ⚠️ **這裡沒有天氣閘，而且不能有**。原設計要用「通報當下是不是靈風／月塵」當反惡意閘，
 * 依據是 Owner 2026-07-31 的遊戲內觀察。2026-08-02 拿 ICE `board-log.jsonl` 驗證後**證偽**：
 * 該檔唯一一次緊急事件（`weather=196`，15 筆）發生時，底層演算法天氣 **15/15 都是晴朗**；
 * 同一份記錄裡非緊急的 171 筆演算法與實測 171/171 吻合 ⇒ 不是演算法或記錄的問題。
 * 一筆陽性觀察就足以否證（板上真的跳出緊急天氣＋5 個 critical 任務），
 * 判讀不對稱見 `tools/compare-board-log.mjs` 開頭。**不要再把天氣閘加回來。**
 */

/** 事件時長（秒）。依據＝`missions.json` 裡 33 個 `critical` 任務的 `timeLimit` 全部是 1200。 */
export const EVENT_DURATION = 1200;

/**
 * 緊急事件的天氣 id。這四個**不在 client 全部 172 張 `WeatherRate` 的任何一列**
 * ⇒ 時間演算法永遠擲不出來 ⇒ 出現即代表伺服器推了事件（2026-07-31 spec 已證）。
 */
export const EMERGENCY_WEATHER = [194, 195, 196, 197];

/** critical（緊急）任務的 id 區間——插件回報的證據自洽檢查用。 */
export const CRITICAL_MISSION_MIN = 512;
export const CRITICAL_MISSION_MAX = 544;

/** 手動通報允許的「還有幾分鐘開始」上限。超過這個數字的預告，人也記不準。 */
export const MAX_LEAD_MINUTES = 15;

/** 同一 UUID 對同一伺服器兩次「開新事件」之間的最小間隔（秒）＝事件時長再多 5 分鐘。 */
export const REPORT_COOLDOWN = EVENT_DURATION + 300;

/**
 * 事件列的保留期（秒）。**90 天**——「緊急事件實際何時發生」是這個功能唯一能累積的資料
 * （Owner 2026-08-02：插件的用途就是累積數據量），7 天等於什麼都留不下來。
 * 列本身很小，90 天的量級是幾百列。
 */
export const RETENTION = 90 * 24 * 3600;

/**
 * 去識別期（秒）。事件結束 7 天後把 `reporter`／`confirms`／`disputes` 裡的 UUID 清掉，
 * **只留下計數**（`nConfirm`／`nDispute` 兩欄在投票當下就同步維護，所以清掉陣列不會失去資訊）。
 * 歷史需要的是「什麼時候、哪一台、幾個人證實」，不需要知道是誰。
 */
export const DEIDENTIFY_AFTER = 7 * 24 * 3600;

/**
 * 只收到「預告」還沒看到天氣翻轉時，這筆事件多久後自動失效（秒）。
 *
 * 2026-08-02 實測一筆：預告 17:23:00 → 實際開始 17:28:40，提前量 **5 分 40 秒**。
 * **一個樣本不足以當定律**（這輪已經被同型錯誤咬過一次：天氣閘），所以這裡取一個寬鬆的
 * 上界純粹當「沒等到開始就清掉」的兜底，**不拿它當倒數顯示**。
 */
export const WARN_TTL = 15 * 60;

/** `/history` 一次最多回幾筆。 */
export const HISTORY_LIMIT = 100;

/** 否認達此數且完全沒有人附議 → 標 `disputed`。 */
export const DISPUTE_THRESHOLD = 3;

/** Discord webhook 連續失敗幾次就熔斷。 */
export const BROKEN_AFTER = 4;

/**
 * 繁中服 7 台伺服器。**唯一來源是 `data/dev-stages.json` 的 `worlds`**（台服 client 產生）。
 * 這裡不寫死，由 worker 進入點 import 進來後呼叫 `setWorlds()`——寫死等於多一份會漂移的複本。
 */
let WORLDS = [];

export function setWorlds(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('worlds 不可為空');
  WORLDS = list.slice();
}

export function getWorlds() {
  return WORLDS.slice();
}

export function isKnownWorld(world) {
  return typeof world === 'string' && WORLDS.includes(world);
}

/** UUID v4 字面格式。不是驗身份，只是擋掉明顯的垃圾鍵（DO 的 key 空間要乾淨）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Discord webhook 白名單（防 SSRF）。**只放行 discord 官方兩個網域的 https**——
 * 這個函式是唯一能讓 worker 對外發請求的地方，任何放寬都等於開一個代發請求的洞。
 * 語意照抄 sub-timer worker（`worker/src/shared.ts`）。
 */
export function isAllowedWebhook(url) {
  if (typeof url !== 'string' || url.length > 300) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // hostname 必須**完全等於**這兩個之一：`discord.com.evil.tld` 與 `evildiscord.com` 都要退
  return u.hostname === 'discord.com' || u.hostname === 'discordapp.com';
}

/** 遮罩 webhook：只留尾巴 4 碼。任何回應與紀錄都只能出現遮罩後的值。 */
export function maskWebhook(url) {
  if (typeof url !== 'string' || url === '') return '';
  return `https://discord.com/api/webhooks/…${url.slice(-4)}`;
}

/**
 * 手動通報的欄位檢查。
 * @returns {{ok:true, world:string, startAt:number}|{ok:false, reason:string}}
 */
export function validateManualReport(body, now) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'bad_body' };
  if (!isUuid(body.uuid)) return { ok: false, reason: 'bad_uuid' };
  if (!isKnownWorld(body.world)) return { ok: false, reason: 'bad_world' };
  const lead = body.startsInMinutes;
  if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_MINUTES) {
    return { ok: false, reason: 'bad_lead' };
  }
  return { ok: true, world: body.world, startAt: now + lead * 60 };
}

/**
 * 插件通報的欄位檢查。
 *
 * **真正的門是 `PLUGIN_TOKEN`**，不是這裡。`weatherId` 必須是緊急天氣——那是插件宣稱的事情
 * 本身，自相矛盾的 payload 沒有理由收。
 *
 * `missionIds` 則是**選填**：任務板沒開著的時候插件根本讀不到它，而緊急事件不會等人開任務板。
 * 原設計把它列為必要證據，那會讓「真的偵測到卻報不上去」——用一個擋不住有 token 的偽造者
 * 的檢查，換掉真實訊號，不划算。有給就檢查自洽（至少一個 critical id），純粹用來抓接線寫錯。
 */
export function validatePluginReport(body, now) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'bad_body' };
  if (!isKnownWorld(body.world)) return { ok: false, reason: 'bad_world' };
  const phase = ['end', 'warn'].includes(body.phase) ? body.phase : 'start';
  // `warn` 來自**聊天欄的預告訊息**，那一刻天氣還沒翻轉 ⇒ 不可能有緊急天氣 id，
  // 硬要求它就等於永遠收不到預告。start/end 仍然要求，因為那兩個確實是看著天氣送的。
  if (phase !== 'warn' && !EMERGENCY_WEATHER.includes(body.weatherId)) {
    return { ok: false, reason: 'bad_weather' };
  }
  const ids = Array.isArray(body.missionIds) ? body.missionIds : [];
  if (ids.length > 0) {
    const hasCritical = ids.some(
      (i) => Number.isInteger(i) && i >= CRITICAL_MISSION_MIN && i <= CRITICAL_MISSION_MAX,
    );
    if (!hasCritical) return { ok: false, reason: 'no_critical_evidence' };
  }
  return { ok: true, world: body.world, phase, startAt: now };
}

/**
 * 通報者能不能撤回自己那一筆。
 *
 * 三個條件缺一不可：
 * ① **是本人**（`reporter` 相符）——這是「取消我按錯的那一筆」，不是替別人做決定。
 * ② **還在進行中**——已經結束的事件撤回沒有意義，而且它已經是歷史的一部分。
 * ③ **還沒有人附議**——有人附議代表別人也看到了，那就不是誤按。
 *    這一條同時擋掉「先亂報、再撤掉」的反覆騷擾循環：附議一出現，撤回權就消失，
 *    只能走否認流程（那會留下痕跡）。
 *
 * ⚠️ 撤回**不會收回已經送出去的 Discord／網頁通知**——那些是即時推播，發出去就追不回來。
 * UI 必須講明白，不能讓人以為按了取消就當作沒發生過。
 */
export function canWithdraw(ev, uuid, now) {
  if (!ev || ev.status !== 'active') return { ok: false, reason: 'not_active' };
  if (now >= ev.endAt) return { ok: false, reason: 'not_active' };
  if (!ev.reporter || ev.reporter !== uuid) return { ok: false, reason: 'not_reporter' };
  if ((ev.confirms ?? []).length > 0) return { ok: false, reason: 'has_confirms' };
  return { ok: true };
}

export function validateWithdraw(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'bad_body' };
  if (!isUuid(body.uuid)) return { ok: false, reason: 'bad_uuid' };
  if (!Number.isInteger(body.eventId) || body.eventId <= 0) return { ok: false, reason: 'bad_event' };
  return { ok: true, uuid: body.uuid, eventId: body.eventId };
}

export function validateVote(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'bad_body' };
  if (!isUuid(body.uuid)) return { ok: false, reason: 'bad_uuid' };
  if (!Number.isInteger(body.eventId) || body.eventId <= 0) return { ok: false, reason: 'bad_event' };
  if (body.kind !== 'confirm' && body.kind !== 'dispute') return { ok: false, reason: 'bad_kind' };
  return { ok: true, uuid: body.uuid, eventId: body.eventId, kind: body.kind };
}

export function validateSub(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'bad_body' };
  if (!isUuid(body.uuid)) return { ok: false, reason: 'bad_uuid' };
  if (!Array.isArray(body.worlds) || body.worlds.length > WORLDS.length) {
    return { ok: false, reason: 'bad_worlds' };
  }
  const worlds = [...new Set(body.worlds)];
  if (!worlds.every(isKnownWorld)) return { ok: false, reason: 'bad_worlds' };
  const url = body.webhookUrl ?? '';
  if (url !== '' && !isAllowedWebhook(url)) return { ok: false, reason: 'bad_webhook' };
  return { ok: true, uuid: body.uuid, worlds, webhookUrl: url };
}

/** 事件此刻是否算「進行中」。過期用 lazy 判定，不排 alarm。 */
export function isActive(ev, now) {
  return !!ev && ev.status === 'active' && now < ev.endAt;
}

/**
 * 投票後的新狀態。**單向**：一旦標成 `disputed` 就不因為後來的附議回頭——
 * 一個已經被三個人否認的通報，事後再多一票也不該重新推播（推播早就送出去了）。
 * @returns {{confirms:string[], disputes:string[], status:string, changed:boolean}}
 */
export function applyVote(ev, uuid, kind) {
  const confirms = new Set(ev.confirms ?? []);
  const disputes = new Set(ev.disputes ?? []);
  // 同一人改投＝換邊，不是兩票
  if (kind === 'confirm') {
    disputes.delete(uuid);
    confirms.add(uuid);
  } else {
    confirms.delete(uuid);
    disputes.add(uuid);
  }
  let status = ev.status;
  if (status === 'active' && disputes.size >= DISPUTE_THRESHOLD && confirms.size === 0) {
    status = 'disputed';
  }
  return {
    confirms: [...confirms],
    disputes: [...disputes],
    status,
    changed: status !== ev.status,
  };
}

/**
 * 該對誰發 Discord。條件：訂閱了這台伺服器、填了 webhook、還沒被熔斷。
 * `subs` 的 `worlds` 已是陣列（DO 讀出時解過 JSON）。
 */
export function fanoutTargets(subs, world) {
  return subs.filter(
    (s) => !s.broken && s.webhookUrl && Array.isArray(s.worlds) && s.worlds.includes(world),
  );
}

/**
 * 同一 UUID 是否還在冷卻中（只擋「開新事件」，附議不受限）。
 * @param lastAt 該 UUID 上次在該伺服器開新事件的時間；沒有就傳 0
 */
export function inCooldown(lastAt, now) {
  return lastAt > 0 && now - lastAt < REPORT_COOLDOWN;
}

/**
 * Discord 訊息內容。純字串組裝放這裡，DO 只負責送。
 *
 * ⚠️ **不揭露 `source`**（Owner 2026-08-02：「不要說明用插件偵測，就說通知回報即可」）。
 * `source` 仍然記在資料庫裡供管理端看 stats，但**任何使用者看得到的地方都只講「回報」**——
 * 對收通知的人來說，他要知道的是「哪一台、還有多久」，資料怎麼進來的與他無關。
 */
export function discordPayload(ev, now) {
  // 只收到預告、還不知道何時開始（`startAt === 0`）——**不編造倒數**。
  // 目前只有一個提前量樣本（5 分 40 秒），寫一個看起來精確的數字，
  // 下一次不準的時候就沒有人會再相信這一頁。
  if (!ev.startAt) {
    return {
      username: 'FFXIV 宇宙探索',
      embeds: [
        {
          title: `⚡ ${ev.world}　緊急事件預告`,
          description: '遊戲內已出現預兆通告，**再過幾分鐘就會開始**。\n實際開始時會再通知一次。',
          color: 0xb58900,
        },
      ],
    };
  }
  const mins = Math.max(0, Math.round((ev.startAt - now) / 60));
  const when = ev.startAt <= now ? '已經開始' : `約 ${mins} 分鐘後開始`;
  return {
    username: 'FFXIV 宇宙探索',
    embeds: [
      {
        title: `⚡ ${ev.world}　緊急事件${ev.startAt <= now ? '進行中' : '預告'}`,
        description: `**${when}**，持續約 20 分鐘。\n（依回報顯示，實際以遊戲內為準）`,
        color: 0x00b5d8,
      },
    ],
  };
}
