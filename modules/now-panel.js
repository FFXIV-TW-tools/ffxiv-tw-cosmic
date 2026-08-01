/**
 * 主畫面：**現在有哪些任務條件成立，下一批是什麼時候**。就這樣。
 *
 * ## 名詞一律用遊戲的說法
 * 分類＝基礎任務／臨時任務／緊急任務（Addon#16748/16749/16750），
 * 臨時任務底下再分連續任務／時間限定任務／天氣限定任務（#16871/16872/16873）。
 * **不得自造上位詞**——一度把這個面板叫「限時任務」，那個詞遊戲裡不存在，
 * 而且把「臨時任務」與它底下的「時間限定」混成一層（Owner 2026-07-31 糾正）。
 *
 * 取代先前的職業看板（Owner 2026-07-31：「不要那麼複雜了」）。舊版一張卡片塞了
 * 三組數字＋倒數＋緊急註記，看的人得先讀懂四個概念才知道要不要去玩。
 * 這版只回答一句話能問的問題：現在能做什麼、下次什麼時候。
 *
 * ## 只列「有條件的」
 * 不限時的任務隨時都在，不需要一個面板告訴你——它們在任務清單分頁。
 * 這裡列的是有時段／天候閘的那 63 個，也就是真正需要盯時間的。
 *
 * **基礎與臨時都收，不按分類裁**（2026-08-01）：原本只收臨時任務，理由是面板叫「臨時任務」——
 * 那是拿面板名去裁資料。實際上 ET 02:00–04:00 只有一個任務、且當時被判成基礎，
 * 於是那個時段面板永遠空白，而 Owner 在遊戲裡看得到。面板名已改成「現在開放的任務」。
 * （後續 #400 的實測也推翻了「rank≤4＝基礎」這個判準本身，見 TcCosmicSheets.MissionClass。）
 *
 * ## 「現在」是保證，「下一個」是預測
 * 兩者都算得準（天氣＝unix 時間的純函數、ET 時段已對過遊戲）。
 * 唯一算不出來的是**前置任務有沒有完成**，所以有前置的會標出來而不是假裝它一定在。
 */

import { clockText, formatDuration } from './eorzea-time.js';
import { jobIcon } from './job-icon.js';

/** 條件欄＝遊戲的子分類名 ＋ **實際的值**。只寫子分類名還是得點進去才知道幾點，
 *  只寫值又丟掉遊戲的用詞——兩個都要（Owner 2026-07-31）。 */
const COND_TEXT = {
  time: (c) => `ET ${String(c.start).padStart(2, '0')}:00–${String(c.end).padStart(2, '0')}:00`,
  weather: (c) => c.label.replace(/^天候：/, ''),
};
/** 臨時任務的子標籤（Addon#16872/16873）。**只掛臨時任務**，基礎任務不適用。 */
const COND_KIND = { time: '時間限定任務', weather: '天氣限定任務' };
/** 遊戲的三個分頁名（Addon#16748/16749/16750）。基礎任務用它，不套子標籤。 */
const CLASS_LABEL = { basic: '基礎任務', temporary: '臨時任務', critical: '緊急任務' };

export function createNowPanel(root, { windows, missions, conditions, jobs, forecaster, onJump }) {
  const byId = new Map(missions.map((m) => [m.id, m]));

  /**
   * 同名跨職組。40 組三筆、48 組兩筆、293 筆是單獨的（去掉【高難】/【高難+】前綴後比對）。
   * client 裡它們共用同一個 `c1`，只有職業與需求物不同（例：#74/#119/#164「補充月門基地的備用品」
   * ＝鍛造／甲冑／金工，需求物是棒狀／室外／室內照明）。
   *
   * **Owner 2026-07-31 的假設**：同組可能只擇一或輪流出現，而不是三個一起出。
   * 這個離線無法驗證，所以只把「同組還有誰」顯示出來讓人自己對照，
   * 不拿它去過濾或推算。見 docs/BACKLOG.md B-016。
   */


  const siblings = new Map();
  {
    const byName = new Map();
    for (const m of missions) {
      const key = m.name.replace(/^【高難\+?】/, '');
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(m);
    }
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      for (const m of group) siblings.set(m.id, group.filter((x) => x.id !== m.id));
    }
  }
  const nowHead = root.querySelector('#np-now-head');
  const nowList = root.querySelector('#np-now');
  const nextHead = root.querySelector('#np-next-head');
  const nextList = root.querySelector('#np-next');
  const caveat = root.querySelector('#np-caveat');
  const scope = root.querySelector('#np-scope');

  let jobFilter = [];
  let lastNow = null;
  /** 勝出任務 id → 同職同條件被蓋掉的低階任務（見 collapseByRank）。 */
  let altOf = new Map();

  /**
   * 有條件、非緊急、非雙職業、（有選職業的話）是你的職業。
   *
   * **緊急任務排除**：天候條件只是**必要**條件，還要等伺服器推播緊急事件，離線算不出來。
   * 2026-07-31 Owner 在靈風時段實測，本站列的 8 個裡有 3 個是緊急任務
   * （製作火焰噴射器的零件／調查孢子霧對植被的影響／採集有益菌類），遊戲內都沒有。
   *
   * **雙職業任務（16 筆）排除**：Owner 兩次實測都看不到，且**「第二職沒練」的解釋已被他本人否證**
   * （兩個職業都有，仍看不到）。它們在資料上自成一區——`JobCategorySecondary` 非零者
   * 恰好等於 `c21 ∈ {20000, 20100}` 那 16 筆（交集 16/16，id 連續 #496–511），
   * 而且是全表唯一沒有 rank-4 對應版本的一組。**出現規則未知** ⇒ 不放進主清單假裝算得出來，
   * 只在下方標明有這 16 筆存在。見 docs/BACKLOG.md B-013。
   */
  function relevant(m) {
    if ((m.conds ?? []).length === 0) return false;
    /*
     * **基礎任務也要進來**（2026-08-01 修）。原本寫死只收 `temporary`，理由是「面板名叫臨時任務」
     * ——那是拿面板名去裁資料，把使用者要的東西擋在外面。22 個 ET 條件任務裡有 11 個是基礎任務，
     * 而且 **ET 02:00–04:00 整個時段就只有一個任務、剛好是基礎的**（#400 採集精密空氣淨化裝置所需的材料）
     * ⇒ 那個時段面板必定空白，Owner 在遊戲裡看到卻在網站上找不到。
     * 面板名已改成「現在開放的任務」——描述這份清單在做什麼，不是自造一個遊戲沒有的分類。
     * 緊急任務仍排除：它是伺服器推播、算不出來也偵測不到（見 renderCaveat）。
     */
    if (m.class === 'critical') return false;
    if (m.jobs.length > 1) return false;
    if (jobFilter.length && !m.jobs.some((j) => jobFilter.includes(j))) return false;
    return true;
  }

  /**
   * **每職業 × 每條件只出一個任務，取階級最高的那個。**
   *
   * 遊戲內實測（Owner 2026-08-01，月塵、勾了 5 職）：符合條件的任務資料上有 8 個，
   * 任務板上只出現 **4** 個——每職一個，而且全是【高難+】。鍊金完全沒出現，
   * 而月塵的鍊金**只有【高難+】、沒有【高難】可退** ⇒ 那一階他還沒解開。
   *
   * 所以規則不是「條件成立就全部出現」，而是**每職每條件只出一個**。取哪一個？
   * ICE 任務板記錄（2026-07-31，176 快照）裡「兩階都存在」的組合共有 **4 個獨立天氣視窗**
   * 可檢定，**4/4 全是高階，零次低階**；加上 Owner 2026-08-01 這次的 3 職，共 7 次零反例。
   * 若真是隨機二選一，機率約 0.8% ⇒ **隨機說基本可排除**，故本站一律取高階。
   *
   * ⚠ **但「為什麼是高階」尚未定論**。最省事的解釋是該職的階級解鎖門（鍊金在月塵只有高階、
   * 而它整個沒出現，正好符合「那一階沒解開又無低階可退」），但樣本還撐不起這個斷言。
   * 措辭因此保持中性；被蓋掉的低階任務寫進該列說明而不是丟掉。
   *
   * **決定性反例很便宜**：ICE 記錄器持續在跑，只要有任何一次同職同條件出現低階，
   * 這裡就要改。分析指令＝`node tools/compare-board-log.mjs`。
   */
  function collapseByRank(list) {
    // 分類也進 key：基礎與臨時是遊戲的兩個分頁，不該互相蓋掉
    const key = (m) => `${m.jobs[0]}|${m.conds[0] ?? 0}|${m.class}`;
    const best = new Map();
    for (const m of list) {
      const cur = best.get(key(m));
      if (!cur || m.rank > cur.rank) best.set(key(m), m);
    }
    altOf = new Map();
    for (const m of list) {
      const w = best.get(key(m));
      if (w && w.id !== m.id) altOf.set(w.id, m);
    }
    return [...best.values()];
  }

  /**
   * 條件欄文字＝分類 ＋ 實際的值。每個任務最多一個條件，不必處理組合。
   *
   * **子標籤只掛臨時任務**（遊戲如此，Addon#16871–16873）⇒ 基礎任務不能寫「時間限定任務」，
   * 那是自造分類。基礎任務就寫「基礎任務」，條件值照舊。
   */
  function condText(m) {
    const groups = new Map();
    for (const id of m.conds ?? []) {
      const cond = conditions[id];
      if (!cond || !COND_TEXT[cond.type]) continue;
      if (!groups.has(cond.type)) groups.set(cond.type, []);
      groups.get(cond.type).push(COND_TEXT[cond.type](cond));
    }
    const kind = (type) => (m.class === 'temporary' ? COND_KIND[type] : CLASS_LABEL[m.class] ?? '');
    const parts = [...groups.entries()]
      .map(([type, texts]) => `${kind(type)}　${texts.join('、')}`);
    return parts.join('　＋　') || '—';
  }

  function windowOf(condId) {
    return windows.find((w) => w.condId === condId);
  }

  /** 條件此刻是否成立。每個任務最多一個條件（c15），見 weather-forecast.js 的 conditionsMet。 */
  function isOpen(m, now) {
    let unknown = false;
    for (const id of m.conds ?? []) {
      const r = windowOf(id)?.isOpen(now) ?? null;
      if (r === false) return false;
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }

  /**
   * 這個任務下一次**所有**條件同時成立的時刻（unix 秒），找不到回 null。
   *
   * 原本只看時段條件、忽略天候，於是「下一批」會列出**下一段天氣根本不對**的任務——
   * 天候是純時間函數、算得出來，列一個不可能發生的東西沒有任何價值（Owner 2026-07-31）。
   *
   * 用 350 秒（＝2 艾歐澤亞小時）當掃描步長：ET 視窗邊界正好是 350 的倍數，
   * 天候週期 1400 秒是它的 4 倍 ⇒ 這個格線涵蓋兩種條件的所有狀態變化，不會跳過任何開窗。
   */
  const SCAN_STEP = 350;
  const SCAN_LIMIT = 1000;          // ≈ 4 天；超過這個距離的預報對「等一下要做什麼」沒有意義
  const scanCache = new Map();

  function nextOpenAt(m, now) {
    const block = Math.floor(now / SCAN_STEP);
    const key = `${m.id}:${block}`;
    if (scanCache.has(key)) return scanCache.get(key);
    let found = null;
    for (let i = 1; i <= SCAN_LIMIT; i++) {
      const t = (block + i) * SCAN_STEP;
      if (isOpen(m, t) === true) { found = t; break; }
    }
    // 每秒重畫一次、每 350 秒才換 key ⇒ 快取自然有界；仍加上限防長時間開著累積
    if (scanCache.size > 4000) scanCache.clear();
    scanCache.set(key, found);
    return found;
  }

  /** 宇宙工具的階級用羅馬數字（遊戲就是這樣標）。 */
  const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];

  /**
   * 宇宙工具階級**從資料推**，不寫死：台服目前只到 Ⅳ，之後改版加階時欄位會自己長出來，
   * 而且欄位標題與資料列都吃同一份清單 ⇒ 不會有「標題 5 欄、資料 4 欄」這種錯位。
   */
  const RELIC_LEVELS = [...new Set(missions.flatMap((m) => (m.reward?.relic ?? []).map((x) => x.level)))]
    .sort((a, b) => a - b);

  /**
   * 每個獎勵各佔一格、逐列對齊（Owner 2026-07-31：「不要擠在一起」）。
   * 擠成一串 `30/33　Ⅳ23 Ⅲ15 Ⅱ15` 沒辦法上下比大小——而「哪個任務比較划算」正是
   * 看這欄的唯一理由。`relic` 是**同一任務對不同階工具給的不同經驗**，缺的階留空格。
   */
  function rewardCells(m) {
    const r = m.reward ?? {};
    const byLevel = new Map((r.relic ?? []).map((x) => [x.level, x.exp]));
    return [
      { text: String(r.cosmo ?? 0), cls: 'cos-np__num' },
      { text: String(r.lunar ?? 0), cls: 'cos-np__num' },
      ...RELIC_LEVELS.map((lv) => ({ text: byLevel.has(lv) ? String(byLevel.get(lv)) : '', cls: 'cos-np__num' })),
    ];
  }

  /** 欄位標題與 grid 欄寬都由 JS 產生，才能保證跟資料列的欄數永遠一致。 */
  function setupColumns() {
    root.style.setProperty(
      '--cos-np-cols',
      `52px 22rem minmax(0, 1fr) 4rem 4rem ${RELIC_LEVELS.map(() => '3rem').join(' ')} 8rem`,
    );
    for (const head of root.querySelectorAll('.cos-np__cols')) {
      head.textContent = '';
      const labels = ['職業', '限定條件', '任務名稱', '宇宙', '月球',
        ...RELIC_LEVELS.map((lv) => ROMAN[lv] ?? String(lv)), '還缺什麼'];
      for (const [i, label] of labels.entries()) {
        const sp = document.createElement('span');
        sp.textContent = label;
        // 數字欄（宇宙/月球/各階經驗）靠右，與資料對齊
        if (i >= 3 && i < labels.length - 1) sp.className = 'cos-np__num';
        head.append(sp);
      }
    }
  }

  function line(m) {
    const li = document.createElement('li');
    li.className = 'cos-np__item';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cos-np__btn';

    // 雙職業任務有兩個圖示 —— **必須包成一格**，否則第二個圖示會自己佔掉一個 grid 欄，
    // 把後面每一欄都往右推一格（Owner 2026-07-31 回報「排版很亂」即此）。
    const icons = document.createElement('span');
    icons.className = 'cos-np__icons';
    for (const id of m.jobs) {
      const job = jobs[id];
      if (job) icons.append(jobIcon(job, { size: 22 }));
    }
    btn.append(icons);

    const kind = document.createElement('span');
    kind.className = 'codex-small cos-np__kind';
    kind.textContent = condText(m);
    btn.append(kind);

    const name = document.createElement('span');
    name.className = 'cos-np__name';
    name.textContent = m.name;
    btn.append(name);

    for (const cell of rewardCells(m)) {
      const sp = document.createElement('span');
      sp.className = `codex-small ${cell.cls}`;
      sp.textContent = cell.text;
      btn.append(sp);
    }

    // 「還缺什麼」欄＝條件之外、本站算不出來的門，列出來而不是默默當它們不存在
    const note = document.createElement('span');
    note.className = 'codex-small cos-np__gate';
    // 有前置的就是遊戲說的「連續任務」（Addon#16871）——Owner 2026-07-31 確認，
    // 與 c16 的反解一致。用遊戲的詞，前置是哪一筆放在 data-help 裡。
    // 同職同條件被蓋掉的低階任務：沒解到這一階的人實際看到的是那個 ⇒ 標出來而不是靜默丟掉
    note.textContent = m.prereq ? '連續任務' : (altOf.has(m.id) ? '階級擇一' : '');
    btn.append(note);

    // 點某一列＝想看那一筆的細節（需求物、獎勵、完整條件）⇒ 直接用名稱帶過去，
    // 不套任何會把它篩掉的條件（available/hideBulk 都關）。
    btn.addEventListener('click', () => onJump({ text: m.name, available: false, hideBulk: false }));
    btn.dataset.help = [
      condText(m),
      `宇宙信用點 ${m.reward?.cosmo ?? 0}｜月球信用點 ${m.reward?.lunar ?? 0}`,
      (m.reward?.relic ?? []).length
        ? `宇宙工具經驗：${m.reward.relic.map((x) => `${ROMAN[x.level] ?? x.level} 階 +${x.exp}`).join('、')}`
        : '',
      m.timeLimit ? `時限 ${Math.round(m.timeLimit / 60)} 分` : '',
      m.prereq ? `連續任務：${chainHelp(m)}` : '',
      // 每職每條件只出一階（見 collapseByRank）。這裡列的是「你若還沒解到這一階，實際會出的那個」
      altOf.has(m.id)
        // 任務名本身已帶【高難】/【高難+】前綴，直接引名字即可，不必再造一份階級標籤。
        // 措辭刻意中性：「為什麼只出高階那個」還沒定論（見 collapseByRank），不寫成已知結論
        ? `此職此條件只會出一個；另一個是「${altOf.get(m.id).name}」（實測到目前都出高階那個）`
        : '',
      siblings.has(m.id)
        ? `同名任務另有：${siblings.get(m.id).map((x) => x.jobs.map((j) => jobs[j]?.label ?? j).join('/')).join('、')}`
        : '',
      '點一下看完整資料',
    ].filter(Boolean).join('｜');
    li.append(btn);
    return li;
  }

  /**
   * 連續任務的整條鏈。33 條鏈的源頭是**基礎任務**（rank A），
   * 形狀＝基礎 A →【高難】續·X →【高難+】X。知道源頭在基礎分頁才知道從哪開始做。
   */
  function chainHelp(m) {
    const chain = [];
    let cur = byId.get(m.prereq);
    for (let i = 0; cur && i < 6; i++) { chain.unshift(cur); cur = cur.prereq ? byId.get(cur.prereq) : null; }
    if (chain.length === 0) return `要先完成 #${m.prereq}`;
    const kind = chain[0].class === 'basic' ? '基礎任務' : '臨時任務';
    return `要先完成${kind}「${chain.map((x) => x.name).join('」→「')}」`;
  }

  /** 沒有前置的排前面——連續任務要先完成前一筆，不是「現在就能去做」的。 */
  function ordered(items) {
    return [...items].sort((a, b) => (a.prereq ? 1 : 0) - (b.prereq ? 1 : 0)
      || (a.jobs[0] ?? 0) - (b.jobs[0] ?? 0)
      || a.rank - b.rank);
  }

  function fill(list, items, emptyText) {
    list.textContent = '';
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'cos-np__empty codex-small';
      li.textContent = emptyText;
      list.append(li);
      return;
    }
    for (const m of ordered(items)) list.append(line(m));
  }

  /**
   * 緊急事件的告誡**只在特殊天氣（靈風／月塵）進行中才出現**。
   * 晴朗時本來就沒有天氣限定任務，常駐這段只會被當成背景雜訊（Owner 2026-07-31）。
   *
   * 為什麼這件事非講不可：緊急天氣（磁暴／流星雨／孢子霧）會**覆蓋**當前天候，
   * 而它們不在任何 `WeatherRate` 內 ⇒ 純時間演算法既算不出何時來、也偵測不到正在發生 ⇒
   * 被覆蓋的那段時間，上面每一筆天氣限定任務都是錯的。
   * Owner 2026-07-31 實測：靈風進行中突然轉孢子霧，限時任務整批消失、改出緊急事件。
   */
  function renderCaveat(now) {
    const w = forecaster.weatherAt(now);
    const special = w.name !== '晴朗';
    caveat.hidden = !special;
    if (!special) return;
    caveat.textContent = '';
    const lead = document.createElement('strong');
    lead.textContent = `⚠️ 現在是${w.name}，隨時可能觸發緊急事件。`;
    caveat.append(
      lead,
      document.createTextNode('緊急事件的天氣（磁暴／流星雨／孢子霧）會覆蓋掉現在的天候，'
        + '被覆蓋後上面的天氣限定任務會跟著失效。那是伺服器推播 —— 本站既算不出何時發生，'
        + '也偵測不到它正在發生。'),
    );
  }

  function render(now) {
    lastNow = now;
    renderCaveat(now);
    const pool = collapseByRank(missions.filter(relevant));

    const open = pool.filter((m) => isOpen(m, now) === true);
    fill(nowList, open, '現在沒有條件開啟中的任務');
    // textContent 會把 #np-scope 一起洗掉 ⇒ 只換第一個文字節點
    nowHead.firstChild.nodeValue = open.length
      // 面板收基礎與臨時兩類 ⇒ 這裡不寫死某一類的名字（分類寫在每列的「限定條件」欄）
      ? `現在有 ${open.length} 個任務`
      : '現在沒有條件開啟中的任務';
    renderScope();

    // 下一批＝最早會開的那個時刻，以及那一刻同時開啟的所有任務
    // （只報一個時刻，不列一長串未來——那又變回舊版的資訊牆）
    let soonest = null;
    const withEta = [];
    for (const m of pool) {
      if (isOpen(m, now) === true) continue;
      const start = nextOpenAt(m, now);
      if (start === null) continue;
      withEta.push({ m, start });
      if (soonest === null || start < soonest) soonest = start;
    }
    const nextBatch = withEta.filter((x) => x.start === soonest).map((x) => x.m);
    fill(nextList, nextBatch, '接下來 4 天內沒有會開啟的任務');
    // 倒數後面補現實時間：「4 分 52 秒後」還要自己心算，「（12:47）」才是能直接對錶的
    nextHead.textContent = soonest === null
      ? '接下來沒有'
      : `下一批 — ${formatDuration(soonest - now)}後（${clockText(soonest)}）`;
  }

  /**
   * 標題右邊的範圍說明。沒有它，使用者會把「現在有 3 個」當成全服只有 3 個，
   * 而不是「你勾的職業有 3 個」（Owner 2026-07-31）。
   */
  function renderScope() {
    if (!scope) return;
    scope.textContent = jobFilter.length
      ? `（只顯示你勾選的職業：${jobFilter.map((id) => jobs[id]?.label ?? `#${id}`).join('、')}）`
      : '（目前顯示全部 11 個職業 —— 用右上角「我練的職業」縮小範圍）';
  }

  function setJobs(ids) {
    jobFilter = ids;
    if (lastNow !== null) render(lastNow);
  }

  setupColumns();

  return { render, setJobs };
}
