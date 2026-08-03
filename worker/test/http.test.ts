// worker/test/http.test.ts — HTTP 邊界 + DO 狀態的整合測試（vitest-pool-workers 的 SELF.fetch 打整個 handler）
//
// 與 `test/logic.test.mjs`（純函式、node --test）互補：那邊守決策，這邊守**接線**——
// 路由、狀態碼映射、CORS、限流 binding、封鎖／撤銷、SSRF 最後一道防線、fan-out 熔斷、遮罩、退訂刪列。
//
// **絕不打真 Discord**：所有 webhook 送出都由 `vi.stubGlobal('fetch', …)` 攔下。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SELF, env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import devStages from '../../data/dev-stages.json';

const ALLOWED = 'https://ffxiv-tw-cosmic.pages.dev';
const BAD = 'https://evil.example.com';
const W = devStages.worlds[0];
const W2 = devStages.worlds[1];
const HOOK = 'https://discord.com/api/webhooks/111/aaaaTAIL';

let seq = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++seq).padStart(12, '0')}`;

// 限流 binding 在測試環境是**真的會作用**的（每 IP 每分鐘：通報 2、寫入 5）。
// 每個請求給一個獨立來源 IP，這樣測的是路由與狀態，而不是「限流器還在不在」——
// 限流本身另有專門案例。
const ip = () => `10.0.0.${++seq % 250}`;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip(), ...headers,
    },
    body: JSON.stringify(body),
  });
}
function put(path: string, body: unknown) {
  return SELF.fetch(`https://x${path}`, {
    method: 'PUT',
    headers: {
      Origin: ALLOWED, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip(),
    },
    body: JSON.stringify(body),
  });
}

/** 撤銷某筆事件。DO 狀態在同一檔的測試之間共用，所以每個案例要收拾自己的事件。 */
function revoke(eventId: number) {
  return SELF.fetch('https://x/admin/revoke', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId }),
  });
}

/** 把某台伺服器現有的進行中事件清掉，讓案例從乾淨狀態開始（同檔測試共用一個 DO）。 */
async function clearWorld(world: string) {
  const st = await (await SELF.fetch('https://x/state')).json() as any;
  if (st.events[world]) await revoke(st.events[world].id);
}

/** 攔截 fan-out 用的 fetch；回傳收到的 webhook 呼叫清單。 */
function stubDiscord(status = 204) {
  const calls: { url: string; body: any }[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('discord')) {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(null, { status });
    }
    return real(input, init);
  });
  return calls;
}

const PLUG = { 'X-Plugin-Token': 'plugin-secret' };

/** 插件通報一筆——**不受 30 秒靜置影響**，用在只關心 fan-out 本身的案例。 */
function pluginReport(world: string) {
  return post('/report', { world, weatherId: 196, missionIds: [518], phase: 'start' }, PLUG);
}

const doStub = () => env.COSMIC_EVENTS.get(env.COSMIC_EVENTS.idFromName('v1'));

/**
 * 把待推播時間拉到過去再觸發 alarm ＝「30 秒過去了」。
 * 直接等 30 秒會讓測試變成計時器測試；這裡測的是**到期後會做什麼**。
 */
async function fireNotifyNow() {
  await runInDurableObject(doStub(), (inst: any) => {
    inst.sql.exec('UPDATE events SET notifyAt = 1 WHERE notifyAt > 0');
  });
  await runDurableObjectAlarm(doStub());
}

beforeEach(() => {
  env.PLUGIN_TOKEN = 'plugin-secret';
  env.ADMIN_TOKEN = 'admin-secret';
});
afterEach(() => vi.unstubAllGlobals());

describe('邊界', () => {
  it('health → 200', async () => {
    const res = await SELF.fetch('https://x/health');
    expect(res.status).toBe(200);
    expect((await res.json() as any).worlds).toBe(7);
  });

  it('不允許的 origin 不回 ACAO，且寫入被 403', async () => {
    const res = await SELF.fetch('https://x/health', { headers: { Origin: BAD } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const r = await SELF.fetch('https://x/report', {
      method: 'POST',
      headers: { Origin: BAD, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: uuid(), world: W, startsInMinutes: 0 }),
    });
    expect(r.status).toBe(403);
  });

  // B-047：遷 xivtc.com 期間的雙列契約。漏新的 ⇒ cosmic.xivtc.com 的通報／同步全滅；
  // 漏舊的 ⇒ 手上是舊書籤的既有使用者當場斷線。兩邊都要有斷言才擋得住其中一邊被順手刪掉。
  it('新網域 cosmic.xivtc.com 放行，未列舉的 xivtc 子網域仍被拒', async () => {
    const ok = await SELF.fetch('https://x/health', { headers: { Origin: 'https://cosmic.xivtc.com' } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://cosmic.xivtc.com');
    for (const o of ['https://unknown.xivtc.com', 'https://cosmic.xivtc.com.attacker.net']) {
      const r = await SELF.fetch('https://x/health', { headers: { Origin: o } });
      expect(r.headers.get('Access-Control-Allow-Origin'), o).toBeNull();
    }
  });

  it('同一 IP 連續通報會被限流（2/60s）', async () => {
    stubDiscord();
    const same = '203.0.113.7';
    const send = () => SELF.fetch('https://x/report', {
      method: 'POST',
      headers: { Origin: ALLOWED, 'Content-Type': 'application/json', 'CF-Connecting-IP': same },
      body: JSON.stringify({ uuid: uuid(), world: devStages.worlds[5], startsInMinutes: 0 }),
    });
    await send();
    await send();
    expect((await send()).status).toBe(429);
  });

  // 外審 round-2 finding 2：如果路由吃 body 裡的 now，任何人都能繞過冷卻與過期判定。
  // 正式路徑只用伺服器時鐘——這條把它釘死，別讓誰哪天「為了好測」把它接出來。
  it('body 裡的 now 被完全忽略（安全時鐘不可由外部控制）', async () => {
    stubDiscord();
    const world = devStages.worlds[3];
    const r = await post('/report', { uuid: uuid(), world, startsInMinutes: 0, now: 1 });
    expect(r.status).toBe(200);
    const st = await (await SELF.fetch('https://x/state')).json() as any;
    // 若 now 被採用，startAt 會是 1（1970），倒數與過期判定全毀
    expect(st.events[world].startAt).toBeGreaterThan(1_700_000_000);
    await revoke(st.events[world].id);
  });

  it('OPTIONS preflight：允許的 origin 回 ACAO 與 methods，不允許的不回', async () => {
    const ok = await SELF.fetch('https://x/report', { method: 'OPTIONS', headers: { Origin: ALLOWED } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(ok.headers.get('Access-Control-Allow-Headers')).toContain('X-Plugin-Token');

    const bad = await SELF.fetch('https://x/report', { method: 'OPTIONS', headers: { Origin: BAD } });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // admin 是非瀏覽器路徑（curl／腳本），沒有 Origin。若誤套白名單會讓管理命令全部 403。
  it('admin 沒有 Origin 但 token 正確仍可用', async () => {
    const res = await SELF.fetch('https://x/admin/stats', { headers: { Authorization: 'Bearer admin-secret' } });
    expect(res.status).toBe(200);
  });

  it('Content-Type 非 json → 415；body 超過 8KB → 413', async () => {
    const r1 = await SELF.fetch('https://x/report', {
      method: 'POST', headers: { Origin: ALLOWED, 'Content-Type': 'text/plain' }, body: '{}',
    });
    expect(r1.status).toBe(415);

    const r2 = await post('/report', { uuid: uuid(), world: W, startsInMinutes: 0, pad: 'x'.repeat(9000) });
    expect(r2.status).toBe(413);
  });
});

describe('手動通報', () => {
  it('第一筆建立事件並出現在 /state', async () => {
    stubDiscord();
    const res = await post('/report', { uuid: uuid(), world: W, startsInMinutes: 0 });
    expect(res.status).toBe(200);
    const { eventId } = await res.json() as any;
    expect(eventId).toBeGreaterThan(0);

    const st = await (await SELF.fetch(`https://x/state?bust=${seq}`)).json() as any;
    expect(st.events[W].id).toBe(eventId);
    expect(st.events[W].source).toBe('manual');
  });

  it('進行中再通報 → 409，且轉成附議而不是新事件', async () => {
    stubDiscord();
    const first = await (await post('/report', { uuid: uuid(), world: W2, startsInMinutes: 0 })).json() as any;
    const res = await post('/report', { uuid: uuid(), world: W2, startsInMinutes: 0 });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.eventId).toBe(first.eventId);
    expect(body.duplicate).toBe(true);
  });

  it('欄位不合 → 400', async () => {
    expect((await post('/report', { uuid: uuid(), world: W, startsInMinutes: 99 })).status).toBe(400);
    expect((await post('/report', { uuid: 'x', world: W, startsInMinutes: 0 })).status).toBe(400);
    expect((await post('/report', { uuid: uuid(), world: '拉姆', startsInMinutes: 0 })).status).toBe(400);
  });
});

describe('插件通報', () => {
  const world = devStages.worlds[2];

  it('token 錯 → 401；證據不自洽 → 400', async () => {
    const good = { world, weatherId: 196, missionIds: [518], phase: 'start' };
    expect((await post('/report', good, { 'X-Plugin-Token': 'wrong' })).status).toBe(401);
    expect((await post('/report', { ...good, weatherId: 49 }, { 'X-Plugin-Token': 'plugin-secret' })).status).toBe(400);
    expect((await post('/report', { ...good, missionIds: [362] }, { 'X-Plugin-Token': 'plugin-secret' })).status).toBe(400);
  });

  it('start 建立事件、end 把 endAt 收到現在', async () => {
    stubDiscord();
    const start = await post('/report',
      { world, weatherId: 196, missionIds: [518], phase: 'start' }, { 'X-Plugin-Token': 'plugin-secret' });
    expect(start.status).toBe(200);

    const before = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(before.events[world].source).toBe('plugin');

    const end = await post('/report',
      { world, weatherId: 196, missionIds: [], phase: 'end' }, { 'X-Plugin-Token': 'plugin-secret' });
    expect(end.status).toBe(200);

    const after = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(after.events[world]).toBeUndefined();
  });
});

describe('schema 遷移', () => {
  // 2026-08-03 實測：variant 與 weather 兩個 ALTER 共用一個 try，先加的那欄已存在時
  // 第一句就丟例外並被 catch 吞掉 ⇒ 後面的欄位永遠沒被建立，症狀是部署後 500
  // 「table events has no column named weather」。本機全新 DB 測不出來——所以這條測的是
  // 「每一欄都真的存在」，而不是「建構子有沒有丟例外」。
  it('events 表的每一個後加欄位都存在（一欄一個 ALTER）', async () => {
    const cols = await runInDurableObject(doStub(), (inst: any) =>
      [...inst.sql.exec('PRAGMA table_info(events)')].map((r: any) => r.name));
    for (const c of ['variant', 'weather', 'nConfirm', 'nDispute', 'warnedAt', 'notifyAt']) {
      expect(cols).toContain(c);
    }
  });
});

describe('事件變體（α／β）', () => {
  const world = devStages.worlds[3];

  it('插件帶 variant → 存下來並在 /state 帶出；未知值退 400', async () => {
    stubDiscord();
    await clearWorld(world);
    const bad = await post('/report',
      { world, weatherId: 196, missionIds: [518], phase: 'start', variant: 'storm-z' }, PLUG);
    expect(bad.status).toBe(400);

    const ok = await post('/report',
      { world, weatherId: 196, missionIds: [518], phase: 'start', variant: 'storm-a' }, PLUG);
    expect(ok.status).toBe(200);
    const st = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(st.events[world].variant).toBe('storm-a');
    await revoke(st.events[world].id);
  });

  it('手動通報也能帶變體；後到的附議者只補空欄，不改寫已定下來的', async () => {
    stubDiscord();
    const w = devStages.worlds[6];
    await clearWorld(w);
    // 第一個人只看到預告 ⇒ 只報得出天氣種類
    const first = await (await post('/report',
      { uuid: uuid(), world: w, startsInMinutes: 0, weather: 'storm' })).json() as any;
    const mid = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect([mid.events[w].weather, mid.events[w].variant]).toEqual(['storm', null]);

    // 第二個人事件開始後才進來，看得到開始通告 ⇒ 補上 α／β（空欄才補）
    const dup = await post('/report',
      { uuid: uuid(), world: w, startsInMinutes: 0, variant: 'storm-b' });
    expect(dup.status).toBe(409);                       // 已有進行中事件 ⇒ 轉附議
    const after = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(after.events[w].variant).toBe('storm-b');
    expect(after.events[w].id).toBe(first.eventId);

    // 第三個人選錯了也蓋不掉已經定下來的變體
    await post('/report', { uuid: uuid(), world: w, startsInMinutes: 0, variant: 'spore-a' });
    const last = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(last.events[w].variant).toBe('storm-b');
    await revoke(first.eventId);
  });

  it('phase 拼錯不再被靜默當成 start', async () => {
    const r = await post('/report',
      { world, weatherId: 196, missionIds: [518], phase: 'strat' }, PLUG);
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toBe('bad_phase');
  });

  it('預告時沒有變體，開始通告才補上（COALESCE 不會用 null 蓋掉）', async () => {
    stubDiscord();
    const w = devStages.worlds[5];
    await clearWorld(w);
    const warn = await post('/report', { world: w, phase: 'warn' }, PLUG);
    expect(warn.status).toBe(200);
    const mid = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(mid.events[w].variant).toBeNull();

    await post('/report',
      { world: w, weatherId: 196, missionIds: [518], phase: 'start', variant: 'spore-b' }, PLUG);
    const after = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(after.events[w].variant).toBe('spore-b');
    expect(after.events[w].id).toBe(mid.events[w].id);   // 同一筆，不是新開的
    await revoke(after.events[w].id);
  });
});

describe('投票', () => {
  it('3 否認 0 附議 → disputed，且不再出現在 /state', async () => {
    stubDiscord();
    const world = devStages.worlds[3];
    const { eventId } = await (await post('/report', { uuid: uuid(), world, startsInMinutes: 0 })).json() as any;
    for (let i = 0; i < 3; i++) {
      const r = await post('/vote', { uuid: uuid(), eventId, kind: 'dispute' });
      expect(r.status).toBe(200);
    }
    const st = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(st.events[world]).toBeUndefined();
  });

  it('不存在的事件 → 404', async () => {
    expect((await post('/vote', { uuid: uuid(), eventId: 999999, kind: 'confirm' })).status).toBe(404);
  });
});

describe('來源升級與冷卻', () => {
  // 玩家先報、插件稍後證實＝必然會發生的順序。插件沒有 UUID 不能偽裝成附議，
  // 但它的可信度較高 ⇒ 事件來源升級為 plugin，UI 才不會繼續標成低可信的「玩家通報」。
  it('manual 事件被插件證實後，來源升級為 plugin', async () => {
    stubDiscord();
    const world = devStages.worlds[1];
    // 先清掉該 world 既有事件，確保這輪是乾淨的
    const pre = await (await SELF.fetch('https://x/state')).json() as any;
    if (pre.events[world]) await revoke(pre.events[world].id);
    await post('/report', { uuid: uuid(), world, startsInMinutes: 0 });
    const before = await (await SELF.fetch('https://x/state')).json() as any;
    expect(before.events[world].source).toBe('manual');

    const r = await post('/report',
      { world, weatherId: 195, missionIds: [520], phase: 'start' }, { 'X-Plugin-Token': 'plugin-secret' });
    expect(r.status).toBe(409);   // 已有進行中事件 ⇒ 不開新的
    const after = await (await SELF.fetch('https://x/state')).json() as any;
    expect(after.events[world].id).toBe(before.events[world].id);
    expect(after.events[world].source).toBe('plugin');
    await revoke(after.events[world].id);
  });

  it('同一 UUID 同伺服器在冷卻內不能再開新事件（429）', async () => {
    stubDiscord();
    const world = devStages.worlds[2];
    const u = uuid();
    const first = await post('/report', { uuid: u, world, startsInMinutes: 0 });
    const id = (await first.json() as any).eventId;
    // 撤銷掉事件 ⇒ 已無 active，但冷卻仍應擋住同一人立刻再開
    await revoke(id);
    const again = await post('/report', { uuid: u, world, startsInMinutes: 0 });
    expect(again.status).toBe(429);
    expect((await again.json() as any).reason).toBe('cooldown');
    // 別人不受影響
    const other = await post('/report', { uuid: uuid(), world, startsInMinutes: 0 });
    expect(other.status).toBe(200);
    await revoke((await other.json() as any).eventId);
  });

  it('phase:end 在沒有進行中事件時不做任何事', async () => {
    const world = devStages.worlds[6];
    const r = await post('/report',
      { world, weatherId: 196, phase: 'end' }, { 'X-Plugin-Token': 'plugin-secret' });
    expect(r.status).toBe(409);
    expect((await r.json() as any).reason).toBe('no_active_event');
  });
});

describe('訂閱', () => {
  it('GET 只回遮罩後的 webhook', async () => {
    const u = uuid();
    await put('/sub', { uuid: u, worlds: [W], webhookUrl: HOOK });
    const got = await (await SELF.fetch(`https://x/sub?uuid=${u}`, { headers: { Origin: ALLOWED } })).json() as any;
    expect(got.worlds).toEqual([W]);
    expect(got.webhookUrl).toContain('TAIL');
    expect(got.webhookUrl).not.toContain('111');
  });

  it('worlds 空陣列 → 實體刪列', async () => {
    const u = uuid();
    await put('/sub', { uuid: u, worlds: [W], webhookUrl: HOOK });
    await put('/sub', { uuid: u, worlds: [] });
    const got = await (await SELF.fetch(`https://x/sub?uuid=${u}`, { headers: { Origin: ALLOWED } })).json() as any;
    expect(got.worlds).toEqual([]);
    expect(got.webhookUrl).toBe('');
  });

  it('非 discord 網域的 webhook → 400', async () => {
    for (const bad of ['https://discord.com.evil.tld/x', 'https://evildiscord.com/x', 'http://discord.com/x']) {
      expect((await put('/sub', { uuid: uuid(), worlds: [W], webhookUrl: bad })).status).toBe(400);
    }
  });
});

describe('fan-out', () => {
  it('只送給訂了該伺服器的人', async () => {
    const calls = stubDiscord();
    const world = devStages.worlds[4];
    await put('/sub', { uuid: uuid(), worlds: [world], webhookUrl: HOOK });
    await put('/sub', { uuid: uuid(), worlds: [devStages.worlds[5]], webhookUrl: HOOK });

    // 用插件通報：這個案例測的是「只送給訂了這台的人」，不該被手動通報的靜置期干擾
    await pluginReport(world);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body.embeds[0].title).toContain(world);
  });

  it('連續失敗 4 次 → 該訂閱標 broken 並停送', async () => {
    const calls = stubDiscord(500);
    const world = devStages.worlds[6];
    const u = uuid();
    await put('/sub', { uuid: u, worlds: [world], webhookUrl: HOOK });

    for (let i = 0; i < 5; i++) {
      // 每輪先撤銷上一個事件，才能再開一個新的（同伺服器同時只有一個 active）
      const r = await pluginReport(world);
      const body = await r.json() as any;
      await SELF.fetch('https://x/admin/revoke', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: body.eventId }),
      });
    }
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(4));
    const got = await (await SELF.fetch(`https://x/sub?uuid=${u}`, { headers: { Origin: ALLOWED } })).json() as any;
    expect(got.broken).toBe(true);
    const n = calls.length;
    await pluginReport(world);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(n);   // 熔斷後不再送
  });
});

describe('手動通報靜置 30 秒才推播', () => {
  // DO 狀態同檔共用：別的案例留下的訂閱者也會收到自己那台的推播。
  // 所以一律只數「標題裡是本案例那台伺服器」的那幾條，不數總量。
  const sentFor = (calls: { body: any }[], world: string) =>
    calls.filter((c) => String(c.body.embeds[0].title).includes(world)).length;

  it('按下去當下不推播，事件本身立刻就在 /state 上', async () => {
    const calls = stubDiscord();
    const world = devStages.worlds[3];
    await clearWorld(world);
    await put('/sub', { uuid: uuid(), worlds: [world], webhookUrl: HOOK });

    const r = await post('/report', { uuid: uuid(), world, startsInMinutes: 0 });
    const { eventId } = await r.json() as any;
    await new Promise((res) => setTimeout(res, 50));
    expect(sentFor(calls, world)).toBe(0);            // 還在靜置期

    const st = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(st.events[world].id).toBe(eventId);        // 但網站上看得到——延遲的只有推播

    await fireNotifyNow();
    expect(sentFor(calls, world)).toBe(1);
    await revoke(eventId);
  });

  it('靜置期內撤回 → 一則通知都不會送出，而且回傳的話術要如實說出這件事', async () => {
    const calls = stubDiscord();
    const world = devStages.worlds[4];
    await clearWorld(world);
    await put('/sub', { uuid: uuid(), worlds: [world], webhookUrl: HOOK });

    const u = uuid();
    const { eventId } = await (await post('/report', { uuid: u, world, startsInMinutes: 0 })).json() as any;
    const w = await post('/withdraw', { uuid: u, eventId });
    expect(w.status).toBe(200);
    expect((await w.json() as any).note).toContain('沒有人會收到');

    await fireNotifyNow();
    expect(sentFor(calls, world)).toBe(0);   // 這一條就是整個機制存在的理由
  });

  it('別人附議 → 立刻送，不再等靜置期滿', async () => {
    const calls = stubDiscord();
    const world = devStages.worlds[2];
    await clearWorld(world);
    await put('/sub', { uuid: uuid(), worlds: [world], webhookUrl: HOOK });

    const { eventId } = await (await post('/report', { uuid: uuid(), world, startsInMinutes: 0 })).json() as any;
    expect(sentFor(calls, world)).toBe(0);

    await post('/vote', { uuid: uuid(), eventId, kind: 'confirm' });
    await vi.waitFor(() => expect(sentFor(calls, world)).toBeGreaterThanOrEqual(1));
    await revoke(eventId);
  });

  it('通報者按「馬上通知」→ 立刻送；別人按同一顆是 403，送過再按是 403', async () => {
    const calls = stubDiscord();
    const world = devStages.worlds[6];
    await clearWorld(world);
    await put('/sub', { uuid: uuid(), worlds: [world], webhookUrl: HOOK });

    const u = uuid();
    const { eventId } = await (await post('/report', { uuid: u, world, startsInMinutes: 0 })).json() as any;

    // 不是通報者 → 403
    expect((await post('/notify-now', { uuid: uuid(), eventId })).status).toBe(403);
    expect(sentFor(calls, world)).toBe(0);

    const ok = await post('/notify-now', { uuid: u, eventId });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).note).toContain('無法撤回');
    await vi.waitFor(() => expect(sentFor(calls, world)).toBeGreaterThanOrEqual(1));

    // 已經送過了 → 403（不是 200，避免重複推播）
    expect((await post('/notify-now', { uuid: u, eventId })).status).toBe(403);
    await revoke(eventId);
  });

  it('插件在靜置期內證實同一台 → 立刻送，不再等', async () => {
    const calls = stubDiscord();
    const world = devStages.worlds[5];
    await clearWorld(world);
    await put('/sub', { uuid: uuid(), worlds: [world], webhookUrl: HOOK });

    const { eventId } = await (await post('/report', { uuid: uuid(), world, startsInMinutes: 0 })).json() as any;
    expect(sentFor(calls, world)).toBe(0);

    await pluginReport(world);      // 遊戲天氣證實了它
    await vi.waitFor(() => expect(sentFor(calls, world)).toBeGreaterThanOrEqual(1));
    await revoke(eventId);
  });
});

describe('預告（warn）→ 進行中', () => {
  const plug = { 'X-Plugin-Token': 'plugin-secret' };

  it('warn 建立「未知開始時間」的事件（startAt=0），天氣翻轉後就地升級成同一筆', async () => {
    const calls = stubDiscord();
    const world = devStages.worlds[1];
    await clearWorld(world);

    const w = await post('/report', { world, phase: 'warn' }, plug);
    expect(w.status).toBe(200);
    const id = (await w.json() as any).eventId;

    const s1 = await (await SELF.fetch('https://x/state')).json() as any;
    expect(s1.events[world].startAt).toBe(0);        // 不假裝知道何時開始
    expect(s1.events[world].warnedAt).toBeGreaterThan(0);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(0));

    // 天氣真的翻轉 ⇒ 同一筆升級，不開新事件
    const st = await post('/report', { world, weatherId: 196, phase: 'start' }, plug);
    expect(st.status).toBe(200);
    expect((await st.json() as any).eventId).toBe(id);

    const s2 = await (await SELF.fetch('https://x/state')).json() as any;
    expect(s2.events[world].id).toBe(id);
    expect(s2.events[world].startAt).toBeGreaterThan(0);
    expect(s2.events[world].startExact).toBe(true);
    await revoke(id);
  });

  it('warn 不要求 weatherId（那一刻天氣還沒翻轉）', async () => {
    stubDiscord();
    const world = devStages.worlds[2];
    await clearWorld(world);
    const r = await post('/report', { world, phase: 'warn' }, plug);
    expect(r.status).toBe(200);
    await revoke((await r.json() as any).eventId);
  });

  it('已經有事件時再收到 warn → 409，不開第二筆', async () => {
    stubDiscord();
    const world = devStages.worlds[0];
    await clearWorld(world);
    const first = (await (await post('/report', { world, phase: 'warn' }, plug)).json() as any).eventId;
    const again = await post('/report', { world, phase: 'warn' }, plug);
    expect(again.status).toBe(409);
    expect((await again.json() as any).eventId).toBe(first);
    await revoke(first);
  });

  it('歷史紀錄帶出提前量（預告→實際開始）', async () => {
    stubDiscord();
    const world = devStages.worlds[4];
    await clearWorld(world);
    const id = (await (await post('/report', { world, phase: 'warn' }, plug)).json() as any).eventId;
    await post('/report', { world, weatherId: 196, phase: 'start' }, plug);
    await revoke(id);
    const h = await (await SELF.fetch(`https://x/history?world=${encodeURIComponent(world)}`)).json() as any;
    const row = h.rows.find((x: any) => x.id === id);
    expect(row.warnedAt).toBeGreaterThan(0);
    expect(row.leadSeconds).not.toBeNull();
  });
});

describe('撤回自己的通報', () => {
  it('本人可撤回，之後不再出現在 /state、歷史標 withdrawn', async () => {
    stubDiscord();
    const world = devStages.worlds[6];
    await clearWorld(world);
    const u = uuid();
    const id = (await (await post('/report', { uuid: u, world, startsInMinutes: 0 })).json() as any).eventId;

    const r = await post('/withdraw', { uuid: u, eventId: id });
    expect(r.status).toBe(200);
    const st = await (await SELF.fetch('https://x/state')).json() as any;
    expect(st.events[world]).toBeUndefined();
    const h = await (await SELF.fetch(`https://x/history?world=${encodeURIComponent(world)}`)).json() as any;
    expect(h.rows.find((x: any) => x.id === id).status).toBe('withdrawn');
  });

  it('別人不能撤 → 403；已有人附議 → 403', async () => {
    stubDiscord();
    const world = devStages.worlds[3];
    await clearWorld(world);
    const u = uuid();
    const id = (await (await post('/report', { uuid: u, world, startsInMinutes: 0 })).json() as any).eventId;

    expect((await post('/withdraw', { uuid: uuid(), eventId: id })).status).toBe(403);

    await post('/vote', { uuid: uuid(), eventId: id, kind: 'confirm' });
    const r = await post('/withdraw', { uuid: u, eventId: id });
    expect(r.status).toBe(403);
    expect((await r.json() as any).reason).toBe('has_confirms');
    await revoke(id);
  });

  it('不存在的事件 → 404', async () => {
    expect((await post('/withdraw', { uuid: uuid(), eventId: 999999 })).status).toBe(404);
  });
});

describe('歷史紀錄', () => {
  it('已結束／已撤銷的事件會列出來，進行中的不列', async () => {
    stubDiscord();
    const world = devStages.worlds[5];
    await clearWorld(world);
    const r = await post('/report', { uuid: uuid(), world, startsInMinutes: 0 });
    const id = (await r.json() as any).eventId;

    // 進行中 ⇒ 還不算歷史
    const during = await (await SELF.fetch(`https://x/history?world=${encodeURIComponent(world)}`)).json() as any;
    expect(during.rows.find((x: any) => x.id === id)).toBeUndefined();

    await revoke(id);
    const after = await (await SELF.fetch(`https://x/history?world=${encodeURIComponent(world)}`)).json() as any;
    const row = after.rows.find((x: any) => x.id === id);
    expect(row).toBeDefined();
    expect(row.status).toBe('revoked');      // 撤銷的也要看得到，藏起來等於給一份被修過的資料
    expect(row.world).toBe(world);
    expect(after.retentionDays).toBe(90);
    // 歷史只回計數，不回任何 UUID
    expect(JSON.stringify(after)).not.toContain('aaaaaaaa-');
  });

  it('投票數會存進歷史（去識別後仍看得到數量）', async () => {
    stubDiscord();
    const world = devStages.worlds[4];
    await clearWorld(world);   // 前面的 fan-out 案例在這台留了進行中事件，不清會變成附議
    const r = await post('/report', { uuid: uuid(), world, startsInMinutes: 0 });
    const id = (await r.json() as any).eventId;
    await post('/vote', { uuid: uuid(), eventId: id, kind: 'confirm' });
    await post('/vote', { uuid: uuid(), eventId: id, kind: 'confirm' });
    await revoke(id);

    const h = await (await SELF.fetch(`https://x/history?world=${encodeURIComponent(world)}`)).json() as any;
    expect(h.rows.find((x: any) => x.id === id).confirms).toBe(2);
  });

  it('未知伺服器 → 400', async () => {
    expect((await SELF.fetch('https://x/history?world=拉姆')).status).toBe(400);
  });
});

describe('管理', () => {
  it('缺 token → 401；撤銷後 /state 不再列', async () => {
    stubDiscord();
    const world = devStages.worlds[0];
    const { eventId } = await (await post('/report', { uuid: uuid(), world, startsInMinutes: 0 })).json() as any;
    expect((await SELF.fetch('https://x/admin/stats')).status).toBe(401);

    const res = await SELF.fetch('https://x/admin/revoke', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId }),
    });
    expect(res.status).toBe(200);
    const st = await (await SELF.fetch(`https://x/state?bust=${++seq}`)).json() as any;
    expect(st.events[world]?.id).not.toBe(eventId);
  });

  it('封鎖 UUID 後該人所有寫入都 403，訂閱一併刪除', async () => {
    const u = uuid();
    await put('/sub', { uuid: u, worlds: [W], webhookUrl: HOOK });
    const res = await SELF.fetch('https://x/admin/block', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: u, note: '測試' }),
    });
    expect(res.status).toBe(200);

    expect((await post('/report', { uuid: u, world: W, startsInMinutes: 0 })).status).toBe(403);
    expect((await post('/vote', { uuid: u, eventId: 1, kind: 'confirm' })).status).toBe(403);
    expect((await put('/sub', { uuid: u, worlds: [W] })).status).toBe(403);

    const got = await (await SELF.fetch(`https://x/sub?uuid=${u}`, { headers: { Origin: ALLOWED } })).json() as any;
    expect(got.worlds).toEqual([]);
  });

  it('adjust 校正開始時間，endAt 跟著重算', async () => {
    stubDiscord();
    const world = devStages.worlds[3];
    await clearWorld(world);
    const id = (await (await post('/report', { uuid: uuid(), world, startsInMinutes: 0 })).json() as any).eventId;
    const before = await (await SELF.fetch('https://x/state')).json() as any;
    const target = before.events[world].startAt - 600;   // 往前推 10 分鐘

    const res = await SELF.fetch('https://x/admin/adjust', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: id, startAt: target }),
    });
    expect(res.status).toBe(200);
    const after = await (await SELF.fetch('https://x/state')).json() as any;
    expect(after.events[world].startAt).toBe(target);
    expect(after.events[world].endAt).toBe(target + 1200);
    expect(after.events[world].startExact).toBe(false);   // 人工估的，不冒充精確
    await revoke(id);
  });

  it('adjust 拒絕離譜的時間戳', async () => {
    const res = await SELF.fetch('https://x/admin/adjust', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: 1, startAt: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('purge 只刪已撤銷／已撤回的，跑完的真實事件留著', async () => {
    stubDiscord();
    const worldA = devStages.worlds[5];
    await clearWorld(worldA);
    // 一筆會被撤銷的
    const doomed = (await (await post('/report', { uuid: uuid(), world: worldA, startsInMinutes: 0 })).json() as any).eventId;
    await revoke(doomed);

    const res = await SELF.fetch('https://x/admin/purge', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deleted).toBeGreaterThan(0);

    const h = await (await SELF.fetch('https://x/history?limit=100')).json() as any;
    expect(h.rows.find((x: any) => x.id === doomed)).toBeUndefined();
    // 沒有任何 revoked/withdrawn 殘留
    expect(h.rows.filter((x: any) => ['revoked','withdrawn'].includes(x.status)).length).toBe(0);
  });

  it('stats 有分來源的桶', async () => {
    const res = await SELF.fetch('https://x/admin/stats', { headers: { Authorization: 'Bearer admin-secret' } });
    const s = await res.json() as any;
    expect(s.report_ok_manual).toBeGreaterThan(0);
    expect(s.report_ok_plugin).toBeGreaterThan(0);
  });
});
