/**
 * 職業圖示。11 個 DoH/DoL 職名每個 3–4 個字，攤在表格欄與 chip 上會把版面撐爛
 * （Owner 2026-07-31：「職業名稱用 icon 替代就好了，不然太多字了很影響閱讀跟排版」）。
 *
 * 圖示是 generator 從 client 解出來放同源的 `img/jobs/<abbr>.png`——CSP `img-src 'self'`
 * 擋掉所有外連圖床，這也是當初要自己解 icon 的原因。
 *
 * **文字不能消失，只能換載體**：`alt` 給讀螢幕器與圖片載入失敗時、`title` 給滑鼠停留。
 * 圖示本身沒有語意，拿掉 alt 等於把職業欄變成空白。
 */
export function jobIcon(job, { size = 20, className = 'cos-jobicon' } = {}) {
  const img = document.createElement('img');
  img.className = className;
  img.src = `img/jobs/${job.abbr}.png`;
  img.alt = job.label;
  img.title = job.label;
  img.width = size;
  img.height = size;
  img.loading = 'lazy';
  return img;
}

/** 一格裡放多個職業圖示（雙職任務）。回傳 fragment 方便直接 append 進 td/button。 */
export function jobIcons(jobIds, jobs, opts) {
  const frag = document.createDocumentFragment();
  for (const id of jobIds) {
    const job = jobs[id];
    if (!job) {
      frag.append(document.createTextNode(`#${id}`));
      continue;
    }
    frag.append(jobIcon(job, opts));
  }
  return frag;
}
