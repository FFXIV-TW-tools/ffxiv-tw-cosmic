/**
 * 分頁一：天氣時間軸。
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

export function createForecastView(root, { forecaster, weatherData, missions, conditions, jobs, onJump }) {
  const el = {
    now: root.querySelector('#fc-now'),
    timeline: root.querySelector('#fc-timeline'),
    // zone 標籤住在 .page-header（本 panel 之外）——標題列即工具列，是設計系統推薦的位置
    zone: document.querySelector('#fc-zone'),
  };

  // 有天候條件的任務：按天氣 id 分組，供時間軸標「這個時段開放幾個任務」
  const byWeather = new Map();
  for (const m of missions) {
    const cond = conditions[m.cond];
    if (cond?.type !== 'weather') continue;
    if (!byWeather.has(cond.weatherId)) byWeather.set(cond.weatherId, []);
    byWeather.get(cond.weatherId).push(m);
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
    const note = current.name === PLAIN_WEATHER
      ? nextSpecialNote(now)
      : `還剩 ${formatDuration(remain)}`;
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

  /**
   * 全頁唯一的金色高亮（設計系統：一頁最多 1 處，且限「限時 / 唯一推薦 / 要你現在動作」）。
   * 靈風視窗正是限時，且是 11 個緊急任務的必要條件——這頁真正要你盯的就是它。
   */
  function renderHighlight(now) {
    const windy = weatherData.table.find((w) => w.name === '靈風');
    el.highlight.innerHTML = '';
    if (!windy) return;

    const count = (byWeather.get(windy.id) ?? []).length;
    const current = forecaster.weatherAt(now);
    const wrap = document.createElement('div');
    wrap.className = 'codex-tint-panel codex-tint-panel--highlight codex-tint-panel--bar cos-highlight';

    if (current.id === windy.id) {
      const remain = WEATHER_PERIOD - (now % WEATHER_PERIOD);
      wrap.innerHTML = '';
      wrap.append(
        strong(`💨 現在正是靈風時段 — 還剩 ${formatDuration(remain)}`),
        note(`這是 ${count} 個緊急任務的必要條件視窗。視窗外它們不會出現；視窗內出不出現由伺服器決定。`),
      );
    } else {
      const next = forecaster.nextWeather(now, windy.id);
      if (!next) {
        wrap.append(strong('掃描範圍內找不到靈風時段'), note('這不正常，請回報。'));
      } else {
        wrap.append(
          strong(`💨 下一個靈風視窗：${dateText(next.start)} ${clockText(next.start)}（${formatDuration(next.start - now)}後）`),
          note(`持續 23 分 20 秒，是 ${count} 個緊急任務的必要條件。靈風佔全部時段的 ${windy.rate}%。`),
        );
      }
    }
    el.highlight.append(wrap);
  }

  function strong(text) {
    const e = document.createElement('div');
    e.className = 'codex-h3 cos-highlight__title';
    e.textContent = text;
    return e;
  }

  function note(text) {
    const e = document.createElement('div');
    e.className = 'codex-body';
    e.textContent = text;
    return e;
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
        jobCell(slot.weather.id),
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

  /**
   * 該天氣時段可做的職業，做成可點的 chip → 跳到任務清單並套好篩選。
   * 用 `<button aria-pressed>` 是設計系統對可點 chip 的硬性要求（不是 span）。
   */
  function jobCell(weatherId) {
    const cell = document.createElement('td');
    cell.className = 'cos-col-jobs';
    const list = byWeather.get(weatherId) ?? [];
    if (list.length === 0) {
      cell.textContent = '—';
      return cell;
    }
    const jobIds = [...new Set(list.flatMap((m) => m.jobs))].sort((a, b) => a - b);
    for (const id of jobIds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'codex-chip codex-xs';
      b.setAttribute('aria-pressed', 'false');
      b.textContent = jobs[id]?.label ?? `#${id}`;
      b.dataset.help = `跳到任務清單，只看${jobs[id]?.label ?? id}在此天候可做的任務`;
      b.addEventListener('click', () => onJump({ jobIds: [id], condKinds: ['weather'] }));
      cell.append(b);
    }
    return cell;
  }

  return { render };
}
