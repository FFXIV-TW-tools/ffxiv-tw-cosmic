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

import { WEATHER_PERIOD, clockText, dateText, eorzeaClock, formatDuration } from './eorzea-time.js';

/** 天氣 → emoji。純裝飾，資料本身以文字承載。 */
const WEATHER_ICON = { 月塵: '🌘', 晴朗: '🌤', 靈風: '💨' };

/** 渴望灣的「平常天氣」：佔 70%、沒有任何任務綁它 ⇒ 時間軸與倒數都不列它。 */
const PLAIN_WEATHER = '晴朗';

/** 時間軸要湊滿的特殊天氣筆數，以及為此往前掃的時段上限（特殊天氣約佔 30%）。 */
const SPECIAL_ROWS = 20;
const SCAN_PERIODS = 200;

export function createForecastView({ forecaster, weatherData, missions, conditions }) {
  /*
   * 這個 view 現在橫跨兩個分頁：天氣三格在「臨時任務」頁（它是任務的前提），
   * 時間軸在「天氣預報」頁。**所以一律用 document 查，不能用 panel root**——
   * 用 root 查會在拆分頁後靜默拿到 null，時間軸整片消失（2026-08-01 實踩）。
   */
  const el = {
    now: document.querySelector('#fc-now'),
    timeline: document.querySelector('#fc-timeline'),
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

  el.zone.textContent = `${weatherData.zone.name}（${weatherData.table.map((w) => `${w.name} ${w.rate}%`).join('／')}）`;

  function render(nowSeconds) {
    renderNow(nowSeconds);
    renderTimeline(nowSeconds);
  }

  function renderNow(now) {
    const current = forecaster.weatherAt(now);
    const et = eorzeaClock(now);
    const remain = WEATHER_PERIOD - (now % WEATHER_PERIOD);
    // 晴朗佔 70% 且沒有任何任務綁它 ⇒ 報「還有多久變天」是雜訊（多半只是變成另一段晴朗）。
    // 晴朗時改報「距離下一個特殊天氣」，那才是有意義的數字。
    /*
     * 倒數只講「還剩多久」等於半句話——變完之後是什麼，才是決定要不要現在收工的依據
     * （Owner 2026-07-31）。下一段天氣是純時間函數，算得出來就直接寫出來。
     *
     * 晴朗時再補一句「距離下一個特殊天氣」：晴朗佔 70%，下一段多半還是晴朗，
     * 只寫「接著是晴朗」對使用者毫無用處。
     */
    const next = forecaster.weatherAt(now + remain);
    const nextText = `還剩 ${formatDuration(remain)} → 接著是 ${WEATHER_ICON[next.name] ?? ''} ${next.name}`;
    const note = current.name === PLAIN_WEATHER && next.name === PLAIN_WEATHER
      ? `${nextText}（${nextSpecialNote(now)}）`
      : nextText;
    el.now.innerHTML = '';
    el.now.append(
      block('目前天氣', `${WEATHER_ICON[current.name] ?? ''} ${current.name}`, note),
      block('艾歐澤亞時間', `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`, '天氣全伺服器同步，不分伺服器'),
      windyBlock(now),
    );
  }

  /**
   * 全頁唯一的金色高亮（設計系統：一頁最多 1 處，限「限時／唯一推薦／要你現在動作」）。
   * 靈風視窗正是限時，且是 11 個緊急任務的必要條件。
   */
  function windyBlock(now) {
    const windy = weatherData.table.find((w) => w.name === '靈風');
    if (!windy) return document.createDocumentFragment();
    const count = (byWeather.get(windy.id) ?? []).length;
    const isNow = forecaster.weatherAt(now).id === windy.id;
    const next = forecaster.nextWeather(now, windy.id);
    const d = block(
      '靈風視窗',
      isNow ? `還剩 ${formatDuration(WEATHER_PERIOD - (now % WEATHER_PERIOD))}` : (next ? `${formatDuration(next.start - now)}後` : '—'),
      `${count} 個緊急任務的必要條件（佔 ${windy.rate}% 時段）`,
    );
    d.classList.add('codex-tint-panel', 'codex-tint-panel--highlight', 'codex-tint-panel--bar');
    return d;
  }

  function block(label, value, note) {
    const d = document.createElement('div');
    d.className = 'cos-stat';
    const l = document.createElement('span');
    l.className = 'codex-label';
    l.textContent = label;
    const v = document.createElement('strong');
    v.className = 'codex-h2 cos-stat__value';
    v.textContent = value;
    const n = document.createElement('span');
    n.className = 'codex-small cos-stat__note';
    n.textContent = note;
    d.append(l, v, n);
    return d;
  }

  /** 距離下一個非「晴朗」時段的說明文字。 */
  function nextSpecialNote(now) {
    const upcoming = forecaster
      .forecast(now, SCAN_PERIODS)
      .find((slot) => slot.weather.name !== PLAIN_WEATHER && slot.start > now);
    if (!upcoming) return '掃描範圍內沒有特殊天氣';
    return `${upcoming.weather.name} ${formatDuration(upcoming.start - now)}後`;
  }

  function renderTimeline(now) {
    // 只列特殊天氣（月塵／靈風）。晴朗佔 70%、且沒有任務綁它，整片列出來只是把重點稀釋掉。
    const rows = forecaster
      .forecast(now, SCAN_PERIODS)
      .filter((slot) => slot.weather.name !== PLAIN_WEATHER)
      .slice(0, SPECIAL_ROWS);
    const tbody = el.timeline.querySelector('tbody');
    tbody.innerHTML = '';
    let lastDate = '';

    for (const slot of rows) {
      const tr = document.createElement('tr');
      const isNow = now >= slot.start && now < slot.end;
      if (isNow) tr.classList.add('is-current');

      const date = dateText(slot.start);
      const dateCell = date === lastDate ? '' : date;
      lastDate = date;

      const et = eorzeaClock(slot.start);

      tr.append(
        td(dateCell, 'cos-col-date'),
        td(clockText(slot.start), 'codex-table__num'),
        td(`${String(et.hour).padStart(2, '0')}:00`, 'codex-table__num'),
        td(`${WEATHER_ICON[slot.weather.name] ?? ''} ${slot.weather.name}`),
        td(isNow ? '進行中' : formatDuration(slot.start - now), 'codex-table__num'),
      );
      tbody.append(tr);
    }
  }

  function td(text, cls) {
    const e = document.createElement('td');
    if (cls) e.className = cls;
    e.textContent = text;
    return e;
  }

  return { render };
}
