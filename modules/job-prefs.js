/**
 * 「我練的職業」偏好——建議面板要有這個才不會變成 11 職的雜訊牆。
 *
 * 用 localStorage 而不是 portal 的 `FFXIVSettings`：那是跨工具的雲端同步偏好，
 * 這個純屬本站的檢視狀態，沒有跨工具語意，塞進去只會污染共用設定面。
 */

const KEY = 'ffxiv-tw-cosmic:jobs';
const RANK_KEY = 'ffxiv-tw-cosmic:rank';

/** 階級由低到高。任務板只會出現「你已解鎖的階級」的任務——這是離線不可知的個人進度。 */
export const RANKS = [
  { value: 1, label: 'D' },
  { value: 2, label: 'C' },
  { value: 3, label: 'B' },
  { value: 4, label: 'A1' },
  { value: 5, label: 'A2' },
  { value: 6, label: 'A3' },
];

export function loadRank() {
  const n = Number(localStorage.getItem(RANK_KEY));
  return RANKS.some((r) => r.value === n) ? n : null;
}

export function saveRank(rank) {
  try {
    if (rank) localStorage.setItem(RANK_KEY, String(rank));
    else localStorage.removeItem(RANK_KEY);
  } catch {
    // 記不住不影響本次 session
  }
}

/**
 * 「我目前的最高階級」選擇器。
 * 由來＝2026-07-31 Owner 實地回報「條件符合了但現場一個任務都沒看到」：全部 119 個條件任務
 * 都是 A2／A3 高難或緊急，沒解鎖該階級的人條件開了也看不到。這是離線算不出來、
 * 只能由使用者提供的關鍵輸入。
 */
export function createRankPicker(host, onChange) {
  const field = document.createElement('span');
  field.className = 'cos-rankpick';

  const label = document.createElement('label');
  label.className = 'codex-label';
  label.setAttribute('for', 'rank-pick');
  label.textContent = '我的階級';

  const sel = document.createElement('select');
  sel.className = 'codex-select';
  sel.id = 'rank-pick';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '未設定';
  sel.append(none);
  for (const r of RANKS) {
    const o = document.createElement('option');
    o.value = String(r.value);
    o.textContent = r.label;
    sel.append(o);
  }
  const current = loadRank();
  sel.value = current ? String(current) : '';

  sel.addEventListener('change', () => {
    const v = Number(sel.value) || null;
    saveRank(v);
    onChange(v);
  });

  field.append(label, sel);
  host.append(field);
  return { get: () => Number(sel.value) || null };
}

export function loadJobs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // 存進去的是使用者資料，讀回來要當外部輸入驗——手改／舊格式都可能是任何東西
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export function saveJobs(jobIds) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...jobIds].sort((a, b) => a - b)));
  } catch {
    // 私密模式／配額滿：偏好記不住不影響任何功能，靜默降級即可
  }
}

/**
 * 建立 page-header 上的職業選擇器。
 * @param {HTMLElement} host
 * @param {object} jobs data/missions.json 的 jobs（id → {label,...}）
 * @param {(ids:number[]) => void} onChange
 */
export function createJobPicker(host, jobs, onChange) {
  const selected = new Set(loadJobs());
  const entries = Object.entries(jobs).map(([id, j]) => [Number(id), j]);

  const details = document.createElement('details');
  details.className = 'codex-accordion cos-jobpick';

  const summary = document.createElement('summary');
  summary.className = 'cos-jobpick__summary';
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'codex-accordion__body cos-jobpick__body';
  details.append(body);

  for (const [id, job] of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'codex-chip';
    b.textContent = job.label;
    b.setAttribute('aria-pressed', String(selected.has(id)));
    b.addEventListener('click', () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      b.setAttribute('aria-pressed', String(selected.has(id)));
      commit();
    });
    body.append(b);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'codex-btn codex-btn--ghost codex-small';
  clear.textContent = '全部清除';
  clear.addEventListener('click', () => {
    selected.clear();
    body.querySelectorAll('[aria-pressed]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    commit();
  });
  body.append(clear);

  function label() {
    if (selected.size === 0) return '⚙ 我練的職業：全部';
    const names = entries.filter(([id]) => selected.has(id)).map(([, j]) => j.label);
    return `⚙ 我練的職業：${names.length <= 3 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 職`}`;
  }

  function commit() {
    summary.textContent = label();
    saveJobs(selected);
    onChange([...selected]);
  }

  summary.textContent = label();
  host.append(details);
  return { get: () => [...selected] };
}
