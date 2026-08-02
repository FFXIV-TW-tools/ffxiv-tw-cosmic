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
    L.validateManualReport({ uuid: U1, world: W, startsInMinutes: 15 }, NOW).ok,
    true,
    '上界 15 要收',
  );
  assert.equal(L.validateManualReport({ uuid: U1, world: W, startsInMinutes: 16 }, NOW).reason, 'bad_lead');
  assert.equal(L.validateManualReport({ uuid: U1, world: W, startsInMinutes: -1 }, NOW).reason, 'bad_lead');
  assert.equal(L.validateManualReport({ uuid: U1, world: W, startsInMinutes: 1.5 }, NOW).reason, 'bad_lead');
  assert.equal(L.validateManualReport({ uuid: U1, world: '拉姆', startsInMinutes: 0 }, NOW).reason, 'bad_world');
  assert.equal(L.validateManualReport({ uuid: 'nope', world: W, startsInMinutes: 0 }, NOW).reason, 'bad_uuid');
  assert.equal(L.validateManualReport(null, NOW).reason, 'bad_body');
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
  // 有給任務清單卻一個 critical 都沒有 → 自相矛盾，退
  assert.equal(
    L.validatePluginReport({ ...good, missionIds: [362, 363] }, NOW).reason,
    'no_critical_evidence',
  );
  // **沒給任務清單是合法的**：任務板沒開著時插件讀不到，而事件不會等人開板
  assert.equal(L.validatePluginReport({ ...good, missionIds: [] }, NOW).ok, true);
  assert.equal(L.validatePluginReport({ world, weatherId: 196, phase: 'start' }, NOW).ok, true);
  // end 相位同理
  assert.equal(L.validatePluginReport({ ...good, phase: 'end', missionIds: [] }, NOW).ok, true);
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

test('Discord 訊息：來源與時間措辭', () => {
  const base = { world: W, startAt: NOW + 300, endAt: NOW + 300 + L.EVENT_DURATION };
  const manual = L.discordPayload({ ...base, source: 'manual' }, NOW);
  assert.match(manual.embeds[0].description, /約 5 分鐘後開始/);
  assert.match(manual.embeds[0].description, /玩家通報（未經覆核）/);

  const plugin = L.discordPayload({ ...base, startAt: NOW, source: 'plugin' }, NOW);
  assert.match(plugin.embeds[0].description, /已經開始/);
  assert.match(plugin.embeds[0].description, /插件偵測/);
  assert.ok(!plugin.embeds[0].description.includes('未經覆核'));
});
