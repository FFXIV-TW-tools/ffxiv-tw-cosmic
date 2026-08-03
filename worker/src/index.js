/**
 * ffxiv-tw-cosmic-api — 緊急事件通報的路由層。
 *
 * 職責只有三件：擋掉不該進來的（origin／content-type／大小／限流／封鎖）、把 body 交給
 * `logic.js` 驗，然後轉給唯一的 Durable Object。**所有判斷邏輯都不在這裡。**
 *
 * 兩條寫入路徑的信任模型不同，刻意分開：
 *   · 瀏覽器（manual）：有 Origin ⇒ 走白名單＋UUID＋限流。
 *   · 插件（plugin）  ：**沒有 Origin**（不是瀏覽器發的），改用 `X-Plugin-Token` 共享密鑰
 *                      ＋證據自洽檢查。拿 origin 白名單去擋它只會擋到自己人。
 */

import devStages from '../../data/dev-stages.json';
import * as L from './logic.js';
import { CosmicEventsDO } from './events-do.js';

export { CosmicEventsDO };

L.setWorlds(devStages.worlds);

/** 照抄 portal settings worker：只認自家 Pages（含 CF preview hash）與本機。 */
const ORIGIN_PATTERNS = [
  /^https:\/\/([a-f0-9]+\.)?ffxiv-[a-z-]+\.pages\.dev$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$/,
];

const MAX_BODY = 8 * 1024;

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Plugin-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  // 不允許的 origin → 完全不回 ACAO（瀏覽器擋），不回字面 'null'
  // （'null' 會被 sandbox iframe / data: 等 opaque origin 命中而意外放行）。
  if (ORIGIN_PATTERNS.some((re) => re.test(origin))) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(request, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  // 沒有 Origin header 的請求（curl／插件）不走這條路徑，由呼叫端自己決定要不要擋
  if (!origin) return false;
  return ORIGIN_PATTERNS.some((re) => re.test(origin));
}

/** fail-open：binding 缺失或呼叫出錯時放行（沿用 portal 慣例，限流不該變成單點故障）。 */
async function rateLimited(env, request, name) {
  const binding = env[name];
  if (!binding || typeof binding.limit !== 'function') return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { success } = await binding.limit({ key: ip });
    return !success;
  } catch (err) {
    console.warn(`[ratelimit] ${name} 失效（fail-open）:`, (err && err.name) || 'error');
    return false;
  }
}

/** 讀 JSON body，含 8KB 上限。回傳 `{err}` 時呼叫端直接回那個 Response。 */
async function readJson(request) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.includes('application/json')) return { err: [415, 'content_type'] };
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return { err: [413, 'too_large'] };
  const text = await request.text();
  if (text.length > MAX_BODY) return { err: [413, 'too_large'] };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { err: [400, 'bad_json'] };
  }
}

function stub(env) {
  return env.COSMIC_EVENTS.get(env.COSMIC_EVENTS.idFromName('v1'));
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });

    const url = new URL(request.url);
    const path = url.pathname;
    const now = Math.floor(Date.now() / 1000);

    if (path === '/health') return json(request, { ok: true, worlds: L.getWorlds().length });

    // ── 讀取現況 ──
    if (path === '/state' && request.method === 'GET') {
      if (await rateLimited(env, request, 'GET_RATE_LIMITER')) {
        return json(request, { error: 'rate_limited' }, 429);
      }
      // **刻意不加 edge cache**。原設計要用 `caches.default` 擋 DO 讀請求，但算過之後不划算：
      // 前端 60 秒才輪詢一次，就算 50 個人同時開著也只有 72k reads/day，而 DO 免費額度是 1M/day。
      // 換來的是「事件已撤銷但快取還在說進行中」這類 staleness 問題，以及測試要繞開它。
      // 真正的濫用防線是 GET_RATE_LIMITER（120/min/IP），不是快取。
      return json(request, await stub(env).state(now));
    }

    // ── 歷史紀錄（已結束／已撤銷的事件）──
    if (path === '/history' && request.method === 'GET') {
      if (await rateLimited(env, request, 'GET_RATE_LIMITER')) {
        return json(request, { error: 'rate_limited' }, 429);
      }
      const world = url.searchParams.get('world') || '';
      if (world && !L.isKnownWorld(world)) return json(request, { error: 'bad_world' }, 400);
      const limit = Number(url.searchParams.get('limit') || 50);
      return json(request, await stub(env).history(now, { world, limit }));
    }

    // ── 通報 ──
    if (path === '/report' && request.method === 'POST') {
      const pluginToken = request.headers.get('X-Plugin-Token');
      const { body, err } = await readJson(request);
      if (err) return json(request, { error: err[1] }, err[0]);

      if (pluginToken) {
        if (!env.PLUGIN_TOKEN) return json(request, { error: 'not_configured' }, 503);
        if (pluginToken !== env.PLUGIN_TOKEN) return json(request, { error: 'bad_token' }, 401);
        const v = L.validatePluginReport(body, now);
        if (!v.ok) return json(request, { error: v.reason }, 400);
        const r = await stub(env).report(
          { source: 'plugin', world: v.world, startAt: v.startAt, phase: v.phase, variant: v.variant },
          now,
        );
        // 與手動路徑同一套語意：409＝已有進行中事件（本筆只把來源升級成 plugin，不開新的）
        // 或 end 找不到對象。兩條路徑回不同碼會讓 README 與客戶端各信一半。
        return json(request, r, r.ok && !r.duplicate ? 200 : 409);
      }

      if (!originAllowed(request)) return json(request, { error: 'origin' }, 403);
      if (await rateLimited(env, request, 'REPORT_RATE_LIMITER')) {
        return json(request, { error: 'rate_limited' }, 429);
      }
      const v = L.validateManualReport(body, now);
      if (!v.ok) return json(request, { error: v.reason }, 400);
      const s = stub(env);
      if (await s.isBlocked(body.uuid)) return json(request, { error: 'blocked' }, 403);
      const r = await s.report(
        { source: 'manual', world: v.world, startAt: v.startAt, reporter: body.uuid },
        now,
      );
      if (!r.ok) return json(request, r, 429);          // 冷卻中＝請稍後，不是壞請求
      return json(request, r, r.duplicate ? 409 : 200); // 409＝已有進行中事件，本筆轉為附議
    }

    // ── 附議／否認 ──
    if (path === '/vote' && request.method === 'POST') {
      if (!originAllowed(request)) return json(request, { error: 'origin' }, 403);
      if (await rateLimited(env, request, 'VOTE_RATE_LIMITER')) {
        return json(request, { error: 'rate_limited' }, 429);
      }
      const { body, err } = await readJson(request);
      if (err) return json(request, { error: err[1] }, err[0]);
      const v = L.validateVote(body);
      if (!v.ok) return json(request, { error: v.reason }, 400);
      const s = stub(env);
      if (await s.isBlocked(v.uuid)) return json(request, { error: 'blocked' }, 403);
      const r = await s.vote(v, now);
      return json(request, r, r.ok ? 200 : 404);
    }

    // ── 放棄靜置期，立刻推播（通報者本人）──
    if (path === '/notify-now' && request.method === 'POST') {
      if (!originAllowed(request)) return json(request, { error: 'origin' }, 403);
      if (await rateLimited(env, request, 'VOTE_RATE_LIMITER')) {
        return json(request, { error: 'rate_limited' }, 429);
      }
      const { body, err } = await readJson(request);
      if (err) return json(request, { error: err[1] }, err[0]);
      // 與 /withdraw 同一組欄位（uuid + eventId），共用驗證
      const v = L.validateWithdraw(body);
      if (!v.ok) return json(request, { error: v.reason }, 400);
      const s = stub(env);
      if (await s.isBlocked(v.uuid)) return json(request, { error: 'blocked' }, 403);
      const r = await s.notifyNow(v, now);
      if (r.ok) return json(request, r);
      return json(request, r, r.reason === 'not_found' || r.reason === 'not_active' ? 404 : 403);
    }

    // ── 撤回自己的通報（誤按用）──
    if (path === '/withdraw' && request.method === 'POST') {
      if (!originAllowed(request)) return json(request, { error: 'origin' }, 403);
      if (await rateLimited(env, request, 'VOTE_RATE_LIMITER')) {
        return json(request, { error: 'rate_limited' }, 429);
      }
      const { body, err } = await readJson(request);
      if (err) return json(request, { error: err[1] }, err[0]);
      const v = L.validateWithdraw(body);
      if (!v.ok) return json(request, { error: v.reason }, 400);
      const s = stub(env);
      if (await s.isBlocked(v.uuid)) return json(request, { error: 'blocked' }, 403);
      const r = await s.withdraw(v, now);
      if (r.ok) return json(request, r);
      // 不是本人／已有人附議 → 403（權限問題）；事件不存在或已結束 → 404
      return json(request, r, r.reason === 'not_found' || r.reason === 'not_active' ? 404 : 403);
    }

    // ── 訂閱 ──
    if (path === '/sub') {
      if (!originAllowed(request)) return json(request, { error: 'origin' }, 403);
      if (request.method === 'GET') {
        if (await rateLimited(env, request, 'GET_RATE_LIMITER')) {
          return json(request, { error: 'rate_limited' }, 429);
        }
        const uuid = url.searchParams.get('uuid') || '';
        if (!L.isUuid(uuid)) return json(request, { error: 'bad_uuid' }, 400);
        return json(request, await stub(env).getSub(uuid));
      }
      if (request.method === 'PUT') {
        if (await rateLimited(env, request, 'VOTE_RATE_LIMITER')) {
          return json(request, { error: 'rate_limited' }, 429);
        }
        const { body, err } = await readJson(request);
        if (err) return json(request, { error: err[1] }, err[0]);
        const v = L.validateSub(body);
        if (!v.ok) return json(request, { error: v.reason }, 400);
        const s = stub(env);
        if (await s.isBlocked(v.uuid)) return json(request, { error: 'blocked' }, 403);
        return json(request, await s.putSub(v, now));
      }
      return json(request, { error: 'method' }, 405);
    }

    // ── 管理（Bearer ADMIN_TOKEN）──
    if (path.startsWith('/admin/')) {
      if (!env.ADMIN_TOKEN) return json(request, { error: 'not_configured' }, 503);
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return json(request, { error: 'unauthorized' }, 401);
      const s = stub(env);
      if (path === '/admin/stats') return json(request, await s.stats());
      if (request.method !== 'POST') return json(request, { error: 'method' }, 405);
      const { body, err } = await readJson(request);
      if (err) return json(request, { error: err[1] }, err[0]);
      if (path === '/admin/revoke') {
        if (!Number.isInteger(body?.eventId)) return json(request, { error: 'bad_event' }, 400);
        const r = await s.revoke(body.eventId, now);
        return json(request, r, r.ok ? 200 : 404);
      }
      if (path === '/admin/adjust') {
        if (!Number.isInteger(body?.eventId)) return json(request, { error: 'bad_event' }, 400);
        // 只接受合理範圍內的時間戳，避免手滑把事件丟到 1970 或 2286
        if (!Number.isInteger(body?.startAt) || Math.abs(body.startAt - now) > 86400) {
          return json(request, { error: 'bad_start' }, 400);
        }
        const r = await s.adjustStart(body.eventId, body.startAt, now);
        return json(request, r, r.ok ? 200 : 404);
      }
      if (path === '/admin/purge') return json(request, await s.purgeRevoked(now));
      if (path === '/admin/block') {
        if (!L.isUuid(body?.uuid)) return json(request, { error: 'bad_uuid' }, 400);
        return json(request, await s.block(body.uuid, String(body.note ?? ''), now));
      }
      return json(request, { error: 'not_found' }, 404);
    }

    return json(request, { error: 'not_found' }, 404);
  },
};
