/**
 * 緊急事件的訂閱與通知。
 *
 * **兩個管道的能力不一樣，UI 必須講清楚，不能含糊**：
 *   · 網頁通知 — **只有這個分頁還開著（含被切到背景）才會響**。
 *     原本規劃用 Service Worker 做「關掉分頁也響」，查證後放棄：SW 在沒有任何分頁時
 *     會被瀏覽器終止，計時器不會把它叫醒（W3C service-worker lifetime），
 *     那個承諾根本兌現不了。與其做一個時靈時不靈的東西，不如老實說它的範圍。
 *   · Discord — 由後端送，**關掉瀏覽器、關掉電腦都收得到**。要可靠就用這個。
 *
 * webhook 用 portal 跨工具共用的 `discord.webhookUrl`（使用者可能已經為潛水艇計時器填過），
 * 本站**不自建欄位**——同一個東西存兩份，遲早會有一份是舊的。
 */

import { emergencyApi } from './emergency-api.js';

const WEB_KEY = 'ffxiv-tw-cosmic:em-webnotify';

/** 已響過的 eventId。上界防長開分頁時無限長大（本站鐵則）。 */
const FIRED_CAP = 200;

function loadWebPref() {
  try {
    return localStorage.getItem(WEB_KEY) === '1';
  } catch {
    return false;
  }
}

function saveWebPref(on) {
  try {
    localStorage.setItem(WEB_KEY, on ? '1' : '0');
  } catch {
    // 私密模式／配額滿：這輪仍可運作，只是記不住
  }
}

/**
 * @param {HTMLElement} root #panel-emergency
 * @param {{worlds: string[]}} opts
 */
export function createEmergencyNotify(root, { worlds }) {
  const el = {
    chips: root.querySelector('#em-sub-worlds'),
    web: root.querySelector('#em-web'),
    save: root.querySelector('#em-sub-save'),
    status: root.querySelector('#em-sub-status'),
    discord: root.querySelector('#em-discord-status'),
  };

  const selected = new Set();
  const fired = new Set();
  let webOn = loadWebPref();
  el.web.checked = webOn;

  for (const w of worlds) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'codex-chip';
    b.textContent = w;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      if (selected.has(w)) selected.delete(w);
      else selected.add(w);
      b.setAttribute('aria-pressed', String(selected.has(w)));
    });
    el.chips.append(b);
  }

  function syncChips() {
    for (const b of el.chips.querySelectorAll('[aria-pressed]')) {
      b.setAttribute('aria-pressed', String(selected.has(b.textContent)));
    }
  }

  el.web.addEventListener('change', async () => {
    if (el.web.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // 被拒或不支援：音效與畫面提示照常，只是少一個管道
      }
    }
    webOn = el.web.checked;
    saveWebPref(webOn);
    renderStatus();
  });

  el.save.addEventListener('click', save);

  async function save() {
    el.save.disabled = true;
    const hook = window.FFXIVSettings?.get?.('discord.webhookUrl') ?? '';
    const r = await emergencyApi.putSub([...selected], hook);
    el.status.textContent = r.ok
      ? selected.size === 0
        ? '已退訂 — 後端不再保留你的訂閱資料。'
        : `已儲存：${[...selected].join('、')}`
      : r.message;
    el.save.disabled = false;
    renderDiscord();
  }

  function renderDiscord() {
    const hook = window.FFXIVSettings?.get?.('discord.webhookUrl') ?? '';
    if (hook) {
      el.discord.textContent = '✅ Discord 通知：已設定（關掉瀏覽器也收得到）';
      return;
    }
    el.discord.replaceChildren(
      document.createTextNode('◻ Discord 通知：未設定 — 只會有網頁通知。到工具箱設定填一次 webhook，'),
      Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'codex-btn codex-btn--ghost codex-small',
        textContent: '開啟設定',
        onclick: () => window.FFXIVSettings?.openModal?.(),
      }),
    );
  }

  function renderStatus() {
    const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    if (!webOn) {
      el.status.textContent = '網頁通知：關閉中';
      return;
    }
    el.status.textContent = perm === 'granted'
      ? '網頁通知：開啟中 — 只在這個分頁開著時才會響（可切到背景）'
      : '網頁通知：桌面通知未授權 — 會用音效與畫面提示代替';
  }

  /** 讀回既有訂閱（換裝置時把勾選狀態帶回來）。 */
  async function load() {
    const r = await emergencyApi.getSub();
    if (r.ok && Array.isArray(r.data?.worlds)) {
      selected.clear();
      for (const w of r.data.worlds) selected.add(w);
      syncChips();
      if (r.data.broken) {
        el.status.textContent = '⚠️ 你的 Discord webhook 連續送失敗已被暫停 — 確認網址後按「儲存訂閱」即可恢復。';
        return;
      }
    }
    renderStatus();
    renderDiscord();
  }

  /** 由 view 在每次成功取得現況時呼叫。只對「訂閱的伺服器」且「還沒響過」的事件發通知。 */
  function onState(state) {
    if (!webOn || !state) return;
    const now = Math.floor(Date.now() / 1000);
    for (const w of selected) {
      const ev = state.events?.[w];
      if (!ev || ev.endAt <= now || fired.has(ev.id)) continue;
      fired.add(ev.id);
      if (fired.size > FIRED_CAP) fired.clear();
      fire(w, ev, now);
    }
  }

  function fire(world, ev, now) {
    const title = ev.startAt > now
      ? `⚡ ${world}：緊急事件即將開始`
      : `⚡ ${world}：緊急事件進行中`;
    const body = [
      ev.startAt > now
        ? `約 ${Math.max(0, Math.round((ev.startAt - now) / 60))} 分鐘後開始`
        : `還剩 ${Math.max(0, Math.round((ev.endAt - now) / 60))} 分鐘`,
      ev.source === 'plugin' ? '來源：插件偵測' : '來源：玩家通報（未經覆核）',
    ].join('\n');

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(title, { body, tag: `cosmic-em-${ev.id}`, icon: 'favicon-192.png' });
      } catch {
        // 部分瀏覽器在非 SW 環境限制建構通知：音效與 toast 仍會發
      }
    }
    window.FFXIVSettings?.playAlarm?.({ force: true });
    window.FFXIVToast?.show?.(`${title} — ${body.split('\n')[0]}`, 'ok', 8000);
  }

  load();
  return { onState };
}
