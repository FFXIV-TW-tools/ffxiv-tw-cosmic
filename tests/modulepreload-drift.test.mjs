// tests/modulepreload-drift.test.mjs — index.html 的 modulepreload 區塊 ≡ app.js 的靜態 import 圖。
//
// 為什麼需要哨兵：這 67 條 <link> 是「依賴清單的第二份複本」。漂掉的症狀是**開頁慢一點**——
// 沒有錯誤、沒有警告、畫面完全正常、build 全綠，是這個 repo 家族反覆踩的零回饋訊號形狀。
// 新增／刪除 module 而忘了重生成，只會靜默地把那支檔退回瀑布尾端。
//
// 三條刻意互為反向，缺一即退化：
//   ① 集合雙向相等 — 只驗「HTML 裡的都在圖裡」擋不住漏列，而漏列正是加新 module 時最可能發生的
//   ② 入口 app.js 不得出現在清單裡 — 它已由 <script type="module"> 載入，預載＝多一筆重複請求
//   ③ 每個 href 對應的檔案必須真的存在 — 預載不存在的路徑瀏覽器不會報錯，只是白花一次請求

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeGraph, renderBlock, currentHtmlBlock, ENTRY } from '../tools/gen-modulepreload.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const block = currentHtmlBlock(html);
assert.ok(block, 'index.html 找不到 MODULEPRELOAD 標記區塊（被刪掉了？）');

const inHtml = [...block.matchAll(/rel="modulepreload"\s+href="([^"]+)"/g)].map((m) => m[1]);
const graph = computeGraph();

// ① 雙向相等
const missing = graph.filter((f) => !inHtml.includes(f));
const extra = inHtml.filter((f) => !graph.includes(f));
assert.deepStrictEqual(
  { missing, extra },
  { missing: [], extra: [] },
  'modulepreload 區塊與 import 圖不一致 — 跑 node tools/gen-modulepreload.mjs 重生成'
);

// ② 入口不得自我預載（入口名從生成器取，逐站複製時只有生成器那一行要改）
assert.ok(!inHtml.includes(ENTRY), `${ENTRY} 已由 <script type="module"> 載入，不該再預載`);

// ③ 路徑必須真的存在
for (const f of inHtml) {
  assert.ok(fs.existsSync(path.join(ROOT, f)), `modulepreload 指向不存在的檔案：${f}`);
}

// ④ 生成器輸出必須與 HTML 現況逐字節相同（擋「手改了區塊但格式對不上生成器」）
assert.strictEqual(block, renderBlock(graph), '區塊內容與生成器輸出不同 — 勿手改，跑生成器');

console.log(`✓ modulepreload 區塊與 import 圖一致（${graph.length} 支）`);
