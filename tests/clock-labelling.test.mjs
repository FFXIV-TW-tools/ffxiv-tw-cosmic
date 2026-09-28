/**
 * 時鐘標記哨兵（2026-08-06）。
 *
 * 這一頁同時存在兩種時鐘——現實時鐘與艾歐澤亞時鐘（ET）——而且**格式完全相同**
 * （`18:30` 對 `15:42`），頁首四格更是把兩者並排。漏標的症狀是**畫面完全正常**：
 * 沒有錯誤、沒有警告、測試全綠，只有使用者看錯時間跑去等。零回饋訊號 ⇒ 需要哨兵。
 *
 * 散文請標示「本地」或「ET」，欄位裸值需有可見欄名。
 * 此處測時鐘格式的使用者可見輸出，不以呼叫次數限制版面結構。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
test('localClockText 帶「本地」、etClockText 帶「ET」', async () => {
  const t = await import('../modules/eorzea-time.js');
  const at = 1785984157;
  assert.match(t.localClockText(at), /^本地 \d{2}:\d{2}$/);
  assert.match(t.etClockText(at), /^ET \d{2}:\d{2}$/);
  // 反向控制：兩者不得輸出成同一種東西（複製貼上改錯會靜默通過的那個洞）
  assert.notEqual(t.localClockText(at).slice(0, 2), t.etClockText(at).slice(0, 2));
});
