/**
 * `worker/src/logic.js` 的行為測試。
 *
 * 兩件刻意的事：
 * ① **時間一律注入**——每個案例自己傳 `now`，測試不讀牆鐘（否則同一份測試會在不同時刻有不同結果）。
 * ② **期望值不從實作回抄**——世界名單取自 `data/dev-stages.json`（產生器的產物）、
 *    事件時長對照 `data/missions.json` 裡 critical 任務的 `timeLimit`，都是獨立來源。
 *
 *   node --test worker/test/logic.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as L from '../src/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const devStages = JSON.parse(readFileSync(join(ROOT, 'data', 'dev-stages.json'), 'utf8'));
const missions = JSON.parse(readFileSync(join(ROOT, 'data', 'missions.json'), 'utf8'));

L.setWorlds(devStages.worlds);

const W = devStages.worlds[0];
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const NOW = 1_770_000_000;

test('常數對得上 client 產生的資料', () => {
  const crit = missions.missions.filter((m) => m.critical);
  const limits = [...new Set(crit.map((m) => m.timeLimit))];
  assert.deepEqual(limits, [L.EVENT_DURATION], 'critical 任務的 timeLimit 應該只有一個值且等於 EVENT_DURATION');
  assert.equal(devStages.worlds.length, 7);
  assert.deepEqual(L.getWorlds(), devStages.worlds);

  // 證據自洽檢查的 id 區間必須真的涵蓋全部 critical 任務
  const ids = crit.map((m) => m.id);
  assert.ok(Math.min(...ids) >= L.CRITICAL_MISSION_MIN);
  assert.ok(Math.max(...ids) <= L.CRITICAL_MISSION_MAX);
});

test('手動通報：欄位邊界', () => {
  assert.equal(L.validateManualReport({ uuid: U1, world: W, startsInMinutes: 0 }, NOW).ok, true);
  assert.equal(
    L.validateManualReport({ uuid: U1, world: W, startsInMinutes: 5 }, NOW).ok,
    true,
    '上界 5 要收（＝UI 給的最大選項）',
  );
  // 遊戲的預兆通告只提前約 5 分鐘（實測 5:15 / 5:40），沒有任何管道能知道 6 分鐘後的事
  assert.equal(L.validateManualReport({ uuid: U1, world: W, startsInMinutes: 6 }, NOW).reason, 'bad_lead');
  // 負數＝已經開始了幾分鐘。沒有這個，發現得晚的人只能報「現在」，倒數整段往後偏。
  assert.equal(L.validateManualReport({ uuid: U1, world: W, startsInMinutes: -5 }, NOW).startAt, NOW - 300);
  assert.equal(L.validateManualReport({ uuid: U1, world: W, startsInMinutes: -19 }, NOW).ok, true, '下界 -19 要收');
  assert.equal(
    L.validateManualReport({ uuid: U1, world: W, startsInMinutes: -20 }, NOW).reason, 'bad_lead',
    '再往前就超過 20 分鐘的事件長度，那筆早就結束了',
  );
  assert.equal(L.validateManualReport({ uuid: U1, world: W, startsInMinutes: 1.5 }, NOW).reason, 'bad_lead');
  assert.equal(L.validateManualReport({ uuid: U1, world: '拉姆', startsInMinutes: 0 }, NOW).reason, 'bad_world');
  assert.equal(L.validateManualReport({ uuid: 'nope', world: W, startsInMinutes: 0 }, NOW).reason, 'bad_uuid');
  assert.equal(L.validateManualReport(null, NOW).reason, 'bad_body');
});

test('手動通報：天氣與變體都選填，變體優先於天氣', () => {
  const base = { uuid: U1, world: W, startsInMinutes: 0 };
  // 三種確定程度都要收：什麼都沒填 ／ 只看到預告（分不出 A、B）／ 看到開始通告
  assert.deepEqual(
    [L.validateManualReport(base, NOW).weather, L.validateManualReport(base, NOW).variant],
    [null, null],
    '沒填就是 null，不能自己補一個合理值（鐵則 §2）',
  );
  const kindOnly = L.validateManualReport({ ...base, weather: 'storm' }, NOW);
  assert.deepEqual([kindOnly.weather, kindOnly.variant], ['storm', null]);
  const full = L.validateManualReport({ ...base, variant: 'storm-b' }, NOW);
  assert.deepEqual([full.weather, full.variant], ['storm', 'storm-b'], '天氣由變體前綴推導');
  // 兩欄互相矛盾時變體贏（它是逐字比對通告來的），不是靜默各留一半
  const clash = L.validateManualReport({ ...base, weather: 'spore', variant: 'storm-a' }, NOW);
  assert.deepEqual([clash.weather, clash.variant], ['storm', 'storm-a']);
  assert.equal(L.validateManualReport({ ...base, variant: 'storm-c' }, NOW).reason, 'bad_variant');
  assert.equal(L.validateManualReport({ ...base, weather: 'rain' }, NOW).reason, 'bad_weather_kind');
});

test('手動通報：startAt 是 now + 預告分鐘', () => {
  const r = L.validateManualReport({ uuid: U1, world: W, startsInMinutes: 5 }, NOW);
  assert.equal(r.startAt, NOW + 300);
});

test('插件通報：證據自洽（missionIds 選填）', () => {
  const world = W;
  const good = { world: W, weatherId: 196, missionIds: [362, 518], phase: 'start' };
  assert.equal(L.validatePluginReport(good, NOW).ok, true);

  // 天氣不是緊急天氣 → 退（插件宣稱看到事件，天氣欄卻是平常天氣＝自相矛盾）
  assert.equal(
    L.validatePluginReport({ ...good, weatherId: 49 }, NOW).reason,
    'bad_weather',
  );
  // 有給任務清單卻一個 critical 都沒有 → **不退件**（2026-08-04 改）。
  // 任務板顯示什麼取決於玩家當下的職業，而緊急事件只涉及部分職業 ⇒ 「板上沒有 critical」
  // 是常態，不是矛盾。實測退件會讓整筆 start 消失（見下方專門的案例）。
  assert.equal(L.validatePluginReport({ ...good, missionIds: [362, 363] }, NOW).ok, true);
  // **沒給任務清單是合法的**：任務板沒開著時插件讀不到，而事件不會等人開板
  assert.equal(L.validatePluginReport({ ...good, missionIds: [] }, NOW).ok, true);
  assert.equal(L.validatePluginReport({ world, weatherId: 196, phase: 'start' }, NOW).ok, true);
  // end 相位同理
  assert.equal(L.validatePluginReport({ ...good, phase: 'end', missionIds: [] }, NOW).ok, true);
});

test('warn 相位不要求 weatherId（預告時天氣還沒翻轉）', () => {
  assert.equal(L.validatePluginReport({ world: W, phase: 'warn' }, NOW).ok, true);
  assert.equal(L.validatePluginReport({ world: W, phase: 'warn' }, NOW).phase, 'warn');
  // start/end 仍然要求——那兩個確實是看著天氣送的
  assert.equal(L.validatePluginReport({ world: W, phase: 'start' }, NOW).reason, 'bad_weather');
});

/**
 * Container payload 的文字區（Text Display）。訊息 2026-08-05 改成 Components V2 之後
 * 已經沒有 `embeds[0].description`，標題與內文都在同一個 content 字串裡。
 */
const textOf = (p) => p.components[0].components[0].content;
/** Container payload 的按鈕列。 */
const buttonsOf = (p) => p.components[0].components[1].components;

test('Discord：只收到預告時不編造倒數', () => {
  const warn = L.discordPayload({ id: 7, world: W, startAt: 0, endAt: NOW + 900, source: 'plugin' }, NOW);
  const d = textOf(warn);
  assert.match(d, /再過幾分鐘/);
  assert.ok(!/\d+ 分鐘後開始/.test(d), '不得出現看起來精確的倒數');
  assert.match(d, /預告/);
});

test('webhook 白名單擋掉近似域名與明文', () => {
  assert.equal(L.isAllowedWebhook('https://discord.com/api/webhooks/1/abc'), true);
  assert.equal(L.isAllowedWebhook('https://discordapp.com/api/webhooks/1/abc'), true);
  assert.equal(L.isAllowedWebhook('http://discord.com/api/webhooks/1/abc'), false, '明文要退');
  assert.equal(L.isAllowedWebhook('https://discord.com.evil.tld/x'), false);
  assert.equal(L.isAllowedWebhook('https://evildiscord.com/x'), false);
  assert.equal(L.isAllowedWebhook('https://sub.discord.com/x'), false);
  assert.equal(L.isAllowedWebhook('https://user@discord.com@evil.tld/x'), false);
  assert.equal(L.isAllowedWebhook('not a url'), false);
  assert.equal(L.isAllowedWebhook('https://discord.com/' + 'a'.repeat(400)), false, '超長要退');
});

test('webhook 遮罩只留尾 4 碼', () => {
  const m = L.maskWebhook('https://discord.com/api/webhooks/123/SECRETTAIL');
  assert.ok(m.endsWith('TAIL'));
  assert.ok(!m.includes('SECRET'));
  assert.equal(L.maskWebhook(''), '');
});

test('訂閱：空 worlds 是合法的（＝退訂）', () => {
  const r = L.validateSub({ uuid: U1, worlds: [], webhookUrl: '' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.worlds, []);
});

test('訂閱：重複伺服器去重、未知伺服器與壞 webhook 退件', () => {
  const r = L.validateSub({ uuid: U1, worlds: [W, W], webhookUrl: 'https://discord.com/api/webhooks/1/a' });
  assert.deepEqual(r.worlds, [W]);
  assert.equal(L.validateSub({ uuid: U1, worlds: ['不存在'] }).reason, 'bad_worlds');
  assert.equal(
    L.validateSub({ uuid: U1, worlds: [W], webhookUrl: 'https://evil.tld/x' }).reason,
    'bad_webhook',
  );
});

test('isActive：過期用 lazy 判定', () => {
  const ev = { status: 'active', endAt: NOW + 10 };
  assert.equal(L.isActive(ev, NOW), true);
  assert.equal(L.isActive(ev, NOW + 9), true);
  assert.equal(L.isActive(ev, NOW + 10), false, '到 endAt 那一秒就不算進行中');
  assert.equal(L.isActive({ status: 'revoked', endAt: NOW + 10 }, NOW), false);
  assert.equal(L.isActive({ status: 'disputed', endAt: NOW + 10 }, NOW), false);
  assert.equal(L.isActive(null, NOW), false);
});

// ── 狀態轉移矩陣（外審 finding 5 要求的「有狀態工具必附轉移矩陣」）──
test('狀態轉移：active → active（附議不改狀態）', () => {
  const ev = { status: 'active', confirms: [], disputes: [] };
  const r = L.applyVote(ev, U1, 'confirm');
  assert.equal(r.status, 'active');
  assert.equal(r.changed, false);
  assert.deepEqual(r.confirms, [U1]);
});

test('狀態轉移：active → disputed（3 否認且 0 附議）', () => {
  let ev = { status: 'active', confirms: [], disputes: [] };
  for (const u of [U1, U2]) ev = { ...ev, ...L.applyVote(ev, u, 'dispute') };
  assert.equal(ev.status, 'active', '兩票還不夠');
  ev = { ...ev, ...L.applyVote(ev, U3, 'dispute') };
  assert.equal(ev.status, 'disputed');
});

test('狀態轉移：有人附議過就不會被 3 否認打成 disputed', () => {
  let ev = { status: 'active', confirms: [], disputes: [] };
  ev = { ...ev, ...L.applyVote(ev, U1, 'confirm') };
  for (const u of [U2, U3, '44444444-4444-4444-8444-444444444444']) {
    ev = { ...ev, ...L.applyVote(ev, u, 'dispute') };
  }
  assert.equal(ev.status, 'active', 'confirms 非空 ⇒ 不自動標存疑，交給管理端判斷');
});

test('狀態轉移：disputed 之後再附議不回頭（單向）', () => {
  let ev = { status: 'active', confirms: [], disputes: [] };
  for (const u of [U1, U2, U3]) ev = { ...ev, ...L.applyVote(ev, u, 'dispute') };
  assert.equal(ev.status, 'disputed');
  ev = { ...ev, ...L.applyVote(ev, '55555555-5555-4555-8555-555555555555', 'confirm') };
  assert.equal(ev.status, 'disputed', '推播早就送出去了，事後補票不該讓它復活');
});

test('同一人改投＝換邊，不是兩票', () => {
  let ev = { status: 'active', confirms: [], disputes: [] };
  ev = { ...ev, ...L.applyVote(ev, U1, 'confirm') };
  ev = { ...ev, ...L.applyVote(ev, U1, 'dispute') };
  assert.deepEqual(ev.confirms, []);
  assert.deepEqual(ev.disputes, [U1]);
});

test('撤回：本人、進行中、無人附議三個條件缺一不可', () => {
  const base = { status: 'active', endAt: NOW + 600, reporter: U1, confirms: [], disputes: [] };
  assert.equal(L.canWithdraw(base, U1, NOW).ok, true);
  assert.equal(L.canWithdraw(base, U2, NOW).reason, 'not_reporter', '別人不能撤別人的');
  assert.equal(L.canWithdraw({ ...base, confirms: [U2] }, U1, NOW).reason, 'has_confirms',
    '有人附議就不給撤——那不是誤按，而且會變成先亂報再撤掉的騷擾循環');
  assert.equal(L.canWithdraw({ ...base, status: 'revoked' }, U1, NOW).reason, 'not_active');
  assert.equal(L.canWithdraw(base, U1, NOW + 600).reason, 'not_active', '已結束不能撤');
  assert.equal(L.canWithdraw({ ...base, reporter: '' }, U1, NOW).reason, 'not_reporter',
    '去識別後的舊事件沒有 reporter，任何人都不該撤得動');
  assert.equal(L.canWithdraw(null, U1, NOW).reason, 'not_active');
});

test('fanoutTargets：只挑訂了該伺服器、有 webhook、未熔斷的', () => {
  const hook = 'https://discord.com/api/webhooks/1/a';
  const subs = [
    { uuid: U1, worlds: [W], webhookUrl: hook, broken: 0 },
    { uuid: U2, worlds: [W], webhookUrl: '', broken: 0 },
    { uuid: U3, worlds: [W], webhookUrl: hook, broken: 1 },
    { uuid: U1, worlds: [devStages.worlds[1]], webhookUrl: hook, broken: 0 },
  ];
  const out = L.fanoutTargets(subs, W);
  assert.equal(out.length, 1);
  assert.equal(out[0].uuid, U1);
});

test('冷卻只擋開新事件', () => {
  assert.equal(L.inCooldown(0, NOW), false, '沒有前科＝不冷卻');
  assert.equal(L.inCooldown(NOW - 60, NOW), true);
  assert.equal(L.inCooldown(NOW - L.REPORT_COOLDOWN, NOW), false, '剛好到期＝放行');
});

test('Discord 訊息：講時間，不揭露來源', () => {
  const base = { id: 12, world: W, startAt: NOW + 300, endAt: NOW + 300 + L.EVENT_DURATION };
  const manual = L.discordPayload({ ...base, source: 'manual' }, NOW);
  assert.match(textOf(manual), /約 5 分鐘後開始/);

  const started = L.discordPayload({ ...base, startAt: NOW, source: 'plugin' }, NOW);
  assert.match(textOf(started), /已經開始/);

  // Owner 2026-08-02：對外一律只講「回報」。兩種來源的訊息必須逐字相同，
  // 否則收訊息的人還是能從措辭反推來源。
  const a = L.discordPayload({ ...base, source: 'manual' }, NOW);
  const b = L.discordPayload({ ...base, source: 'plugin' }, NOW);
  assert.deepEqual(a, b, '兩種來源的 Discord 訊息必須完全一樣');
  for (const word of ['插件', '偵測', 'plugin', '玩家通報', '未經覆核']) {
    assert.ok(!JSON.stringify(a).includes(word), `訊息不得出現「${word}」`);
  }
});

test('resolveGroup：判不出來就回 null，不回「比較像」的那一組', () => {
  // 磁暴 α＝518/522/530/537/543
  assert.equal(L.resolveGroup([518, 522, 999], 'storm'), 'storm-α');
  // 只命中 1 筆 → 不定案（任務板可能還留著上一次事件的殘留）
  assert.equal(L.resolveGroup([518], 'storm'), null);
  // 兩組都有命中 → 資料自相矛盾，不從中挑一個
  assert.equal(L.resolveGroup([518, 522, 512, 521], 'storm'), null);
  // 限定天氣：孢子霧的任務不會被判成磁暴的組
  assert.equal(L.resolveGroup([513, 526, 528], 'storm'), null);
  assert.equal(L.resolveGroup([513, 526, 528], 'spore'), 'spore-β');
  assert.equal(L.resolveGroup([], 'storm'), null);
  assert.equal(L.resolveGroup(null, 'storm'), null);
});

test('六組任務 id 互斥且合計 33（分組表的完整性）', () => {
  const all = Object.values(L.VARIANT_MISSIONS).flat();
  assert.equal(all.length, 33);
  assert.equal(new Set(all).size, 33, '有任務同時屬於兩組');
  for (const [g, ids] of Object.entries(L.VARIANT_MISSIONS)) {
    for (const id of ids) {
      assert.ok(id >= L.CRITICAL_MISSION_MIN && id <= L.CRITICAL_MISSION_MAX, `${g} 的 ${id} 不在緊急任務區間`);
    }
  }
});

test('插件通報會把 missionIds 帶出來（原本只驗不存＝每次都丟掉證據）', () => {
  const r = L.validatePluginReport(
    { world: W, weatherId: 196, missionIds: [518, 522, 1], phase: 'start', variant: 'storm-a' }, NOW,
  );
  // 只留緊急任務區間的：`1` 是雜訊，留著只會讓判組多一個不會命中的候選
  assert.deepEqual(r.missionIds, [518, 522]);
});

test('插件通報的天氣種類由 weatherId 查表得出（不靠 variant）', () => {
  const base = { world: W, phase: 'start', missionIds: [518] };
  // 194/195 都是流星雨——id 四個、天氣三種，不是一對一
  assert.equal(L.validatePluginReport({ ...base, weatherId: 194 }, NOW).weather, 'meteor');
  assert.equal(L.validatePluginReport({ ...base, weatherId: 195 }, NOW).weather, 'meteor');
  assert.equal(L.validatePluginReport({ ...base, weatherId: 196 }, NOW).weather, 'storm');
  assert.equal(L.validatePluginReport({ ...base, weatherId: 197 }, NOW).weather, 'spore');
  // 沒抓到開始通告（variant 為 null）時天氣仍然填得出來——這正是原本會空著的情況
  assert.equal(L.validatePluginReport({ ...base, weatherId: 196 }, NOW).variant, null);
  // warn 相位沒有 weatherId（天氣還沒翻轉）⇒ 不編一個
  assert.equal(L.validatePluginReport({ world: W, phase: 'warn' }, NOW).weather, null);
});

test('warn 相位不吃 weatherId（那是上一次事件的殘留值）', () => {
  // 插件在預告時照樣會送 weatherId（lastEmergencyWeather 的殘留，初始值 196＝磁暴）。
  // 天氣還沒翻轉 ⇒ 沒有任何觀測支撐，必須留空。
  const r = L.validatePluginReport({ world: W, phase: 'warn', weatherId: 196 }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.weather, null, '預告不得帶出天氣');
  // start 仍然要填得出來
  assert.equal(L.validatePluginReport({ world: W, phase: 'start', weatherId: 196 }, NOW).weather, 'storm');
});

test('任務板只有一般任務時不退件（緊急任務不涉及該職業是常態）', () => {
  // 2026-08-04 實測：伊弗利特流星雨，玩家是裁縫師（兩組 meteor 都沒有裁縫師）
  // ⇒ 板上只有一般任務 [175,248] ⇒ 舊版整筆 start 被 400 退掉，事件開始完全沒被記錄。
  const r = L.validatePluginReport(
    { world: W, weatherId: 194, phase: 'start', missionIds: [175, 248] }, NOW,
  );
  assert.equal(r.ok, true, '不得退件');
  assert.deepEqual(r.missionIds, [], '非緊急任務一律濾掉，不當證據');
  // 混合時只留緊急區間的
  const mix = L.validatePluginReport(
    { world: W, weatherId: 194, phase: 'start', missionIds: [175, 519, 248, 523] }, NOW,
  );
  assert.deepEqual(mix.missionIds, [519, 523]);
});

// ─────────────────────────────────────────────────────────────────────
// 通知深連結（B-024）。形態＝Components V2 Container，實測樣本經 Owner 真機驗收。
// ─────────────────────────────────────────────────────────────────────

const EV = { id: 4321, world: W, startAt: 0, endAt: 0 };
const started = (now) => ({ ...EV, startAt: now, endAt: now + L.EVENT_DURATION });

test('深連結：三顆按鈕帶正確 id，且附議／否認不是同一條', () => {
  const btns = buttonsOf(L.discordPayload(started(NOW), NOW));
  assert.equal(btns.length, 3);
  for (const b of btns) assert.ok(b.url.includes('ev=4321'), `按鈕漏帶事件 id：${b.url}`);
  const [see, yes, no] = btns.map((b) => b.url);
  // 三連結最容易犯且最無訊號的錯：複製貼上把 dispute 寫成 confirm ⇒ 兩顆看起來都正常，
  // 按下去都變附議。
  assert.notEqual(yes, no, '附議與否認的連結不得相同');
  assert.match(yes, /vote=confirm/);
  assert.match(no, /vote=dispute/);
  assert.ok(!see.includes('vote='), '「看事件」不得帶投票意圖');
});

test('深連結：一律自訂網域，不得出現 pages.dev', () => {
  const json = JSON.stringify(L.discordPayload(started(NOW), NOW))
    + JSON.stringify(L.legacyEmbedPayload(started(NOW), NOW));
  assert.ok(!json.includes('pages.dev'), '舊網址會被交接頁轉走，多繞一跳');
  for (const u of buttonsOf(L.discordPayload(started(NOW), NOW)).map((b) => b.url)) {
    assert.ok(u.startsWith('https://cosmic.xivtc.com/'), u);
  }
});

test('深連結：Container 的三個硬條件（錯一條整則通知全滅，本地看不出來）', () => {
  const p = L.discordPayload(started(NOW), NOW);
  assert.equal(p.flags, 32768, 'IS_COMPONENTS_V2');
  // 設了 flag 之後 embeds／content 一律 400——而 JSON 本身完全合法，只有 Discord 會拒
  assert.ok(!('embeds' in p), 'V2 訊息不得有 embeds');
  assert.ok(!('content' in p), 'V2 訊息不得有 content');
  assert.equal(p.components[0].type, 17, 'Container');
});

test('深連結：按鈕形狀合規（帶 custom_id 就 400，且錯誤訊息不會指出原因）', () => {
  for (const b of buttonsOf(L.discordPayload(started(NOW), NOW))) {
    assert.equal(b.style, 5, 'link button');
    assert.ok(b.url, '必須有 url');
    // 2026-08-05 實測：style 4（紅色）配 url 回 400 {"components":["0"]}。
    // 彩色 style 一律要 custom_id，而 custom_id 是互動元件、非 app webhook 禁送。
    assert.ok(!('custom_id' in b), '非 app webhook 送不了互動元件');
  }
});

test('深連結：預告與進行中的按鈕列逐顆相同（只有文案與色條不同）', () => {
  // Owner 2026-08-05 修正原設計：預兆通告本身就是遊戲內看得到的東西，
  // 所以「我也看到了」在預告階段有明確指涉。預告分支是另一段程式碼，
  // 最可能的退化是「按鈕有了但 vote 參數漏帶」⇒ 逐顆比 url，不是只數數量。
  const warn = L.discordPayload(EV, NOW);
  const live = L.discordPayload(started(NOW), NOW);
  assert.deepEqual(buttonsOf(warn), buttonsOf(live), '兩個分支的按鈕列必須逐顆相同');
  assert.notEqual(
    warn.components[0].accent_color, live.components[0].accent_color,
    '色條仍要分得出預告與進行中',
  );
});

test('深連結：退回版本與主版本的連結逐條相同', () => {
  // legacyEmbedPayload 平常不執行（只有 Discord 拒收 V2 時才送），
  // 壞了要等最需要它的那天才會發現 ⇒ 用測試釘住它不腐爛。
  const live = L.discordPayload(started(NOW), NOW);
  const legacy = L.legacyEmbedPayload(started(NOW), NOW);
  assert.ok(!('components' in legacy), '退回版是純 embed');
  assert.equal(legacy.embeds[0].url, buttonsOf(live)[0].url, '標題連結＝看事件');
  for (const u of buttonsOf(live).map((b) => b.url)) {
    assert.ok(legacy.embeds[0].description.includes(`(${u})`), `退回版漏了連結：${u}`);
  }
});
