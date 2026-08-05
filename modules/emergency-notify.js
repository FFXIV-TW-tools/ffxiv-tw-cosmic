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
    overlay: root.querySelector('#em-notify-overlay'),
    open: root.querySelector('#em-notify-open'),
    close: root.querySelector('#em-notify-close'),
    cancel: root.querySelector('#em-notify-cancel'),
  };

  /**
   * 設定改成彈窗（Owner 2026-08-03：原本是整頁最後一張卡，要捲過三張才看得到）。
   * a11y 契約照設計系統 §.codex-modal：ESC／點遮罩關閉、開窗鎖焦點、關窗由 release 還焦。
   * `trapFocus` 回傳的是 **release 函式本身**（不是 `{release}` 物件——設計系統註明踩過）。
   */
  let releaseTrap = null;

  function openModal() {
    el.overlay.hidden = false;
    document.body.style.overflow = 'hidden';   // 開窗鎖背景捲動
    releaseTrap = window.FFXIVA11y?.trapFocus?.(el.overlay) ?? null;
  }

  function closeModal() {
    el.overlay.hidden = true;
    document.body.style.overflow = '';
    releaseTrap?.();      // 解除鎖焦點並把焦點還給開窗的那顆按鈕
    releaseTrap = null;
  }

  el.open?.addEventListener('click', openModal);
  el.close?.addEventListener('click', closeModal);
  el.cancel?.addEventListener('click', closeModal);
  el.overlay?.addEventListener('click', (e) => {
    if (e.target === el.overlay) closeModal();   // 只認遮罩本身，點內容不關
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.overlay.hidden) closeModal();
  });

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
    // 同 load()：settings 還沒 hydrate 就存，會把空的 webhook 寫上去 ⇒ 訂閱成功卻收不到 Discord
    const s = await whenSettingsReady();
    const hook = s?.get?.('discord.webhookUrl') ?? '';
    // @ 對象（B-062）：取 SDK **正規化後**的 {type,id}，cosmic 不自己判斷（舊值相容在 SDK 裡）。
    // SDK 還沒更新（使用者快取著舊 settings-client.js）時為 undefined → 後端存 none＝不提及。
    const mention = s?.discordMentionTarget?.();
    const r = await emergencyApi.putSub([...selected], hook, mention);
    el.status.textContent = r.ok
      ? selected.size === 0
        ? '已退訂 — 後端不再保留你的訂閱資料。'
        : `已儲存：${[...selected].join('、')}`
      : r.message;
    el.save.disabled = false;
    renderDiscord();
  }

  /**
   * ⚠️ 這裡**一定要等 `FFXIVSettings.ready`**。settings-client 是非同步 hydrate 的，
   * 建構當下直接讀會拿到空字串 ⇒ 明明填過 webhook 的人看到「未設定」，而且不會再刷新
   * （2026-08-02 正式站實測踩到：畫面說未設定，實際上值是在的）。
   * 這種錯誤方向特別糟——它會讓人以為要去設定頁重填，或以為只能收網頁通知。
   */
  async function whenSettingsReady() {
    const s = window.FFXIVSettings;
    if (!s) return null;
    try {
      if (s.ready) await s.ready;
    } catch {
      // 雲端拉取失敗不代表本機沒有值
    }
    return s;
  }

  /** @ 對象的中文標籤（B-062）。none 不顯示——沒設定的人不需要知道有這回事。 */
  const MENTION_LABEL = { user: '指定成員', role: '身分組', everyone: '@everyone', here: '@here' };

  function renderDiscord() {
    const hook = window.FFXIVSettings?.get?.('discord.webhookUrl') ?? '';
    if (hook) {
      const t = window.FFXIVSettings?.discordMentionTarget?.();
      const label = t && MENTION_LABEL[t.type];
      // ⚠️ 提示「要再按一次儲存」是必要的：@ 對象是**存在後端訂閱裡**的（fan-out 由 worker 送，
      // 那時瀏覽器可能根本沒開）⇒ 改全域設定不會自動同步過去，而不講的話症狀是
      // 「我明明改了設定，通知還是 @ 舊的」，完全看不出要回這頁按一下。
      el.discord.textContent = label
        ? `✅ Discord 通知：已設定（關掉瀏覽器也收得到）· @ 對象：${label} — 改了全域設定要再按一次「儲存訂閱」`
        : '✅ Discord 通知：已設定（關掉瀏覽器也收得到）';
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
    const s = await whenSettingsReady();
    // webhook 之後被改（設定 modal 存檔、其他分頁同步）也要跟著更新，不然畫面會停在舊判斷
    s?.onChange?.('discord.webhookUrl', renderDiscord);
    // @ 對象改了也要重繪（否則畫面上的「@ 對象：…」會停在舊值，看起來像沒存到）
    s?.onChange?.('discord.mentionType', renderDiscord);
    s?.onChange?.('discord.mentionId', renderDiscord);

    const r = await emergencyApi.getSub();
    const subscribed = r.ok && Array.isArray(r.data?.worlds) && r.data.worlds.length > 0;
    if (subscribed) {
      selected.clear();
      for (const w of r.data.worlds) selected.add(w);
    } else {
      // 還沒訂閱過 ⇒ 用跨工具的「我的伺服器」先勾起來（只是預勾，**沒有幫他存**）。
      // 這是這頁最可能想要的預設：你要的是自己那台的通知。
      const mine = s?.get?.('character.mainWorld') ?? '';
      if (worlds.includes(mine)) selected.add(mine);
    }
    syncChips();

    if (r.ok && r.data?.broken) {
      el.status.textContent = '⚠️ 你的 Discord webhook 連續送失敗已被暫停 — 確認網址後按「儲存訂閱」即可恢復。';
      renderDiscord();
      return;
    }
    if (!subscribed) {
      // 「勾好了」跟「訂閱生效了」是兩回事，不能讓預勾看起來像已經訂閱
      el.status.textContent = selected.size
        ? `尚未訂閱 — 已依你的「我的伺服器」預先勾選 ${[...selected].join('、')}，按「儲存訂閱」才會生效。`
        : '尚未訂閱 — 勾選要收通知的伺服器後按「儲存訂閱」。';
      renderDiscord();
      return;
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
    // 不揭露來源（同 Discord 訊息，Owner 2026-08-02）
    const body = [
      ev.startAt > now
        ? `約 ${Math.max(0, Math.round((ev.startAt - now) / 60))} 分鐘後開始`
        : `還剩 ${Math.max(0, Math.round((ev.endAt - now) / 60))} 分鐘`,
      '依回報顯示，實際以遊戲內為準',
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
