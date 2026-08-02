/**
 * 緊急事件歷史紀錄——已結束或已撤銷的回報，新到舊。
 *
 * **這是本站唯一會累積的緊急事件資料。** 其他所有東西都是時間的純函數（重算即可得），
 * 只有「某台伺服器在某個時刻真的出過事件」這件事，除非有人記下來否則永遠找不回來。
 *
 * ⚠️ **不要拿它當預測用，UI 也不能暗示可以**。目前沒有任何證據顯示緊急事件有規律
 * （它不在任何 WeatherRate 內、也不與 ET 或天氣相關——2026-08-02 已證偽天氣關聯）。
 * 這份表的價值是「以後也許看得出規律」，不是「現在就能推下一次」。
 *
 * 只在使用者切到緊急事件分頁時才抓一次，之後靠通報成功／換伺服器篩選才重抓——
 * 歷史不會自己變，跟著現況每 60 秒輪詢是白花額度。
 */

import { emergencyApi } from './emergency-api.js';
import { clockText, dateText } from './eorzea-time.js';

const STATUS_LABEL = {
  ended: ['已結束', ''],
  withdrawn: ['已取消', 'codex-badge--warn'],
  disputed: ['存疑', 'codex-badge--warn'],
  revoked: ['已撤銷', 'codex-badge--danger'],
};

/**
 * 顯示用的狀態。
 *
 * ⚠️ 資料庫裡的 `status` **不會**因為時間到了就改成別的——過期是用 `endAt` lazy 判定的
 * （後端刻意不排 alarm）。所以一筆早就結束的事件，`status` 仍然是 `active`，
 * 直接拿它當標籤會在歷史表裡寫出一整排「進行中」。這裡按時間補上真正的狀態。
 */
function displayStatus(row, now) {
  if (row.status === 'active') return row.endAt <= now ? 'ended' : 'active';
  return row.status;
}

/**
 * @param {HTMLElement} root #panel-emergency
 * @param {{worlds: string[]}} opts
 */
export function createEmergencyHistory(root, { worlds }) {
  const el = {
    world: root.querySelector('#em-hist-world'),
    body: root.querySelector('#em-hist tbody'),
    table: root.querySelector('#em-hist'),
    empty: root.querySelector('#em-hist-empty'),
    note: root.querySelector('#em-hist-note'),
  };

  el.world.append(new Option('全部伺服器', ''));
  for (const w of worlds) el.world.append(new Option(w, w));
  el.world.addEventListener('change', () => load());

  let loaded = false;

  function render(data) {
    const rows = data?.rows ?? [];
    el.empty.hidden = rows.length > 0;
    el.table.hidden = rows.length === 0;

    el.body.replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      // `active` 在這張表裡不該出現（後端只回已結束／已撤銷的），真的出現就照實寫，不掩飾
      const [label, cls] = STATUS_LABEL[displayStatus(r, data.now)] ?? ['進行中', 'codex-badge--warn'];
      const cells = [
        dateText(r.startAt),
        clockText(r.startAt),
        r.world,
        String(r.confirms),
        String(r.disputes),
        null,   // 狀態用 badge，下面單獨組
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        if (i === 1 || i === 3 || i === 4) td.className = 'codex-table__num';
        if (text !== null) td.textContent = text;
        tr.append(td);
      });
      const badge = document.createElement('span');
      badge.className = `codex-badge ${cls}`.trim();
      badge.textContent = label;
      tr.lastChild.append(badge);
      return tr;
    }));

    el.note.textContent = rows.length
      ? `保留 ${data.retentionDays} 天；滿 7 天的紀錄只留時間與數量，回報者身份會被清掉。`
      : '';
  }

  async function load() {
    const r = await emergencyApi.getHistory(el.world.value, 50);
    if (!r.ok) {
      el.empty.hidden = false;
      el.table.hidden = true;
      el.empty.lastElementChild.textContent = '讀不到歷史紀錄 — 本站其他分頁不受影響';
      return;
    }
    loaded = true;
    render(r.data);
  }

  /** 分頁被切到時才第一次抓；之後由 `refresh()` 明確觸發。 */
  function ensureLoaded() {
    if (!loaded) load();
  }

  return { ensureLoaded, refresh: load };
}
