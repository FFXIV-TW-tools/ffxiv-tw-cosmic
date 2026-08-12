/**
 * 預告階段的「還要多久開始」區間（B-027，Owner 2026-08-11 拍板方案 A）。
 *
 * 這一頁的資訊主張比其他頁弱（靠回報、沒亮不代表沒事件），所以**寧可少講**：
 * 給區間不給精確倒數，走過區間就退回「即將開始」而不是改口說「應該已經開始了」。
 * 這些斷言釘的就是那條界線——有人日後想把它改成精確倒數時，會先撞到這裡。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// emergency-view 需要瀏覽器全域才 import 得起來；只取純函式，先補最小 stub
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { querySelector: () => null, createElement: () => ({ append() {}, classList: { add() {} } }) };
globalThis.window = { addEventListener() {} };
globalThis.location = { hostname: '127.0.0.1', href: 'http://127.0.0.1/', search: '' };
const { warnEtaText } = await import(`file:///${join(ROOT, 'modules', 'emergency-view.js').replace(/\\/g, '/')}`);

const W = 1785000000;   // 預兆通告出現的時刻

test('剛出現預告 → 約 4–5 分鐘後（＝密集區間 278–281 秒往外取整）', () => {
  assert.equal(warnEtaText(W, W), '約 4–5 分鐘後開始');
});

test('隨時間收斂，不是固定字串', () => {
  assert.equal(warnEtaText(W, W + 60), '約 3–4 分鐘後開始');
  assert.equal(warnEtaText(W, W + 120), '約 2–3 分鐘後開始');
  assert.equal(warnEtaText(W, W + 180), '約 1–2 分鐘後開始');
});

test('走過密集區間 → 退回「即將開始」，不得改口說「應該已經開始了」', () => {
  // 那 1/18 的離群值（543 秒）就是「還沒開始」的場合，我們不知道，所以不講
  assert.equal(warnEtaText(W, W + 281), '即將開始');
  assert.equal(warnEtaText(W, W + 600), '即將開始');
});

test('沒有 warnedAt 時退回「即將開始」，不得拿 now 當基準編一個區間', () => {
  assert.equal(warnEtaText(0, W), '即將開始');
  assert.equal(warnEtaText(undefined, W), '即將開始');
});

test('永遠不出現精確秒數（區間才是這一頁能負責的粒度）', () => {
  for (let d = 0; d <= 600; d += 7) {
    const s = warnEtaText(W, W + d);
    assert.doesNotMatch(s, /秒/, `t+${d}s 出現了秒級文字：${s}`);
    assert.match(s, /^(即將開始|約 \d+(–\d+)? 分鐘後開始)$/, `t+${d}s 格式異常：${s}`);
  }
});
