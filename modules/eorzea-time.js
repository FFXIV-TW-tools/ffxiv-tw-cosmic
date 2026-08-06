/**
 * 艾歐澤亞時間與天氣週期的純計算層——**沒有 DOM、沒有資料表**，只有時間數學。
 *
 * 天氣是 unix 時間的純函數（SE 官方演算法），與伺服器、DC、實例都無關：
 * 全繁中服 7 個伺服器在同一秒看到的天氣完全相同，因此本站不需要「選伺服器」。
 *
 * ⚠️ DRY 註記：同一套雜湊也存在於 `ffxiv-tw-sightseeing/modules/weather.js`。
 * 那份把演算法與「手打的全區天氣機率表」綁在同一個檔，而本站的機率表是從台服 client
 * 直接產生（`data/weather.json`）——順帶發現該手打表的月夜峰那列是錯的（見 docs/BACKLOG.md B-001）。
 * 收斂到 portal 共用層需要動共用 API（Owner Gate1），故此處先各自實作、以 BACKLOG 追蹤。
 */

/** 天氣時段長度（秒）＝8 艾歐澤亞小時＝23 分 20 秒。 */
export const WEATHER_PERIOD = 1400;

/** 艾歐澤亞 1 小時 = 175 現實秒。 */
const ET_HOUR = 175;

/** 艾歐澤亞 1 天 = 24 ET 小時 = 4200 現實秒。 */
const ET_DAY = ET_HOUR * 24;

/**
 * 天氣種子（0–99）。SE 官方演算法：把「艾歐澤亞日數 × 100 ＋ 時段起點」丟進一個
 * 位移互斥或雜湊。落在哪個天氣由各區的機率表累加決定。
 *
 * 實作細節：JS 的位元運算是 32 位元有號數，`<<`／`^` 之後必須 `>>> 0` 轉回無號，
 * 否則負數會讓 `% 100` 取出負值。
 */
export function forecastTarget(unixSeconds) {
  const unix = Math.floor(unixSeconds);
  const bell = Math.floor(unix / ET_HOUR);
  // 每 8 ET 小時一個時段，取該時段的起始鐘點（0 / 8 / 16）
  const increment = (bell + 8 - (bell % 8)) % 24;
  const totalDays = Math.floor(unix / ET_DAY);

  const base = totalDays * 100 + increment;
  const step1 = ((base << 11) ^ base) >>> 0;
  const step2 = ((step1 >>> 8) ^ step1) >>> 0;
  return step2 % 100;
}

/** 該 unix 秒所屬天氣時段的起始 unix 秒。 */
export function periodStart(unixSeconds) {
  return Math.floor(unixSeconds / WEATHER_PERIOD) * WEATHER_PERIOD;
}

/** 該 unix 秒對應的艾歐澤亞時間（時、分）。 */
export function eorzeaClock(unixSeconds) {
  const etSeconds = Math.floor(unixSeconds / ET_HOUR * 3600);
  return {
    hour: Math.floor(etSeconds / 3600) % 24,
    minute: Math.floor(etSeconds / 60) % 60,
  };
}

/** 艾歐澤亞小時（含小數）——用來判斷是否落在某個 ET 時段條件內。 */
export function eorzeaHour(unixSeconds) {
  return (unixSeconds % ET_DAY) / ET_HOUR;
}

/**
 * ET 時段條件是否在該時刻成立。
 * 表中的區間都是 [start, end) 的 2 小時階梯（00-02、02-04…22-24），不跨日，故不必處理繞回。
 */
export function inEorzeaWindow(unixSeconds, start, end) {
  const h = eorzeaHour(unixSeconds);
  return h >= start && h < end;
}

/**
 * 下一次（含當前）「艾歐澤亞 ET 時段條件成立」的區間。
 * 正在窗內時回傳當前窗（呼叫端要的是「現在能不能做」，不是「下一輪」）。
 */
export function nextEorzeaWindow(unixSeconds, start, end) {
  const dayStart = Math.floor(unixSeconds / ET_DAY) * ET_DAY;
  let from = dayStart + start * ET_HOUR;
  const span = (end - start) * ET_HOUR;
  if (from + span <= unixSeconds) from += ET_DAY;
  return { start: from, end: from + span };
}

/** 艾歐澤亞一天的現實秒數——供呼叫端換算「多久輪一次」。 */
export const EORZEA_DAY = ET_DAY;

/** 把秒數格式化成「1 小時 23 分」／「45 秒」這種倒數文字。 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小時 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/**
 * 本地時間 HH:MM，**裸值不帶標記**。
 *
 * ⚠️ **散文裡不要直接用這支**，用下面的 `localClockText()`。這一頁同時存在兩種時鐘
 * ——現實時鐘與艾歐澤亞時鐘（ET）——而且**格式一模一樣**（`18:30`／`15:42`），
 * 頁首四格更是把兩者並排。裸值等於要使用者自己猜是哪一種（Owner 2026-08-06 指出）。
 *
 * 允許用裸值的**唯一情形**：欄位標題已經標明是哪種時鐘（天氣預報表的「本地時間」／「ET」兩欄）。
 * 這條判準由 `tests/clock-labelling.test.mjs` 機械守門——散文裡漏標的症狀是「畫面完全正常、
 * 只是有人看錯時間跑去等」，沒有任何錯誤訊號。
 */
export function clockText(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 現實時鐘的標記字。ET 那一側的對應標記是 `ET`（見 forecast-view 四格）。 */
export const LOCAL_TAG = '本地';

/** 散文用的本地時間：`本地 18:30`。與 ET 並排時一眼分得出是哪一種時鐘。 */
export function localClockText(unixSeconds) {
  return `${LOCAL_TAG} ${clockText(unixSeconds)}`;
}

/** 散文用的 ET：`ET 15:42`。跟 `localClockText()` 是同一組對照，兩邊要一起改。 */
export function etClockText(unixSeconds) {
  const et = eorzeaClock(unixSeconds);
  return `ET ${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`;
}

/** 本地日期 MM/DD（跨日時給時間軸標記用）。 */
export function dateText(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
