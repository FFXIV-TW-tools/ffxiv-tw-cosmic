/**
 * 到「製作求解器」的深連結——把任務的需求物直接接上求解。
 *
 * ## 為什麼用 `?item=` 而不是 `?recipe=`
 * 本站的權威是「這個任務要交什麼物品」，配方 id 讓 crafter 自己解。實測不變量：
 * 400 個製作任務的需求物**全部**在 crafter 的配方表查得到（`recipes.json` 的 `item_id`），
 * 所以這條連結不會落空。反過來用 recipe id 會多一層本站要跟著維護的對照。
 *
 * ## 為什麼不帶目標品質
 * 三段品質門檻是**配方**的屬性（一般收藏品也有同型欄位），權威在 monorepo `game_ref.sqlite`
 * 的 `recipe_quality_stages`，換算實作只有 crafter 一份。本站塞絕對品質數字進去等於開第二條
 * 換算路徑，對面資料一更新就會靜默給出達不到門檻的手法。要預選階段就傳 `?stage=1|2|3`（序號），
 * 讓 crafter 自己換算。
 *
 * ## 中間素材
 * 128 個任務的 `recipes` 比需求物多——那些是中間素材（先做 A 再用 A 做 B）。本站只連到
 * **要交的成品**；中間素材在 crafter 的原料清單裡看得到，不在這裡重複列一次。
 */

const DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
// dev 路徑沿用 index.html 的 portal bootstrap 慣例（:8774 服務整個 external/ 目錄）
const BASE = DEV ? 'http://localhost:8774/ffxiv-crafter/' : 'https://crafter.xivtc.com/';

/** 跨工具共用同一個具名分頁（生態內互跳慣例，同 crafter → marketboard 的做法）。 */
const TARGET = 'ffxiv-crafter';

export function crafterUrl(itemId) {
  return `${BASE}?item=${encodeURIComponent(itemId)}`;
}

/**
 * 需求物欄的內容。製作類任務（`recipes` 非空）每個需求物都是連結，採集/釣魚類是純文字。
 * 回傳 DocumentFragment，呼叫端自己決定塞進哪個容器。
 */
/** 物品圖示（產生器從 client 解出來放同源 `img/items/`；CSP `img-src 'self'` 禁外連圖床）。 */
function itemIcon(it) {
  if (!it.icon) return null;      // 沒 icon 就不放，別用佔位圖假裝有
  const img = document.createElement('img');
  img.className = 'cos-itemico';
  img.src = `img/items/${String(it.icon).padStart(6, '0')}.png`;
  img.alt = '';                   // 名稱就在旁邊，alt 再唸一次是重複
  img.width = 20;
  img.height = 20;
  img.loading = 'lazy';
  return img;
}

/**
 * 數量。**沒有數量時印「×?」而不是省略、更不是補 ×1**。
 *
 * 40 筆任務（24 個緊急＋16 個雙職業）的需求物是由**配方產出**反推的（`viaRecipe`），
 * 而數量只存在於 `WKSMissionToDo`、配方那邊沒有任何數量欄；已知數量分布是 ×1…×48，
 * 沒有常數可套。省略會被讀成「一個」，補 ×1 更是直接給錯的備料量——兩種錯法都不會有訊號。
 */
function qtyMark(it) {
  const span = document.createElement('span');
  if (it.qty > 0) {
    span.textContent = ` ×${it.qty}`;
    return span;
  }
  span.className = 'cos-itemqty--unknown';
  span.textContent = ' ×?';
  span.title = '數量未知：這筆的需求物是從配方的產出反推的，而台服 client 的配方資料沒有數量欄。以遊戲內顯示為準。';
  return span;
}

export function requiredItems(mission) {
  const frag = document.createDocumentFragment();
  if (!mission.items?.length) {
    frag.append('—');
    return frag;
  }
  const craftable = (mission.recipes?.length ?? 0) > 0;
  mission.items.forEach((it, i) => {
    if (i > 0) frag.append(document.createElement('br'));
    // 有 icon 就一律放（採集物也有），連結與否才看是不是製作類
    const box = document.createElement(craftable ? 'a' : 'span');
    box.className = craftable ? 'cos-craftlink' : 'cos-itemline';
    const ico = itemIcon(it);
    if (ico) box.append(ico);
    box.append(document.createTextNode(it.name));
    box.append(qtyMark(it));
    if (craftable) {
      box.href = crafterUrl(it.itemId);
      box.target = TARGET;
      box.title = `到製作求解器算「${it.name}」的手法與巨集（另開分頁）`;
      // 可點要看得出來：底線之外再給一個明確的動作記號，不能只靠 hover 才發現
      const go = document.createElement('span');
      go.className = 'cos-craftlink__go';
      go.textContent = '⚒ 求解';
      box.append(go);
    }
    frag.append(box);
  });
  return frag;
}
