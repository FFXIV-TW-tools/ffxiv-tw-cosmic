/**
 * 緊急事件現況「多久才出得來」的回歸測試（2026-08-05）。
 *
 * 這一頁的內容排在四份離線 JSON 後面等了三層 round-trip，才輪得到它發 `/state`，
 * 而拿到之後還要再等下一個 1 秒 tick 才畫——兩件事都只在**時序**上出錯，
 * 功能全綠、console 無錯，是典型的「不主動量就看不見」。所以用測試釘住：
 *
 *  1. 首次 render 直接吃 app.js 預抓的那一發，**不重打**，且**當場就把七列畫出來**；
 *  2. 過期的預抓一律丟掉重打——舊資料被標成「剛更新」在這一頁是安全性等級的錯（鐵則 §4）。
 *
 * 用手寫的 DOM stub 而不是 jsdom：這裡要驗的是呼叫時序，不是排版。
 */

import assert from 'node:assert/strict';

// ── 極簡 DOM ──────────────────────────────────────────────────────────────
function makeEl(tag = 'div') {
  const el = {
    tagName: tag,
    children: [],
    dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {} },
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    append(...kids) { el.children.push(...kids); },
    replaceChildren(...kids) { el.children = kids; },
    // 記住 handler：測按鈕要按得下去，否則只能開後門 API 給測試用（那就不是在測真實接線）
    listeners: {},
    addEventListener(type, fn) { el.listeners[type] = fn; },
    setAttribute() {},
    querySelector: () => null,
    scrollIntoView() {},
  };
  return el;
}

const IDS = [
  '#em-list', '#em-deeplink', '#em-status', '#em-lead', '#em-weather', '#em-ann',
  '#em-submit', '#em-msg', '#em-report-overlay', '#em-report-world',
  '#em-report-close', '#em-report-cancel',
];

function makeRoot() {
  const map = Object.fromEntries(IDS.map((id) => [id, makeEl()]));
  return { root: { querySelector: (id) => map[id] ?? null }, map };
}

globalThis.document = {
  hidden: false,
  createElement: makeEl,
  createTextNode: (t) => ({ text: t }),
  addEventListener() {},
  body: { style: {} },
};
globalThis.Option = function Option(label, value) { return { label, value }; };
globalThis.location = { hostname: 'cosmic.xivtc.com', origin: 'https://cosmic.xivtc.com', search: '', hash: '', pathname: '/' };
globalThis.history = { replaceState() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  // 投票路徑會先要 UUID（emergency-api.currentUuid → window.FFXIVSettings.getUuid）；
  // 沒有它 vote() 會在送出前就以 no_uuid 退回，測到的就不是我們要測的那段
  FFXIVSettings: { ready: Promise.resolve(), getUuid: () => '11111111-1111-4111-8111-111111111111' },
};

const WORLDS = ['伊弗利特', '迦樓羅', '利維坦', '巴哈姆特', '奧汀', '泰坦', '鳳凰'];
const STATE = { events: {}, lastEnded: {}, disputeThreshold: 3 };

/** 記錄 `/state` 實際被打了幾次。 */
let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  return { ok: true, status: 200, json: async () => STATE };
};

const { createEmergencyView } = await import('../modules/emergency-view.js');

/** poll 是 async：讓 microtask／timer 佇列跑完再斷言。 */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── 1. 新鮮的預抓：不重打，而且當場就畫 ────────────────────────────────────
{
  const { root, map } = makeRoot();
  fetches = 0;
  const prefetched = { at: Date.now(), promise: Promise.resolve({ ok: true, data: STATE }) };
  const view = createEmergencyView(root, { worlds: WORLDS, prefetch: prefetched });

  assert.equal(map['#em-list'].children.length, 0, '還沒 render 前不該有列');
  view.render(Math.floor(Date.now() / 1000));
  await settle();

  assert.equal(fetches, 0, '首次應吃預抓的那一發，不該再打一次 /state');
  assert.equal(
    map['#em-list'].children.length, WORLDS.length,
    '拿到現況就該把七列畫出來——不能等下一個 tick',
  );
  assert.match(map['#em-status'].textContent, /^更新於/, '狀態列不該還停在「載入中…」');
  console.log('✓ 新鮮預抓：零額外請求，同一輪就畫出七列');
}

// ── 2. 過期的預抓：丟掉重打（舊資料不得被標成剛更新）──────────────────────
{
  const { root, map } = makeRoot();
  fetches = 0;
  const stale = { at: Date.now() - 60_000, promise: Promise.resolve({ ok: true, data: STATE }) };
  const view = createEmergencyView(root, { worlds: WORLDS, prefetch: stale });

  view.render(Math.floor(Date.now() / 1000));
  await settle();

  assert.equal(fetches, 1, '過期的預抓必須丟掉、改打一次新的');
  assert.equal(map['#em-list'].children.length, WORLDS.length);
  console.log('✓ 過期預抓：改打新的，不把舊現況標成剛更新');
}

// ── 3. 背景分頁不輪詢（鐵則 §5 的既有行為，一併釘住）──────────────────────
{
  const { root } = makeRoot();
  fetches = 0;
  document.hidden = true;
  const view = createEmergencyView(root, { worlds: WORLDS, prefetch: null });
  view.render(Math.floor(Date.now() / 1000));
  await settle();
  document.hidden = false;

  assert.equal(fetches, 0, '背景分頁不該發任何請求（額度事故的那條）');
  console.log('✓ 背景分頁：零請求');
}

// ── 4. 投票：用回應裡的票數當場更新，不必等第二趟 /state ────────────────────
{
  // Owner 2026-08-05 回報「按了但沒即時 +1」。根因＝後端 vote() 的回應**本來就帶著**新票數，
  // 前端丟掉不用、改去打第二趟 /state 才更新畫面 ⇒ 兩趟往返（實測重現 2003ms）。
  // 這裡讓 /state **永不 resolve**：若畫面仍能顯示新票數，就證明它不依賴第二趟。
  const world = WORLDS[0];
  const live = {
    events: { [world]: { id: 900, world, startAt: 0, endAt: Math.floor(Date.now() / 1000) + 600,
      status: 'active', confirms: 1, disputes: 0, weather: null, variant: null, source: 'manual',
      pendingNotify: false, missionIds: [] } },
    lastEnded: {}, disputeThreshold: 3,
  };
  const { root, map } = makeRoot();
  fetches = 0;
  globalThis.fetch = async (url, init) => {
    fetches++;
    if (String(url).includes('/vote')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, confirms: 7, disputes: 0, status: 'active' }) };
    }
    return new Promise(() => {});   // /state 永遠不回：卡住第二趟
  };
  const view = createEmergencyView(root, {
    worlds: WORLDS,
    prefetch: { at: Date.now(), promise: Promise.resolve({ ok: true, data: live }) },
  });
  view.render(Math.floor(Date.now() / 1000));
  await settle();

  const votesOf = () => (map['#em-list'].children.find((li) => li.dataset.evId === '900')
    ?.children ?? []).map((c) => c.textContent).join(' ');
  assert.match(votesOf(), /附議 1/, '前置：畫面先是 1 票');

  // 走真正的按鈕：遞迴找到「我也看到了」那顆，呼叫它自己註冊的 click handler
  const findBtn = (node, text) => {
    if (node?.textContent === text && node.listeners?.click) return node;
    for (const kid of node?.children ?? []) {
      const hit = findBtn(kid, text);
      if (hit) return hit;
    }
    return null;
  };
  const btn = findBtn(map['#em-list'], '我也看到了');
  assert.ok(btn, '該列必須有「我也看到了」按鈕');
  btn.listeners.click();
  await settle();
  await settle();

  assert.match(
    votesOf(), /附議 7/,
    '投票回應已帶新票數 ⇒ 不得等第二趟 /state 才更新（那趟在本案例永不回應）',
  );
  console.log('✓ 投票：用回應值當場更新，不等第二趟 /state');
}

console.log('emergency-view 時序測試全過');
