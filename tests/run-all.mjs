// tests/run-all.mjs — 一鍵跑全部測試：node tests/run-all.mjs（任一 fail → exit 1）
// 發佈前驗證入口（取代逐檔記得 node tests/xxx）。新增測試放 tests/*.test.{js,mjs} 即自動納入。
// 每個測試檔各起獨立 node 子行程（避免 global 瀏覽器 stub 互相污染）。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => /\.test\.(js|mjs)$/.test(f)).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`✗ ${f} FAILED (exit ${r.status})`); }
}
console.log(`\n${files.length - failed}/${files.length} 測試檔通過`);
process.exit(failed ? 1 : 0);
