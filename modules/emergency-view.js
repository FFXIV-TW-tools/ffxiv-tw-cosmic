/**
 * 緊急事件分頁——現況、通報、附議／否認。
 *
 * **這一頁的資訊主張跟全站其他頁不同，必須講清楚**：其他頁的東西是算出來的（天氣、ET 時段），
 * 對就是對；這一頁的東西是**別人回報的**，沒人回報就是空的，而空的**不代表沒有事件**。
 * 任何會讓人誤以為「這裡沒亮＝安全」的措辭都是 bug。
 *
 * 倒數用本地時鐘算，只有每 60 秒才真的打一次後端——事件長 20 分鐘，不需要更即時，
 * 而每秒打 API 會把免費額度燒在沒有資訊增益的地方。
 */

import { formatDuration, clockText } from './eorzea-time.js';
import { emergencyApi } from './emergency-api.js';

/** 後端輪詢間隔（秒）。 */
const POLL_SECONDS = 60;

/** 上次通報選的伺服器。純檢視狀態，不進跨工具設定。 */
const LAST_WORLD_KEY = 'ffxiv-tw-cosmic:em-world';

/**
 * 自己送出過的 eventId。用來決定要不要顯示「取消」按鈕——
 * `/state` 刻意不回 `reporter`（那是別人的識別碼，沒有理由發給所有人），
 * 所以「這筆是不是我按的」由本機記著就好。**權限判定仍在後端**，這裡只是顯示層。
 */
const MINE_KEY = 'ffxiv-tw-cosmic:em-mine';
const MINE_CAP = 20;

function loadMine() {
  try {
    const v = JSON.parse(localStorage.getItem(MINE_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function rememberMine(id) {
  try {
    const list = [...new Set([id, ...loadMine()])].slice(0, MINE_CAP);
    localStorage.setItem(MINE_KEY, JSON.stringify(list));
  } catch {
    // 記不住只會少一顆取消鈕，功能不受影響
  }
}

function loadLastWorld() {
  try {
    return localStorage.getItem(LAST_WORLD_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveLastWorld(w) {
  try {
    localStorage.setItem(LAST_WORLD_KEY, w);
  } catch {
    // 私密模式／配額滿：記不住而已，功能不受影響
  }
}

/**
 * 「什麼時候開始」的選項，**分成兩組**：已經開始的、還沒開始的。
 *
 * <b>分組是必要的，不是排版</b>（2026-08-03 Owner 兩次指「不該有 10 分鐘跟 15 分鐘」）：
 * 原本的字面是「15 分鐘前開始」，掃過去會讀成「提前 15 分鐘」——把「已經開始了多久」
 * 誤讀成預告量。已開始那組改用**剩餘時間**（Owner 定的說法），兩組各自只有一種讀法：
 * 「再 N 分鐘開始」是未來、「剩餘時間 N 分鐘」是進行中，沒有共用的數字可以混淆。
 *
 * 負數那組（＝已經開始了幾分鐘）**必須保留**：發現得晚的人不該被迫報「現在開始」，
 * 那會讓倒數整段往後偏（2026-08-02 實測：真實 17:53 開始、17:57 才通報，
 * 結束時間顯示晚 4 分鐘，而當下沒有任何辦法修正）。
 *
 * 往後只到 5 分鐘：遊戲的預兆通告只提前約 5 分鐘（實測 5:15／5:40），
 * 而玩家唯一的資訊來源就是它 ⇒ 沒有管道能知道更久之後的事。後端上限同為 5。
 */
/**
 * 事件長度（分鐘）。client 寫死的任務時限（`timeLimit=1200`），後端同一個常數。
 * 這裡只用來把「已經開始了幾分鐘」換算成畫面上顯示的**剩餘時間**。
 */
const EVENT_MINUTES = 20;

const LEAD_GROUPS = [
  ['還沒開始', [5, 3, 1].map((m) => [m, `再 ${m} 分鐘開始`])],
  // 已經開始的一律講**剩餘時間**，不講「已經過了多久」——玩家看得到的是倒數，
  // 而換算由程式做（`剩餘 = 20 + lead`），標籤與數值不可能對不起來。
  ['已經開始了', [0, -5, -10, -15].map((m) => [
    m, m === 0 ? '剛剛開始' : `剩餘時間 ${EVENT_MINUTES + m} 分鐘`,
  ])],
];

/**
 * @param {HTMLElement} root #panel-emergency
 * @param {{worlds: string[], onState?: (state:object)=>void}} opts
 */
export function createEmergencyView(root, { worlds, onState, onChanged }) {
  const el = {
    list: root.querySelector('#em-list'),
    status: root.querySelector('#em-status'),
    world: root.querySelector('#em-world'),
    lead: root.querySelector('#em-lead'),
    submit: root.querySelector('#em-submit'),
    msg: root.querySelector('#em-msg'),
  };

  /** 最近一次成功取得的現況；後端掛掉時保留上一份並標明時間，不清空。 */
  let state = null;
  let fetchedAt = 0;
  let lastPoll = 0;
  let offline = false;

  // **不給預設值**。`<select>` 天生會選第一個選項，也就是「伊弗利特」——
  // 泰坦的玩家沒注意到下拉框按下去，送出的就是一筆伊弗利特的假通報，而這種
  // 「不是惡意但是錯的」通報，社交層完全分辨不出來（只會被三個人否認掉，
  // 代價是另一台伺服器的人先被吵一次）。所以寧可逼人選一次。
  el.world.append(new Option('請選擇伺服器', ''));
  for (const w of worlds) el.world.append(new Option(w, w));
  for (const [groupLabel, options] of LEAD_GROUPS) {
    const group = document.createElement('optgroup');
    group.label = groupLabel;
    for (const [v, label] of options) group.append(new Option(label, String(v)));
    el.lead.append(group);
  }
  // 預設「剛剛開始」。不設的話瀏覽器選清單第一個＝「已開始 15 分鐘」——**最極端的選項當預設**，
  // 沒注意到就會把時間軸整整推移 15 分鐘。與 2026-08-02 那個「伺服器預設選到第一台造成誤報」
  // 同一種錯：下拉選單的第一項不是中性值。
  el.lead.value = '0';

  el.world.addEventListener('change', () => {
    if (el.world.value) saveLastWorld(el.world.value);
    syncSubmitState();
  });
  syncSubmitState();
  applyDefaultWorld();

  function syncSubmitState() {
    el.submit.disabled = !el.world.value;
    el.submit.title = el.world.value ? '' : '請先選擇伺服器';
  }

  /**
   * 預設值優先序：**這頁上次選的** → portal 跨工具的「我的伺服器」→ 不預設。
   *
   * 上次選的排在前面是因為它更貼近當下意圖（有人會替朋友的伺服器回報）；
   * `character.mainWorld` 是跨工具共用的身份設定（marketboard／BIS 也在吃），
   * 本站只讀不寫——那是使用者在 portal 設定的東西，不該被這頁的臨時選擇覆蓋。
   */
  async function applyDefaultWorld() {
    const known = (w) => (worlds.includes(w) ? w : '');
    let want = known(loadLastWorld());
    if (!want) {
      const s = window.FFXIVSettings;
      if (s) {
        // settings-client 是非同步 hydrate 的，不等它就會讀到空字串（實測踩過）
        try {
          if (s.ready) await s.ready;
        } catch {
          // 雲端拉取失敗不代表本機沒有值，繼續往下讀
        }
        want = known(s.get?.('character.mainWorld') ?? '');
      }
    }
    if (want) {
      el.world.value = want;
      syncSubmitState();
    }
  }

  el.submit.addEventListener('click', submit);

  /** 列上的一鍵通報＝該伺服器、「剛剛開始」。伺服器不由使用者選，所以選不錯。 */
  async function quickReport(world, btn) {
    btn.disabled = true;
    await sendReport(world, 0);
    // 不把 btn 開回來：成功的話這一列會被重畫成「已回報」，那顆按鈕本來就該消失；
    // 失敗（冷卻／限流）時 poll 也會重畫，重畫後的新按鈕是可按的
  }

  async function submit() {
    el.submit.disabled = true;
    await sendReport(el.world.value, Number(el.lead.value));
    syncSubmitState();   // 不能無條件開回來——沒選伺服器時它本來就該是關的
  }

  async function sendReport(world, lead) {
    const r = await emergencyApi.report(world, lead);
    if (r.ok) {
      if (!r.duplicate && Number.isInteger(r.data?.eventId)) rememberMine(r.data.eventId);
      say(
        r.duplicate
          ? `${world} 已經有人回報了 — 已幫你附議 +1。`
          // 通知靜置 30 秒才送（後端 logic.MANUAL_NOTIFY_DELAY）——那段時間按取消，
          // **沒有任何人會收到**。這句話是那個機制對使用者唯一看得見的地方，要講明確。
          : `已通報 ${world}。通知會在 30 秒後送出 — 按錯了現在按「取消」，就不會有人收到。`,
        'ok',
      );
      await poll(true);
      onChanged?.();   // 新事件要進歷史紀錄（撤銷／結束後才會出現在那張表）
    } else {
      say(r.message, 'warn');
    }
  }

  function say(text, tone) {
    el.msg.textContent = text;
    el.msg.dataset.tone = tone;
  }

  async function vote(eventId, kind) {
    const r = await emergencyApi.vote(eventId, kind);
    say(
      r.ok
        ? kind === 'confirm' ? '已附議。' : '已記錄否認 — 三個人否認且無人附議就會下架。'
        : r.message,
      r.ok ? 'ok' : 'warn',
    );
    await poll(true);
    if (r.ok) onChanged?.();   // 票數會進歷史紀錄，讓它跟著更新
  }

  async function withdraw(eventId) {
    const r = await emergencyApi.withdraw(eventId);
    // 後端知道通知到底送出去了沒（靜置期內撤回＝根本沒送），直接用它回的那句話。
    // 自己在前端猜會猜錯：靜置期是伺服器時鐘算的，而且插件證實會提前送出。
    say(r.ok ? (r.data?.note || '已取消。') : r.message, r.ok ? 'ok' : 'warn');
    await poll(true);
    if (r.ok) onChanged?.();
  }

  async function notifyNow(eventId) {
    const r = await emergencyApi.notifyNow(eventId);
    say(r.ok ? (r.data?.note || '已送出通知。') : r.message, r.ok ? 'ok' : 'warn');
    await poll(true);
  }

  async function poll(force = false) {
    const r = await emergencyApi.getState();
    if (!r.ok) {
      offline = true;
      renderStatus();
      return;
    }
    offline = false;
    state = r.data;
    fetchedAt = Math.floor(Date.now() / 1000);
    onState?.(state);
    if (force) render(fetchedAt);
  }

  function renderStatus() {
    if (offline) {
      el.status.textContent = fetchedAt
        ? `⚠️ 連不上通報伺服器，畫面停在 ${clockText(fetchedAt)} 的資料。`
        : '⚠️ 連不上通報伺服器 — 本站其他分頁不受影響。';
      return;
    }
    el.status.textContent = fetchedAt ? `更新於 ${clockText(fetchedAt)}` : '載入中…';
  }

  /**
   * 「上次 03:24 結束 · 4 小時前」——Owner 2026-08-03 想看間隔（實測約 4 小時以上）。
   *
   * **只在真的有紀錄時才出現**，沒有就整個不放。寫「無紀錄」會讓人以為那台從來沒出過事件，
   * 但真相是本站只從 8/2 才開始收，而且覆蓋率＝回報者人數（AGENTS §4 的天花板）。
   * 資料由後端 `/state.lastEnded` 給，前端不從歷史表推——那支只回 50 筆，久沒事件的會被漏掉。
   */
  function lastEndedEl(world, now) {
    const t = state?.lastEnded?.[world];
    if (!t) return document.createTextNode('');
    const span = document.createElement('span');
    span.className = 'codex-small cos-em__last';
    span.textContent = `上次 ${clockText(t)} 結束 · ${formatDuration(now - t)}前`;
    return span;
  }

  /** 一台伺服器一列。沒有事件的也要列出來——「查過了，沒有」跟「不知道」是兩回事。 */
  function row(world, ev, now) {
    const li = document.createElement('li');
    li.className = 'cos-em__row';

    // 狀態點：一眼掃出哪幾台有事，不必逐列讀字（進行中會擴散、預告是靜態警示色）
    const dot = document.createElement('span');
    dot.className = 'codex-status-dot';
    dot.setAttribute('aria-hidden', 'true');
    li.append(dot);

    const name = document.createElement('span');
    name.className = 'cos-em__world';
    name.textContent = world;
    li.append(name);

    if (!ev) {
      li.classList.add('cos-em__row--idle');
      dot.classList.add('codex-status-dot--muted');
      const none = document.createElement('span');
      none.className = 'codex-small cos-em__none';
      none.textContent = '目前沒有人回報';

      // 就地通報：**按鈕長在那一列上，伺服器就是那一列**（Owner 2026-08-03）。
      // 這消掉的是一整類錯誤——原本的表單要人自己選伺服器，而 2026-08-02 實測過
      // 「預設選到第一台」會造成報錯伺服器；強迫明確選擇只是把問題丟給使用者記得。
      // 只有「剛剛開始」走這裡（最常見）；預告或已開始 N 分鐘仍用下方表單。
      const quick = document.createElement('button');
      quick.type = 'button';
      quick.className = 'codex-btn codex-btn--ghost codex-small cos-em__quick';
      quick.textContent = '我看到了，通報';
      quick.addEventListener('click', () => quickReport(world, quick));
      li.append(none, lastEndedEl(world, now), quick);
      return li;
    }

    // **不顯示來源**（Owner 2026-08-02）。後端仍記著 `source` 供管理端統計，但畫面上一律只講
    // 「回報」——對看的人來說要緊的是哪一台、還有多久，資料怎麼進來的與他無關。
    // startAt === 0 ＝只收到遊戲內的預兆通告，**還不知道確切何時開始**
    const warnOnly = !ev.startAt;

    // 有事件的列用共用的左緣色條面板拉出層次：一眼看得出哪幾台要動身，
    // 而不是七列長得一模一樣、要逐列讀字（`--bar` 的色由消費端 `--tint` 給）。
    li.classList.add('codex-tint-panel', 'codex-tint-panel--bar');
    li.style.setProperty('--tint', warnOnly ? 'var(--color-warn, #e8a45a)' : 'var(--color-accent, #4fd1e8)');
    dot.classList.add(warnOnly ? 'codex-status-dot--warn' : 'codex-status-dot--live');
    if (!warnOnly) dot.classList.add('codex-status-dot--scan');

    const badge = document.createElement('span');
    badge.className = `codex-badge ${warnOnly ? 'codex-badge--warn' : 'codex-badge--ok'}`;
    badge.textContent = warnOnly ? '預告' : '已回報';
    li.append(badge);

    const when = document.createElement('strong');
    when.className = 'cos-em__when';
    if (warnOnly) {
      // **不編造倒數**：目前只有一個提前量樣本，寫個看起來精確的數字，
      // 下一次不準的時候就沒有人會再相信這一頁。
      when.textContent = '即將開始';
      const note = document.createElement('span');
      note.className = 'codex-small cos-em__none';
      note.textContent = `（${clockText(ev.warnedAt || now)} 出現預兆通告）`;
      when.append(note);
    } else {
      // 相對時間一律附現實時鐘（Owner 2026-08-03）：要不要現在動身是看幾點，不是看還剩幾分
      when.textContent = ev.startAt > now
        ? `${formatDuration(ev.startAt - now)}後開始（${clockText(ev.startAt)}）`
        : `進行中 · 剩 ${formatDuration(ev.endAt - now)}（到 ${clockText(ev.endAt)}）`;
    }
    li.append(when);

    const votes = document.createElement('span');
    votes.className = 'codex-small cos-em__votes';
    // 「幾個否認會下架」原本只寫在問號 tooltip 裡，等於沒人看得到。改成直接顯示進度：
    // 只在**真的會下架**的情況顯示（有否認且完全沒有附議——有人附議就不會下架了）。
    // 門檻取自後端回的 disputeThreshold，前端不自己寫 3。
    const threshold = state?.disputeThreshold ?? 0;
    const nearDrop = threshold > 0 && ev.disputes > 0 && ev.confirms === 0;
    votes.textContent = nearDrop
      ? `附議 ${ev.confirms}　否認 ${ev.disputes}／${threshold} 就下架`
      : `附議 ${ev.confirms}　否認 ${ev.disputes}`;
    li.append(votes);

    const actions = document.createElement('span');
    actions.className = 'cos-em__actions';
    if (loadMine().includes(ev.id)) {
      // 自己按的：給一顆明確的取消，不必去麻煩三個陌生人來否認
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'codex-btn codex-btn--ghost codex-small';
      cancel.textContent = ev.pendingNotify ? '取消（我按錯了）' : '取消';
      cancel.addEventListener('click', () => withdraw(ev.id));
      actions.append(cancel);
      // 還在靜置期才給「馬上通知」——已經送出去的事件按它沒有意義
      if (ev.pendingNotify) {
        const now = document.createElement('button');
        now.type = 'button';
        now.className = 'codex-btn codex-btn--ghost codex-small';
        now.textContent = '我確定，馬上通知';
        now.title = '跳過 30 秒等待直接送出通知。送出後就無法「沒有人會收到」了。';
        now.addEventListener('click', () => notifyNow(ev.id));
        actions.append(now);
      }
    } else {
      actions.append(
        voteBtn('我也看到了', 'confirm', ev.id),
        voteBtn('查無此事', 'dispute', ev.id),
      );
    }
    li.append(actions);
    return li;
  }

  function voteBtn(label, kind, eventId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'codex-btn codex-btn--ghost codex-small';
    b.textContent = label;
    b.addEventListener('click', () => vote(eventId, kind));
    return b;
  }

  function render(now) {
    if (now - lastPoll >= POLL_SECONDS) {
      lastPoll = now;
      poll();
    }
    renderStatus();
    if (!state) return;

    el.list.replaceChildren(
      ...worlds.map((w) => {
        const ev = state.events[w];
        // 後端算過期是用它自己的時鐘；這邊再用本地時鐘過濾一次，避免時鐘偏差讓已結束的事件多留幾秒
        return row(w, ev && ev.endAt > now ? ev : null, now);
      }),
    );
  }

  return { render };
}
