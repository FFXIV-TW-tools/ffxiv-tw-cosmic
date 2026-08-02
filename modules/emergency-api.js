/**
 * 緊急事件後端（`ffxiv-tw-cosmic-api`）的前端客戶端。
 *
 * 這是本站**唯一**會對外發請求的模組——其餘一切仍是純靜態、算得出來的東西。
 * 後端掛掉時整站必須照常運作，只有這一頁降級為唯讀（呼叫端看 `ok:false` 自己處理）。
 *
 * 身份用 portal 跨工具共用的 UUID（`FFXIVSettings.getUuid()`），**不自建**：
 * 使用者已經為 sub-timer／marketboard 有一個了，再發一組只會讓他多記一個祕密。
 */

const DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const BASE = DEV
  ? `http://${location.hostname}:8789`
  : 'https://ffxiv-tw-cosmic-api.ffxiv-tw-tools.workers.dev';

const TIMEOUT_MS = 8000;
const RETRIES = 2;

/** 後端回的 error code → 給人看的話。看不懂的 code 一律走 fallback，不把英文丟到畫面上。 */
const MESSAGES = {
  origin: '這個來源不被後端接受（請從正式網址開啟）。',
  blocked: '這個識別碼已被停用通報功能。',
  rate_limited: '太頻繁了，請等一分鐘再試。',
  cooldown: '你剛才才通報過這台伺服器，請等這次事件結束。',
  bad_world: '伺服器不在繁中服 7 台之內。',
  bad_lead: '開始時間超出可通報範圍（0–15 分鐘）。',
  bad_uuid: '識別碼異常 — 到工具箱設定重新產生一次即可。',
  bad_webhook: 'Discord webhook 網址不對（只接受 discord.com 的 webhook 連結）。',
  not_found: '找不到這筆通報，可能已經過期或被撤銷。',
  not_reporter: '這筆不是你送的，不能撤回 — 如果你認為是誤報，請按「查無此事」。',
  has_confirms: '已經有人附議了，不能撤回 — 別人也看到了就不算誤按。',
  not_active: '這筆已經結束了，撤回沒有作用。',
  no_active_event: '這台伺服器目前沒有進行中的事件。',
  not_configured: '後端尚未完成設定，請稍後再試。',
};

export function messageFor(code) {
  return MESSAGES[code] ?? '後端暫時無法處理，請稍後再試。';
}

/** 429／503 指數退避 ＋ 逾時中止（`FFXIV_API.md` 的標準模式）。 */
async function fetchRetry(url, opts = {}) {
  for (let i = 0; i <= RETRIES; i++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if ((res.status === 429 || res.status === 503) && i < RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (i === RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(tid);
    }
  }
  throw new Error('unreachable');
}

async function call(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetchRetry(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, code: 'offline', message: '連不上通報伺服器（不影響本站其他功能）。' };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok) return { ok: true, data };
  // 409 不是失敗：代表這台伺服器已經有進行中的事件，本筆自動轉成附議
  if (res.status === 409) return { ok: true, data, duplicate: true };
  const code = data?.error ?? 'unknown';
  return { ok: false, code, message: messageFor(code), status: res.status };
}

/** 取得跨工具共用的 UUID。portal 的 settings-client 還沒載入時回 null（呼叫端顯示提示）。 */
export async function currentUuid() {
  const s = window.FFXIVSettings;
  if (!s || typeof s.getUuid !== 'function') return null;
  try {
    if (s.ready) await s.ready;
  } catch {
    // ready 失敗不代表 UUID 拿不到（可能只是雲端拉取失敗），繼續往下試
  }
  return s.getUuid() || null;
}

export const emergencyApi = {
  base: BASE,

  getState: () => call('/state'),

  getHistory: (world = '', limit = 50) =>
    call(`/history?limit=${limit}${world ? `&world=${encodeURIComponent(world)}` : ''}`),

  async report(world, startsInMinutes) {
    const uuid = await currentUuid();
    if (!uuid) return { ok: false, code: 'no_uuid', message: '尚未取得識別碼，請重新整理後再試。' };
    return call('/report', { method: 'POST', body: { uuid, world, startsInMinutes } });
  },

  async withdraw(eventId) {
    const uuid = await currentUuid();
    if (!uuid) return { ok: false, code: 'no_uuid', message: '尚未取得識別碼，請重新整理後再試。' };
    return call('/withdraw', { method: 'POST', body: { uuid, eventId } });
  },

  async vote(eventId, kind) {
    const uuid = await currentUuid();
    if (!uuid) return { ok: false, code: 'no_uuid', message: '尚未取得識別碼，請重新整理後再試。' };
    return call('/vote', { method: 'POST', body: { uuid, eventId, kind } });
  },

  async getSub() {
    const uuid = await currentUuid();
    if (!uuid) return { ok: false, code: 'no_uuid', message: '尚未取得識別碼。' };
    return call(`/sub?uuid=${encodeURIComponent(uuid)}`);
  },

  async putSub(worlds, webhookUrl) {
    const uuid = await currentUuid();
    if (!uuid) return { ok: false, code: 'no_uuid', message: '尚未取得識別碼。' };
    return call('/sub', { method: 'PUT', body: { uuid, worlds, webhookUrl } });
  },
};
