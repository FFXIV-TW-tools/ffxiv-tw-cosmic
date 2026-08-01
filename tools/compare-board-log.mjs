/**
 * 把 ICE 記錄的「任務板實際內容」跟本站的預測對帳。
 *
 *   node tools/compare-board-log.mjs [board-log.jsonl 路徑]
 *
 * 預設讀 `%APPDATA%/FFXIVSimpleLauncher/Dalamud/Config/pluginConfigs/ICE/board-log.jsonl`
 * （台服 SimpleLauncher 的 Dalamud config root 在 `Dalamud/Config/`，不是國際服 XIVLauncher 的版面）。
 * 記錄由 ICE fork 的 `BoardLogger` 產生（`/ice log on` 開啟，唯讀、不改任何行為）。
 *
 * ## 為什麼要這支
 * 宇宙探索有好幾層規則在 client 裡看不出來（抽選／開發階段／雙職業任務／c14 的真實語意）。
 * 在這支之前唯一的驗證手段是請 Owner 一次一次進遊戲肉眼比對，代價是同一條條件邏輯來回翻案四次。
 * 有了逐筆記錄，這些就變成可重跑的離線分析。
 *
 * ## 判讀方式（不對稱！）
 * · **偽陽性（本站說開、板上沒有）**：**單筆不能當反證** —— 條件表原名帶 Lottery，
 *   條件成立只是取得抽選資格。要看的是**比率**：某任務在 N 次條件成立中出現 0 次才有意義。
 * · **偽陰性（板上有、本站說沒開）**：**一筆就是硬反證** —— 任務出現代表它的條件確實成立，
 *   本站卻算成沒開 ⇒ 條件解讀錯了。這種要優先查。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG = join(process.env.APPDATA ?? '',
  'FFXIVSimpleLauncher', 'Dalamud', 'Config', 'pluginConfigs', 'ICE', 'board-log.jsonl');

const logPath = process.argv[2] ?? DEFAULT_LOG;
if (!existsSync(logPath)) {
  console.error(`找不到記錄檔：${logPath}`);
  console.error('在遊戲內執行 /ice log on，開幾次任務板（記得切幾個職業）之後再跑一次。');
  process.exit(2);
}

const data = JSON.parse(readFileSync(join(HERE, '..', 'data', 'missions.json'), 'utf8'));
const byId = new Map(data.missions.map((m) => [m.id, m]));

// 剝 BOM：C# 的 File.AppendAllText 建檔時會依 Encoding.UTF8 寫入 BOM，
// 第一行就變成 "﻿{...}"，逐行 JSON.parse 直接炸。插件端已改用不帶 BOM 的
// UTF8Encoding(false)，但既有的記錄檔仍帶著，所以這裡也要容錯。
const entries = readFileSync(logPath, 'utf8').replace(/^﻿/, '')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));
if (entries.length === 0) {
  console.error('記錄檔是空的。');
  process.exit(2);
}

// ── 條件判定：與網站同一套邏輯（c14 與 c15 兩個槽，AND）────────────────
/** 單一條件在該筆記錄的時刻是否成立。ET 直接用記錄裡的值（遊戲給的，比推算可信）。 */
function oneCond(c, entry) {
  if (!c) return null;
  if (c.type === 'weather') return entry.weather === c.weatherId;
  if (c.type === 'time') {
    const h = Number(entry.et.split(':')[0]);
    return c.start <= c.end ? (h >= c.start && h < c.end) : (h >= c.start || h < c.end);
  }
  return null;
}

/** 兩個槽都要成立（AND）。任一未定回 null，不可當 false。 */
function condOpen(mission, entry) {
  const ids = mission.conds ?? [];
  if (ids.length === 0) return true;
  let unknown = false;
  for (const id of ids) {
    const r = oneCond(data.conditions[id], entry);
    if (r === false) return false;
    if (r === null) unknown = true;
  }
  return unknown ? null : true;
}

// ── 對帳 ──────────────────────────────────────────────────────────────
const stats = new Map();   // missionId → {open, seen}
const falseNegatives = [];

/*
 * ⚠ **不能用 `e.job` 過濾**：任務板會把「你有能力接的」全部列出來，不是只列當前職業
 * （Owner 2026-07-31 指出，log 直接佐證——同一筆記錄同時出現園藝師與烹調師的任務）。
 * 原本按當下職業過濾，等於把大半訊號丟掉，而且出現率的分母全錯。
 * `e.job` 現在只當中繼資料，不參與判定。
 *
 * 仍無法排除的一層：職業有沒有練到。沒練的職業永遠不會出現在板上，但那是每個玩家
 * 各自的進度，log 裡看不出來 ⇒ 只出現過的職業才納入統計（見下方 seenJobs）。
 */
const seenJobs = new Set(
  entries.flatMap((e) => e.missions).flatMap((id) => byId.get(id)?.jobs ?? []));

/*
 * **統計單位是「不同的看板快照」，不是記錄筆數。**
 * 看板內容只在重抽／接任務時才變，同一份清單會被連續記錄很多次；直接拿記錄筆數當分母
 * 會把「一次觀察」灌成幾十次，出現率就全錯（實測 80 筆記錄其實只有十幾個不同的看板）。
 * 判準＝任務清單本身變了就算一個新快照；時間／天氣另外記，因為條件要按當下狀態判定。
 */
const snapshots = [];
for (const e of entries) {
  const key = e.missions.join(',');
  const last = snapshots.at(-1);
  if (last && last.key === key) { last.samples.push(e); continue; }
  snapshots.push({ key, samples: [e] });
}

for (const snap of snapshots) {
  // 一個快照取第一筆當代表：條件用它的時間／天氣判定
  const e = snap.samples[0];
  const onBoard = new Set(e.missions);

  for (const m of data.missions) {
    // 只統計「記錄中出現過的職業」——沒練的職業不會上板，算進去只會製造假的 0%
    if (!m.jobs.some((j) => seenJobs.has(j))) continue;
    const open = condOpen(m, e);
    if (open !== true) {
      // 板上有、本站說沒開 ⇒ 硬反證
      if (onBoard.has(m.id)) {
        falseNegatives.push({ e, m, reason: open === null ? '條件語意未定' : '條件未開' });
      }
      continue;
    }
    if (!stats.has(m.id)) stats.set(m.id, { open: 0, seen: 0 });
    const s = stats.get(m.id);
    s.open++;
    if (onBoard.has(m.id)) s.seen++;
  }
}

const label = (m) => `#${m.id} ${m.name}（${m.jobs.map((j) => data.jobs[j]?.label ?? j).join('/')}）`;
const conds = (m) => (m.conds ?? []).map((c) => data.conditions[c]?.label).join('＋') || '不限時';

console.log(`記錄 ${entries.length} 筆 → **${snapshots.length} 個不同的看板快照**，時間跨度 ${new Date(entries[0].t * 1000).toLocaleString()}`
  + ` → ${new Date(entries.at(-1).t * 1000).toLocaleString()}`);
console.log(`記錄時的職業：${[...new Set(entries.map((e) => e.job))].map((j) => data.jobs[j]?.label ?? j).join('、')}`);
console.log(`板上出現過的職業：${[...seenJobs].map((j) => data.jobs[j]?.label ?? j).join('、')}`
  + '　（任務板會列出所有你有能力接的職業，不是只列當前職業）');

console.log('\n════ 硬反證：板上有、本站說沒開（條件解讀錯了）════');
if (falseNegatives.length === 0) {
  console.log('  無 —— 目前沒有任何任務在本站判定「沒開」時出現在板上。');
} else {
  const grouped = new Map();
  for (const f of falseNegatives) {
    const k = f.m.id;
    if (!grouped.has(k)) grouped.set(k, { m: f.m, n: 0, reason: f.reason, sample: f.e });
    grouped.get(k).n++;
  }
  for (const g of [...grouped.values()].sort((a, b) => b.n - a.n)) {
    console.log(`  ✗ ${label(g.m)} ×${g.n}`);
    console.log(`      本站條件＝${conds(g.m)}（${g.reason}）｜實測 ET ${g.sample.et} 天氣 ${g.sample.weather}`);
  }
}

console.log('\n════ 出現率：本站說條件成立時，實際出現的比例 ════');
const rows = [...stats.entries()]
  .map(([id, s]) => ({ m: byId.get(id), ...s }))
  // 只看有條件的（不限時的沒有預測價值），且排除緊急任務——它還要等伺服器推事件，
  // 混進來只會用一堆必然的 0% 淹掉真正的訊號。
  .filter((r) => r.m && (r.m.conds ?? []).length > 0 && r.m.class !== 'critical')
  .sort((a, b) => (a.seen / a.open) - (b.seen / b.open) || b.open - a.open);
if (rows.length === 0) {
  console.log('  尚無有條件任務被涵蓋 —— 記錄時間還不夠長，或沒在條件成立時開過任務板。');
} else {
  for (const r of rows) {
    const pct = Math.round(r.seen / r.open * 100);
    const flag = r.seen === 0 && r.open >= 5 ? '  ← 條件成立 5 次以上從未出現，可疑' : '';
    console.log(`  ${String(pct).padStart(3)}%  ${r.seen}/${r.open}  ${label(r.m)}｜${conds(r.m)}${flag}`);
  }
}

/*
 * ── c14 假設檢定 ─────────────────────────────────────────────────────
 * c14 的語意未定（值域與條件表 row id 重疊）。若它其實**也是**一個條件（與 c15 是 AND），
 * 那麼「c14 的視窗開著」與「任務真的出現」應該高度相關；若它不是條件，兩者應該無關。
 * 這是唯一能把它定案的檢定，而且只要記錄夠多就會自己收斂——不需要再靠單點觀察猜。
 */
function c14Open(m, entry) {
  const id = m._unverified?.c14 ?? 0;
  if (id === 0) return true;                      // 沒有 c14 ⇒ 不構成限制
  const c = data.conditions[id];
  if (!c) return null;
  if (c.type === 'weather') return entry.weather === c.weatherId;
  if (c.type === 'time') {
    const h = Number(entry.et.split(':')[0]);
    return c.start <= c.end ? (h >= c.start && h < c.end) : (h >= c.start || h < c.end);
  }
  return null;
}

console.log('\n════ c14 假設檢定：c15 條件成立的樣本中，出現 vs c14 是否也開著 ════');
const table = { openSeen: 0, openMissed: 0, shutSeen: 0, shutMissed: 0 };
for (const snap of snapshots) {
  const e = snap.samples[0];
  const onBoard = new Set(e.missions);
  for (const m of data.missions) {
    if (!m.jobs.some((j) => seenJobs.has(j))) continue;
    if ((m.conds ?? []).length === 0) continue;
    // 只看「c15 那一槽已成立」的樣本——這樣 c14 才是唯一的變因
    const slotB = m.conds?.find((id) => id !== (m._unverified?.c14 ?? 0));
    if (slotB !== undefined && oneCond(data.conditions[slotB], e) !== true) continue;
    if ((m.conds ?? []).length === 0) continue;
    const c14 = c14Open(m, e);
    if (c14 === null) continue;
    // 沒有 c14 的任務對這個檢定沒有鑑別力（永遠算「開著」），排除掉免得稀釋
    if ((m._unverified?.c14 ?? 0) === 0) continue;
    const seen = onBoard.has(m.id);
    if (c14) table[seen ? 'openSeen' : 'openMissed']++;
    else table[seen ? 'shutSeen' : 'shutMissed']++;
  }
}
const rate = (a, b) => (a + b === 0 ? '—' : `${Math.round(a / (a + b) * 100)}%`);
console.log(`  c14 視窗開著：出現 ${table.openSeen} / 未出現 ${table.openMissed}　→ 出現率 ${rate(table.openSeen, table.openMissed)}`);
console.log(`  c14 視窗關著：出現 ${table.shutSeen} / 未出現 ${table.shutMissed}　→ 出現率 ${rate(table.shutSeen, table.shutMissed)}`);
if (table.shutSeen > 0) {
  console.log('  ⇒ c14 關著時仍出現過 ⇒ **c14 不是條件**（一筆就足以否證）');
} else if (table.shutMissed >= 10 && table.openSeen > 0) {
  console.log('  ⇒ c14 關著時從未出現、開著時出現過 ⇒ 高度支持「c14 也是條件（與 c15 是 AND）」');
} else {
  console.log('  ⇒ 樣本不足，繼續收集（需要 c14 關著的樣本 ≥10 且 c14 開著時出現過）');
}

console.log('\n════ 板上出現過、但本站資料沒有的任務 id ════');
const known = new Set(data.missions.map((m) => m.id));
const unknown = [...new Set(entries.flatMap((e) => e.missions))].filter((id) => !known.has(id));
console.log(unknown.length === 0 ? '  無' : `  ${unknown.join(', ')}`);
