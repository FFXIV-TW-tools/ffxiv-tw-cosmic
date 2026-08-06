/**
 * 時鐘標記哨兵（2026-08-06）。
 *
 * 這一頁同時存在兩種時鐘——現實時鐘與艾歐澤亞時鐘（ET）——而且**格式完全相同**
 * （`18:30` 對 `15:42`），頁首四格更是把兩者並排。漏標的症狀是**畫面完全正常**：
 * 沒有錯誤、沒有警告、測試全綠，只有使用者看錯時間跑去等。零回饋訊號 ⇒ 需要哨兵。
 *
 * 判準（與 `modules/eorzea-time.js` 的 `clockText` 註解同一份）：
 * · 散文（stat 區塊、狀態列、倒數句）→ 必須用 `localClockText()`，輸出帶「本地」。
 * · 裸值 `clockText()` **只准用在欄位標題已標明時鐘種類的表格**，且該檔要列在下方白名單。
 *
 * 白名單刻意逐檔＋逐次數釘死：只寫「允許這個檔」的話，同一個檔案裡再多加一處漏標仍會綠。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules');

/**
 * 檔名 → 允許出現的裸 `clockText(` 呼叫次數。
 * 每一筆都對應一個**欄位標題已經標明是哪種時鐘**的表格欄位。
 */
const BARE_ALLOWED = {
  // 天氣預報時間軸：`<th>本地時間</th>`（index.html 兩張表共用同一段渲染程式）
  'forecast-view.js': 1,
  // 緊急事件歷史：`<th>開始<span>本地時間</span></th>`
  'emergency-history.js': 1,
  // 定義本體
  'eorzea-time.js': 2,
};

const files = readdirSync(MODULES).filter((f) => f.endsWith('.js'));

test('裸 clockText 只出現在白名單檔案，且次數精確吻合', () => {
  for (const f of files) {
    const src = readFileSync(join(MODULES, f), 'utf8');
    // 只數呼叫，不數註解裡提到的名字：先剝掉 // 與 /* */ 註解
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // `localClockText(` 也含 `clockText(` ⇒ 用非識別字元界定左邊界
    const n = (code.match(/(^|[^A-Za-z_$.])clockText\(/g) ?? []).length;
    const allowed = BARE_ALLOWED[f] ?? 0;
    assert.equal(
      n, allowed,
      `${f}: 裸 clockText( 出現 ${n} 次，白名單允許 ${allowed} 次。`
      + '散文一律改用 localClockText()；真的是表格欄位就把該檔加進 BARE_ALLOWED 並確認表頭有標。',
    );
  }
});

test('localClockText 帶「本地」、etClockText 帶「ET」', async () => {
  const t = await import('../modules/eorzea-time.js');
  const at = 1785984157;
  assert.match(t.localClockText(at), /^本地 \d{2}:\d{2}$/);
  assert.match(t.etClockText(at), /^ET \d{2}:\d{2}$/);
  // 反向控制：兩者不得輸出成同一種東西（複製貼上改錯會靜默通過的那個洞）
  assert.notEqual(t.localClockText(at).slice(0, 2), t.etClockText(at).slice(0, 2));
});

/**
 * ET 的繁中名是**艾奧傑亞**，不是艾歐澤亞（2026-08-06 Owner 指正）。
 *
 * 佐證＝台服 client dump（`data/item_dict/datamining_tc/`）：`tc_Action`／`tc_Fate`／`tc_Item`
 * 都出現「艾奧傑亞」，而「艾歐澤亞」**零筆**。後者是國際服／簡中式的音譯，寫下去不會有任何
 * 錯誤訊號——畫面正常、測試全綠，只是用了錯的官方譯名（全域鐵則「繁中服至上」）。
 *
 * 掃全部原始碼而非只掃 UI 字串：註解裡留著錯譯，下一個人照抄就又回來了。
 *
 * ⚠️ **刻意不掃 `AGENTS.md` 與本檔**：規則本身必須寫得出「不要用哪個詞」，掃它們等於
 * 規則一寫下去就自我違規（第一版真的紅了）。凡是「規範某個字串」的哨兵都有這個坑。
 */
test('ET 的繁中名一律用台服官方譯名', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const targets = [
    ...readdirSync(MODULES).filter((f) => f.endsWith('.js')).map((f) => join(MODULES, f)),
    join(root, 'index.html'),
    ...readdirSync(join(root, 'tools', 'cosmic-dump'))
      .filter((f) => f.endsWith('.cs')).map((f) => join(root, 'tools', 'cosmic-dump', f)),
    // 產物也要掃：ET 條件的 label 是 `Exporters.cs` 組出來寫進 `missions.json` 的，
    // 只改產生器不重跑 dump 的話，**站上顯示的仍是舊譯名**而原始碼看起來已經對了
    // ——這正是 2026-08-06 當下的狀態（源碼全改完、畫面上 22 處還是錯的）。
    ...readdirSync(join(root, 'data'))
      .filter((f) => f.endsWith('.json')).map((f) => join(root, 'data', f)),
  ];
  for (const p of targets) {
    assert.ok(
      !readFileSync(p, 'utf8').includes('艾歐澤亞'),
      `${p}: 「艾歐澤亞」是國際服式音譯，台服官方譯名是「艾奧傑亞」`,
    );
  }
});

test('四格與緊急事件的時間句都帶標記', () => {
  // 這幾支是使用者最常掃到的散文。逐檔斷言「有輸出時間的地方就有 localClockText」，
  // 免得日後有人改寫句子時把標記一起刪掉。
  for (const f of ['forecast-view.js', 'now-panel.js', 'emergency-view.js']) {
    const src = readFileSync(join(MODULES, f), 'utf8');
    assert.ok(src.includes('localClockText('), `${f} 應該用 localClockText 輸出現實時鐘`);
  }
});
