/**
 * 天氣預報分頁——**純預報，不混任務資訊**。
 *
 * 原本時間軸有一欄「天候任務」放職業圖示，但那讓表格太擠、也把兩件事混在一起
 * （Owner 2026-08-01）。任務去「臨時任務」分頁看，這裡只回答「什麼時候會是什麼天氣」。
 *
 * 這頁的資訊主張很窄，刻意講清楚：**渴望灣的一般天氣（月塵／晴朗／靈風）是時間的純函數，
 * 全伺服器同步、可推算到任意未來**；而緊急事件（磁暴／流星雨／孢子霧）是伺服器推播、
 * 離線推不出來。頁面同時要讓「靈風」這個唯一有任務意義的天氣一眼可見。
 */

import {
  WEATHER_PERIOD, clockText, localClockText, etClockText, dateText, eorzeaClock, formatDuration,
} from './eorzea-time.js';

/**
 * 天氣圖示＝**遊戲自己的圖**，由產生器從 client 解出放同源 `img/weather/<iconId>.png`
 * （icon id 在 `weather.json` 的 table 上，來源見 `tools/cosmic-dump/Program.cs`）。
 *
 * ⚠ 2026-08-01 之前這裡是一組自己發明的 emoji（🌤💨🌘）——遊戲本來就有天氣圖示，
 * 拿 emoji 代替是我擅自決定的，Owner 指正後改掉。**沒有 emoji fallback**：
 * 圖載不到就只顯示名稱，不要再讓那組自創對照偷偷回來。
 */
function weatherIcon(w, size = 20) {
  if (!w?.icon) return null;
  const img = document.createElement('img');
  img.className = 'cos-wicon';
  img.src = `img/weather/${String(w.icon).padStart(6, '0')}.png`;
  img.alt = '';                 // 天氣名就在旁邊，alt 再唸一次是重複
  img.width = size;
  img.height = size;
  img.loading = 'lazy';
  return img;
}

/** 渴望灣的「平常天氣」：佔 70%、沒有任何任務綁它 ⇒ 時間軸與倒數都不列它。 */
const PLAIN_WEATHER = '晴朗';

/** 時間軸要湊滿的特殊天氣筆數，以及為此往前掃的時段上限（特殊天氣約佔 30%）。 */
const SPECIAL_ROWS = 20;
const SCAN_PERIODS = 200;

/**
 * 機甲行動的班表：**現實時間**每小時的 :16 / :36 / :56，20 分鐘一班（Owner 2026-08-01）。
 *
 * 跟這頁其他東西**不同源**：天氣與 ET 都是 unix 時間的函數、走艾奧傑亞刻度；
 * 這個直接按現實時鐘的分鐘走 ⇒ 用 `Date` 取**本地**分秒，不要自己拿 unix 秒取模。
 * 台灣是整點時區，取模剛好也會對；但只要有人在半小時時區（印度／尼泊爾）開這頁就整整差半小時，
 * 而那種錯沒有任何訊號——畫面照樣在倒數，只是倒到錯的時間。
 *
 * **只算下一班、不標「進行中」**：一班持續多久還沒問到，沒有那個數字就寫不出誠實的進行中狀態。
 */
const MECH_MINUTES = [16, 36, 56];

/**
 * 下一班開始的 unix 秒。剛好卡在開始那一秒時回報再下一班（不假裝算得出當班還剩多久）。
 *
 * **export 是為了能單獨驗**（本站無 JS 測試 harness，這是唯一的檢查縫）：
 * `TZ=Asia/Taipei node --input-type=module -e "import {nextMechAt} from './modules/forecast-view.js'; …"`
 * 驗收線＝跨 :16/:36/:56 與整點翻頁的間隔一律 1200 秒。
 */
export function nextMechAt(now) {
  const d = new Date(now * 1000);
  const intoHour = d.getMinutes() * 60 + d.getSeconds();
  for (const m of MECH_MINUTES) {
    if (m * 60 > intoHour) return now + (m * 60 - intoHour);
  }
  return now + (3600 - intoHour) + MECH_MINUTES[0] * 60;   // 本小時三班都過了 → 下一小時的 :16
}

export function createForecastView({ forecaster, weatherData, missions, conditions }) {
  /*
   * 這個 view 現在橫跨兩個分頁：天氣三格在「臨時任務」頁（它是任務的前提），
   * 時間軸在「天氣預報」頁。**所以一律用 document 查，不能用 panel root**——
   * 用 root 查會在拆分頁後靜默拿到 null，時間軸整片消失（2026-08-01 實踩）。
   */
  const el = {
    now: document.querySelector('#fc-now'),
    timeline: document.querySelector('#fc-timeline'),
    timeline2: document.querySelector('#fc-timeline-2'),
    empty: document.querySelector('#fc-timeline-empty'),
    zone: document.querySelector('#fc-zone'),
  };

  // 有天候條件的任務：按天氣 id 分組，供時間軸標「這個時段開放幾個任務」
  const byWeather = new Map();
  for (const m of missions) {
    for (const cid of m.conds ?? []) {
      const cond = conditions[cid];
      if (cond?.type !== 'weather') continue;
      if (!byWeather.has(cond.weatherId)) byWeather.set(cond.weatherId, []);
      byWeather.get(cond.weatherId).push(m);
    }
  }

  el.zone.textContent = `${weatherData.zone.name}：${weatherData.table.map((w) => `${w.name} ${w.rate}%`).join('／')}`;

  function render(nowSeconds) {
    renderNow(nowSeconds);
    renderTimeline(nowSeconds);
  }

  let currentSummary = '';
  let weatherIconId = null;
  const values = {
    weather: document.querySelector('#fc-weather'),
    et: document.querySelector('#fc-et'),
    windy: document.querySelector('#fc-windy'),
    mech: document.querySelector('#fc-mech'),
  };

  // KPI 的四個外框與欄位首繪就存在；每秒只更新原位的文字節點。
  for (const value of Object.values(values)) {
    value.replaceChildren(document.createTextNode('查詢中'));
    const sub = document.createElement('span');
    sub.className = 'codex-subline';
    sub.textContent = '—';
    value.append(sub);
  }

  function update(value, text, note) {
    if (value.firstChild.nodeValue !== text) value.firstChild.nodeValue = text;
    if (value.lastElementChild.textContent !== note) value.lastElementChild.textContent = note;
  }

  function renderNow(now) {
    const current = forecaster.weatherAt(now);
    const remain = WEATHER_PERIOD - (now % WEATHER_PERIOD);
    const next = forecaster.weatherAt(now + remain);
    if (weatherIconId !== current.icon) {
      weatherIconId = current.icon;
      values.weather.querySelector('.cos-wicon')?.remove();
      const icon = weatherIcon(current, 28);
      if (icon) values.weather.insertBefore(icon, values.weather.lastElementChild);
    }
    const until = `${localClockText(now + remain)}`;
    let weatherNote = `還剩 ${formatDuration(remain)}（${until}） → 接著是 ${next.name}`;
    if (current.name === PLAIN_WEATHER && next.name === PLAIN_WEATHER) {
      weatherNote += ` · ${nextSpecialText(now)}`;
    }
    update(values.weather, current.name, weatherNote);
    update(values.et, etClockText(now), '1 小時＝現實 2 分 55 秒 · 全伺服器同步');

    const windy = weatherData.table.find((w) => w.name === '靈風');
    const count = (byWeather.get(windy?.id) ?? []).length;
    const windyNow = windy && current.id === windy.id;
    const upcoming = windy && forecaster.nextWeather(now, windy.id);
    // 相連靈風以整段的終點計算，不能提前在單一天氣週期末收掉。
    const windAt = windyNow ? forecaster.currentRunEnd(now, windy.id) : upcoming?.start;
    const windyText = windAt == null ? '—' : `${formatDuration(windAt - now)}${windyNow ? '剩餘' : '後'}`;
    const windyTime = windAt == null ? '本地時間未定' : `（${localClockText(windAt)}${windyNow ? ' 結束' : ''}）`;
    update(values.windy, windyText, `${windyTime} · ${count} 個天氣限定任務的必要條件 · 佔 ${windy?.rate ?? 0}% 時段`);

    const mechAt = nextMechAt(now);
    const mechText = `${formatDuration(mechAt - now)}後`;
    const mechTime = `（${localClockText(mechAt)}）`;
    update(values.mech, mechText, `${mechTime} · 每小時 :16 / :36 / :56`);
    currentSummary = `渴望灣｜目前天氣：${current.name}｜艾奧傑亞時間：${etClockText(now)}｜靈風視窗：${windyText}${windyTime}｜機甲行動：${mechText}${mechTime}｜緊急事件不能由天氣預測`;
  }

  function nextSpecialText(now) {
    const upcoming = forecaster.forecast(now, SCAN_PERIODS)
      .find((slot) => slot.weather.name !== PLAIN_WEATHER && slot.start > now);
    return upcoming
      ? `${upcoming.weather.name} ${formatDuration(upcoming.start - now)}後（${localClockText(upcoming.start)}）`
      : '掃描範圍內沒有特殊天氣';
  }

  /**
   * 時間軸的「距離現在」欄。每秒只改這幾格文字，不重建整張表。
   *
   * <b>為什麼值得分開</b>：表格內容只在**天氣時段跨過邊界**時才會變（每 23 分 20 秒），
   * 但倒數每秒都要動。原本每秒重建 40 列＋每列一個天氣 `&lt;img&gt;`——量到重建含 layout
   * 約 0.5 ms／次，不算大，但那是每秒都在做一件 23 分鐘才需要做一次的事，
   * 而且 `&lt;img&gt;` 被重新建立會讓瀏覽器每秒重新解碼／重繪那 40 張圖。
   */
  let timelineCells = [];
  let timelineKey = -1;

  function renderTimeline(now) {
    const key = Math.floor(now / WEATHER_PERIOD);
    if (key === timelineKey) {
      for (const { cell, slot } of timelineCells) {
        const text = now >= slot.start && now < slot.end ? '進行中' : formatDuration(slot.start - now);
        if (cell.textContent !== text) cell.textContent = text;
      }
      return;
    }
    timelineKey = key;
    timelineCells = [];

    // 只列特殊天氣（月塵／靈風）。晴朗佔 70%、且沒有任務綁它，整片列出來只是把重點稀釋掉。
    const rows = forecaster
      .forecast(now, SCAN_PERIODS)
      .filter((slot) => slot.weather.name !== PLAIN_WEATHER)
      .slice(0, SPECIAL_ROWS);
    el.empty.hidden = rows.length !== 0;
    // 兩欄並排。**左欄放前半、右欄放後半**（不是奇偶交錯）——時間軸是連續的，
    // 交錯排會讓「往下讀」變成「左右跳著讀」，比原本更難用。
    const half = Math.ceil(rows.length / 2);
    const bodies = [el.timeline.querySelector('tbody'), el.timeline2?.querySelector('tbody')];
    for (const b of bodies) if (b) b.innerHTML = '';

    for (const [i, slot] of rows.entries()) {
      const tbody = (i >= half && bodies[1]) ? bodies[1] : bodies[0];
      const tr = document.createElement('tr');
      const isNow = now >= slot.start && now < slot.end;
      if (isNow) tr.classList.add('is-current');

      const date = dateText(slot.start);

      const et = eorzeaClock(slot.start);

      const countdown = td(isNow ? '進行中' : formatDuration(slot.start - now), 'codex-table__num', '距離現在');
      tr.append(
        td(date, 'cos-col-date', '日期'),
        // 這兩欄用**裸值**（`clockText` 而非 `localClockText`）——欄位標題已經寫著
        // 「本地時間」與「ET」，格內再標一次會把 5 欄擠爆。這是允許裸值的唯一情形，
        // 判準寫在 `eorzea-time.js` 的 `clockText` 註解，由 clock-labelling 測試守門。
        td(clockText(slot.start), 'codex-table__num', '本地時間'),
        td(`${String(et.hour).padStart(2, '0')}:00`, 'codex-table__num', 'ET'),
        weatherCell(slot.weather),
        countdown,
      );
      tbody.append(tr);
      timelineCells.push({ cell: countdown, slot });
    }
  }

  function td(text, cls, label) {
    const e = document.createElement('td');
    if (cls) e.className = cls;
    if (label) e.dataset.label = label;
    e.textContent = text;
    return e;
  }

  /** 時間軸的天氣欄：遊戲圖示 ＋ 名稱。 */
  function weatherCell(w) {
    const e = document.createElement('td');
    e.className = 'cos-wcell';
    e.dataset.label = '天氣';
    const ico = weatherIcon(w);
    if (ico) e.append(ico);
    e.append(document.createTextNode(w.name));
    return e;
  }

  return { render, summaryText: () => currentSummary };
}
