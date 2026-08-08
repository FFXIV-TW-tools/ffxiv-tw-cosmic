/**
 * 錯誤碼 ↔ 中文訊息的涵蓋率哨兵（2026-08-08 健檢 resilience/R2）。
 *
 * 後端有兩種失敗形狀：HTTP 層驗證回 `{error: 'code'}`、Durable Object 的判斷回
 * `{reason: 'code'}`，而 `index.js` 把 DO 的回傳原封不動往外送。前端原本只讀 `error`，
 * 於是 `MESSAGES` 表裡一半的條目**永遠不會被用到**，全部退化成「請稍後再試」——
 * 而 cooldown／not_reporter／has_confirms 這些情境重試永遠不會成功。
 *
 * 症狀是**畫面上有訊息、只是講錯了**：沒有錯誤、沒有警告、測試全綠。故需哨兵。
 *
 * 判準：後端吐得出來的每一個錯誤碼，前端都要有對應的中文訊息。
 * 新增錯誤碼卻忘了配訊息 → 這條紅。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 前端訊息表的鍵集合（從原始碼解析，不 import——那支模組吃瀏覽器全域）。 */
function frontendCodes() {
  const src = readFileSync(join(ROOT, 'modules', 'emergency-api.js'), 'utf8');
  const block = src.slice(src.indexOf('const MESSAGES = {'), src.indexOf('export function messageFor'));
  return new Set([...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]));
}

/** 後端吐得出來的錯誤碼（`error:` 與 `reason:` 兩種形狀都算）。 */
function backendCodes() {
  const out = new Set();
  for (const f of ['index.js', 'events-do.js', 'logic.js']) {
    const src = readFileSync(join(ROOT, 'worker', 'src', f), 'utf8');
    for (const m of src.matchAll(/\b(?:error|reason):\s*'([a-z_]+)'/g)) out.add(m[1]);
  }
  return out;
}

/**
 * 玩家的瀏覽器打不到的碼（管理端 / 插件端 / 協定層）——不需要面向玩家的中文訊息。
 * **逐一列舉而不是整類豁免**（例如不寫「凡 bad_ 開頭都跳過」）：漏配訊息的新碼仍要紅。
 */
const NOT_USER_FACING = new Set([
  // 管理端（`/admin/*`，需 Bearer token）
  'bad_group', 'kind_mismatch', 'unauthorized', 'bad_event', 'bad_start',
  // 插件端（需 X-Plugin-Token）——這些碼只會回給插件，玩家的瀏覽器打不到
  'bad_token', 'bad_phase', 'bad_weather', 'not_configured_plugin',
  // 協定層：前端不可能送錯（送錯是本站自己的 bug，訊息幫不上使用者）
  'method', 'bad_json', 'bad_body',
]);

test('後端每個錯誤碼都有對應的中文訊息', () => {
  const front = frontendCodes();
  const back = backendCodes();
  const missing = [...back].filter((c) => !front.has(c) && !NOT_USER_FACING.has(c)).sort();
  assert.deepEqual(missing, [],
    `這些後端錯誤碼沒有中文訊息，使用者只會看到「請稍後再試」：${missing.join(', ')}`);
});

test('前端解析錯誤碼時 error 與 reason 兩種形狀都要讀', () => {
  const src = readFileSync(join(ROOT, 'modules', 'emergency-api.js'), 'utf8');
  assert.match(src, /data\?\.error\s*\?\?\s*data\?\.reason/,
    'call() 只讀其中一種的話，另一種形狀的失敗會全部退化成通用訊息');
});
