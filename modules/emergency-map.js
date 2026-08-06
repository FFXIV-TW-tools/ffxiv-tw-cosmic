/**
 * 緊急任務地點圖：底圖 ＋ 每個任務一顆座標點。
 *
 * <b>三種資料的可信度不同，畫面上必須分得出來</b>：
 * 1. **座標與底圖** — 台服 client 直出（`WKSMissionMapMarker` ／ `ui/map/c1w1/21`），最硬。
 * 2. **變體分組（哪幾個任務算同一次事件）** — 來自 ICE 的對照表（國際服），但已用台服 client
 *    幾何交叉驗證：33 筆完整分割無遺漏、每組的製作任務座標與該組錨點差 4～19 單位，
 *    採集／釣魚職差得遠是因為上游存交付點、client 存採集區（2026-08-03 驗）。
 * 3. **這次是哪一組** — 由**任務板**判定（後端 `resolveGroup()`，插件送 `missionIds`）。
 *    判得出來就直接開那一組並標「✓」；判不出來就六組都列著讓人自己對，**不猜**。
 *
 * ⚠️ 原本走的是「開始通告文字 → 變體 → 推定組別」，2026-08-03 利維坦實測**證偽**：
 * 事件開始時聊天欄只有一句「發生了緊急情況。」，client 解出的那六則一句都沒出現。
 */

import { VARIANT_MISSIONS } from './variant-groups.js';

const WEATHER_NAMES = { storm: '磁暴', meteor: '流星雨', spore: '孢子霧' };

/** `storm-α` → `storm`。 */
const kindOf = (group) => group.split('-')[0];

/** 標籤最小垂直間距（圖寬的百分比）。pin 高約 23px、圖寬 440px ⇒ 5.3%；取 6% 留一點縫。 */
const MIN_GAP = 6;

/**
 * ⚠️ **client 的 `MassivePcContentTextData` 有六則「開始通告」文字，但它們不在聊天欄。**
 *
 * 2026-08-03 利維坦實測：磁暴事件開始時聊天欄只有一句「發生了緊急情況。」，那六句
 * 一句都沒出現（Owner 推測是任務 NPC 附近的區域訊息）。整個「靠通告文字分辨 A／B」
 * 的前提因此不成立 ⇒ **已從畫面移除**，在確認它們到底出現在哪個介面之前不再宣稱它們是通告。
 *
 * 現在的判準改用**任務板**：任務 id 直接就決定是哪一組，不必經過文字。
 */

/**
 * 每一組的**代表任務**，拿來當按鈕副標。任務板上出現的是哪幾個任務是玩家看得到的事實，
 * 也是插件判組的同一個依據——人跟程式看的是同一件東西。
 */
const GROUP_HINT = {
  'storm-α': '吸引器・無人機搜索',
  'storm-β': '落腳台・照明・儲備糧',
  'meteor-α': '鑽頭・月球車維修',
  'meteor-β': '吸嘴・氣罐・防毒面具',
  'spore-α': '火焰噴射器・菌絲建材',
  'spore-β': '助燃材料・防火裝備',
};

/**
 * 世界座標 → 圖上百分比。公式與 monorepo 其他工具同一條
 *（`QuickIsland/MapHelper.cs`、`build_upstream_names.py`）：
 *   map = (41 / c) × ((world + offset) × c + 1024) / 2048 + 1，  c = sizeFactor / 100
 * 再把 1–41 的地圖座標換成 0–100%。
 *
 * **驗證**：518 算出 (24.8, 32.6)，ICE 獨立記載的 `MapInfo` 是 (24.7, 32.5)；
 * 512 算出 (20.0, 37.0) 對 (19.9, 36.9)。兩個獨立來源對得上才採用。
 */
function toPercent(world, offset, sizeFactor) {
  const c = sizeFactor / 100;
  const map = (41 / c) * ((world + offset) * c + 1024) / 2048 + 1;
  return ((map - 1) / 40) * 100;
}

/**
 * 半徑（世界單位）→ 圖上百分比。同一條換算的**差分**形式：offset 與 sizeFactor 相消，
 * 只剩 `41 / 2048 / 40`。
 *
 * 這一欄是 client 給的（`WKSMissionMapMarker.c3`），就是遊戲在地圖上畫的那個範圍圈。
 * 採集區有半徑（80／100／120），交付點是 0 ⇒ **0 不是缺值，是「這裡是一個點」**。
 */
function radiusPercent(r, sizeFactor) {
  return (r * (41 / sizeFactor * 100) / 2048 / 40) * 100 * (sizeFactor / 100);
}

/**
 * @param {HTMLElement} root #panel-emergency
 * @param {object} data missions.json
 */
export function createEmergencyMap(root, data) {
  const el = {
    overlay: root.querySelector('#em-map-overlay'),
    title: root.querySelector('#em-map-title'),
    close: root.querySelector('#em-map-close'),
    cancel: root.querySelector('#em-map-cancel'),
    picker: root.querySelector('#em-map-picker'),
    note: root.querySelector('#em-map-note'),
    img: root.querySelector('#em-map-img'),
    pins: root.querySelector('#em-map-pins'),
    legend: root.querySelector('#em-map-legend'),
  };
  const cfg = data.map;
  if (!el.picker || !cfg) return { open() {} };

  el.img.src = cfg.image;

  const byId = new Map(data.missions.map((m) => [m.id, m]));
  const jobLabel = (i) => data.jobs?.[i]?.label ?? `職業 ${i}`;
  const jobAbbr = (i) => data.jobs?.[i]?.abbr ?? '';

  /** 目前選的組（一定是單一組——一次事件只會出一組）。 */
  let selected = 'storm-α';
  let releaseTrap = null;
  /** 這次事件已由任務板確認的組（`storm-α`…）。沒確認就是 null——不猜。 */
  let confirmedGroup = null;

  /**
   * 建按鈕列。**只放這次事件那個天氣的兩組**（天氣未知才放全部六組）——
   * 這張圖是**某一筆事件的**，不是共用查詢表（Owner 2026-08-03：
   * 「不要共用地圖，到時候每個緊急一起出你怎麼顯示」）。
   */
  function buildPicker(kind) {
    el.picker.replaceChildren();
    const kinds = kind ? [kind] : Object.keys(WEATHER_NAMES);
    // **一種天氣一行**（Owner 2026-08-03）。六顆按鈕擠成一排時，「哪兩顆是同一種天氣」
    // 只能靠讀字判斷；分行之後那個分組是版面本身講出來的。
    for (const k of kinds) {
      const row = document.createElement('div');
      row.className = 'cos-map__pickrow';

      const label = document.createElement('span');
      label.className = 'codex-label cos-map__pickname';
      label.textContent = WEATHER_NAMES[k];
      row.append(label);

      for (const [key, ab] of [[`${k}-α`, 'A'], [`${k}-β`, 'B']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'codex-btn codex-btn--ghost codex-small cos-map__pick';
        b.dataset.key = key;
        // A／B 直接寫在按鈕上（Owner 2026-08-03：「還是有區分更明顯」）。**它只是組的編號**
        // ——現在辨識靠的是任務板上的任務，不是通告文字（那條路已證實走不通，見檔頭）。
        const name = document.createElement('strong');
        name.textContent = `${WEATHER_NAMES[k]} ${ab}`;
        b.append(name);
        const hint = document.createElement('span');
        hint.className = 'cos-map__hint';
        hint.textContent = GROUP_HINT[key] ?? '';
        b.append(hint);
        b.addEventListener('click', () => {
          selected = key;
          render();
        });
        row.append(b);
      }
      el.picker.append(row);
    }
  }

  function render() {
    // **要 querySelectorAll('button')，不能用 `children`**：改成「一種天氣一行」之後，
    // picker 的直接子層是 row 容器、不是按鈕 ⇒ `dataset.key` 全是 undefined，
    // 選中狀態永遠不會亮，而且**不會報錯**（2026-08-03 實測才發現）。
    for (const b of el.picker.querySelectorAll('button')) {
      b.classList.toggle('cos-map__pick--on', b.dataset.key === selected);
    }

    const groups = [selected];
    const kind = selected.split('-')[0];

    // **不講資料怎麼來的**（Owner 2026-08-05：「不要顯示什麼插件從哪裡讀到的，就說是這張地圖」
    // ——與 2026-08-02「不顯示回報來源」同一條）。對看的人來說要緊的是「是不是這一組」，
    // 而不是這個結論怎麼得出來的。
    el.note.replaceChildren();
    const how = document.createElement('span');
    how.className = 'cos-map__ann';
    how.textContent = confirmedGroup === selected
      ? '✓ 這次的事件就是這一組'
      : `這一組的任務：${GROUP_HINT[selected] ?? ''}`;
    if (confirmedGroup === selected) how.classList.add('cos-map__confirmed');
    el.note.append(how);

    el.pins.replaceChildren();
    el.legend.replaceChildren();

    groups.forEach((g, gi) => {
      // 同一個地點常有 2–3 個職業的任務 ⇒ 先按座標併點，否則圖上是一堆疊在一起的圓
      const spots = new Map();
      for (const id of VARIANT_MISSIONS[g] ?? []) {
        const m = byId.get(id);
        if (!m?.marker) continue;
        const key = `${m.marker.x},${m.marker.y}`;
        if (!spots.has(key)) spots.set(key, { marker: m.marker, missions: [] });
        spots.get(key).missions.push(m);
      }

      // 先算好每顆的位置，讓開重疊之後才畫（同一組裡常有兩個點只差幾個百分點，
      // 標籤直接畫上去會疊成一團看不出誰是誰 —— Owner 2026-08-03 截圖）
      const placed = [...spots.values()].map((spot, i) => ({
        spot,
        n: i + 1,
        x: toPercent(spot.marker.x, cfg.offsetX, cfg.sizeFactor),
        y: toPercent(spot.marker.y, cfg.offsetY, cfg.sizeFactor),
      }));
      deOverlap(placed);
      for (const p of placed) {
        el.pins.append(pin(p, g, gi));
        el.legend.append(legendItem(p.spot, gi, p.n));
      }
    });
  }

  /**
   * 讓重疊的標籤上下讓開。**只動標籤，不動地點**——真實座標另外畫（範圍圈或點）釘在原位，
   * 標籤移走了也還看得出正確位置。由上而下掃一次就夠（點不多）。
   */
  function deOverlap(placed) {
    const sorted = [...placed].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      // 橫向也靠得夠近才會真的疊到，否則不必動
      if (Math.abs(cur.x - prev.x) > 14) continue;
      if (cur.y - prev.y >= MIN_GAP) continue;
      cur.y = prev.y + MIN_GAP;
    }
  }

  /**
   * 一個地點一顆 pin，**上面直接畫該地點要去的職業圖示**（Owner 2026-08-03）。
   * 只寫編號的話還是得對照下面的圖例才知道自己該不該去，等於沒有畫在圖上。
   */
  function pin(p, group, groupIndex) {
    const { spot, n } = p;
    const wrap = document.createElement('div');
    wrap.className = 'cos-map__spot';
    wrap.title = `${spot.missions.map((m) => `${m.jobs.map(jobLabel).join('・')}：${m.name}`).join('\n')}`;

    // 真實座標。有半徑就畫成**範圍圈**（＝遊戲地圖上那個圈，資料出自 `WKSMissionMapMarker` 的
    // 半徑欄），沒有就畫一個點——client 的 0 是「這裡是一個點」（交付／製作處），不是缺值。
    const rp = radiusPercent(spot.marker.r, cfg.sizeFactor);
    const at = document.createElement('span');
    at.className = rp > 0
      ? `cos-map__area cos-map__area--g${groupIndex}`
      : `cos-map__dot cos-map__dot--g${groupIndex}`;
    at.style.left = `${toPercent(spot.marker.x, cfg.offsetX, cfg.sizeFactor)}%`;
    at.style.top = `${toPercent(spot.marker.y, cfg.offsetY, cfg.sizeFactor)}%`;
    if (rp > 0) {
      at.style.width = `${rp * 2}%`;
      at.style.height = `${rp * 2}%`;
    }
    wrap.append(at);

    const d = document.createElement('div');
    d.className = `cos-map__pin cos-map__pin--g${groupIndex}`;
    d.style.left = `${p.x}%`;
    d.style.top = `${p.y}%`;

    const seq = document.createElement('span');
    seq.className = 'cos-map__pinno';
    seq.textContent = String(n);
    d.append(seq);

    // 同一個點的職業可能重複（兩個任務同職），去重後才不會畫出兩顆一樣的圖示
    for (const j of [...new Set(spot.missions.flatMap((m) => m.jobs))]) {
      const abbr = jobAbbr(j);
      if (!abbr) continue;
      const icon = document.createElement('img');
      icon.src = `img/jobs/${abbr}.png`;
      icon.alt = jobLabel(j);
      icon.className = 'cos-map__pinjob';
      icon.loading = 'lazy';
      d.append(icon);
    }
    wrap.append(d);
    return wrap;
  }

  /**
   * 圖例：編號 ＋ 該點的職業圖示。**不列任務名**（Owner 2026-08-03「任務名稱不用顯示」）——
   * 要決定的是「我這個職業要不要去、去哪一點」，任務名在遊戲的任務板上本來就看得到。
   * 名稱仍留在 pin 的 title（滑鼠停上去看得到），不是刪掉資訊，是不佔版面。
   */
  function legendItem(spot, groupIndex, n) {
    const li = document.createElement('li');
    li.className = 'cos-map__legenditem';

    const badge = document.createElement('span');
    badge.className = `cos-map__pin cos-map__pin--g${groupIndex} cos-map__pin--static`;
    badge.textContent = String(n);
    li.append(badge);

    // 同一點的職業可能重複（兩個任務同職），去重後才不會出現兩顆一樣的圖示
    for (const j of [...new Set(spot.missions.flatMap((m) => m.jobs))]) {
      const abbr = jobAbbr(j);
      const item = document.createElement('span');
      item.className = 'cos-map__job';
      if (abbr) {
        const icon = document.createElement('img');
        icon.src = `img/jobs/${abbr}.png`;
        icon.alt = '';
        icon.className = 'cos-map__jobicon';
        icon.loading = 'lazy';
        item.append(icon);
      }
      const text = document.createElement('span');
      text.textContent = jobLabel(j);
      item.append(text);
      li.append(item);
    }
    return li;
  }

  function openModal() {
    el.overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    releaseTrap = window.FFXIVA11y?.trapFocus?.(el.overlay) ?? null;
  }

  function closeModal() {
    el.overlay.hidden = true;
    document.body.style.overflow = '';
    releaseTrap?.();
    releaseTrap = null;
  }

  el.close?.addEventListener('click', closeModal);
  el.cancel?.addEventListener('click', closeModal);
  el.overlay?.addEventListener('click', (e) => {
    if (e.target === el.overlay) closeModal();   // 只認遮罩本身
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.overlay.hidden) closeModal();
  });

  return {
    /**
     * 開某一筆事件的地圖。**伺服器與天氣都由那一列給**，不是共用一張圖去猜——
     * 兩台同時出不同天氣的事件時，共用那張圖必然有一台是錯的
     *（Owner 2026-08-03：「不要共用地圖，到時候每個緊急一起出你怎麼顯示」）。
     *
     * 天氣已知 ⇒ 只放那個天氣的兩組（範圍從六縮到二是有依據的）；未知 ⇒ 六組都放。
     *
     * **組別一律由 `group` 帶進來，這裡不自己推**：通告文字（`storm-a`／`storm-b`）↔ 任務分組
     * （α／β）的對應已於 2026-08-06 全數定案（B-023），但那份對應表**存在後端**
     * （`variant_map`，實測共現學到的），由 `_fillFromBoard()` 直接把 `groupKey` 填進事件 ⇒
     * 前端拿到的 `ev.group` 已經是答案。前端再算一次就是第二份真相。
     * `group` 為空＝那筆連通告變體都沒人填，此時仍不自動選——猜對的機率是一半，
     * 而使用者不會知道它選錯了。
     */
    open(world, kind, group) {
      // 任務板已經確認是哪一組 ⇒ **直接開那一組**，不必讓人自己選、也沒有猜的餘地。
      confirmedGroup = VARIANT_MISSIONS[group] ? group : null;
      const known = WEATHER_NAMES[kind] ? kind : (confirmedGroup ? kindOf(confirmedGroup) : null);
      // world 為空＝**速查模式**（不綁任何一筆事件，六組都列）。沒有事件時也想先看
      // 「這六組分別長什麼樣」是合理的（Owner 2026-08-03），而那與「這筆事件要去哪」
      // 是兩個不同的問題 —— 標題要講清楚是哪一個，否則速查會被當成現況。
      el.title.textContent = !world
        ? '任務地點速查 — 六組固定地點'
        : known
          ? `${world} · ${WEATHER_NAMES[known]} — 任務地點`
          : `${world} — 任務地點（這筆沒填天氣，六組都列出來對照）`;
      buildPicker(known);
      selected = confirmedGroup ?? `${known ?? 'storm'}-α`;
      render();
      openModal();
    },
  };
}
