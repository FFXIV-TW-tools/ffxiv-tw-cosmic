/**
 * 職業看板——本站主畫面。
 *
 * 回答的是：**「這個職業現在有哪些非基礎任務可能出現，還有多久會多出新的」**。
 *
 * ## 三個分類（遊戲自己的分法；資料來自 client 的 c18 ＋ IsSpecialQuest）
 *   · 基礎 231（D/C/B）—— **不進看板**。量大又隨時都在，放進來會把重點淹掉，只在底部留入口。
 *   · 臨時 280（A1/A2/A3）—— **看板主體**。其中 184 個無條件、隨時在池子裡；96 個綁時段條件。
 *   · 緊急 33 —— 另外標，因為它比臨時多一層伺服器事件。
 *
 * ## 三道門（2026-07-31 Owner 連續兩次實地打臉後成文）
 *   1. **階級門**：任務板只給你已解鎖階級的任務 —— 離線不可知，由使用者填。
 *   2. **條件門**：時段／天候。**條件沒開一定不會出現**，反過來不成立。
 *   3. **抽選門**：條件表原名帶 Lottery ——遊戲從「你符合的池」抽幾個給你。
 *      所以本站給的是**池**，不是任務板的實際內容。措辭一律「可能出現」，禁用「可做」。
 *
 * 第一版看板只顯示「限時視窗倒數」，把 184 個無條件臨時任務全藏了 ——
 * Owner 在遊戲內看到 A1 無條件的「製作高性能無人機所需的材料」而網站一片空白，即此段由來。
 */

import { formatDuration } from './eorzea-time.js';

const RANK_LABEL = { 1: 'D', 2: 'C', 3: 'B', 4: 'A1', 5: 'A2', 6: 'A3' };

export function createJobBoardView(root, { windows, missions, conditions, jobs, onJump }) {
  const board = root.querySelector('#jb-board');
  const foot = root.querySelector('#jb-foot');
  const basicCount = missions.filter((m) => m.class === 'basic').length;

  let jobFilter = [];
  let maxRank = null;
  let lastNow = null;

  foot.textContent = '';
  const footBtn = document.createElement('button');
  footBtn.type = 'button';
  footBtn.className = 'codex-btn codex-btn--ghost codex-small';
  footBtn.textContent = `另有 ${basicCount} 個基礎任務（D/C/B）— 看清單`;
  footBtn.addEventListener('click', () => onJump({ classes: ['basic'], jobIds: jobFilter }));
  foot.append(footBtn);

  function setJobs(ids) {
    jobFilter = ids;
    if (lastNow !== null) render(lastNow);
  }

  function setMaxRank(rank) {
    maxRank = rank;
    if (lastNow !== null) render(lastNow);
  }

  /** 該職業、在你階級內、且非基礎的任務。 */
  function poolFor(jobId) {
    return missions
      .filter((m) => m.class !== 'basic')
      .filter((m) => m.jobs.includes(jobId))
      .filter((m) => maxRank === null || m.rank <= maxRank);
  }

  /** 條件此刻是否成立。無條件恆真；語意未定回 null（不可當 false）。 */
  function condOpen(m, now) {
    const c = conditions[m.cond];
    if (!c || c.type === 'none') return true;
    const w = windows.find((x) => x.condId === m.cond);
    return w ? w.isOpen(now) : null;
  }

  /** 下一個「會讓池子變多」的視窗。 */
  function nextWindow(jobId, now) {
    let best = null;
    for (const w of windows) {
      if (!w.jobs.includes(jobId)) continue;
      if (w.isOpen(now) !== false) continue;
      const at = w.next(now);
      if (!at) continue;
      const list = w.missions
        .filter((m) => m.jobs.includes(jobId))
        .filter((m) => maxRank === null || m.rank <= maxRank);
      if (list.length === 0) continue;
      const eta = at.start - now;
      if (!best || eta < best.eta) best = { window: w, at, list, eta };
    }
    return best;
  }

  function render(now) {
    lastNow = now;
    board.innerHTML = '';
    const wanted = jobFilter.length ? new Set(jobFilter) : null;
    const rows = Object.entries(jobs)
      .map(([id, job]) => ({ id: Number(id), job }))
      .filter((r) => !wanted || wanted.has(r.id))
      .map((r) => {
        const pool = poolFor(r.id);
        return { ...r, open: pool.filter((m) => condOpen(m, now) === true), next: nextWindow(r.id, now) };
      })
      .sort((a, b) => b.open.length - a.open.length || (a.next?.eta ?? Infinity) - (b.next?.eta ?? Infinity));

    for (const row of rows) board.append(card(row));
  }

  function card({ id, job, open, next }) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cos-jc';
    if (open.length > 0) el.classList.add('is-open');

    const head = document.createElement('span');
    head.className = 'cos-jc__head';
    const icon = document.createElement('img');
    icon.className = 'cos-jc__icon';
    icon.src = `img/jobs/${job.abbr}.png`;
    icon.alt = '';
    icon.width = 32;
    icon.height = 32;
    icon.loading = 'lazy';
    const name = document.createElement('span');
    name.className = 'codex-body cos-jc__name';
    name.textContent = job.label;
    head.append(icon, name);
    el.append(head);

    // 主數字＝池子裡現在有幾個非基礎任務。刻意不寫「板上有幾個」——中間還隔著抽選。
    const big = document.createElement('span');
    big.className = 'codex-h3 cos-jc__eta';
    if (open.length === 0) {
      big.textContent = '目前沒有';
      big.classList.add('is-none');
    } else {
      big.textContent = `${open.length} 個可能出現`;
    }
    el.append(big);

    const verb = job.role === 'gatherer' ? '採集' : '製作';
    const temp = open.filter((m) => m.class === 'temporary');
    const crit = open.filter((m) => m.class === 'critical');
    const ranks = [...new Set(temp.map((m) => RANK_LABEL[m.rank]))].sort();

    const kind = document.createElement('span');
    kind.className = 'codex-small cos-jc__kind';
    kind.textContent = open.length === 0
      ? `${verb} · 你的階級沒有臨時任務`
      : `${verb} · 臨時 ${temp.length}${ranks.length ? `（${ranks.join('／')}）` : ''}${crit.length ? ` · 緊急 ${crit.length}` : ''}`;
    el.append(kind);

    const cond = document.createElement('span');
    cond.className = 'codex-small cos-jc__cond';
    cond.textContent = next
      ? `${formatDuration(next.eta)}後多 ${next.list.length} 個（${next.window.label}）`
      : '沒有即將開啟的條件視窗';
    el.append(cond);

    if (crit.length > 0) {
      const c = document.createElement('span');
      c.className = 'codex-small cos-jc__crit';
      c.textContent = `⚡ 其中 ${crit.length} 個緊急 — 還需伺服器觸發事件`;
      el.append(c);
    }
    if (next && !next.window.verified) {
      const u = document.createElement('span');
      u.className = 'codex-small cos-jc__unverified';
      u.textContent = '⚠ 時段解讀未經遊戲內驗證';
      el.append(u);
    }

    el.dataset.help = [
      '本站給的是「池」，不是任務板的實際內容 —— 中間還隔著遊戲的抽選',
      `臨時 ${temp.length} 個${crit.length ? `、緊急 ${crit.length} 個` : ''}`,
      next ? `${formatDuration(next.eta)}後「${next.window.label}」開啟，池子會多 ${next.list.length} 個` : '',
      '點一下看清單',
    ].filter(Boolean).join('｜');
    el.addEventListener('click', () => onJump({ jobIds: [id], classes: ['temporary', 'critical'] }));
    return el;
  }

  return { render, setJobs, setMaxRank };
}
