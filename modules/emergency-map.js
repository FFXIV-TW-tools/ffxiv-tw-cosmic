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

/**
 * 兩則**開始**通告（預告那則 A／B 共用，分不出來所以不列在這）。
 *
 * ⚠️ **刻意不標「這則＝α」**：通告分得出兩則、任務分得出兩組，但兩者之間**沒有任何證據**
 * （見 docs/BACKLOG.md B-023）。硬標就是擲硬幣，而猜錯的人會被送到地圖的另一半——
 * 比不標更糟。等插件抓到一筆同時有通告與任務板的紀錄就解出來了。
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
 * @param {HTMLElement} root #panel-emergency
 * @param {object} data missions.json
 */
export function createEmergencyMap(root, data) {
  const el = {
    picker: root.querySelector('#em-map-picker'),
    note: root.querySelector('#em-map-note'),
    img: root.querySelector('#em-map-img'),
    pins: root.querySelector('#em-map-pins'),
    legend: root.querySelector('#em-map-legend'),
  };
  const cfg = data.map;
  if (!el.picker || !cfg) return;

  el.img.src = cfg.image;

  const byId = new Map(data.missions.map((m) => [m.id, m]));
  const jobLabel = (i) => data.jobs?.[i]?.label ?? `職業 ${i}`;
  const jobAbbr = (i) => data.jobs?.[i]?.abbr ?? '';

  /**
   * 目前選的組（一定是單一組）。**沒有「全部」選項**（Owner 2026-08-03：「會有點誤導」）——
   * 一次事件只會出一組，把兩組疊在同一張圖上會讓人以為要跑八個點。
   */
  let selected = 'storm-α';

  buildPicker();
  render();

  function buildPicker() {
    for (const [kind, name] of Object.entries(WEATHER_NAMES)) {
      for (const key of [`${kind}-α`, `${kind}-β`]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'codex-btn codex-btn--ghost codex-small cos-map__pick';
        b.dataset.key = key;
        // 標籤用**這組有什麼任務**，不用 A／B——「哪則通告＝哪一組」還沒有證據（B-023），
        // 掛上 A／B 等於要人拿一個猜出來的編號去對照，猜錯就跑錯半張圖。
        b.append(document.createTextNode(name));
        const hint = document.createElement('span');
        hint.className = 'cos-map__hint';
        hint.textContent = GROUP_HINT[key] ?? '';
        b.append(hint);
        b.addEventListener('click', () => {
          selected = key;
          render();
        });
        el.picker.append(b);
      }
    }
  }

  function render() {
    for (const b of el.picker.children) {
      b.classList.toggle('cos-map__pick--on', b.dataset.key === selected);
    }

    const groups = [selected];
    const kind = selected.split('-')[0];

    el.note.replaceChildren();
    el.note.append(
      `${WEATHER_NAMES[kind]}有兩組任務，一次事件只會出其中一組 — 開任務板看是哪幾個任務，`
      + '就知道要看這張圖的哪一組。這一組的地點是遊戲資料寫死的，不隨伺服器變。',
      document.createElement('br'),
    );
    // 聊天欄的開始通告原文：兩則列出來讓人比對自己看到的是哪一句。
    // **不標哪則對應哪一組**——那個對應目前無證據（B-023），標了就是把猜測寫成事實。
    const ann = document.createElement('span');
    ann.textContent = `${WEATHER_NAMES[kind]}的開始通告有兩則：「${START_ANNOUNCEMENTS[kind][0]}」`
      + `／「${START_ANNOUNCEMENTS[kind][1]}」。`
      + '（哪一則對應哪一組尚未確認，所以請以任務板上的任務為準。）';
    el.note.append(ann);

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

      let n = 0;
      for (const spot of spots.values()) {
        n += 1;
        el.pins.append(pin(spot, g, gi, n));
        el.legend.append(legendItem(spot, g, gi, n));
      }
    });
  }

  /**
   * 一個地點一顆 pin，**上面直接畫該地點要去的職業圖示**（Owner 2026-08-03）。
   * 只寫編號的話還是得對照下面的圖例才知道自己該不該去，等於沒有畫在圖上。
   */
  function pin(spot, group, groupIndex, n) {
    const d = document.createElement('div');
    d.className = `cos-map__pin cos-map__pin--g${groupIndex}`;
    d.style.left = `${toPercent(spot.marker.x, cfg.offsetX, cfg.sizeFactor)}%`;
    d.style.top = `${toPercent(spot.marker.y, cfg.offsetY, cfg.sizeFactor)}%`;
    d.title = `${group}\n${spot.missions.map((m) => `${m.jobs.map(jobLabel).join('・')}：${m.name}`).join('\n')}`;

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
    return d;
  }

  function legendItem(spot, group, groupIndex, n) {
    const li = document.createElement('li');
    li.className = 'cos-map__legenditem';

    const badge = document.createElement('span');
    badge.className = `cos-map__pin cos-map__pin--g${groupIndex} cos-map__pin--static`;
    badge.textContent = String(n);
    li.append(badge);

    for (const m of spot.missions) {
      const item = document.createElement('span');
      item.className = 'cos-map__job';
      for (const j of m.jobs) {
        const abbr = jobAbbr(j);
        if (abbr) {
          const icon = document.createElement('img');
          icon.src = `img/jobs/${abbr}.png`;
          icon.alt = '';
          icon.className = 'cos-map__jobicon';
          icon.loading = 'lazy';
          item.append(icon);
        }
      }
      const text = document.createElement('span');
      text.textContent = `${m.jobs.map(jobLabel).join('・')}　${m.name}`;
      item.append(text);
      li.append(item);
    }
    return li;
  }

  // 刻意**不做**「跟著現況自動切到這次的變體」：後端存的 `storm-a`／`storm-b` 是通告文字，
  // 這裡的分組是 α／β，兩者對應未知（B-023）⇒ 自動切只會有一半機率切對，
  // 而使用者不會知道它切錯了。等對應解出來再接。
}
