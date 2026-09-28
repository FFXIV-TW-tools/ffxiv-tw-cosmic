import { ICONS } from './cos_icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'codex-ico');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = ICONS[name];
  return svg;
}

export function hydrateIcons(root = document) {
  for (const svg of root.querySelectorAll('svg[data-cos-icon]')) {
    svg.innerHTML = ICONS[svg.dataset.cosIcon];
    svg.setAttribute('focusable', 'false');
  }
}
