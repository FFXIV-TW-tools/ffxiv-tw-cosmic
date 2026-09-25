/**
 * 桌面通知受 portal 全域開關「啟用瀏覽器通知」（`notification.browserEnabled`）管轄。
 *
 * 失效形狀：設定面板上的開關關掉了，鬧鐘／緊急事件照樣 `new Notification` ——開關**零消費端**，
 * 使用者看到的是「我關了它還在跳」，而站內沒有任何錯誤訊號。
 *
 * 兩條路徑（`alarm.js` 的限時視窗鬧鐘、`emergency-notify.js` 的緊急事件）都走真的模組入口觸發，
 * 用 stub 的 `window.FFXIVSettings` 驗三段式接法：
 *   新 SDK（有 `notify()`）⇒ 交給它、不自己建 Notification；
 *   舊 SDK（只有 `get()`）⇒ 開關 false 不建、未設定照建；
 *   SDK 缺席 ⇒ 與改動前相同，直接建 Notification。
 * 以及：音效與頁內 toast 不受全域開關影響；本地開關關掉時連 SDK 都不叫（AND）；
 * 狀態文字跟著全域開關改口（全域關掉還寫「桌面通知＋音效」＝畫面說謊），切回來要恢復。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (f) => `file:///${join(ROOT, 'modules', f).replace(/\\/g, '/')}`;

const OPEN_AT = 1785000000;
const OPEN_LEN = 600;
const WORLD = '伊弗利特';

/** 每個案例的觀測紀錄；Notification／SDK／toast 都寫進這裡。 */
let rec;

/**
 * @param {'notify'|'get-false'|'get-unset'|'absent'} sdk
 */
function setupGlobals(sdk) {
  rec = { constructed: [], notified: [], alarms: 0, toasts: 0 };
  globalThis.Notification = class {
    static permission = 'granted';
    constructor(title, options) { rec.constructed.push({ title, options }); }
  };
  globalThis.location = { hostname: 'cosmic.xivtc.com', origin: 'https://cosmic.xivtc.com' };
  const toast = { show() { rec.toasts++; } };
  const base = {
    playAlarm() { rec.alarms++; },
    get: (k) => (k === 'notification.browserEnabled' && sdk === 'get-false' ? false : undefined),
  };
  const settings = {
    notify: { ...base, notify(title, options) { rec.notified.push({ title, options }); return { shown: true }; } },
    'get-false': base,
    'get-unset': base,
    absent: undefined,
  }[sdk];
  globalThis.window = { addEventListener() {}, FFXIVToast: toast, FFXIVSettings: settings };
}

function stubStorage(entries) {
  globalThis.localStorage = {
    _s: { ...entries },
    getItem(k) { return this._s[k] ?? null; },
    setItem(k, v) { this._s[k] = String(v); },
  };
}

/** 建一個鬧鐘實例（提前 3 分）；回傳 { check, status }。 */
async function makeAlarm({ enabled = true } = {}) {
  stubStorage({ 'ffxiv-tw-cosmic:alarm': JSON.stringify({ enabled, leadMinutes: 3 }) });
  const node = (v) => ({ checked: enabled, value: String(v), textContent: '', addEventListener() {} });
  const nodes = { '#al-enabled': node(''), '#al-lead': node(3), '#al-status': node('') };
  const { createAlarm } = await import(`${mod('alarm.js')}?v=${Math.random()}`);
  const a = createAlarm({ querySelector: (s) => nodes[s] }, {
    windows: [{
      condId: 7,
      label: '天候：靈風',
      jobs: [8],
      missions: [{ jobs: [8], critical: false }],
      isOpen: (now) => now >= OPEN_AT && now < OPEN_AT + OPEN_LEN,
      next: () => ({ start: OPEN_AT, end: OPEN_AT + OPEN_LEN }),
    }],
    jobs: { 8: { label: '木工師' } },
    getJobFilter: () => [],
  });
  return { check: a.check, status: nodes['#al-status'] };
}

/** 觸發一次鬧鐘（逐秒跑過開啟前 3 分鐘的觸發點）。 */
async function fireAlarm(opts) {
  const { check } = await makeAlarm(opts);
  for (let t = OPEN_AT - 400; t < OPEN_AT; t++) check(t);
}

/** 建一個緊急事件通知實例並勾選 WORLD；回傳 { onState, status }。 */
async function makeEmergency({ webOn = true } = {}) {
  stubStorage({ 'ffxiv-tw-cosmic:em-webnotify': webOn ? '1' : '0' });
  const chips = [];
  const n = (extra = {}) => ({
    textContent: '', checked: false, hidden: true, disabled: false,
    addEventListener() {}, append(c) { chips.push(c); }, replaceChildren() {},
    querySelectorAll: () => [], ...extra,
  });
  const nodes = {
    '#em-sub-worlds': n(), '#em-web': n({ checked: webOn }), '#em-sub-save': n(),
    '#em-sub-status': n(), '#em-discord-status': n(),
  };
  globalThis.document = {
    body: { style: {} },
    addEventListener() {},
    createTextNode: (t) => ({ t }),
    createElement: () => {
      const listeners = {};
      return {
        setAttribute() {},
        addEventListener(type, fn) { listeners[type] = fn; },
        click() { listeners.click?.(); },
      };
    },
  };
  const { createEmergencyNotify } = await import(`${mod('emergency-notify.js')}?v=${Math.random()}`);
  const em = createEmergencyNotify({ querySelector: (s) => nodes[s] ?? null }, { worlds: [WORLD] });
  await new Promise((r) => setImmediate(r));   // 等 load() 跑完，免得它事後改動勾選
  chips[0].click();                            // 勾選 WORLD
  return { onState: em.onState, status: nodes['#em-sub-status'] };
}

/** 觸發一次緊急事件網頁通知（餵一筆 WORLD 的進行中事件）。 */
async function fireEmergency(opts) {
  const { onState } = await makeEmergency(opts);
  const now = Math.floor(Date.now() / 1000);
  onState({ events: { [WORLD]: { id: 'ev-1', startAt: now - 60, endAt: now + 600 } } });
}

const PATHS = [
  ['鬧鐘（alarm.js）', fireAlarm, /^3 分鐘後：木工師$/, 'cosmic-7'],
  ['緊急事件（emergency-notify.js）', fireEmergency, new RegExp(`^⚡ ${WORLD}：緊急事件進行中$`), 'cosmic-em-ev-1'],
];

for (const [name, fire, titleRe, tag] of PATHS) {
  test(`${name}：新 SDK 有 notify() ⇒ 交給 SDK，不自己建 Notification`, async () => {
    setupGlobals('notify');
    await fire();
    assert.equal(rec.constructed.length, 0, '有 notify() 時不得繞過 SDK 直接建 Notification');
    assert.equal(rec.notified.length, 1);
    assert.match(rec.notified[0].title, titleRe);
    assert.equal(rec.notified[0].options.tag, tag);
    assert.equal(rec.notified[0].options.icon, 'favicon-192.png');
    assert.equal(rec.alarms, 1);
    assert.equal(rec.toasts, 1);
  });

  test(`${name}：舊 SDK、全域開關 false ⇒ 不建 Notification，音效與 toast 照常`, async () => {
    setupGlobals('get-false');
    await fire();
    assert.equal(rec.constructed.length, 0, '全域開關關掉時桌面通知仍跳出');
    assert.equal(rec.alarms, 1, '全域開關只管桌面通知，音效不得被一起關掉');
    assert.equal(rec.toasts, 1, '全域開關只管桌面通知，頁內 toast 不得被一起關掉');
  });

  test(`${name}：舊 SDK、全域開關未設定 ⇒ 視為預設開啟，照建 Notification`, async () => {
    setupGlobals('get-unset');
    await fire();
    assert.equal(rec.constructed.length, 1);
    assert.match(rec.constructed[0].title, titleRe);
  });

  test(`${name}：SDK 缺席 ⇒ 與改動前相同，直接建 Notification`, async () => {
    setupGlobals('absent');
    await fire();
    assert.equal(rec.constructed.length, 1);
    assert.match(rec.constructed[0].title, titleRe);
    assert.equal(rec.constructed[0].options.tag, tag);
    assert.equal(rec.toasts, 1);
  });
}

test('鬧鐘：本地開關關掉 ⇒ 連 SDK 都不叫（與全域開關取 AND）', async () => {
  setupGlobals('notify');
  await fireAlarm({ enabled: false });
  assert.equal(rec.notified.length + rec.constructed.length, 0);
});

test('緊急事件：本地網頁通知關掉 ⇒ 連 SDK 都不叫（與全域開關取 AND）', async () => {
  setupGlobals('notify');
  await fireEmergency({ webOn: false });
  assert.equal(rec.notified.length + rec.constructed.length, 0);
});

/**
 * 可切換的 SDK stub：`get()` 讀活的值、`onChange()` 記下監聽，`flip()` 模擬使用者在設定面板切開關。
 * `getUuid` 讓緊急事件的 getSub 走到 fetch（stub 成「已訂閱 WORLD」）⇒ load() 收尾會畫網頁通知狀態。
 */
function setupLiveSettings(browserEnabled) {
  setupGlobals('absent');
  const listeners = [];
  const store = { 'notification.browserEnabled': browserEnabled };
  globalThis.window.FFXIVSettings = {
    get: (k) => store[k],
    onChange(k, fn) { listeners.push([k, fn]); },
    getUuid: () => 'uuid-test',
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ worlds: [WORLD] }) });
  return {
    flip(v) {
      store['notification.browserEnabled'] = v;
      for (const [k, fn] of listeners) if (k === 'notification.browserEnabled') fn(v, k);
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test('鬧鐘狀態文字：全域關 ⇒ 改說桌面通知已在全域關閉；重開 ⇒ 恢復', async () => {
  const live = setupLiveSettings(true);
  const { status } = await makeAlarm();
  assert.match(status.textContent, /桌面通知＋音效/);
  live.flip(false);
  assert.match(status.textContent, /音效＋畫面提示（桌面通知已在全域設定關閉）/);
  assert.doesNotMatch(status.textContent, /桌面通知＋音效/);
  live.flip(true);
  assert.match(status.textContent, /桌面通知＋音效/);
});

test('緊急事件狀態文字：全域關 ⇒ 改說桌面通知已在全域關閉；重開 ⇒ 恢復', async () => {
  const live = setupLiveSettings(true);
  const { status } = await makeEmergency();
  await settle();                                // load() 的 getSub → fetch → json 走完
  await settle();
  assert.match(status.textContent, /^網頁通知：開啟中/);
  live.flip(false);
  assert.match(status.textContent, /^網頁通知：桌面通知已在全域設定關閉/);
  live.flip(true);
  assert.match(status.textContent, /^網頁通知：開啟中/);
});

test('緊急事件狀態文字：切全域開關不蓋掉訂閱訊息（如 webhook 被暫停）', async () => {
  const live = setupLiveSettings(true);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ worlds: [WORLD], broken: true }) });
  const { status } = await makeEmergency();
  await settle();
  await settle();
  assert.match(status.textContent, /webhook 連續送失敗已被暫停/);
  live.flip(false);
  assert.match(status.textContent, /webhook 連續送失敗已被暫停/);
});
