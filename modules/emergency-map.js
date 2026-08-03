/**
 * 緊急任務地點圖：底圖 ＋ 每個任務一顆座標點。
 *
 * <b>三種資料的可信度不同，畫面上必須分得出來</b>：
 * 1. **座標與底圖** — 台服 client 直出（`WKSMissionMapMarker` ／ `ui/map/c1w1/21`），最硬。
 * 2. **變體分組（哪幾個任務算同一次事件）** — 來自 ICE 的對照表（國際服），但已用台服 client
 *    幾何交叉驗證：33 筆完整分割無遺漏、每組的製作任務座標與該組錨點差 4～19 單位，
 *    採集／釣魚職差得遠是因為上游存交付點、client 存採集區（2026-08-03 驗）。
 * 3. **通告文字 ↔ 變體** — **未知**。通告分得出兩則、任務分得出兩組，但兩者之間沒有證據
 *    （B-023）。⇒ 兩組各自獨立呈現、按鈕用「這組有什麼任務」當標籤，**不掛 A／B**：
 *    掛了就是把猜測寫成事實，而猜錯的人會跑錯半張圖。不猜（AGENTS 鐵則 §2）。
 */

/**
 * 六個變體各自的任務 id。權威＝ICE fork `GatheringUtil.UpdateCriticalWeather()`。
 *
 * **這裡刻意只放 id，不放座標**——座標一律從 `missions.json` 的 `marker` 現查，
 * 抄一份進來就是第二份真相，台服改版後兩邊各自漂移（同 AGENTS 鐵則 §3 的道理）。
 *
 * 分組只到「渴望灣」為止。上游另有 Phaenna（第二張圖）的 18 筆，台服未實裝 ⇒ 不放。
 */
const VARIANT_MISSIONS = {
  'storm-α': [518, 522, 530, 537, 543],
  'storm-β': [512, 521, 527, 533, 536, 542],
  'meteor-α': [515, 524, 538, 519, 523],
  'meteor-β': [516, 520, 525, 531, 534, 539],
  'spore-α': [517, 532, 514, 529, 541],
  'spore-β': [513, 526, 528, 535, 540, 544],
};

const WEATHER_NAMES = { storm: '磁暴', meteor: '流星雨', spore: '孢子霧' };

/** 標籤最小垂直間距（圖寬的百分比）。pin 高約 23px、圖寬 440px ⇒ 5.3%；取 6% 留一點縫。 */
const MIN_GAP = 6;

/**
 * 兩則**開始**通告，順序＝client 內的順序（預告那則兩組共用，分不出來所以不列在這）。
 *
 * ⚠️ **索引 0→α、1→β 是「排列順序相同」的假設，不是已證實的對應**（Owner 2026-08-03
 * 兩次要求分開顯示後採用）。真正的證據要等插件抓到一筆**同時**有開始通告與任務板的紀錄
 * ——那時任務 id 落在哪一組就直接定案（docs/BACKLOG.md B-023）。
 *
 * 在那之前 UI 上必須留「待實測」記號：這一欄錯了會把人送到地圖的另一半，
 * 而錯的形式是**完全沒有訊號**（畫面照常、通告也照常，只是指錯地方）。
 */
const START_ANNOUNCEMENTS = {
  storm: ['已確認磁暴造成惡劣影響…收集救災所需的物資', '磁暴造成渴望灣多個地區受災…展開救災活動'],
  meteor: ['有小型隕石雨墜落在月門基地附近…恢復生產建設秩序', '隕石雨墜落造成的衝擊導致地面氣體外洩'],
  spore: ['渴望灣東部爆發孢子霧…查明是否出現變異菌床', '孢子霧吞沒渴望灣東部…除去變異菌床'],
};

/**
 * 每一組的**代表任務**（取該組的頭兩個），拿來當按鈕副標。
 *
 * 這是目前唯一**分得準**的識別方式：任務板上出現的是哪幾個任務是看得到的事實，
 * 而「A 組／B 組」這種標籤在對應關係確定之前只是編號。
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
        // A／B 直接寫在按鈕上（Owner 2026-08-03：「還是有區分更明顯」）。**這個編號的
        // 對應仍是推定**（見 START_ANNOUNCEMENTS），所以每一組底下那行「※ 待實測確認」
        // 不能拿掉——編號一旦看起來像事實，就沒有人會去驗它。
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
    for (const b of el.picker.children) {
      b.classList.toggle('cos-map__pick--on', b.dataset.key === selected);
    }

    const groups = [selected];
    const kind = selected.split('-')[0];

    // **只顯示這一組自己的那一則**（Owner 2026-08-03：「磁暴 A 只顯示 A 的對話，不要混一起」）。
    // 對應依 client 排列順序推定（見 START_ANNOUNCEMENTS 註解），所以後面掛一個短記號——
    // 沒有記號的話，這條假設會在畫面上看起來像已知事實。
    const idx = selected.endsWith('α') ? 0 : 1;
    el.note.replaceChildren();
    const line = document.createElement('span');
    line.className = 'cos-map__ann';
    line.textContent = `「${START_ANNOUNCEMENTS[kind][idx]}」`;
    el.note.append(line);
    const mark = document.createElement('span');
    mark.className = 'cos-map__ann cos-map__pending';
    mark.textContent = '※ 通告與任務組的對應待實測確認';
    el.note.append(mark);

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
     * **不自動選定其中一組**：通告文字（`storm-a`／`storm-b`）與任務分組（α／β）的對應
     * 目前無證據（B-023），自動選只有一半機率對，而使用者不會知道它選錯了。
     */
    open(world, kind) {
      const known = WEATHER_NAMES[kind] ? kind : null;
      // world 為空＝**速查模式**（不綁任何一筆事件，六組都列）。沒有事件時也想先看
      // 「這六組分別長什麼樣」是合理的（Owner 2026-08-03），而那與「這筆事件要去哪」
      // 是兩個不同的問題 —— 標題要講清楚是哪一個，否則速查會被當成現況。
      el.title.textContent = !world
        ? '任務地點速查 — 六組固定地點'
        : known
          ? `${world} · ${WEATHER_NAMES[known]} — 任務地點`
          : `${world} — 任務地點（這筆沒填天氣，六組都列出來對照）`;
      buildPicker(known);
      selected = `${known ?? 'storm'}-α`;
      render();
      openModal();
    },
  };
}
