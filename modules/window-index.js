/**
 * 「限時視窗」索引——把任務依開放條件聚成視窗，並算出每個視窗的開闔時間。純邏輯、無 DOM。
 *
 * 為什麼要有這層：544 個任務裡 392 個沒有時段／天候閘，真正需要盯時間的只有 152 個。
 * 建議與時間軸都只該圍繞這 152 個轉，其餘用「獎勵排序」即可，不需要預測。
 *
 * 一個任務可以同時屬於兩個視窗（c14/c15 兩個槽），而兩槽是 **AND** ——
 * 兩個視窗都開著才會出現，證據鏈見 weather-forecast.js 的 conditionsMet。
 */

import { EORZEA_DAY, inEorzeaWindow, nextEorzeaWindow } from './eorzea-time.js';

/**
 * @param {object} conditions data/missions.json 的 conditions
 * @param {object[]} missions
 * @param {object} forecaster createForecaster() 的回傳
 * @returns {object[]} 每個非「無條件」視窗一筆，含任務、職業與開闔計算
 */
export function buildWindows(conditions, missions, forecaster) {
  // 一個任務可以有**兩個**條件（client 的 c14/c15 兩個槽）⇒ 會同時屬於兩個視窗
  const grouped = new Map();
  for (const m of missions) {
    for (const cid of m.conds ?? []) {
      const cond = conditions[cid];
      if (!cond || cond.type === 'none') continue;
      if (!grouped.has(cid)) grouped.set(cid, []);
      grouped.get(cid).push(m);
    }
  }

  const out = [];
  for (const [condId, list] of grouped) {
    const cond = conditions[condId];
    const jobs = [...new Set(list.flatMap((m) => m.jobs))].sort((a, b) => a - b);
    out.push({
      condId: Number(condId),
      type: cond.type,
      label: cond.label,
      missions: list,
      jobs,
      criticalCount: list.filter((m) => m.critical).length,

      /**
       * 這個視窗的時間解讀有沒有獨立證據。**兩種都有了**（2026-07-31）。
       *  · weather：條件表的天氣 id（49 靈風／148 月塵）2/2 命中渴望灣天氣表裡的兩個
       *    非「晴朗」天氣，而天氣演算法本身已用中薩納蘭／摩杜納回推驗證過。
       *  · time：原本標未驗證——12 列的 (start,end) 剛好等於 2(N-1),2N，值完全由列號決定、
       *    跟「ET 小時」相容也跟任何 2 級距的東西相容，唯一依據是上游的欄位命名。
       *    現已由 Owner 遊戲內核對：#445「採集精密空氣淨化裝置所需的材料」(園藝師/A) 本站解出
       *    ET 10:00–12:00，遊戲顯示 10:00~11:59，逐位吻合；同名的採掘師版 (#400) 是 02:00–04:00，
       *    兩者不同 ⇒ 不是碰巧對上任意 2 小時級距。單位確認為**艾歐澤亞小時**。
       */
      verified: cond.type === 'weather' || cond.type === 'time',

      /** 現在是否開著。條件語意未定者回 null——不可當 false（會把它們說成「不能做」）。 */
      isOpen(now) {
        if (cond.type === 'weather') return forecaster.weatherAt(now).id === cond.weatherId;
        if (cond.type === 'time') return inEorzeaWindow(now, cond.start, cond.end);
        return null;
      },

      /** 下一次（含當前）開啟區間；未定條件回 null。 */
      next(now) {
        if (cond.type === 'weather') {
          const w = forecaster.nextWeather(now, cond.weatherId);
          return w ? { start: w.start, end: w.end } : null;
        }
        if (cond.type === 'time') return nextEorzeaWindow(now, cond.start, cond.end);
        return null;
      },

      /** 平均多久輪一次（秒）——ET 時段每艾歐澤亞日一次；天候依機率期望值。 */
      cadence() {
        if (cond.type === 'time') return EORZEA_DAY;
        if (cond.type === 'weather') {
          const rate = forecaster.table.find((w) => w.id === cond.weatherId)?.rate ?? 0;
          return rate > 0 ? Math.round(forecaster.periodSeconds * (100 / rate)) : null;
        }
        return null;
      },
    });
  }

  // 稀有度排序：任務數少的視窗＝錯過成本高，排前面
  out.sort((a, b) => a.missions.length - b.missions.length);
  return out;
}

/**
 * 現在開著的視窗（依稀有度排序）。未定條件**不列入**——不知道開沒開就不該推薦。
 */
export function openWindows(windows, now) {
  return windows.filter((w) => w.isOpen(now) === true);
}

/**
 * 下一個即將開啟的視窗（不含現在開著的）。
 */
export function upcomingWindows(windows, now, limit = 3) {
  return windows
    .filter((w) => w.isOpen(now) === false)
    .map((w) => ({ window: w, at: w.next(now) }))
    .filter((x) => x.at)
    .sort((a, b) => a.at.start - b.at.start)
    .slice(0, limit);
}

/**
 * 常駐任務（無條件）中，指定職業獎勵最高的幾個。
 * **排序依據只有「宇宙＋月球信用點」**——刻意不做「每分鐘效率」之類的分數：
 * 資料裡的 timeLimit 是**時限**不是實際耗時，拿它當分母是編造精度。
 */
export function topAlwaysAvailable(conditions, missions, jobIds, limit = 5) {
  const wanted = jobIds && jobIds.length ? new Set(jobIds) : null;
  return missions
    .filter((m) => (m.conds ?? []).length === 0)
    .filter((m) => !wanted || m.jobs.some((j) => wanted.has(j)))
    .map((m) => ({ mission: m, total: m.reward.cosmo + m.reward.lunar }))
    .sort((a, b) => b.total - a.total || a.mission.rank - b.mission.rank)
    .slice(0, limit);
}
