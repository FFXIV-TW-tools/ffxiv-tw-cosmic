/**
 * `.codex-tabs` 的鍵盤行為。
 *
 * portal 的 `.codex-tabs` **只有樣式、沒有共用鍵盤契約**（_DESIGN-SYSTEM.md 明載，
 * 屬 B-017 Track A3 待辦）——只複製 markup 會做出鍵盤不可及的分頁，故本站自行實作
 * WAI-ARIA tabs pattern：roving tabindex ＋ 左右／Home／End。
 */

/**
 * @param {HTMLElement} tablist 內含 [role=tab] 的容器
 * @param {(id: string) => void} onChange 切換後回呼，收 tab 的 data-tab
 */
export function setupTabs(tablist, onChange) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  if (tabs.length === 0) return { select: () => {} };

  function select(id, { focus = false } = {}) {
    let selected = null;
    for (const tab of tabs) {
      const active = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(active));
      // roving tabindex：只有選中的那顆進 Tab 序列，其餘用方向鍵到達
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
      if (active) selected = tab;
    }
    if (selected && focus) selected.focus();
    if (selected) onChange(id);
  }

  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) select(tab.dataset.tab);
  });

  tablist.addEventListener('keydown', (e) => {
    const current = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    if (current < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    select(tabs[next].dataset.tab, { focus: true });
  });

  return { select };
}
