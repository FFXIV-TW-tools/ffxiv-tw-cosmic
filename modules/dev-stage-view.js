/**
 * 分頁四：月門基地開發進度。
 *
 * ⚠️ **這一頁的資料一半來自使用者**。client 只知道「有哪些階段」（16 期／63 個施工階段），
 * **「你的伺服器現在在第幾期」是伺服器狀態、離線完全不可知**——所以由使用者自己選，
 * 每個伺服器分開記（伊弗利特與利維坦本來就會在不同期）。
 *
 * 頁面上必須讓人看得出哪部分是查來的、哪部分是自己填的，不能混成一體讓人以為全是實測。
 */

const KEY = 'ffxiv-tw-cosmic:phases';

function loadPhases() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // localStorage 是使用者資料，讀回來當外部輸入驗
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [world, phase] of Object.entries(parsed)) {
      if (Number.isInteger(phase) && phase >= 1 && phase <= 99) out[world] = phase;
    }
    return out;
  } catch {
    return {};
  }
}

function savePhases(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 私密模式／配額滿：記不住不影響查閱，靜默降級
  }
}

export function createDevStageView(root, { devData }) {
  const el = {
    world: root.querySelector('#ds-world'),
    phase: root.querySelector('#ds-phase'),
    summary: root.querySelector('#ds-summary'),
    list: root.querySelector('#ds-list'),
  };

  const phases = devData.phases;
  const stages = devData.stages;
  const saved = loadPhases();
  let world = Object.keys(saved)[0] ?? devData.worlds[0];

  for (const w of devData.worlds) {
    const o = document.createElement('option');
    o.value = w;
    o.textContent = w;
    el.world.append(o);
  }
  el.world.value = world;

  const unset = document.createElement('option');
  unset.value = '';
  unset.textContent = '尚未設定';
  el.phase.append(unset);
  for (const p of phases) {
    const o = document.createElement('option');
    o.value = String(p.phase);
    o.textContent = `第 ${p.phase} 期 — ${p.title}`;
    el.phase.append(o);
  }

  el.world.addEventListener('change', () => {
    world = el.world.value;
    render();
  });
  el.phase.addEventListener('change', () => {
    const v = Number(el.phase.value);
    if (v) saved[world] = v;
    else delete saved[world];
    savePhases(saved);
    render();
  });

  function render() {
    el.phase.value = saved[world] ? String(saved[world]) : '';
    el.list.innerHTML = '';
    el.summary.innerHTML = '';

    const current = saved[world];
    if (!current) {
      const empty = document.createElement('div');
      empty.className = 'codex-empty';
      empty.innerHTML = '';
      const icon = document.createElement('div');
      icon.className = 'codex-empty__icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '🏗';
      const text = document.createElement('div');
      text.textContent = `選一個「目前期數」— 遊戲內開拓紀錄看得到 ${world} 現在到第幾期`;
      empty.append(icon, text);
      el.list.append(empty);
      return;
    }

    const cur = phases.find((p) => p.phase === current);
    const next = phases.find((p) => p.phase === current + 1);

    el.summary.append(
      stat('目前', `第 ${current} 期`, cur?.title ?? ''),
      stat('進度', `${current} / ${phases.length}`, `還有 ${Math.max(0, phases.length - current)} 期`),
      next
        ? stat('下一期', `第 ${next.phase} 期`, next.title)
        : stat('下一期', '已完結', '全部工程都完成了'),
    );

    // 目前期到下一期之間要經過的施工階段＝ [cur.fromStage+1, next.fromStage]
    if (!next) return;
    const todo = stages.filter((s) => s.id > cur.fromStage && s.id <= next.fromStage);
    el.list.append(stageList(todo, next));
  }

  function stat(label, value, note) {
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

  function stageList(todo, next) {
    const wrap = document.createElement('div');
    const h = document.createElement('h3');
    h.className = 'codex-h3 cos-ds-title';
    h.textContent = `到第 ${next.phase} 期還要經過 ${todo.length} 個施工階段`;
    wrap.append(h);

    const ol = document.createElement('ol');
    ol.className = 'cos-ds-steps';
    for (const s of todo) {
      const li = document.createElement('li');
      li.className = 'cos-ds-step';
      if (s.milestone) li.classList.add('is-milestone');
      const t = document.createElement('span');
      t.className = 'codex-body cos-ds-step__title';
      t.textContent = s.title;
      const g = document.createElement('span');
      g.className = 'codex-small cos-ds-step__grade';
      g.textContent = `基地等級 ${s.grade}`;
      li.append(t, g);
      ol.append(li);
    }
    wrap.append(ol);
    return wrap;
  }

  render();
  return { render };
}
