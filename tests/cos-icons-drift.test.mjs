import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.resolve(root, '../ffxiv-tw-tools-portal/tools/gen-site-icons.mjs');
if (!existsSync(generator)) {
  console.log('SKIP Cosmic 圖示漂移：CI 未提供 portal 正典');
} else {
  const run = spawnSync(process.execPath, [generator, '--config', 'tools/icons.config.json', '--check'],
    { cwd: root, encoding: 'utf8' });
  if (run.status === 2) console.log('SKIP Cosmic 圖示漂移：portal 正典不可用');
  else assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
}
