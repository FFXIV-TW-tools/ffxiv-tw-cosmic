/**
 * 分頁二：任務清單（544 筆）。
 *
 * 篩選一律走 `<button class="codex-chip" aria-pressed>`（設計系統：可點 chip 必須是 button），
 * 「現在可接」欄位對條件未定的任務顯示「未知」而不是「否」——client 那幾列是空的，
 * 拿 0 冒充「無條件」會把 6 個緊急任務標成隨時可接。
 */

import { inEorzeaWindow } from './eorzea-time.js';
import { conditionsMet } from './weather-forecast.js';
import { jobIcon, jobIcons } from './job-icon.js';
import { requiredItems } from './crafter-link.js';

/** 階級標籤用**遊戲自己的說法**。A1/A2/A3 是上游 ICE 的內部命名，遊戲 UI 沒有這個詞：
 *  rank1–4＝無前綴的 D/C/B/A（基礎分頁）、rank5＝【高難】、rank6＝【高難+】（臨時分頁），
 *  與任務名前綴一對一對齊、零例外。 */
const RANK_LABEL = { 1: 'D', 2: 'C', 3: 'B', 4: 'A', 5: '高難', 6: '高難+' };

/** 遊戲的三個分頁（Addon#16748/16749/16750）。 */
const CLASS_META = {
  basic: ['基礎任務', 'neutral'],
  temporary: ['臨時任務', 'warn'],
  critical: ['緊急任務', 'danger'],
};

/** 臨時任務底下的子標籤（Addon#16871/16872/16873）。可同時成立，不是互斥分類。 */
const TAG_LABEL = { sequential: '連續任務', time: '時間限定任務', weather: '天氣限定任務' };

export function createMissionView(root, { missions, conditions, jobs, forecaster }) {
  const byId = new Map(missions.map((m) => [m.id, m]));
  const el = {
    jobFilter: root.querySelector('#mv-jobs'),
    rankFilter: root.querySelector('#mv-ranks'),
    condFilter: root.querySelector('#mv-conds'),
    search: root.querySelector('#mv-search'),
    tbody: root.querySelector('#mv-table tbody'),
    empty: root.querySelector('#mv-empty'),
    count: root.querySelector('#mv-count'),
    classFilter: root.querySelector('#mv-classes'),
    tagFilter: root.querySelector('#mv-tags'),
    onlyAvailable: root.querySelector('#mv-available'),
    hideBulk: root.querySelector('#mv-hidebulk'),
  };

  const state = {
    jobs: new Set(), ranks: new Set(), conds: new Set(), classes: new Set(), tags: new Set(),
    text: '', available: false, hideBulk: true,
  };
  // 外部（時間軸／建議面板）要能把篩選設定進來 → 需要能依值找到對應的 chip 節點
  const chipIndex = { jobs: new Map(), conds: new Map(), classes: new Map(), tags: new Map() };
  let now = Math.floor(Date.now() / 1000);

  buildClassChips();
  buildTagChips();
  buildJobChips();
  buildRankChips();
  buildCondChips();
  bindInputs();

  /**
   * 職業 chip **分兩列：製作職（DoH 8）在上、採集職（DoL 3）在下**（Owner 2026-08-01）。
   * 讓 11 個圖示自由 wrap 會排成 9+2 這種沒有意義的斷點，掃視時分不出哪些是採集。
   * 分組依據是 `jobs[].role`（來自 `data/item_dict/jobs.json` 的權威欄位），不自己列清單。
   */
  function buildJobChips() {
    const rows = { crafter: row(), gatherer: row() };
    for (const [id, job] of Object.entries(jobs)) {
      const b = chip('', () => toggle(state.jobs, Number(id)));
      b.append(jobIcon(job, { size: 22 }));
      // chip 只剩圖示 ⇒ 無障礙名稱要另外給，否則按鈕對讀螢幕器是空的
      b.setAttribute('aria-label', job.label);
      b.title = job.label;
      b.classList.add('cos-chip--icon');
      chipIndex.jobs.set(Number(id), b);
      (rows[job.role] ?? rows.crafter).append(b);
    }
    el.jobFilter.append(rows.crafter, rows.gatherer);

    function row() {
      const d = document.createElement('div');
      d.className = 'cos-chips cos-chips--row';
      return d;
    }
  }

  function buildRankChips() {
    for (const [rank, label] of Object.entries(RANK_LABEL)) {
      el.rankFilter.append(chip(label, () => toggle(state.ranks, Number(rank))));
    }
  }

  /** 遊戲自己的三個分頁。基礎 319（D/C/B/A）／臨時 192（高難、高難+）／緊急 33，互斥且合計 544。 */
  function buildClassChips() {
    for (const [key, [label]] of Object.entries(CLASS_META)) {
      const b = chip(label, () => { toggle(state.classes, key); syncTagChips(); });
      chipIndex.classes.set(key, b);
      el.classFilter.append(b);
    }
  }

  /** 臨時任務的子標籤。連續 88／時間限定 96／天氣限定 41，會互相重疊；只掛在臨時任務上。 */
  function buildTagChips() {
    for (const [key, label] of Object.entries(TAG_LABEL)) {
      const b = chip(label, () => toggle(state.tags, key));
      chipIndex.tags.set(key, b);
      el.tagFilter.append(b);
    }
    syncTagChips();
  }

  /**
   * 子標籤只掛在臨時任務上，所以選了基礎／緊急時它們**不該可點**——原本三顆一直是可點的，
   * 點下去必然 0 筆，等於引導使用者去按一個沒有意義的按鈕（Owner 2026-08-01）。
   * 停用時一併清掉已按下的，否則會留下一個看不見卻仍在生效的篩選。
   */
  function syncTagChips() {
    const usable = state.classes.size === 0 || state.classes.has('temporary');
    for (const [key, b] of chipIndex.tags) {
      b.disabled = !usable;
      b.title = usable ? '' : '子標籤只掛在臨時任務上';
      if (!usable && state.tags.has(key)) {
        state.tags.delete(key);
        b.setAttribute('aria-pressed', 'false');
      }
    }
  }

  /** 條件依「種類」聚合成 4 顆，而不是 23 顆 cond id——使用者關心的是種類。 */
  function buildCondChips() {
    const kinds = [
      ['none', '不限時'],
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
    el.hideBulk.addEventListener('change', () => {
      state.hideBulk = el.hideBulk.checked;
      render();
    });
  }

  function matches(m) {
    // 不限時的基礎任務有 302 個、隨時都在，預設收起來——否則從看板點任一職業進來，
    // 前幾十列全是 D 階的不限時任務，真正要看的那筆反而被埋掉（Owner 2026-07-31）。
    // 這是**看得見的開關**而不是隱形篩選，底部的基礎任務入口會把它關掉。
    if (state.hideBulk && m.class === 'basic' && (m.conds ?? []).length === 0) return false;
    if (state.classes.size && !state.classes.has(m.class)) return false;
    // 子標籤可疊加 ⇒ 任一命中就算（選「連續任務」＋「天氣限定任務」＝兩者任一）
    if (state.tags.size && !(m.tags ?? []).some((t) => state.tags.has(t))) return false;
    if (state.jobs.size && !m.jobs.some((j) => state.jobs.has(j))) return false;
    if (state.ranks.size && !state.ranks.has(m.rank)) return false;
    if (state.conds.size) {
      // 一個任務可有多個條件 ⇒ 任一條件的種類命中篩選就算
      const kinds = (m.conds ?? []).map((c) => conditions[c]?.type).filter(Boolean);
      if (kinds.length === 0) kinds.push('none');
      if (!kinds.some((k) => state.conds.has(k))) return false;
    }
    if (state.text && !m.name.includes(state.text)
        && !m.items.some((it) => it.name.includes(state.text))) return false;
    if (state.available && availability(m).state !== 'open') return false;
    return true;
  }

  /**
   * 「現在」欄。有時段／天候條件的任務：**條件到了就會出現**（Owner 2026-08-01 明確指正
   * ——先前依一份取樣有偏差的統計寫成「不保證出現」，那是錯的，見下方 note）。
   * 不限時的那批才是從池子裡抽（看板名額有限），標「不限時」而不是「一定看得到」。
   * @returns {{state:'open'|'closed'|'unknown', label:string, tone?:string}}
   */
  function availability(m) {
    const met = conditionsMet(m.conds, conditions, now, forecaster, inEorzeaWindow);
    if (met === null) return { state: 'unknown', label: '條件未定' };
    if (!met) return { state: 'closed', label: '條件未開' };
    // 前置任務是否已完成離線不可知 ⇒ 有前置的不能單憑時段／天候就說「符合」。
    if (m.prereq) return { state: 'unknown', label: '需先完成前置', tone: 'warn' };
    // 有時段／天候條件的：條件到了就會出現。不限時的才是從池子裡抽。
    return (m.conds ?? []).length > 0
      ? { state: 'open', label: '會出現', tone: 'success' }
      : { state: 'open', label: '不限時', tone: 'neutral' };
  }

  /**
   * 排序權重：**現在就能做的排前面**（Owner 2026-08-03）。
   *
   * 原本完全沒有排序，順序就是資料檔的任務 id 順序＝毫無意義；再加上只畫前 200 筆，
   * 使用者看到的是「id 最小的 200 個」而不是「最該看的 200 個」——**篩選出來的東西
   * 有一半根本沒被畫出來**，而畫面上只寫「還有 N 筆」，看不出漏掉的是哪些。
   *
   * 三段：能做的 → 條件沒到但會出現的 → 卡前置／條件未定的。
   * 同段內用宇宙點數由高到低（那是玩家實際在最佳化的數字）。
   */
  const AVAIL_ORDER = { open: 0, closed: 1, unknown: 2 };

  function rankOf(m) {
    const a = availability(m);
    // 同為 open 時「不限時」排在「會出現」之前：前者現在就能接，後者要等條件
    const sub = a.state === 'open' && (m.conds ?? []).length > 0 ? 1 : 0;
    return AVAIL_ORDER[a.state] * 2 + sub;
  }

  function render() {
    const rows = missions.filter(matches).sort((a, b) => {
      const d = rankOf(a) - rankOf(b);
      if (d) return d;
      return (b.reward?.cosmo ?? 0) - (a.reward?.cosmo ?? 0);
    });
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
      cell.colSpan = 10;
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

    const [clsLabel, clsTone] = CLASS_META[m.class] ?? ['—', 'neutral'];
    const classCell = document.createElement('td');
    const clsBadge = document.createElement('span');
    clsBadge.className = `codex-badge codex-badge--${clsTone}`;
    clsBadge.textContent = clsLabel;
    classCell.append(clsBadge);
    // 子標籤跟分頁名並列。它們可疊加，所以不是「取代」分頁名而是附加。
    for (const t of m.tags ?? []) {
      const b = document.createElement('span');
      b.className = 'codex-badge codex-badge--neutral cos-tag';
      b.textContent = TAG_LABEL[t] ?? t;
      classCell.append(b);
    }

    const itemCell = document.createElement('td');
    // 製作類任務的需求物直接連到求解器（採集/釣魚類沒有配方 → 純文字）
    itemCell.append(requiredItems(m));

    const availCell = document.createElement('td');
    // 直接用共用 badge 的語意變體，不自造顏色（設計系統：禁覆寫 .codex-* 根 selector）
    const tone = avail.tone ?? { open: 'success', closed: 'neutral', unknown: 'warn' }[avail.state];
    const dot = document.createElement('span');
    dot.className = `codex-badge codex-badge--${tone}`;
    dot.textContent = avail.label;
    availCell.append(dot);

    const jobCell = document.createElement('td');
    jobCell.className = 'cos-jobcell';
    jobCell.append(jobIcons(m.jobs, jobs, { size: 22 }));

    // 欄序＝誰 → 是什麼 → 何時 → 代價 → 報酬（與主面板同一套邏輯）。
    // 獎勵拆成宇宙／月球兩欄，也跟面板一致——擠在一格沒辦法上下比大小。
    tr.append(
      jobCell,
      classCell,
      td(RANK_LABEL[m.rank] ?? String(m.rank), 'codex-table__num'),
      nameCell,
      td(condText(m)),
      availCell,
      td(m.timeLimit ? `${Math.round(m.timeLimit / 60)} 分` : '—', 'codex-table__num'),
      itemCell,
      td(String(m.reward.cosmo), 'codex-table__num'),
      td(String(m.reward.lunar), 'codex-table__num'),
    );
    return tr;
  }

  /**
   * 開放條件欄。前置任務（連續任務）跟時段／天候同樣是「開放條件」，所以放同一欄——
   * 它才是「條件都符合卻看不到」最常見的原因：88 個臨時任務要先完成指定的前一個任務。
   */
  function condText(m) {
    const parts = (m.conds ?? []).map((id) => conditions[id]?.label).filter(Boolean);
    if (m.prereq) parts.push(`先完成${chainText(m)}`);
    return parts.join(' ＋ ') || '不限時';
  }

  /**
   * 連續任務的**整條鏈**，從最源頭往下寫。
   *
   * 只寫「先完成『X』」看不出 X 是哪一類、也看不出還要幾層——而 33 條鏈的起點其實是
   * **基礎任務**（Owner 2026-07-31 指出，資料吻合：88 個前置裡 33 個指向 rank A 的基礎任務、
   * 33 個指向【高難】、22 個指向【高難+】）。形狀是 基礎 A →【高難】續·X →【高難+】X。
   * 知道源頭在基礎分頁，才知道該從哪裡開始做。
   */
  function chainText(m) {
    const chain = [];
    let cur = byId.get(m.prereq);
    // 資料上鏈深最多 3；設上限純粹是防資料出錯時無限迴圈
    for (let i = 0; cur && i < 6; i++) {
      chain.unshift(cur);
      cur = cur.prereq ? byId.get(cur.prereq) : null;
    }
    if (chain.length === 0) return `「#${m.prereq}」`;
    const root = chain[0];
    const rootLabel = CLASS_META[root.class]?.[0] ?? '';
    return chain.map((x, i) => (i === 0 ? `${rootLabel}「${x.name}」` : `「${x.name}」`)).join(' → ');
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
   *
   * `available` 預設 **true**：跳過來的人是從「現在有什麼」的看板點進來的，
   * 落地看到一整片「條件未開」等於要他再篩一次（Owner 2026-07-31）。
   * 呼叫端要看全部時明確傳 `available: false`。
   */
  function setFilter({
    jobIds = [], condKinds = [], classes = [], tags = [],
    available = true, hideBulk = true, text = '',
  } = {}) {
    state.jobs = new Set(jobIds);
    state.ranks.clear();
    state.conds = new Set(condKinds);
    state.classes = new Set(classes);
    state.tags = new Set(tags);
    state.text = text;
    state.available = available;
    state.hideBulk = hideBulk;
    el.search.value = text;
    el.onlyAvailable.checked = available;
    el.hideBulk.checked = hideBulk;
    for (const [key, b] of chipIndex.classes) b.setAttribute('aria-pressed', String(state.classes.has(key)));
    for (const [key, b] of chipIndex.tags) b.setAttribute('aria-pressed', String(state.tags.has(key)));
    syncTagChips();
    for (const [id, b] of chipIndex.jobs) b.setAttribute('aria-pressed', String(state.jobs.has(id)));
    for (const [kind, b] of chipIndex.conds) b.setAttribute('aria-pressed', String(state.conds.has(kind)));
    el.rankFilter.querySelectorAll('[aria-pressed]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    render();
  }

  render();
  return { tick, setFilter };
}
