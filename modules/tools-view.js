/**
 * 分頁三：宇宙工具（月球武器）升級鏈。
 * 11 職 × 9 階（原型 v0.1 → v0.8 → 成品），資料直接來自台服 client。
 */

export function createToolsView(root, { chains }) {
  const list = root.querySelector('#tv-list');
  const summary = root.querySelector('#tv-summary');

  const totalUnreleased = chains.reduce((n, c) => n + c.unreleasedStages, 0);
  summary.textContent = totalUnreleased > 0
    ? `${chains.length} 職各 ${chains[0].stages.length} 階。每職另有 ${chains[0].unreleasedStages} 階在台服尚未實裝（客戶端內名稱為空）。`
    : `${chains.length} 職各 ${chains[0].stages.length} 階。`;

  for (const chain of chains) {
    list.append(renderChain(chain));
  }

  function renderChain(chain) {
    const box = document.createElement('section');
    box.className = 'codex-tablet codex-tablet--cyan codex-tablet--padded cos-chain';

    const hud = document.createElement('span');
    hud.className = 'codex-hud';
    hud.setAttribute('aria-hidden', 'true');

    const title = document.createElement('h3');
    title.className = 'codex-h3 cos-chain__title';
    title.textContent = chain.job ?? `職業 #${chain.jobId}`;

    const final = chain.stages[chain.stages.length - 1];
    const goal = document.createElement('span');
    goal.className = 'codex-label cos-chain__goal';
    goal.textContent = `成品：${final.name}`;
    title.append(' ', goal);

    const steps = document.createElement('ol');
    steps.className = 'cos-steps';
    chain.stages.forEach((stage, i) => {
      const li = document.createElement('li');
      li.className = 'cos-step';
      const n = document.createElement('span');
      n.className = 'codex-label codex-label--code cos-step__n';
      n.textContent = i === chain.stages.length - 1 ? 'FIN' : `v0.${i + 1}`;
      const nm = document.createElement('span');
      nm.className = 'codex-body cos-step__name';
      nm.textContent = stage.name;
      li.append(n, nm);
      steps.append(li);
    });

    if (chain.unreleasedStages > 0) {
      const li = document.createElement('li');
      li.className = 'cos-step cos-step--locked';
      const n = document.createElement('span');
      n.className = 'codex-label codex-label--muted cos-step__n';
      n.textContent = '?';
      const nm = document.createElement('span');
      nm.className = 'codex-body cos-step__name';
      nm.textContent = `另有 ${chain.unreleasedStages} 階尚未實裝`;
      li.append(n, nm);
      steps.append(li);
    }

    box.append(hud, title, steps);
    return box;
  }
}
