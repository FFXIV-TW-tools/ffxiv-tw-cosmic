/**
 * 渴望灣天氣預報——把 `data/weather.json`（台服 client 產生的機率表）套上時間演算法。
 * 純資料轉換，不碰 DOM。
 */

import { WEATHER_PERIOD, forecastTarget, periodStart } from './eorzea-time.js';

/**
 * 建一個綁定某區機率表的預報器。
 * @param {{table: {id:number,name:string,rate:number}[]}} weatherData
 */
export function createForecaster(weatherData) {
  const table = weatherData.table;
  // 累積上界：seed < cumulative[i] 即命中第 i 個天氣。與遊戲的判定順序一致。
  const cumulative = [];
  let acc = 0;
  for (const w of table) {
    acc += w.rate;
    cumulative.push(acc);
  }

  /** 指定時刻的天氣。 */
  function weatherAt(unixSeconds) {
    const seed = forecastTarget(unixSeconds);
    for (let i = 0; i < cumulative.length; i++) {
      if (seed < cumulative[i]) return table[i];
    }
    return table[table.length - 1];
  }

  /**
   * 從 `from` 起連續 `count` 個時段。回傳的每筆都對齊時段起點。
   */
  function forecast(from, count) {
    const start = periodStart(from);
    const out = [];
    for (let i = 0; i < count; i++) {
      const at = start + i * WEATHER_PERIOD;
      out.push({ start: at, end: at + WEATHER_PERIOD, weather: weatherAt(at) });
    }
    return out;
  }

  /**
   * 下一個（含當前）指定天氣的時段。
   * @param {number} from unix 秒
   * @param {number} weatherId
   * @param {number} maxPeriods 掃描上限；掃不到回 null（呼叫端不可當 0 處理）
   */
  function nextWeather(from, weatherId, maxPeriods = 400) {
    const start = periodStart(from);
    for (let i = 0; i < maxPeriods; i++) {
      const at = start + i * WEATHER_PERIOD;
      if (weatherAt(at).id === weatherId) {
        return { start: at, end: at + WEATHER_PERIOD, periodsAway: i };
      }
    }
    return null;
  }

  return { table, periodSeconds: WEATHER_PERIOD, weatherAt, forecast, nextWeather };
}

/**
 * 單一條件在指定時刻是否成立。
 * @returns {boolean|null} null ＝條件語意未定（台服 client 該列是空的），無法判斷
 */
function singleConditionMet(cond, unixSeconds, forecaster, inEorzeaWindow) {
  if (!cond || cond.type === 'none') return true;
  if (cond.type === 'weather') return forecaster.weatherAt(unixSeconds).id === cond.weatherId;
  if (cond.type === 'time') return inEorzeaWindow(unixSeconds, cond.start, cond.end);
  return null;
}

/**
 * 任務的條件是否成立。**每個任務最多一個條件**（client 的 c15），所以沒有組合邏輯。
 *
 * **這條之所以曾經那麼難搞，是因為前提就是錯的**：原本以為 c14 與 c15 都是條件槽，
 * 於是花了整整四輪在「AND 還是 OR」之間來回翻案。真相是 **c14 根本不是條件欄**——
 * 由 ICE fork 內建的手工對照表 `SinusMapV2` 交叉驗證（ET 部分 22/22 全對到 c15，
 * 零筆對到 c14），加上分布形狀與 Owner 的實測三方一致。證據鏈見
 * `tools/cosmic-dump/TcCosmicSheets.cs` 的 `Condition`。
 *
 * 教訓：**組合邏輯翻案四次，全都是在錯誤前提上做推理**。當一個模型需要反覆特例化才能
 * 兜住觀察，該懷疑的是輸入欄位選錯了，而不是繼續調規則。
 *
 * @returns {boolean|null} null ＝條件語意未定（台服 client 那幾列是空的）
 */
export function conditionsMet(condIds, conditions, unixSeconds, forecaster, inEorzeaWindow) {
  if (!condIds || condIds.length === 0) return true;
  let unknown = false;
  for (const id of condIds) {
    const r = singleConditionMet(conditions[id], unixSeconds, forecaster, inEorzeaWindow);
    if (r === false) return false;
    if (r === null) unknown = true;
  }
  return unknown ? null : true;
}
