#!/usr/bin/env node
// tests/handoff.test.mjs — 舊網址交接頁契約（B-048 Task 3）
//
// 【為什麼每個攔截條件都要有正負兩案例】
// B-047／B-048 兩輪外審抓到**同一類錯誤三次**：驗收方式與實際攔截條件對不上——
//   R1 C4：用 `curl -sI`（送 HEAD）去驗一個「只攔 GET」的 Function
//   R2-12：用預設 `Accept: */*` 去驗一個「要求 text/html」的 Function
//   Build 期：用 `/favorites.html` 去驗一個會 308 到 `/favorites` 的頁面
// 共同形狀是「憑印象寫驗證命令」。所以這裡把四個條件逐一釘死，每條都要有「不成立就必須放行」。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { __test } = await import(pathToFileURL(join(ROOT, 'functions', '_middleware.js')).href);
const { shouldHandoff, escAttr, handoffPage, OLD_HOST, NEW_ORIGIN } = __test;

let fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fail++; };

// ⚠️ `o.accept ?? 預設` 會把 null 當 nullish 而套回預設 ⇒「無 Accept」那格根本沒測到。
//    用 `in` 判斷是否顯式指定，null 表示**完全不帶這個 header**。
const req = (o = {}) => {
  const headers = {};
  if (!('accept' in o)) headers.accept = 'text/html,application/xhtml+xml';
  else if (o.accept !== null) headers.accept = o.accept;
  return new Request(o.url || `https://${OLD_HOST}/`, { method: o.method || 'GET', headers });
};
const hit = (o = {}) => shouldHandoff(req(o), new URL(o.url || `https://${OLD_HOST}/`));

// ── ① 條件齊全時攔截 ──
ok(hit() === true, '四條件齊全 → 攔截');

// ── ② 逐一破壞單一條件，都必須放行 ──
ok(hit({ method: 'POST' }) === false, '① 非 GET → 放行（POST）');
ok(hit({ method: 'HEAD' }) === false, '① HEAD → 放行（前閘 R1 C4：用 -sI 驗會驗到這條）');
ok(hit({ accept: '*/*' }) === false, '② Accept: */* → 放行（前閘 R2-12：curl 預設就是這個）');
ok(hit({ accept: 'text/css' }) === false, '② 資產請求 → 放行');
ok(hit({ accept: null }) === false, '② 無 Accept header → 放行');
ok(hit({ url: `https://abc123.${OLD_HOST}/` }) === false,
  '③④ CF preview 子網域 → 放行（攔了會讓預覽部署無法驗證）');
ok(hit({ url: `${NEW_ORIGIN}/` }) === false,
  '③④ 新網域 → 放行（否則自我攔截成無窮迴圈）');
ok(hit({ url: `https://evil-${OLD_HOST}/` }) === false, '③④ 前綴混淆 → 放行（不攔＝不是我們的站）');
ok(hit({ url: `https://${OLD_HOST}.attacker.net/` }) === false, '③④ 後綴混淆 → 放行');

// ── ③ 回應標頭與內容 ──
const res = handoffPage(new URL(`https://${OLD_HOST}/?a=1`));
const h = res.headers;
ok(h.get('cache-control') === 'no-store', 'no-store（改壞了要能立刻回滾，不留快取殘留）');
ok(h.get('referrer-policy') === 'no-referrer', 'no-referrer（UUID 會進 URL）');
const csp = h.get('content-security-policy') || '';
ok(/script-src 'nonce-[A-Za-z0-9]{8,}'/.test(csp), 'CSP 用 nonce 而非 unsafe-inline');
ok(!csp.includes('connect-src'), '無 connect-src —— 交接頁不發任何網路請求（搬運已於範圍收斂時移除）');

const body = await res.text();
// ⚠️ 由 NEW_ORIGIN 推導，不得寫死主機名 —— 本檔是 13 站逐站複製的樣板（plan Task 4 Step 1：
//    「每站只換兩個常數」），寫死的話每站都要記得改測試，而那正是漏抄的來源。
ok(body.includes(`<link rel="canonical" href="${NEW_ORIGIN}/?a=1">`),
  'canonical 逐路徑指向新網址（本 Function 一上線，靜態 canonical 就不再出現 ⇒ SEO 收斂靠這條）');
ok(!body.includes('ftw_uuid=') , 'canonical 與 noscript 連結不含 ftw_*（身份不進 SEO 訊號）');
ok(body.includes('<noscript>') && body.includes(`href="${NEW_ORIGIN}/?a=1"`),
  'noscript 連結由 server 組出 pathname+search（不是只連首頁）');

// nonce 每次不同
const n1 = (handoffPage(new URL(`https://${OLD_HOST}/`)).headers.get('content-security-policy') || '').match(/nonce-([A-Za-z0-9]+)/)[1];
const n2 = (handoffPage(new URL(`https://${OLD_HOST}/`)).headers.get('content-security-policy') || '').match(/nonce-([A-Za-z0-9]+)/)[1];
ok(n1 !== n2, 'nonce 每個 response 重新產生（固定 nonce 等同 unsafe-inline）');

// ── ④ 惡意 query／path 的跳脫 ──
ok(escAttr('"><script>alert(1)</script>') === '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
  'escAttr: 引號與角括號都跳脫');
const evil = await handoffPage(new URL(`https://${OLD_HOST}/?q=%22%3E%3Cscript%3E`)).text();
ok(!evil.includes('"><script>'), '惡意 query 不會原樣進 href（前閘 R2-18）');

// ── ⑤ inline script 的關鍵不變量（source ratchet）──
ok(body.includes("p.set('ftw_uuid_t'"),
  '必帶 ftw_uuid_t —— 省略會讓帶入身份在 decideAdopt 裡變成最弱檔（前閘 R2-13）');
ok(!body.includes('ftw_link'.concat("',")) && !/p\.set\('ftw_link'/.test(body),
  '不得附加 ftw_link=1（那是 QR/邀請語意＝凌駕資料保護，交接不是那個語意）');
ok(/forEach\(function\(k\)\{p\.delete\(k\);\}\)/.test(body),
  '先 delete 再 set —— 直接 append 的話 URLSearchParams.get() 只取第一個值，舊參數會勝出（前閘 R1 C12）');
ok(body.includes('location.replace('), '用 replace 不用 assign（避免返回鍵陷阱）');
ok(!/setTimeout|await |\.then\(/.test(body.split('<noscript>')[0]),
  '零延遲：跳轉路徑上不得有 setTimeout／await（Owner：要讓使用者感受不到）');

// ── ⑥ _routes.json ≡ route manifest ──
const routes = JSON.parse(readFileSync(join(ROOT, '_routes.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'tests', 'route-manifest.json'), 'utf8'));
ok(JSON.stringify(routes.include) === JSON.stringify(manifest.paths),
  '_routes.json 的 include ≡ route-manifest.json 的 paths');
ok(!routes.include.includes('/*'),
  'include 不得用 /* —— 那會讓每個資產請求都變成一次 Functions invocation');

// ── ⑦ 部署面：functions 與 _routes.json 必須在允許清單內 ──
const allow = readFileSync(join(ROOT, 'deploy-allow.txt'), 'utf8').split('\n').map((s) => s.trim());
ok(allow.includes('functions'), 'deploy-allow.txt 含 functions（fail-closed：漏了 build 直接失敗）');
ok(allow.includes('_routes.json'), 'deploy-allow.txt 含 _routes.json');

console.log(fail ? `\n✗ ${fail} 項失敗` : `\n✓ handoff: 全綠`);
process.exit(fail ? 1 : 0);
