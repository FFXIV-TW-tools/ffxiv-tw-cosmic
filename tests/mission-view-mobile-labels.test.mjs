// tests/mission-view-mobile-labels.test.mjs — 任務清單「手機堆疊卡」的欄名互鎖。
//
// 為什麼需要哨兵：手機版把 10 欄表拆成逐任務卡（css/style.css §手機），那時候 thead 是隱藏的
// ⇒ 欄名**只能**來自 `mission-view.js` 逐格寫入的 `data-label`。拿掉它桌面完全看不出來
// （桌面有 thead），只有手機會退化成一串無名數字——本 repo 家族反覆踩的零回饋訊號形狀。
//
// 三條互為反向，缺一即退化：
//   ① JS 端有 `MV_COL_LABELS` 且長度 == thead 欄數 — 少一個就有一格沒有欄名
//   ② JS 端真的把它寫進每一格（`dataset.label`）— 只宣告常數不寫入＝畫面上沒有欄名
//   ③ CSS 端真的有 `attr(data-label)` 消費端 — 只寫入不顯示＝白寫

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(ROOT, 'modules', 'mission-view.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

export function run() {
  const m = js.match(/const MV_COL_LABELS = \[([^\]]+)\]/);
  assert.ok(m, '① mission-view.js 應有 MV_COL_LABELS 欄名常數（手機堆疊卡的欄名來源）');
  const labels = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  // thead 欄數以 #mv-table 那段 <thead> 為準
  const thead = html.split('id="mv-table"')[1].split('</thead>')[0];
  const thCount = (thead.match(/<th[ >]/g) || []).length;
  assert.strictEqual(labels.length, thCount,
    `① MV_COL_LABELS 應與 #mv-table 表頭欄數相同（實測 ${labels.length} vs ${thCount}）`);

  assert.ok(/cells\.forEach\([^)]*\)\s*=>\s*\{\s*c\.dataset\.label\s*=\s*MV_COL_LABELS\[i\]/.test(js),
    '② row() 必須把 MV_COL_LABELS 逐格寫進 dataset.label（只宣告常數不寫入＝畫面上沒有欄名）');

  assert.ok(/content:\s*attr\(data-label\)/.test(css),
    '③ css/style.css 必須有 attr(data-label) 消費端（只寫入不顯示＝白寫）');

  console.log(`mission-view-mobile-labels: 3 條互鎖通過（${labels.length} 欄）`);
}
