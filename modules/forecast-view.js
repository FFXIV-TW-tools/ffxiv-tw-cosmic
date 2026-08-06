/**
 * 天氣預報分頁——**純預報，不混任務資訊**。
 *
 * 原本時間軸有一欄「天候任務」放職業圖示，但那讓表格太擠、也把兩件事混在一起
 * （Owner 2026-08-01）。任務去「臨時任務」分頁看，這裡只回答「什麼時候會是什麼天氣」。
 *
 * 這頁的資訊主張很窄，刻意講清楚：**渴望灣的一般天氣（月塵／晴朗／靈風）是時間的純函數，
 * 全伺服器同步、可推算到任意未來**；而緊急事件（磁暴／流星雨／孢子霧）是伺服器推播、
 * 離線推不出來。頁面同時要讓「靈風」這個唯一有任務意義的天氣一眼可見。
 */

import {
  WEATHER_PERIOD, clockText, localClockText, etClockText, dateText, eorzeaClock, formatDuration,
} from './eorzea-time.js';

/**
 * 天氣圖示＝**遊戲自己的圖**，由產生器從 client 解出放同源 `img/weather/<iconId>.png`
 * （icon id 在 `weather.json` 的 table 上，來源見 `tools/cosmic-dump/Program.cs`）。
 *
 * ⚠ 2026-08-01 之前這裡是一組自己發明的 emoji（🌤💨🌘）——遊戲本來就有天氣圖示，
 * 拿 emoji 代替是我擅自決定的，Owner 指正後改掉。**沒有 emoji fallback**：
 * 圖載不到就只顯示名稱，不要再讓那組自創對照偷偷回來。
 */
function weatherIcon(w, size = 20) {
  if (!w?.icon) return null;
  const img = document.createElement('img');
  img.className = 'cos-wicon';
  img.src = `img/weather/${String(w.icon).padStart(6, '0')}.png`;
  img.alt = '';                 // 天氣名就在旁邊，alt 再唸一次是重複
  img.width = size;
  img.height = size;
  img.loading = 'lazy';
  return img;
}

/** 渴望灣的「平常天氣」：佔 70%、沒有任何任務綁它 ⇒ 時間軸與倒數都不列它。 */
const PLAIN_WEATHER = '晴朗';

/** 時間軸要湊滿的特殊天氣筆數，以及為此往前掃的時段上限（特殊天氣約佔 30%）。 */
const SPECIAL_ROWS = 20;
const SCAN_PERIODS = 200;

/**
 * 機甲行動的班表：**現實時間**每小時的 :16 / :36 / :56，20 分鐘一班（Owner 2026-08-01）。
 *
 * 跟這頁其他東西**不同源**：天氣與 ET 都是 unix 時間的函數、走艾歐澤亞刻度；
 * 這個直接按現實時鐘的分鐘走 ⇒ 用 `Date` 取**本地**分秒，不要自己拿 unix 秒取模。
 * 台灣是整點時區，取模剛好也會對；但只要有人在半小時時區（印度／尼泊爾）開這頁就整整差半小時，
 * 而那種錯沒有任何訊號——畫面照樣在倒數，只是倒到錯的時間。
 *
 * **只算下一班、不標「進行中」**：一班持續多久還沒問到，沒有那個數字就寫不出誠實的進行中狀態。
 */
const MECH_MINUTES = [16, 36, 56];

/**
 * 下一班開始的 unix 秒。剛好卡在開始那一秒時回報再下一班（不假裝算得出當班還剩多久）。
 *
 * **export 是為了能單獨驗**（本站無 JS 測試 harness，這是唯一的檢查縫）：
 * `TZ=Asia/Taipei node --input-type=module -e "import {nextMechAt} from './modules/forecast-view.js'; …"`
 * 驗收線＝跨 :16/:36/:56 與整點翻頁的間隔一律 1200 秒。
 */
export function nextMechAt(now) {
  const d = new Date(now * 1000);
  const intoHour = d.getMinutes() * 60 + d.getSeconds();
  for (const m of MECH_MINUTES) {
    if (m * 60 > intoHour) return now + (m * 60 - intoHour);
  }
  return now + (3600 - intoHour) + MECH_MINUTES[0] * 60;   // 本小時三班都過了 → 下一小時的 :16
}

export function createForecastView({ forecaster, weatherData, missions, conditions }) {
  /*
   * 這個 view 現在橫跨兩個分頁：天氣三格在「臨時任務」頁（它是任務的前提），
   * 時間軸在「天氣預報」頁。**所以一律用 document 查，不能用 panel root**——
   * 用 root 查會在拆分頁後靜默拿到 null，時間軸整片消失（2026-08-01 實踩）。
   */
  const el = {
    now: document.querySelector('#fc-now'),
    timeline: document.querySelector('#fc-timeline'),
    timeline2: document.querySelector('#fc-timeline-2'),
    zone: document.querySelector('#fc-zone'),
  };

  // 有天候條件的任務：按天氣 id 分組，供時間軸標「這個時段開放幾個任務」
  const byWeather = new Map();
  for (const m of missions) {
    for (const cid of m.conds ?? []) {
      const cond = conditions[cid];
      if (cond?.type !== 'weather') continue;
      if (!byWeather.has(cond.weatherId)) byWeather.set(cond.weatherId, []);
      byWeather.get(cond.weatherId).push(m);
    }
  }

  el.zone.textContent = `${weatherData.zone.name}（${weatherData.table.map((w) => `${w.name} ${w.rate}%`).join('／')}）`;

  function render(nowSeconds) {
    renderNow(nowSeconds);
    renderTimeline(nowSeconds);
  }

  function renderNow(now) {
    const current = forecaster.weatherAt(now);
    const remain = WEATHER_PERIOD - (now % WEATHER_PERIOD);
    // 晴朗佔 70% 且沒有任何任務綁它 ⇒ 報「還有多久變天」是雜訊（多半只是變成另一段晴朗）。
    // 晴朗時改報「距離下一個特殊天氣」，那才是有意義的數字。
    /*
     * 倒數只講「還剩多久」等於半句話——變完之後是什麼，才是決定要不要現在收工的依據
     * （Owner 2026-07-31）。下一段天氣是純時間函數，算得出來就直接寫出來。
     *
     * 晴朗時再補一句「距離下一個特殊天氣」：晴朗佔 70%，下一段多半還是晴朗，
     * 只寫「接著是晴朗」對使用者毫無用處。
     */
    const next = forecaster.weatherAt(now + remain);
    // 相對時間一律補上**現實時鐘**（Owner 2026-08-03：「不然要一直數」）——
    // 「還剩 12 分」要心算才知道是幾點，「還剩 12 分（本地 14:35）」不用。
    // ⚠️ 一律帶「本地」標記：隔壁那一格就是 ET，兩種時鐘格式一模一樣（2026-08-06）。
    // 註記改成節點陣列，才能把遊戲自己的天氣圖示放進「接著是」（原本是純文字塞不進圖）。
    const note = [
      document.createTextNode(`還剩 ${formatDuration(remain)}（${localClockText(now + remain)}）→ 接著是 `),
      weatherIcon(next, 16),
      document.createTextNode(` ${next.name}`),
    ];
    if (current.name === PLAIN_WEATHER && next.name === PLAIN_WEATHER) {
      note.push(document.createTextNode('（'), ...nextSpecialNote(now), document.createTextNode('）'));
    }
    el.now.innerHTML = '';
    el.now.append(
      block('目前天氣', [weatherIcon(current, 28), document.createTextNode(` ${current.name}`)], note),
      // 值帶 `ET` 前綴，與其餘三格的「本地 HH:MM」形成一眼可辨的對照——
      // 這一格的 label 雖然寫著「艾歐澤亞時間」，但人是掃數字的，四個 `18:30` 並排時
      // label 幫不上忙（Owner 2026-08-06）。註記講**尺度差**，那才是「差別」的本體：
      // 1 ET 小時＝175 現實秒 ⇒ ET 跑得比現實快約 20.6 倍。
      block('艾歐澤亞時間', etClockText(now), '遊戲內時間 · 1 小時＝現實 2 分 55 秒；全伺服器同步'),
      windyBlock(now),
      mechBlock(now),
    );
  }

  /**
   * 全頁唯一的金色高亮（設計系統：一頁最多 1 處，限「限時／唯一推薦／要你現在動作」）。
   * 靈風視窗正是限時，且是 20 個**天氣限定臨時任務**的必要條件。
   *
   * ⚠️ 2026-08-02 更正：這裡原本寫「緊急任務的必要條件」，**是錯的**。
   * 掛靈風條件（cond 13）的 20 個任務 `class` 全部是 `temporary`；33 個 `critical`（緊急）任務的
   * `conds` **全部是空的** —— client 裡沒有任何欄位說緊急任務需要靈風。舊文案是 2026-07-31
   * 分類判準修正（commit 2577acf）之前的認知殘留，判準修好後沒人回來改這幾句。
   */
  function windyBlock(now) {
    const windy = weatherData.table.find((w) => w.name === '靈風');
    if (!windy) return document.createDocumentFragment();
    const count = (byWeather.get(windy.id) ?? []).length;
    const isNow = forecaster.weatherAt(now).id === windy.id;
    const next = forecaster.nextWeather(now, windy.id);
    const d = block(
      '靈風視窗',
      // 同上：相對時間一律附現實時鐘（進行中報「到幾點結束」，還沒到報「幾點開始」）
      // 「到 本地 18:30」讀起來會卡，所以進行中那句把標記放進去後改寫成「…結束」——
      // 保留「這個時刻是結束不是開始」的語意，同時不犧牲標記（2026-08-06）。
      isNow
        ? clockSuffix(`還剩 ${formatDuration(WEATHER_PERIOD - (now % WEATHER_PERIOD))}`,
          now + WEATHER_PERIOD - (now % WEATHER_PERIOD), ' 結束')
        : (next ? clockSuffix(`${formatDuration(next.start - now)}後`, next.start) : '—'),
      `${count} 個天氣限定臨時任務的必要條件（佔 ${windy.rate}% 時段）`,
    );
    d.classList.add('codex-tint-panel', 'codex-tint-panel--highlight', 'codex-tint-panel--bar');
    return d;
  }

  /**
   * 機甲行動倒數。**刻意不用金色高亮**——設計系統規定一頁最多一處，那一處已經給了靈風視窗
   * （它是 20 個天氣限定臨時任務的必要條件）。這張是固定班表，錯過就等 20 分鐘，不是限時機會。
   */
  function mechBlock(now) {
    const next = nextMechAt(now);
    return block(
      '機甲行動',
      clockSuffix(`${formatDuration(next - now)}後`, next),
      '每小時 :16 / :36 / :56（本地時間，不是 ET）',
    );
  }

  /**
   * 「倒數 ＋（本地 HH:MM）」的值。**時鐘降一級字**（`codex-small`）——
   * 加上「本地」標記之後整串在 4 欄版面會折行（2026-08-06 實測），而且折行不是唯一的理由：
   * 這一格的焦點是倒數，時鐘是拿來對錶的輔助，本來就不該跟倒數同一個字級。
   * 依設計系統「utility 只裁字級」，顏色／字重仍繼承 `.codex-h2`（accent）。
   */
  function clockSuffix(mainText, unixSeconds, tail = '') {
    const small = document.createElement('span');
    small.className = 'codex-small';
    small.textContent = `（${localClockText(unixSeconds)}${tail}）`;
    return [document.createTextNode(mainText), small];
  }

  function block(label, value, note) {
    const d = document.createElement('div');
    d.className = 'cos-stat';
    const l = document.createElement('span');
    l.className = 'codex-label';
    l.textContent = label;
    const v = document.createElement('strong');
    v.className = 'codex-h2 cos-stat__value';
    // value 可以是字串或節點陣列（天氣那張要在名稱前放遊戲圖示）
    if (Array.isArray(value)) v.append(...value.filter(Boolean));
    else v.textContent = value;
    const n = document.createElement('span');
    n.className = 'codex-small cos-stat__note';
    // note 同 value：可以是字串或節點陣列（天氣註記要放遊戲圖示）
    if (Array.isArray(note)) n.append(...note.filter(Boolean));
    else n.textContent = note;
    d.append(l, v, n);
    return d;
  }

  /** 距離下一個非「晴朗」時段——回節點陣列（要放天氣圖示），不是字串。 */
  function nextSpecialNote(now) {
    const upcoming = forecaster
      .forecast(now, SCAN_PERIODS)
      .find((slot) => slot.weather.name !== PLAIN_WEATHER && slot.start > now);
    if (!upcoming) return [document.createTextNode('掃描範圍內沒有特殊天氣')];
    return [
      weatherIcon(upcoming.weather, 16),
      document.createTextNode(
        ` ${upcoming.weather.name} ${formatDuration(upcoming.start - now)}後（${localClockText(upcoming.start)}）`,
      ),
    ];
  }

  /**
   * 時間軸的「距離現在」欄。每秒只改這幾格文字，不重建整張表。
   *
   * <b>為什麼值得分開</b>：表格內容只在**天氣時段跨過邊界**時才會變（每 23 分 20 秒），
   * 但倒數每秒都要動。原本每秒重建 40 列＋每列一個天氣 `&lt;img&gt;`——量到重建含 layout
   * 約 0.5 ms／次，不算大，但那是每秒都在做一件 23 分鐘才需要做一次的事，
   * 而且 `&lt;img&gt;` 被重新建立會讓瀏覽器每秒重新解碼／重繪那 40 張圖。
   */
  let timelineCells = [];
  let timelineKey = -1;

  function renderTimeline(now) {
    const key = Math.floor(now / WEATHER_PERIOD);
    if (key === timelineKey) {
      for (const { cell, slot } of timelineCells) {
        const text = now >= slot.start && now < slot.end ? '進行中' : formatDuration(slot.start - now);
        if (cell.textContent !== text) cell.textContent = text;
      }
      return;
    }
    timelineKey = key;
    timelineCells = [];

    // 只列特殊天氣（月塵／靈風）。晴朗佔 70%、且沒有任務綁它，整片列出來只是把重點稀釋掉。
    const rows = forecaster
      .forecast(now, SCAN_PERIODS)
      .filter((slot) => slot.weather.name !== PLAIN_WEATHER)
      .slice(0, SPECIAL_ROWS);
    // 兩欄並排。**左欄放前半、右欄放後半**（不是奇偶交錯）——時間軸是連續的，
    // 交錯排會讓「往下讀」變成「左右跳著讀」，比原本更難用。
    const half = Math.ceil(rows.length / 2);
    const bodies = [el.timeline.querySelector('tbody'), el.timeline2?.querySelector('tbody')];
    for (const b of bodies) if (b) b.innerHTML = '';
    let lastDate = '';

    for (const [i, slot] of rows.entries()) {
      // 換欄時把日期重印一次：右欄第一列若沿用「與上一列同日就留白」的規則，
      // 會出現一個沒有日期的開頭（左欄的最後一列在另一個欄位，讀者看不到那個脈絡）
      const tbody = (i >= half && bodies[1]) ? bodies[1] : bodies[0];
      if (i === half) lastDate = '';
      const tr = document.createElement('tr');
      const isNow = now >= slot.start && now < slot.end;
      if (isNow) tr.classList.add('is-current');

      const date = dateText(slot.start);
      const dateCell = date === lastDate ? '' : date;
      lastDate = date;

      const et = eorzeaClock(slot.start);

      const countdown = td(isNow ? '進行中' : formatDuration(slot.start - now), 'codex-table__num');
      tr.append(
        td(dateCell, 'cos-col-date'),
        // 這兩欄用**裸值**（`clockText` 而非 `localClockText`）——欄位標題已經寫著
        // 「本地時間」與「ET」，格內再標一次會把 5 欄擠爆。這是允許裸值的唯一情形，
        // 判準寫在 `eorzea-time.js` 的 `clockText` 註解，由 clock-labelling 測試守門。
        td(clockText(slot.start), 'codex-table__num'),
        td(`${String(et.hour).padStart(2, '0')}:00`, 'codex-table__num'),
        weatherCell(slot.weather),
        countdown,
      );
      tbody.append(tr);
      timelineCells.push({ cell: countdown, slot });
    }
  }

  function td(text, cls) {
    const e = document.createElement('td');
    if (cls) e.className = cls;
    e.textContent = text;
    return e;
  }

  /** 時間軸的天氣欄：遊戲圖示 ＋ 名稱。 */
  function weatherCell(w) {
    const e = document.createElement('td');
    e.className = 'cos-wcell';
    const ico = weatherIcon(w);
    if (ico) e.append(ico);
    e.append(document.createTextNode(w.name));
    return e;
  }

  return { render };
}
