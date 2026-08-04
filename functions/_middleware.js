// functions/_middleware.js — 舊網址交接頁（B-048）
//
// 【複製到新站要改什麼】只有下面兩個常數：OLD_HOST 與 NEW_ORIGIN。其餘一字不動。
// 本檔在 13 站之間**正規化後必須逐字節相同**（`tools/check-handoff-consistency.js` 守），
// 所以連這段標題與註解都不得寫死站名或 Task 編號——寫死的話每站都要記得改，而那正是漏抄的來源。
//
// 【做什麼】把還用舊 `*.pages.dev` 書籤進來的人，連同他的跨工具身份一起送到 `xivtc.com`。
//
// 【為什麼要有這支，而不是用 301】
// 301 在**邊緣執行、早於任何 JS** ⇒ 舊 origin 完全沒有機會讀到 `localStorage` 裡的 UUID。
// 純 301 會讓使用者靜默失去雲端身份（設定、貓小胖、跨工具偏好全部對不回去）。
// 所以必須是「回一頁極簡 HTML、由 client 讀 LS 後自行組目標 URL」——
// 這也是為什麼目標 URL **不能**在 server 端組完就送：`#fragment` 永遠不會送到伺服器。
//
// 【為什麼是 Functions 而不是在頁面裡塞一段 JS】
// ① 舊站自己的 JS 一行都不會執行（否則像 mit-planner 會先自動連上房間才跳走）
// ② 這個回應的 `Referrer-Policy: no-referrer` 由我們控制（UUID 會出現在 URL）
// ③ portal CDN 掛掉也照常運作
//
// 【設計約束】
// - **冪等、無旗標**：每次進舊網址都重跑。刻意不設「已交接」記號——成功只有新 origin 知道，
//   而新 origin 不能替 `pages.dev` 設 cookie（PSL），所以那個旗標沒有可靠的成功確認路徑。
// - **零可見、瞬間跳轉**（Owner 2026-08-03）。「網址搬家了」的告知放在**新站**，不放這裡。
// - **不產生新 UUID**：沒有身份就不帶。這裡沒有資料要搬，造一個身份沒有意義。

const OLD_HOST = 'ffxiv-tw-cosmic.pages.dev';
const NEW_ORIGIN = 'https://cosmic.xivtc.com';

// 與 settings-client.js 同一套規則，不另立第二份判準
const UUID_KEY = 'ffxiv-tools-settings-uuid';
const LINKEDAT_KEY = 'ffxiv-tools-settings-uuid-linkedat';
const FTW_PARAMS = ['ftw_uuid', 'ftw_uuid_t', 'ftw_link'];

// 資料救援門：帶這個參數就完全不攔，直接把舊站原樣送出。
// 【為什麼需要】新網域＝新 origin ⇒ **存在瀏覽器裡的資料（巨集庫、配裝、清單）留在舊 origin**，
// 它們不像 UUID 能靠 cookie／URL 帶過去（localStorage 沒有任何跨 origin 共享機制）。
// 使用者要救資料就得回舊站用各工具自己的匯出功能，但交接頁一上線，舊站首頁再也進不去 ——
// 於是「資料還在、只是拿不到」，而使用者看到的是「東西不見了」。2026-08-04 由實際回報觸發。
// 【為什麼不是靠未列入 _routes.json 的路徑】那是 CF Pages「未知路徑回 index.html」的副作用，
// 不是我們宣告的行為：哪天 CF 改掉就靜默失效，而且無法寫進公告當正式指引。
const STAY_PARAM = 'ftw_stay';

// 攔截條件——**四個同時成立才攔**，任何一個不成立就 next()：
//   ① GET（POST／HEAD 等一律放行）
//   ② Accept 含 text/html（只攔「人在導覽」，資產與 fetch 一律放行）
//   ③④ host 精確等於 production 舊 host
//       ⚠️ 用**字串全等**而非 endsWith('.pages.dev')：全等同時滿足 ③ 與 ④——
//          `<hash>.<OLD_HOST>`（CF preview 部署）天然不匹配而被放行。
//          攔了 preview 會讓預覽部署無法驗證；用 endsWith 還會在新網域哪天共用同一份程式碼時自我攔截成迴圈。
function shouldHandoff(request, url) {
  if (request.method !== 'GET') return false;
  if (!(request.headers.get('accept') || '').includes('text/html')) return false;
  if (url.searchParams.get(STAY_PARAM) === '1') return false;   // 救援門，見上
  return url.hostname === OLD_HOST;
}

// HTML attribute context 的跳脫。pathname／search 直接來自 request，
// 不跳脫就是把使用者可控字串塞進 href（前閘 R2-18）。
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 每個 response 都要新的、不可預測的 nonce——固定或可預測的 nonce 等同 'unsafe-inline'
function makeNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[^A-Za-z0-9]/g, '');
}

function handoffPage(url) {
  const nonce = makeNonce();
  // server 端只組得出 pathname + search（hash 永遠不會送達伺服器）
  const target = NEW_ORIGIN + url.pathname + url.search;
  // canonical 指向新網址（不含 ftw_*）。
  // ⚠️ 這條是 SEO 收斂的**唯一訊號**：本 middleware 一上線，舊 host 的靜態 canonical
  //    就再也不會出現，所以必須在這裡自己補回來。
  const canonical = escAttr(target);
  const script = `(function(){
try{
  var u=new URL(${JSON.stringify(target)});
  u.hash=location.hash;                      // hash 只有 client 拿得到
  var p=u.searchParams;
  ${JSON.stringify(FTW_PARAMS)}.forEach(function(k){p.delete(k);});   // 先清再設：直接 append 的話 URLSearchParams.get() 只取第一個值，舊書籤或刻意構造的參數會勝出
  var id=null;
  try{id=localStorage.getItem(${JSON.stringify(UUID_KEY)});}catch(e){}
  if(id&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)){
    p.set('ftw_uuid',id.toLowerCase());
    var t=0;
    try{
      var raw=parseInt(localStorage.getItem(${JSON.stringify(LINKEDAT_KEY)}),10);
      // 上界同 settings-client 的 withinClockBound：未來時間戳會讓該身份永遠勝過真實時間戳
      if(isFinite(raw)&&raw>0&&raw<=Date.now()+300000)t=raw;
    }catch(e){}
    p.set('ftw_uuid_t',String(t));           // 必帶：省略會讓帶入身份在 decideAdopt 裡變成最弱檔
  }
  location.replace(u.toString());            // replace 不用 assign：否則返回鍵會跳回舊站再跳一次
}catch(e){location.replace(${JSON.stringify(target)});}
})();`;
  return new Response(`<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8">
<link rel="canonical" href="${canonical}">
<title>前往新網址…</title>
<script nonce="${nonce}">${script}</script>
</head><body>
<noscript><p>本站已搬遷至新網址。你的瀏覽器停用了 JavaScript，跨工具身份無法自動帶過去（到新站的設定面板貼上原本的 UUID 即可接回）。</p>
<p><a href="${canonical}">前往 ${canonical}</a></p></noscript>
</body></html>`, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 改壞了要能立刻回滾——有快取的話舊版會繼續送給使用者
      'Cache-Control': 'no-store',
      // UUID 會進 URL ⇒ 不得把它當 Referer 送給任何人
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
    },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (!shouldHandoff(context.request, url)) return context.next();
  return handoffPage(url);
}

// 測試用（Node）——`export` 的檔案在 CF 是 module worker，這裡只是讓測試拿得到純函式
export const __test = { shouldHandoff, escAttr, handoffPage, OLD_HOST, NEW_ORIGIN };
