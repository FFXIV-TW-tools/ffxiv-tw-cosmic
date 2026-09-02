// functions/_middleware.js — 舊網址 301（B-048 交接頁 → 2026-09-02 改為 HTTP 301）
//
// 【複製到新站要改什麼】只有下面兩個常數：OLD_HOST 與 NEW_ORIGIN。其餘一字不動。
// 本檔在 13 站之間**正規化後必須逐字節相同**，所以連這段標題與註解都不得寫死站名或 Task 編號——
// 寫死的話每站都要記得改，而那正是漏抄的來源。
//
// 【做什麼】舊 `*.pages.dev` host 上的 HTML 導覽請求，一律回 **301** 到 `xivtc.com` 同路徑。
//
// 【為什麼從「200 交接頁／inline JS 跳轉」改回 301】（2026-09-02，GSC 實查）
// 搬網域一個月後，Google 對舊 host 的判定是：
//   · 上次檢索 2026-09-02，擷取成功、允許索引、**「Google 所選的標準網址＝受檢測網址」**
//   · 也就是 `<link rel="canonical">` 指向新網址被 Google 否決，舊 host 繼續當本尊，
//     搜尋結果站名顯示「Cloudflare」、新網域拿不到任何搜尋訊號。
// 根因：舊 host 對爬蟲回的是 200 ＋ 整頁內容。inline JS 的 `location.replace` 對真人有效，
// 但 Googlebot 渲染後沒把它當重導向（GSC 報「已編入索引」而非「網頁會重新導向」）。
// canonical 是建議、301 才是指令——搜尋引擎只認 HTTP 層。
//
// 【代價，Owner 已知】
// 301 在邊緣執行、早於任何 JS ⇒ 舊 origin 讀不到 `localStorage` 的 UUID，
// 還沒來過新站的舊書籤使用者不再自動帶雲端身份（到新站設定面板貼 UUID 即可接回）。
// 遷移一個月後這群人已很少；相對地 SEO 不收斂是每天在流失。
// 各 HTML `<head>` 第一支 inline 交接腳本**保留不動**——它是 `_routes.json` 未涵蓋路徑的退路，
// 且 13 站一致性哨兵以它為受檢對象。
//
// 【設計約束】
// - **冪等、無旗標**：每次進舊網址都重跑。
// - **不產生新 UUID**：沒有身份就不帶。這裡沒有資料要搬。
// - **`Cache-Control: no-store`**：改壞了要能立刻回滾；瀏覽器對 301 預設會永久快取，
//   沒這條的話一次錯誤部署會被使用者的瀏覽器記住。

const OLD_HOST = 'ffxiv-tw-cosmic.pages.dev';
const NEW_ORIGIN = 'https://cosmic.xivtc.com';

// 資料救援門：帶這個參數就完全不攔，直接把舊站原樣送出。
// 【為什麼需要】新網域＝新 origin ⇒ **存在瀏覽器裡的資料（巨集庫、配裝、清單）留在舊 origin**，
// 它們不像 UUID 能靠 cookie／URL 帶過去（localStorage 沒有任何跨 origin 共享機制）。
// 使用者要救資料就得回舊站用各工具自己的匯出功能。2026-08-04 由實際回報觸發。
// 【參數為什麼這麼短】它要能口頭或在公告裡一句話講完（「網址後面加 ?stay」）。只看參數在不在、
// 不看值，因為「還要記得等於 1」是救援指引最容易被講錯的地方。
// ⚠️ `?stay` 的頁面仍會跑 inline 交接腳本，該腳本同樣放行 `stay`（兩處同語意，handoff.test 守）。
const STAY_PARAM = 'stay';

// 攔截條件——**四個同時成立才攔**，任何一個不成立就 next()：
//   ① GET（POST／HEAD 等一律放行）
//   ② Accept 含 text/html（只攔「人在導覽」與爬蟲抓頁；資產與 fetch 一律放行——
//      舊 host 上被瀏覽器快取的舊 HTML 仍可能請求同源資產，301 到跨 origin 會被自己的 CSP 擋掉）
//   ③④ host 精確等於 production 舊 host
//       ⚠️ 用**字串全等**而非 endsWith('.pages.dev')：全等同時滿足 ③ 與 ④——
//          `<hash>.<OLD_HOST>`（CF preview 部署）天然不匹配而被放行。
//          攔了 preview 會讓預覽部署無法驗證；用 endsWith 還會在新網域哪天共用同一份程式碼時自我攔截成迴圈。
function shouldHandoff(request, url) {
  if (request.method !== 'GET') return false;
  if (!(request.headers.get('accept') || '').includes('text/html')) return false;
  if (url.searchParams.has(STAY_PARAM)) return false;   // 救援門，見上
  return url.hostname === OLD_HOST;
}

function handoffRedirect(url) {
  // server 端只組得出 pathname + search（hash 由瀏覽器自行帶過 301，不會送達伺服器）。
  // pathname／search 來自 WHATWG URL parser，已百分比編碼，放進 Location 不會有 CRLF 注入。
  const target = NEW_ORIGIN + url.pathname + url.search;
  return new Response(null, {
    status: 301,
    headers: {
      'Location': target,
      'Cache-Control': 'no-store',
      // 舊書籤的 query 可能帶 ftw_*（舊版交接留下的）⇒ 不得把它當 Referer 送給任何人
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (!shouldHandoff(context.request, url)) return context.next();
  return handoffRedirect(url);
}

// 測試用（Node）——`export` 的檔案在 CF 是 module worker，這裡只是讓測試拿得到純函式
export const __test = { shouldHandoff, handoffRedirect, OLD_HOST, NEW_ORIGIN };
