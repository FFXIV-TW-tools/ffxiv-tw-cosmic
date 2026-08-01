/**
 * 「我練的職業」偏好——建議面板要有這個才不會變成 11 職的雜訊牆。
 *
 * 用 localStorage 而不是 portal 的 `FFXIVSettings`：那是跨工具的雲端同步偏好，
 * 這個純屬本站的檢視狀態，沒有跨工具語意，塞進去只會污染共用設定面。
 */

import { jobIcon } from './job-icon.js';

const KEY = 'ffxiv-tw-cosmic:jobs';

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

  // 製作職在上、採集職在下（與任務清單的職業篩選同一個分組方式）
  const jobRows = { crafter: iconRow(), gatherer: iconRow() };
  for (const [id, job] of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'codex-chip cos-chip--icon';
    b.append(jobIcon(job, { size: 22 }));
    b.setAttribute('aria-label', job.label);
    b.title = job.label;
    b.setAttribute('aria-pressed', String(selected.has(id)));
    b.addEventListener('click', () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      b.setAttribute('aria-pressed', String(selected.has(id)));
      commit();
    });
    (jobRows[job.role] ?? jobRows.crafter).append(b);
  }
  body.append(jobRows.crafter, jobRows.gatherer);

  function iconRow() {
    const d = document.createElement('div');
    d.className = 'cos-chips cos-chips--row';
    return d;
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
