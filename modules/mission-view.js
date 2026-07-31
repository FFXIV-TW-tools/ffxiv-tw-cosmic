/**
 * 分頁二：任務清單（544 筆）。
 *
 * 篩選一律走 `<button class="codex-chip" aria-pressed>`（設計系統：可點 chip 必須是 button），
 * 「現在可接」欄位對條件未定的任務顯示「未知」而不是「否」——client 那幾列是空的，
 * 拿 0 冒充「無條件」會把 6 個緊急任務標成隨時可接。
 */

import { inEorzeaWindow } from './eorzea-time.js';
import { conditionMet } from './weather-forecast.js';

const RANK_LABEL = { 1: 'D', 2: 'C', 3: 'B', 4: 'A1', 5: 'A2', 6: 'A3' };

export function createMissionView(root, { missions, conditions, jobs, forecaster }) {
  const el = {
    jobFilter: root.querySelector('#mv-jobs'),
    rankFilter: root.querySelector('#mv-ranks'),
    condFilter: root.querySelector('#mv-conds'),
    search: root.querySelector('#mv-search'),
    tbody: root.querySelector('#mv-table tbody'),
    empty: root.querySelector('#mv-empty'),
    count: root.querySelector('#mv-count'),
    classFilter: root.querySelector('#mv-classes'),
    onlyAvailable: root.querySelector('#mv-available'),
  };

  const state = { jobs: new Set(), ranks: new Set(), conds: new Set(), classes: new Set(), text: '', available: false };
  // 外部（時間軸／建議面板）要能把篩選設定進來 → 需要能依值找到對應的 chip 節點
  const chipIndex = { jobs: new Map(), conds: new Map(), classes: new Map() };
  let now = Math.floor(Date.now() / 1000);

  buildClassChips();
  buildJobChips();
  buildRankChips();
  buildCondChips();
  bindInputs();

  function buildJobChips() {
    for (const [id, job] of Object.entries(jobs)) {
      const b = chip(job.label, () => toggle(state.jobs, Number(id)));
      chipIndex.jobs.set(Number(id), b);
      el.jobFilter.append(b);
    }
  }

  function buildRankChips() {
    for (const [rank, label] of Object.entries(RANK_LABEL)) {
      el.rankFilter.append(chip(label, () => toggle(state.ranks, Number(rank))));
    }
  }

  /** 遊戲自己的三分類。基礎 231／臨時 280／緊急 33，互斥且合計 544。 */
  function buildClassChips() {
    for (const [key, label] of [['basic', '基礎'], ['temporary', '臨時'], ['critical', '緊急']]) {
      const b = chip(label, () => toggle(state.classes, key));
      chipIndex.classes.set(key, b);
      el.classFilter.append(b);
    }
  }

  /** 條件依「種類」聚合成 4 顆，而不是 23 顆 cond id——使用者關心的是種類。 */
  function buildCondChips() {
    const kinds = [
      ['none', '無條件'],
      ['time', 'ET 時段'],
      ['weather', '天候'],
      ['unknown', '條件未定'],
    ];
    for (const [kind, label] of kinds) {
      const b = chip(label, () => toggle(state.conds, kind));
      chipIndex.conds.set(kind, b);
      el.condFilter.append(b);
    }
  }

  function chip(label, onToggle) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'codex-chip';
    b.setAttribute('aria-pressed', 'false');
    b.textContent = label;
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(next));
      onToggle();
      render();
    });
    return b;
  }

  function toggle(set, value) {
    if (set.has(value)) set.delete(value);
    else set.add(value);
  }

  function bindInputs() {
    el.search.addEventListener('input', () => {
      state.text = el.search.value.trim();
      render();
    });
    el.onlyAvailable.addEventListener('change', () => {
      state.available = el.onlyAvailable.checked;
      render();
    });
  }

  function matches(m) {
    if (state.classes.size && !state.classes.has(m.class)) return false;
    if (state.jobs.size && !m.jobs.some((j) => state.jobs.has(j))) return false;
    if (state.ranks.size && !state.ranks.has(m.rank)) return false;
    if (state.conds.size) {
      const kind = conditions[m.cond]?.type ?? 'none';
      if (!state.conds.has(kind)) return false;
    }
    if (state.text && !m.name.includes(state.text)
        && !m.items.some((it) => it.name.includes(state.text))) return false;
    if (state.available && availability(m).state !== 'open') return false;
    return true;
  }

  /**
   * 「現在」欄＝**條件成不成立**，不是「任務會不會出現」。
   * 條件表原名帶 Lottery（抽選）＝條件成立只是取得抽選資格；緊急任務更要等伺服器事件。
   * 所以標籤一律用「條件符合／條件未開」，不寫「可接」。
   * @returns {{state:'open'|'closed'|'unknown', label:string}}
   */
  function availability(m) {
    const met = conditionMet(conditions[m.cond], now, forecaster, inEorzeaWindow);
    if (met === null) return { state: 'unknown', label: '條件未定' };
    return met ? { state: 'open', label: '條件符合' } : { state: 'closed', label: '條件未開' };
  }

  function render() {
    const rows = missions.filter(matches);
    el.count.textContent = `${rows.length} / ${missions.length}`;
    el.tbody.innerHTML = '';
    el.empty.hidden = rows.length > 0;
    el.tbody.closest('.codex-table-wrap').hidden = rows.length === 0;

    // 只畫前 200 筆：544 × 8 欄一次全畫會讓篩選有明顯延遲，而使用者實際只看前幾十筆。
    const shown = rows.slice(0, 200);
    for (const m of shown) el.tbody.append(row(m));
    if (rows.length > shown.length) {
      const tr = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 9;
      cell.className = 'cos-more';
      cell.textContent = `還有 ${rows.length - shown.length} 筆 — 用上方篩選縮小範圍`;
      tr.append(cell);
      el.tbody.append(tr);
    }
  }

  function row(m) {
    const tr = document.createElement('tr');
    const avail = availability(m);

    const nameCell = document.createElement('td');
    nameCell.append(document.createTextNode(m.name));

    const CLASS_META = {
      basic: ['基礎', 'neutral'],
      temporary: ['臨時', 'warn'],
      critical: ['緊急', 'danger'],
    };
    const [clsLabel, clsTone] = CLASS_META[m.class] ?? ['—', 'neutral'];
    const classCell = document.createElement('td');
    const clsBadge = document.createElement('span');
    clsBadge.className = `codex-badge codex-badge--${clsTone}`;
    clsBadge.textContent = clsLabel;
    classCell.append(clsBadge);

    const itemCell = document.createElement('td');
    itemCell.textContent = m.items.length
      ? m.items.map((it) => `${it.name} ×${it.qty}`).join('、')
      : '—';

    const availCell = document.createElement('td');
    // 直接用共用 badge 的語意變體，不自造顏色（設計系統：禁覆寫 .codex-* 根 selector）
    const tone = { open: 'success', closed: 'neutral', unknown: 'warn' }[avail.state];
    const dot = document.createElement('span');
    dot.className = `codex-badge codex-badge--${tone}`;
    dot.textContent = avail.label;
    availCell.append(dot);

    tr.append(
      nameCell,
      classCell,
      td(m.jobs.map((j) => jobs[j]?.label ?? `#${j}`).join('／')),
      td(RANK_LABEL[m.rank] ?? String(m.rank), 'codex-table__num'),
      td(m.timeLimit ? `${Math.round(m.timeLimit / 60)} 分` : '—', 'codex-table__num'),
      td(conditions[m.cond]?.label ?? '—'),
      itemCell,
      td(`${m.reward.cosmo} / ${m.reward.lunar}`, 'codex-table__num'),
      availCell,
    );
    return tr;
  }

  function td(text, cls) {
    const e = document.createElement('td');
    if (cls) e.className = cls;
    e.textContent = text;
    return e;
  }

  /** 外部時鐘推進時重算「現在可接」。 */
  function tick(nowSeconds) {
    now = nowSeconds;
    render();
  }

  /**
   * 從別的分頁跳過來時套用篩選。**先把既有篩選全部清掉**——保留舊條件會讓使用者
   * 點了「木工師」卻看到 0 筆（因為上次還留著「漁師」），看起來像壞掉。
   */
  function setFilter({ jobIds = [], condKinds = [], classes = [] } = {}) {
    state.jobs = new Set(jobIds);
    state.ranks.clear();
    state.conds = new Set(condKinds);
    state.classes = new Set(classes);
    state.text = '';
    state.available = false;
    el.search.value = '';
    el.onlyAvailable.checked = false;
    for (const [key, b] of chipIndex.classes) b.setAttribute('aria-pressed', String(state.classes.has(key)));
    for (const [id, b] of chipIndex.jobs) b.setAttribute('aria-pressed', String(state.jobs.has(id)));
    for (const [kind, b] of chipIndex.conds) b.setAttribute('aria-pressed', String(state.conds.has(kind)));
    el.rankFilter.querySelectorAll('[aria-pressed]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    render();
  }

  render();
  return { tick, setFilter };
}
