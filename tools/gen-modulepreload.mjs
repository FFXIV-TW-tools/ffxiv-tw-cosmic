#!/usr/bin/env node
// tools/gen-modulepreload.mjs — 由 app.js 的靜態 import 圖生成 index.html 的 modulepreload 區塊。
//
// 為什麼要有這支：ES module 的依賴只有在**父模組下載並解析完**才會被發現，所以 63 支 module
// 會排成 5 層瀑布逐層發射（實測 market：0→300→360→420→540ms）。modulepreload 讓瀏覽器在解析
// HTML 時就一次全部平行抓（實測同一批檔平行取回僅 150ms）。
//
// ⚠️ 為什麼是生成而不是手貼：63 條 <link> 手寫＝「同一份依賴清單的第二份複本」，漏一條的症狀
//    只是「慢一點」——無錯誤、無警告、build 全綠，正是這個 repo 家族反覆踩的零訊號漂移。
//    清單一律由這支從 import 圖推導，並由 tests/modulepreload-drift.test.mjs 機械比對。
//
// ⚠️ 動態 import() **刻意不納入**：它是條件載入，預載等於把「只有走到那條路才需要」的成本搬到
//    每次開頁。現況 market 沒有任何真正的動態 import（唯一的 `import(` 出現在 craft_costs.js:81
//    的 JSDoc 型別註解裡），所以這條目前不影響輸出——但日後有人加了條件載入時，規則要先在這裡。
//
// 用法：
//   node tools/gen-modulepreload.mjs           # 改寫 index.html
//   node tools/gen-modulepreload.mjs --check   # 只比對，不一致 exit 1（哨兵用）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ 這支與 tests/modulepreload-drift.test.mjs 是逐站複製的樣板，**各站只准差這一行**。
// 入口名由這裡 export 出去給測試用，不要在測試裡再寫一次（寫兩次＝副本間差兩處，抄的時候會漏）。
export const ENTRY = 'modules/app.js';
const HTML = path.join(ROOT, 'index.html');
const BEGIN = '  <!-- MODULEPRELOAD:BEGIN — 由 tools/gen-modulepreload.mjs 生成，勿手改 -->';
const END = '  <!-- MODULEPRELOAD:END -->';

// 只認相對 specifier。`from './x.js'` 同時涵蓋 import 與 re-export；動態 import() 沒有 from
// 子句故天然被排除。側效 import（`import './x.js'`）另外一條。
const FROM_RE = /\bfrom\s*['"](\.[^'"]+)['"]/g;
const SIDE_EFFECT_RE = /^[ \t]*import\s*['"](\.[^'"]+)['"]/gm;

// 只剝整行註解：既避免「被註解掉的 import 仍被預載」，又不會誤傷字串裡的 `https://`。
function stripLineComments(src) {
  return src.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, '');
}

export function computeGraph(entry = ENTRY) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    seen.add(rel);
    const src = stripLineComments(fs.readFileSync(abs, 'utf8'));
    for (const re of [FROM_RE, SIDE_EFFECT_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
      }
    }
  };
  walk(entry);
  // 入口本身已由 <script type="module" src="app.js"> 載入，預載它只會多一筆重複請求。
  seen.delete(entry);
  return [...seen].sort();
}

export function renderBlock(files) {
  return [BEGIN, ...files.map((f) => `  <link rel="modulepreload" href="${f}">`), END].join('\n');
}

function splice(html, block) {
  const i = html.indexOf(BEGIN);
  const j = html.indexOf(END);
  if (i === -1 || j === -1) throw new Error('index.html 找不到 MODULEPRELOAD 標記區塊');
  return html.slice(0, i) + block + html.slice(j + END.length);
}

export function currentHtmlBlock(html = fs.readFileSync(HTML, 'utf8')) {
  const i = html.indexOf(BEGIN);
  const j = html.indexOf(END);
  if (i === -1 || j === -1) return null;
  return html.slice(i, j + END.length);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = computeGraph();
  const block = renderBlock(files);
  const html = fs.readFileSync(HTML, 'utf8');
  if (process.argv.includes('--check')) {
    if (currentHtmlBlock(html) !== block) {
      console.error('✗ index.html 的 modulepreload 區塊與 import 圖不一致 — 跑 node tools/gen-modulepreload.mjs 重生成');
      process.exit(1);
    }
    console.log(`✓ modulepreload 區塊已同步（${files.length} 支）`);
  } else {
    fs.writeFileSync(HTML, splice(html, block));
    console.log(`✓ 已寫入 ${files.length} 條 modulepreload`);
  }
}
