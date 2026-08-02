import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `test/logic.test.mjs` 是 node:test 的純函式測試（`pnpm test:logic`），
  // 不走 workers runtime——放進來只會用錯的 runner 跑錯的東西。
  test: { include: ['test/**/*.test.ts'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
});
