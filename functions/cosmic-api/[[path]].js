// functions/cosmic-api/[[path]].js — 緊急事件 API 同源代理（後端 PoP 修復）
//
// 樣板＝同 repo 的 `functions/settings-api/[[path]].js`（13 站一致），只換四處：
// 檔頭敘事／`UPSTREAM`／binding 變數名／路徑前綴。邏輯**刻意逐字相同**，
// 改一處就要問「另外那支要不要一起改」——不一致比不夠好更難查。
//
// 【要解決什麼】
// 本站後端 `ffxiv-tw-cosmic-api` 在 `*.workers.dev`，而該 hostname 解析到
// `104.21/172.67` 池 —— 那個池只到 SIN。實測（2026-08-03）同一支 Worker、
// 只換 client 解析到的 IP 池：`/health` SIN **780ms** → 同源代理 **240ms**。
// 通報頁每次進頁 `/state`、每次通報／附議都各付一次這個差額。
//
// 【為什麼是同源代理，不是把 API 換到 api.xivtc.com】
// 換 hostname 只拿到 KHH；同源還額外拿到兩件事：
//   ① 重用同一條連線 —— 省掉冷啟動的 DNS+TCP+TLS（實測 355ms）
//   ② 沒有 CORS preflight —— 少一次來回（本站的 POST 帶 JSON body，preflight 必發）
//
// 【為什麼是 service binding，不是 fetch() 到 workers.dev】
// 🔴 這是本檔最重要的一條，改壞了完全沒有訊號：
// `fetch('https://…workers.dev/…')` 會讓請求**重新入境 CF 網路**，於是上游收到的
// `CF-Connecting-IP` 是本 Function 所在 colo 的位址，不是使用者的。上游的 per-IP
// rate limit 因此變成**全站所有使用者共用一個配額**——而症狀是「偶爾有人被 429」，
// 查不到、也對不上任何一次改動。
//
// service binding（`env.COSMIC_API`）是**同機直呼**：不經過網路、不重新入境，
// 原始 request 的 method / headers / body 逐字送到上游 Worker 的 fetch handler。
// ⇒ **全方法開放**（GET/HEAD/PUT/DELETE/POST），代理不自建方法白名單：
//   ① `CF-Connecting-IP` 保留原值 —— per-IP rate limit 與冷卻判定語意不變
//   ② POST 的 JSON body 逐字穿透 —— 通報／附議不需要代理知道 schema
//
// 【綁定設定】Pages 專案 → Settings → Functions → Service bindings：
//   Variable name `COSMIC_API` → Worker `ffxiv-tw-cosmic-api`（Entrypoint default）
// ⚠️ **不做 fetch() URL fallback**：綁定缺席時回 503，不偷偷走那條會蓋掉 client IP 的路。
//    fallback 看起來像韌性，實際上是把上面那條紅線在無人察覺的情況下放回來。

// binding 之下 hostname 只是路由標記（實際不走 DNS），保留是為了讓人一眼看出代理的是誰，
// 也讓「這個站連到哪個後端」grep 得到。
const UPSTREAM = 'https://ffxiv-tw-cosmic-api.ffxiv-tw-tools.workers.dev';

/**
 * `/state` 的邊緣微快取秒數（2026-08-04 額度事故當天加）。
 *
 * 【為什麼】本站的輪詢在**這一跳被計兩次**（Pages Function 一次、service binding 打到
 * 上游 Worker 又一次）。當天 `ffxiv-tw-cosmic-api` 24h 打了 56k、帳號 100k/日的免費額度
 * 見底。前端已改成三檔輪詢（鐵則 §5），但**那救不了已經開著的分頁**——它們跑的是舊 JS，
 * 除非使用者重新載入。這一層是唯一能對**舊分頁立即生效**的槓桿。
 *
 * 【為什麼安全】`/state` 是**全域資料**：不含任何使用者專屬欄位（`reporter` 刻意不回），
 * 所以同一個 PoP 的所有人本來就該看到同一份。事件長 20 分鐘，20 秒的落後在畫面上
 * 是倒數少跳幾格，不改變任何判斷。
 *
 * 【邊界，勿放寬】
 *  - **只快取 GET `/state`**。`/history` 帶 query 變體多、命中率低；其餘全是寫入或帶 uuid。
 *  - 只快取 200。錯誤與 429 一律穿透，否則會把一次限流放大成整個 PoP 的限流。
 *  - 命中時**不呼叫上游** ⇒ 省的就是被計第二次的那一次。
 *  - 回給瀏覽器的 `Cache-Control` 仍是 `no-store`：這是**邊緣**快取，不是瀏覽器快取。
 *    瀏覽器端快取會讓「我剛通報完，重新整理卻看不到自己那筆」——那是會被當成 bug 的行為。
 */
const STATE_EDGE_TTL = 20;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const cacheable = request.method === 'GET' && url.pathname === '/cosmic-api/state';
  // key 只用 pathname：/state 不吃 query，帶不帶參數都是同一份資料。
  const cacheKey = new Request(url.origin + '/cosmic-api/state', { method: 'GET' });
  if (cacheable) {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('Cache-Control', 'no-store');       // 邊緣快取，不讓瀏覽器也存
      h.set('X-Edge-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers: h });
    }
  }

  if (!env || !env.COSMIC_API) {
    // 本機 dev（wrangler pages dev 未帶 binding）或忘了在 dashboard 綁 —— 明講，不降級。
    console.error('[cosmic-api proxy] 缺少 COSMIC_API service binding');
    return new Response(JSON.stringify({ error: 'binding_missing' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const target = UPSTREAM + url.pathname.replace(/^\/cosmic-api/, '') + url.search;
  // 用原 request 當第二引數：method / headers / body 逐字沿用（含 CF-Connecting-IP）。
  const req = new Request(target, request);
  // 上游有 Origin 白名單；同源代理要表明自己是哪個站（瀏覽器同源請求可能根本不帶 Origin）。
  req.headers.set('Origin', url.origin);

  // 這一跳的實測成本 —— 就是決定架構的那個數字（同機直呼 vs 又跨海一次）
  const t0 = Date.now();
  let res;
  try {
    res = await env.COSMIC_API.fetch(req);
  } catch (err) {
    // 不靜默吞：代理失敗要讓 client 分得出「後端掛了」與「代理掛了」
    console.error('[cosmic-api proxy] upstream fetch failed:', err && err.message);
    return new Response(JSON.stringify({ error: 'proxy_upstream_failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const hop = Date.now() - t0;

  const out = new Headers(res.headers);
  out.set('Server-Timing', `upstream;dur=${hop}`);

  if (cacheable && res.status === 200) {
    // 存進邊緣：這一份帶 s-maxage 給 CF 看；回給瀏覽器的另一份維持 no-store。
    const body = await res.arrayBuffer();
    const forEdge = new Headers(out);
    forEdge.set('Cache-Control', `public, s-maxage=${STATE_EDGE_TTL}`);
    context.waitUntil(caches.default.put(cacheKey, new Response(body, { status: 200, headers: forEdge })));

    out.set('Cache-Control', 'no-store');
    out.set('X-Edge-Cache', 'MISS');
    return new Response(body, { status: 200, headers: out });
  }

  out.set('Cache-Control', 'no-store');   // 即時事件狀態，瀏覽器端任何快取都不對
  return new Response(res.body, { status: res.status, headers: out });
}

export const __test = { UPSTREAM };
