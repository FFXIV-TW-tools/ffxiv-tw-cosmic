/**
 * 鬧鐘提前量的觸發時機（2026-08-08 健檢 correctness-core/A1）。
 *
 * 「開啟當下」（0 分）原本**永遠不會響**：迴圈先把所有已開的視窗跳過，剩下的 `eta` 必然 > 0，
 * 而閘是 `eta > leadSeconds` ⇒ lead=0 時一律 continue。選項就在畫面上、狀態列還寫著
 * 「開啟中 · 提前 0 分鐘」——**功能靜默失效，沒有任何訊號**。
 *
 * 這裡喂假 window 與假 Notification，**逐秒跑過開啟時刻**並數 fire 次數。
 * ⚠️ 不引 jsdom：只給 `createAlarm` 需要的三個節點，要驗的是觸發時機不是排版。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALARM = `file:///${join(ROOT, 'modules', 'alarm.js').replace(/\\/g, '/')}`;

const OPEN_AT = 1785000000;      // 假視窗的開啟時刻
const OPEN_LEN = 600;

function fakeWindow() {
  return {
    condId: 1,
    label: '天候：靈風',
    jobs: [8],
    missions: [{ jobs: [8], critical: false }],
    isOpen: (now) => now >= OPEN_AT && now < OPEN_AT + OPEN_LEN,
    // 契約：下一次**含當前** ⇒ 開著時回的是當前視窗（start 在過去）
    next: (now) => (now < OPEN_AT + OPEN_LEN
      ? { start: OPEN_AT, end: OPEN_AT + OPEN_LEN }
      : { start: OPEN_AT + 4200, end: OPEN_AT + 4200 + OPEN_LEN }),
    cadence: () => 4200,
  };
}

/** 建一個鬧鐘實例；回傳 { check, fires() }。 */
async function makeAlarm(leadMinutes) {
  const fired = [];
  const node = (v) => ({
    checked: true, value: String(v), textContent: '', hidden: false,
    addEventListener() {},
  });
  const nodes = { '#al-enabled': node(''), '#al-lead': node(leadMinutes), '#al-status': node('') };
  const root = { querySelector: (s) => nodes[s] };

  globalThis.localStorage = {
    _s: { 'ffxiv-tw-cosmic:alarm': JSON.stringify({ enabled: true, leadMinutes }) },
    getItem(k) { return this._s[k] ?? null; },
    setItem(k, v) { this._s[k] = String(v); },
  };
  globalThis.Notification = class {
    static permission = 'granted';
    constructor(title) { fired.push(title); }
  };
  globalThis.Audio = class { play() { return Promise.resolve(); } };
  globalThis.document = { querySelector: () => null, createElement: () => ({ classList: { add() {} }, append() {}, remove() {}, style: {} }) };
  globalThis.window = { addEventListener() {} };

  const { createAlarm } = await import(`${ALARM}?v=${leadMinutes}-${Math.random()}`);
  const a = createAlarm(root, { windows: [fakeWindow()], jobs: { 8: { label: '木工師' } }, getJobFilter: () => [] });
  return { check: a.check, fires: () => fired };
}

function runTicks(check, from, to) {
  for (let t = from; t <= to; t++) check(t);
}

test('提前 0 分（開啟當下）：在視窗開啟那一刻響，且只響一次', async () => {
  const a = await makeAlarm(0);
  runTicks(a.check, OPEN_AT - 5, OPEN_AT + 30);
  const f = a.fires();
  assert.equal(f.length, 1, `應恰響一次，實際 ${f.length} 次：${JSON.stringify(f)}`);
  assert.match(f[0], /^現在：/, 'lead=0 的標題應該是「現在：」而不是「N 分鐘後」');
});

test('提前 0 分：視窗已經開了很久才打開鬧鐘 ⇒ 不補響（那是雜訊不是提醒）', async () => {
  const a = await makeAlarm(0);
  runTicks(a.check, OPEN_AT + 300, OPEN_AT + 330);   // 開啟後 5 分鐘才開始 tick
  assert.equal(a.fires().length, 0);
});

test('提前 3 分：維持原行為，在開啟前 3 分鐘響一次', async () => {
  const a = await makeAlarm(3);
  runTicks(a.check, OPEN_AT - 400, OPEN_AT - 1);
  const f = a.fires();
  assert.equal(f.length, 1, `應恰響一次，實際 ${f.length} 次`);
  assert.match(f[0], /分鐘後：/, 'lead>0 的標題應該報剩幾分鐘');
});

test('提前 3 分：不會因為視窗已經開著就補響（原行為，不得回歸）', async () => {
  const a = await makeAlarm(3);
  runTicks(a.check, OPEN_AT + 1, OPEN_AT + 60);
  assert.equal(a.fires().length, 0);
});
