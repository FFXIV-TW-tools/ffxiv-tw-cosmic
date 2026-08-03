// functions/settings-api/[[path]].js — 設定 API 同源代理（後端 PoP 修復，第一站試點）
//
// 【要解決什麼】
// 共用設定後端在 `*.workers.dev`，而該 hostname 解析到 `104.21/172.67` 池 —— 那個池只到 SIN。
// 實測（2026-08-03）同一支 Worker、只換 client 解析到的 IP 池：
//   /health              SIN 780ms  →  KHH  34ms
//   /u/:uuid/:docId(DO)  SIN 1250ms →  KHH 120ms
// 前端切到 KHH 之後，後端就成了唯一瓶頸：market.xivtc.com 首載 1681ms，
// 其中 settings API 單獨吃掉 1258ms。
//
// 【為什麼是同源代理，不是把 API 換到 api.xivtc.com】
// 換 hostname 只拿到 KHH；同源還額外拿到兩件事：
//   ① 重用同一條連線 —— 省掉冷啟動的 DNS+TCP+TLS（實測 355ms）
//   ② 沒有 CORS preflight —— 少一次來回
//
// 【為什麼是 service binding，不是 fetch() 到 workers.dev】
// 🔴 這是本檔最重要的一條，改壞了完全沒有訊號：
// `fetch('https://…workers.dev/…')` 會讓請求**重新入境 CF 網路**，於是上游收到的
// `CF-Connecting-IP` 是本 Function 所在 colo 的位址，不是使用者的。上游的 per-IP
// rate limit（GET 120/60s、PUT 60/60s）因此變成**全站所有使用者共用一個配額**——
// 而症狀是「偶爾有人被 429」，查不到、也對不上任何一次改動。
//
// service binding（`env.SETTINGS_API`）是**同機直呼**：不經過網路、不重新入境，
// 原始 request 的 method / headers / body 逐字送到上游 Worker 的 fetch handler。
// ⇒ 檔頭原本列的兩個未解問題就此消解，所以**全方法開放**（GET/HEAD/PUT/DELETE/POST）：
//   ① `CF-Connecting-IP` 保留原值 —— per-IP rate limit 語意不變
//   ② `If-Match` / `ETag` 樂觀鎖逐字穿透 —— 不會退化成靜默覆蓋
//
// 【綁定設定】Pages 專案 → Settings → Functions → Service bindings：
//   Variable name `SETTINGS_API` → Worker `ffxiv-tw-tools-settings-api`（Entrypoint default）
// ⚠️ **不做 fetch() URL fallback**：綁定缺席時回 503，不偷偷走那條會蓋掉 client IP 的路。
//    fallback 看起來像韌性，實際上是把上面那條紅線在無人察覺的情況下放回來。

// binding 之下 hostname 只是路由標記（實際不走 DNS），保留是為了讓人一眼看出代理的是誰，
// 也讓「這個站連到哪個後端」grep 得到。
const UPSTREAM = 'https://ffxiv-tw-tools-settings-api.ffxiv-tw-tools.workers.dev';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env || !env.SETTINGS_API) {
    // 本機 dev（wrangler pages dev 未帶 binding）或忘了在 dashboard 綁 —— 明講，不降級。
    console.error('[settings-api proxy] 缺少 SETTINGS_API service binding');
    return new Response(JSON.stringify({ error: 'binding_missing' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const target = UPSTREAM + url.pathname.replace(/^\/settings-api/, '') + url.search;
  // 用原 request 當第二引數：method / headers / body 逐字沿用（含 CF-Connecting-IP、If-Match）。
  const req = new Request(target, request);
  // 上游有 Origin 白名單；同源代理要表明自己是哪個站（瀏覽器同源請求可能根本不帶 Origin）。
  req.headers.set('Origin', url.origin);

  // 這一跳的實測成本 —— 就是決定架構的那個數字（同機直呼 vs 又跨海一次）
  const t0 = Date.now();
  let res;
  try {
    res = await env.SETTINGS_API.fetch(req);
  } catch (err) {
    // 不靜默吞：代理失敗要讓 client 分得出「後端掛了」與「代理掛了」
    console.error('[settings-api proxy] upstream fetch failed:', err && err.message);
    return new Response(JSON.stringify({ error: 'proxy_upstream_failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const hop = Date.now() - t0;

  const out = new Headers(res.headers);
  out.set('Server-Timing', `upstream;dur=${hop}`);
  out.set('Cache-Control', 'no-store');   // 使用者資料，任何快取都不對
  return new Response(res.body, { status: res.status, headers: out });
}

export const __test = { UPSTREAM };
