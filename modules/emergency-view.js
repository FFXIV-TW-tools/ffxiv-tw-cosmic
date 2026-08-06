/**
 * 緊急事件分頁——現況、通報、附議／否認。
 *
 * **這一頁的資訊主張跟全站其他頁不同，必須講清楚**：其他頁的東西是算出來的（天氣、ET 時段），
 * 對就是對；這一頁的東西是**別人回報的**，沒人回報就是空的，而空的**不代表沒有事件**。
 * 任何會讓人誤以為「這裡沒亮＝安全」的措辭都是 bug。
 *
 * 倒數用本地時鐘算，後端只在必要時才打——事件長 20 分鐘，不需要更即時，
 * 而閒置時猛打 API 會把免費額度燒在沒有資訊增益的地方（輪詢節奏見下方常數）。
 */

import { formatDuration, clockText } from './eorzea-time.js';
import { emergencyApi } from './emergency-api.js';

/**
 * 輪詢節奏（2026-08-04 額度事故後改成三檔；鐵則 §5）。
 *
 * **主要的「有事了」通道是 Discord，不是輪詢**：後端 DO 收到通報就自己發 webhook，
 * 使用者看到通知 → 打開／切回分頁 → `visibilitychange` 立刻 poll → 進 ACTIVE。
 * 所以輪詢只需要接住「沒訂 Discord、又剛好開著頁面」的人，那用心跳就夠。
 *
 * ⚠️ 為什麼閒置不能直接歸零：瀏覽器沒有任何管道能自己發現「別人通報了」——
 * 那個訊號在伺服器側。歸零＝除非你自己按按鈕，否則永遠不會被觸發。
 */
const POLL_ACTIVE_SECONDS = 60;    // 我關心的伺服器有進行中事件（或我剛動作過）
const POLL_IDLE_SECONDS = 300;     // 心跳。事件本身長 20 分鐘，5 分鐘的落後可接受

/** 自己通報／附議後維持 ACTIVE 的時間（秒）——你剛表達過關心，這段時間值得即時。 */
const SELF_ACTIVE_SECONDS = 1800;

/**
 * app.js 那一發預抓的保鮮期（毫秒）。正常路徑上它是幾百毫秒前才發的；
 * 超過就寧可重打一次——這一頁最貴的錯誤是把舊資料標成新的。
 */
const PREFETCH_MAX_AGE_MS = 10_000;

/** 上次通報選的伺服器。純檢視狀態，不進跨工具設定。 */

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

/**
 * 天氣／變體。**六則通告全部出自台服 client 的 `MassivePcContentTextData`**
 *（2026-08-03 離線解出），不是轉述。
 *
 * 每種天氣有三則：一則**預告**（A／B 共用，看到它的人分不出來）、兩則**開始**（A／B 各一，
 * 對應不同的任務與地點）。所以選單必須有「只看到預告」那一層——
 * 逼只看到預告的人選 A 或 B，就是在製造假資料（鐵則 §2）。
 */
const WEATHERS = [
  {
    kind: 'storm',
    name: '磁暴',
    warn: '即將發生大規模磁暴……所有機械設備都可能會受到影響！請大家提高警覺！',
    starts: [
      ['storm-a', '已確認磁暴造成惡劣影響…收集救災所需的物資'],
      ['storm-b', '磁暴造成渴望灣多個地區受災…展開救災活動'],
    ],
  },
  {
    kind: 'meteor',
    name: '流星雨',
    warn: '觀測到小型隕石群正在靠近！',
    starts: [
      ['meteor-a', '有小型隕石雨墜落在月門基地附近…恢復生產建設秩序'],
      ['meteor-b', '隕石雨墜落造成的衝擊導致地面氣體外洩'],
    ],
  },
  {
    kind: 'spore',
    name: '孢子霧',
    warn: '觀測到孢子霧爆發的預兆！',
    starts: [
      ['spore-a', '渴望灣東部爆發孢子霧…查明是否出現變異菌床'],
      ['spore-b', '孢子霧吞沒渴望灣東部…除去變異菌床'],
    ],
  },
];

/** A／B 的顯示字。變體只有兩個，順序即 client 內的順序。 */
const AB = ['A', 'B'];

/** 選單值 → 送出去的欄位。`kind` 只知道天氣、`variant` 連 A／B 都知道。 */
const WEATHER_CHOICES = [
  { value: '', label: '不確定', weather: null, variant: null },
  ...WEATHERS.flatMap((w) => [
    // 只看到預告 ⇒ 只報得出天氣。這一項必須排在該天氣的最前面，它才是預設的落點。
    { value: w.kind, label: `${w.name}（只看到預告，不確定 A／B）`, weather: w.kind, variant: null },
    ...w.starts.map(([variant, text], i) => ({
      value: variant,
      label: `${w.name} ${AB[i]} — 「${text}」`,
      weather: w.kind,
      variant,
    })),
  ]),
];

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
 * @param {{worlds: string[], prefetch?: {at:number, promise:Promise<object>}|null,
 *          onState?: (state:object)=>void}} opts app.js 在載靜態 JSON 前先發的那一發現況
 */
export function createEmergencyView(root, { worlds, prefetch = null, onState, onChanged, onShowMap }) {
  const el = {
    list: root.querySelector('#em-list'),
    deeplink: root.querySelector('#em-deeplink'),
    status: root.querySelector('#em-status'),
    lead: root.querySelector('#em-lead'),
    weather: root.querySelector('#em-weather'),
    announcements: root.querySelector('#em-ann'),
    submit: root.querySelector('#em-submit'),
    msg: root.querySelector('#em-msg'),
    overlay: root.querySelector('#em-report-overlay'),
    dialogWorld: root.querySelector('#em-report-world'),
    close: root.querySelector('#em-report-close'),
    cancel: root.querySelector('#em-report-cancel'),
  };

  /** 最近一次成功取得的現況；後端掛掉時保留上一份並標明時間，不清空。 */
  let state = null;
  let fetchedAt = 0;
  let lastPoll = 0;
  let offline = false;
  /** 自己動作過之後維持 ACTIVE 到這個時間戳（秒）。 */
  let selfActiveUntil = 0;

  /**
   * 「我關心的伺服器」。用跨工具身份的 `character.mainWorld`（同步讀、不花請求）。
   *
   * **沒設定就回全部**：不能因為使用者沒填過設定，就讓他漏看自己那台的事件——
   * 這一頁最嚴重的失效模式是「畫面沒亮被當成沒事」（鐵則 §4）。少省一點無所謂。
   * 刻意不去讀 Discord 訂閱清單：那住在 emergency-notify，為它拉一條跨模組管線
   * 換到的精準度有限，而多一條耦合就多一個會漂的地方。
   */
  function watchedWorlds() {
    const mine = window.FFXIVSettings?.get?.('character.mainWorld') ?? '';
    return worlds.includes(mine) ? [mine] : worlds;
  }

  /**
   * 這一刻該用哪一檔。判準只看**已經拿到的 state**，不額外發請求。
   */
  function pollIntervalFor(now) {
    if (now < selfActiveUntil) return POLL_ACTIVE_SECONDS;
    if (!state) return POLL_IDLE_SECONDS;
    const hot = watchedWorlds().some((w) => {
      const ev = state.events[w];
      return ev && ev.endAt > now;
    });
    return hot ? POLL_ACTIVE_SECONDS : POLL_IDLE_SECONDS;
  }

  /** 自己通報／附議／否認之後叫它——你剛表達過關心，這 30 分鐘值得即時。 */
  function markSelfActive() {
    selfActiveUntil = Math.floor(Date.now() / 1000) + SELF_ACTIVE_SECONDS;
  }

  // 天氣是**選填**。第一項就是「不確定」而且是預設——填錯的天氣會讓之後的地圖把人導去
  // 錯的地點，比沒填更糟（鐵則 §2 的同一個道理：寧可標成未知，不要拿看起來合理的值充數）。
  // 「不確定」單獨在最上面，其餘依天氣分組——同一種天氣的三個選項要黏在一起，
  // 才看得出「預告 ／ A ／ B」是同一件事的三種確定程度。
  el.weather.append(new Option(WEATHER_CHOICES[0].label, WEATHER_CHOICES[0].value));
  for (const w of WEATHERS) {
    const group = document.createElement('optgroup');
    group.label = w.name;
    for (const c of WEATHER_CHOICES.filter((x) => x.weather === w.kind)) {
      group.append(new Option(c.label, c.value));
    }
    el.weather.append(group);
  }

  // 遊戲原文對照表（收合）：預告一則、開始兩則且**標明哪則是 A 哪則是 B**——
  // 選單問 A／B，這裡就得答得出 A／B，否則等於要人瞎猜（2026-08-03 Owner 指出）。
  if (el.announcements) {
    for (const w of WEATHERS) {
      const block = document.createElement('p');
      block.className = 'codex-small';
      const title = document.createElement('strong');
      title.textContent = w.name;
      block.append(title, document.createTextNode(`　預告（A／B 共用）：「${w.warn}」`));
      w.starts.forEach(([, text], i) => {
        block.append(
          document.createElement('br'),
          document.createTextNode(`　　${w.name} ${AB[i]}：「${text}」`),
        );
      });
      el.announcements.append(block);
    }
  }

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

  /**
   * 彈窗鎖定的伺服器。**由使用者按的那一列決定，不是選出來的**——
   * 2026-08-02 實測過「下拉選單預設選到第一台」會產生報錯伺服器的假通報，
   * 而那種「不是惡意但是錯的」通報社交層分辨不出來。把欄位整個拿掉，錯誤就沒有發生的餘地。
   */
  let dialogWorld = '';
  let releaseTrap = null;

  function openReport(world) {
    dialogWorld = world;
    el.dialogWorld.textContent = world;
    el.lead.value = '0';
    el.weather.value = '';
    say('', 'ok');
    el.submit.disabled = false;
    el.overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    releaseTrap = window.FFXIVA11y?.trapFocus?.(el.overlay) ?? null;
  }

  function closeReport() {
    el.overlay.hidden = true;
    document.body.style.overflow = '';
    releaseTrap?.();
    releaseTrap = null;
  }

  el.close?.addEventListener('click', closeReport);
  el.cancel?.addEventListener('click', closeReport);
  el.overlay?.addEventListener('click', (e) => {
    if (e.target === el.overlay) closeReport();   // 只認遮罩本身
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.overlay.hidden) closeReport();
  });

  // 回到前景立刻補一次（配合 render() 的背景不輪詢）。使用者剛把分頁切回來，看到的第一眼
  // 就該是新的，不能等下一個 60 秒週期——那正是「畫面是舊的」會被誤讀成「沒有事件」的時刻。
  // （`poll()` 本身拿到就重畫，這裡不必再另外要求。）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    lastPoll = Math.floor(Date.now() / 1000);
    poll();
  });

  el.submit.addEventListener('click', submit);

  async function submit() {
    el.submit.disabled = true;
    const choice = WEATHER_CHOICES.find((c) => c.value === el.weather.value) ?? WEATHER_CHOICES[0];
    const ok = await sendReport(dialogWorld, Number(el.lead.value), choice);
    el.submit.disabled = false;
    // 成功就關窗（結果會顯示在那一列上）；失敗留著讓人看錯誤訊息並重試
    if (ok) closeReport();
  }

  async function sendReport(world, lead, choice) {
    markSelfActive();   // 你剛通報 ⇒ 接下來 30 分鐘值得即時（鐵則 §5）
    const r = await emergencyApi.report(world, lead, choice);
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
      await poll();
      onChanged?.();   // 新事件要進歷史紀錄（撤銷／結束後才會出現在那張表）
      return true;
    }
    say(r.message, 'warn');
    return false;
  }

  function say(text, tone) {
    el.msg.textContent = text;
    el.msg.dataset.tone = tone;
  }

  // ── Discord 通知的深連結收端（`?ev=<id>&vote=confirm|dispute`）──

  /**
   * 深連結意圖存成**狀態**，不是一次性 DOM 操作——`render()` 每秒重建整份事件列，
   * 直接改 DOM 的高亮下一秒就被 `replaceChildren` 抹掉。
   * @type {{evId:number, vote:string|null, scrolled:boolean}|null}
   */
  let deepLink = null;

  function readDeepLink() {
    let p;
    try {
      p = new URLSearchParams(location.search);
    } catch {
      return;   // 極少數嵌入情境拿不到 search，不影響其他功能
    }
    const raw = p.get('ev') ?? '';
    if (!/^\d+$/.test(raw)) return;                       // 只認正整數，其餘一律忽略
    const vote = p.get('vote');
    deepLink = {
      evId: Number(raw),
      vote: vote === 'confirm' || vote === 'dispute' ? vote : null,
      scrolled: false,
    };
    // 讀完立刻把自己的參數清掉（保留別人的參數與 hash）：
    // 不清的話使用者一重整就又跳一次確認列，而他可能已經投過了
    try {
      p.delete('ev');
      p.delete('vote');
      const q = p.toString();
      history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
    } catch {
      // 不允許改 URL 的情境：確認列照樣運作，只是重整會再出現一次
    }
  }

  function closeDeepLink() {
    deepLink = null;
    el.deeplink.replaceChildren();
    el.deeplink.hidden = true;
  }

  /** 依 `deepLink` 狀態重畫確認列。每次 render 都呼叫（狀態驅動，不做一次性 DOM）。 */
  function renderDeepLink(now) {
    if (!deepLink) return;
    // ⚠️ 還沒拿到現況（首次載入中／後端離線）時**什麼都不要說**：
    // 這時候找不到事件不代表它結束了，講「已經結束」會把「我們連不上」誤報成
    // 「那筆通報沒了」——方向完全相反，而使用者無從分辨。
    if (!state) return;
    const ev = Object.values(state.events ?? {}).find((e) => e && e.id === deepLink.evId);
    const live = ev && ev.endAt > now;

    el.deeplink.hidden = false;
    if (!live) {
      // 已結束／已下架／id 不存在——不白屏、不報錯，講一句人話就收起
      el.deeplink.replaceChildren(
        Object.assign(document.createElement('span'), {
          className: 'codex-small',
          textContent: '這則通報已經結束了，看看其他伺服器的現況。',
        }),
      );
      setTimeout(closeDeepLink, 5000);
      deepLink = null;    // 先清狀態，避免下一次 render 又重畫一次同一句
      return;
    }
    // 只帶 `?ev`＝從「看事件」按鈕來的，沒有要投票 ⇒ 不出確認列。
    // ⚠️ 但**狀態要留著**：高亮靠它才知道要標哪一列。這裡若順手 `closeDeepLink()`，
    // 「看事件」就變成點了什麼都沒發生——七列長得一樣，人還是得自己找。
    if (!deepLink.vote) { el.deeplink.replaceChildren(); el.deeplink.hidden = true; return; }

    const world = Object.keys(state.events).find((w) => state.events[w]?.id === ev.id) ?? '';
    const when = ev.startAt > now
      ? `${formatDuration(ev.startAt - now)}後開始`
      : `進行中 · 剩 ${formatDuration(ev.endAt - now)}`;
    const isConfirm = deepLink.vote === 'confirm';

    const text = document.createElement('span');
    text.className = 'codex-small';
    text.textContent = `要對「${world} · ${when}」${isConfirm ? '附議' : '按下否認'}嗎？`;

    const ok = document.createElement('button');
    ok.type = 'button';
    // 否認＝把別人的通報推向下架，屬破壞性操作 ⇒ danger 變體（與列上的 voteBtn 一致）
    ok.className = `codex-btn codex-small ${isConfirm ? 'codex-btn--primary' : 'codex-btn--danger'}`;
    ok.textContent = isConfirm ? '確認附議' : '確認否認';
    ok.addEventListener('click', () => {
      const kind = deepLink.vote;
      closeDeepLink();
      vote(ev.id, kind);        // 走既有那支，不另寫送出邏輯
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'codex-btn codex-btn--ghost codex-small';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeDeepLink);

    el.deeplink.replaceChildren(text, ok, cancel);
  }

  /** 把深連結指到的那一列標起來。捲動**只做一次**——每秒重捲會把使用者鎖在原地。 */
  function highlightDeepLink() {
    if (!deepLink) return;
    const li = el.list.querySelector(`[data-ev-id="${deepLink.evId}"]`);
    if (!li) return;
    li.classList.add('cos-em__row--hl');
    if (!deepLink.scrolled) {
      deepLink.scrolled = true;
      li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /**
   * 把後端回的票數就地寫進現況。
   *
   * **不是樂觀更新**（不猜、不預設成功）——後端 `vote()` 的回應**本來就帶著**新的
   * `confirms`／`disputes`／`status`，這裡只是把它用掉。原本丟掉不用、改等第二趟 `/state`
   * 才更新畫面 ⇒ 按下到數字改變要**兩趟往返**（台灣→CF 各約 250ms）。
   * 2026-08-05 Owner 回報「按了但沒即時 +1」；本機把 `/state` 延遲 1.5s 重現，實測 **2003ms**。
   */
  function applyVoteResult(eventId, data) {
    if (!state?.events || !data) return false;
    const world = Object.keys(state.events).find((w) => state.events[w]?.id === eventId);
    if (!world) return false;
    const ev = state.events[world];
    if (typeof data.confirms === 'number') ev.confirms = data.confirms;
    if (typeof data.disputes === 'number') ev.disputes = data.disputes;
    if (data.status) ev.status = data.status;
    return true;
  }

  async function vote(eventId, kind) {
    markSelfActive();
    const r = await emergencyApi.vote(eventId, kind);
    say(
      r.ok
        ? kind === 'confirm' ? '已附議。' : '已記錄否認 — 三個人否認且無人附議就會下架。'
        : r.message,
      r.ok ? 'ok' : 'warn',
    );
    // 先用回應裡的票數把畫面更新掉，再去對帳——順序反過來就等於沒修
    if (r.ok && applyVoteResult(eventId, r.data)) render(Math.floor(Date.now() / 1000));
    // 仍然重抓一次：別人這段期間的投票、事件狀態變化靠它補齊（畫面已經動過，不影響體感）
    await poll();
    if (r.ok) onChanged?.();   // 票數會進歷史紀錄，讓它跟著更新
  }

  async function withdraw(eventId) {
    markSelfActive();
    const r = await emergencyApi.withdraw(eventId);
    // 後端知道通知到底送出去了沒（靜置期內撤回＝根本沒送），直接用它回的那句話。
    // 自己在前端猜會猜錯：靜置期是伺服器時鐘算的，而且插件證實會提前送出。
    say(r.ok ? (r.data?.note || '已取消。') : r.message, r.ok ? 'ok' : 'warn');
    await poll();
    if (r.ok) onChanged?.();
  }

  async function notifyNow(eventId) {
    markSelfActive();
    const r = await emergencyApi.notifyNow(eventId);
    say(r.ok ? (r.data?.note || '已送出通知。') : r.message, r.ok ? 'ok' : 'warn');
    await poll();
  }

  async function poll() {
    // 首次用 app.js 在載靜態 JSON**之前**就發出的那一發（`prefetch`）——現況跟那四份離線資料
    // 沒有依賴關係，排在它們後面等於白等三層 round-trip（2026-08-05 實測：後端只花 25ms，
    // 但要到頁面載入後 400ms 才輪得到它發請求）。同步清掉，兩次 poll 撞在一起也只會用一次。
    //
    // ⚠️ 過期就不要：載入後馬上切走、幾分鐘後才切回來的分頁，那一發早已是舊的，
    // 而 `fetchedAt` 蓋的是**取用當下**的時間 ⇒ 會把舊現況標成「剛更新」。
    // 在這一頁那不是顯示瑕疵，是把「我們不知道」講成「查過了沒有」（鐵則 §4）。
    const p = prefetch && Date.now() - prefetch.at < PREFETCH_MAX_AGE_MS
      ? prefetch.promise
      : emergencyApi.getState();
    prefetch = null;
    const r = await p;
    if (!r.ok) {
      offline = true;
      renderStatus();
      return;
    }
    offline = false;
    state = r.data;
    fetchedAt = Math.floor(Date.now() / 1000);
    onState?.(state);
    // **拿到就畫，不等下一個 tick**：原本非 force 的輪詢只更新資料不重畫，七列要等到下一秒
    // 才出現（首次載入最明顯——畫面停在「載入中…」，而資料其實早就到了）。
    // 不會遞迴：render() 是先設 lastPoll 才呼叫 poll()，重畫時間隔判斷必定不成立。
    render(fetchedAt);
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
    // **沒有紀錄時也要放這個 span（空的）**：它是固定寬的一欄，右邊的按鈕靠它對齊。
    // 只在有值時才 append 的話，七列的按鈕會各自從不同的 x 開始（Owner 2026-08-03 截圖）。
    const span = document.createElement('span');
    span.className = 'codex-small cos-em__last';
    const t = state?.lastEnded?.[world];
    // 沒有紀錄就留空——寫「無紀錄」會讓人以為那台從沒出過事件，但真相是本站 8/2 才開始收
    span.textContent = t ? `上次 ${clockText(t)} 結束 · ${formatDuration(now - t)}前` : '';
    return span;
  }

  /**
 * 事件上的天氣標示：`磁暴 A`／`磁暴`（只知道天氣）／`null`（沒人填）。
 *
 * 三種狀態必須分得出來，不能把後兩者都畫成同一個樣子——之後的地圖只在知道 A／B 時
 * 才指得出地點，而「不知道」與「知道是磁暴但不知道 A／B」對它是不同的輸入。
 */
function weatherLabel(ev) {
  // **只寫天氣，不寫 A／B**：`a`／`b` 是**通告文字**的編號，地圖上的組叫 α／β，兩套名字不同；
  // 這裡寫「磁暴 B」，人到地圖上會找不到叫 B 的那一組。對應本身已於 2026-08-06 全數定案
  // （B-023，後端 `variantMap`），所以要顯示的話該顯示的是 `ev.group`（`storm-α`）而不是變體，
  // 而那要先決定 α／β 對使用者叫什麼名字 —— 未做，見 BACKLOG B-026。
  const kind = ev.weather ?? (ev.variant ? ev.variant.split('-')[0] : null);
  return WEATHERS.find((x) => x.kind === kind)?.name ?? null;
}

/** 一台伺服器一列。沒有事件的也要列出來——「查過了，沒有」跟「不知道」是兩回事。 */
  function row(world, ev, now) {
    const li = document.createElement('li');
    li.className = 'cos-em__row';
    // Discord 通知的深連結靠這個找到自己那一列（`highlightDeepLink`）
    if (ev) li.dataset.evId = String(ev.id);

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
      quick.addEventListener('click', () => openReport(world));
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

    // 天氣／變體：**沒有就整個不放**（不寫「未知」——那會被讀成「查過了是未知」，
    // 但真相是沒人填）。有值才顯示，也讓填錯的人自己看得出來要按取消重報。
    // 地點圖入口。**不管天氣有沒有填都要有**——第一版掛在天氣標籤上，結果沒填天氣的事件
    // 整列連一個入口都沒有（Owner 2026-08-03 截圖：奧汀「天氣未填」，畫面上找不到地圖）。
    // 而「不知道天氣」正是最需要去看地圖的情況：六組長什麼樣，看了才對得出來。
    const kind = ev.weather ?? (ev.variant ? ev.variant.split('-')[0] : null);
    const w = weatherLabel(ev);
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'codex-badge cos-em__weather cos-em__weather--link';
    tag.textContent = w ? `${w} · 地點圖` : '🗺 地點圖';
    tag.title = w ? `展開地點圖，看${w}要去哪幾個點` : '展開地點圖（這筆沒填天氣，六組都可以對照）';
    tag.addEventListener('click', () => onShowMap?.(world, kind, ev.group));
    li.append(tag);

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
    // 有事件的列也放這一欄（多半是空的）：七列的按鈕靠它落在同一個 x
    li.append(votes, lastEndedEl(world, now));

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
        // 否認走 danger 色（Owner 2026-08-03）：它的後果是**把別人的通報下架**，
        // 跟「我也看到了」不是同一種份量，長得一樣會被順手亂按。
        voteBtn('查無此事', 'dispute', ev.id),
      );
    }
    li.append(actions);
    return li;
  }

  function voteBtn(label, kind, eventId) {
    const b = document.createElement('button');
    b.type = 'button';
    // 否認＝把別人的通報推向下架，屬於設計系統說的「破壞性操作」⇒ danger 變體
    b.className = `codex-btn codex-small ${kind === 'dispute' ? 'codex-btn--danger' : 'codex-btn--ghost'}`;
    b.textContent = label;
    b.addEventListener('click', () => vote(eventId, kind));
    return b;
  }

  function render(now) {
    // 背景分頁不輪詢（2026-08-04）：`setInterval` 在隱藏分頁**照跑**（只被節流到 ≥1s），
    // 所以一個開著不看的分頁一天仍打 1440 次。實測那天 cosmic-api 24h 內 56k 次
    // ≈ 39 個長期掛著的分頁，佔掉帳號免費額度 100k/日 的一大半。
    // **代價只有「沒在看時畫面是舊的」**——推播完全不靠這裡（後端 DO 自己發 Discord webhook），
    // 回到前景時下面的 visibilitychange 會立刻補一次。
    if (!document.hidden && now - lastPoll >= pollIntervalFor(now)) {
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
    // 列重建之後才套：高亮是狀態的投影，不是一次性 DOM 操作
    renderDeepLink(now);
    highlightDeepLink();
  }

  readDeepLink();   // 進站當下就讀，`render()` 之後每次都依狀態重畫

  return { render };
}
