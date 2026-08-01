/**
 * 從 ICE 的任務板記錄推出**每個職業各自解到哪一階**。純分析工具，**不餵網站**。
 *
 * ⚠ 曾經把結果寫成 `data/observed-progress.json` 給面板當篩選依據——**那是錯的設計**：
 * 這個站是要給別人用的，別人沒有這份記錄。站上的做法改成「使用者勾選『我練的職業』
 * ＝把該職當成已解到最高階」，再補一句說明（Owner 2026-08-01）。
 * 本工具留下來只為離線分析用（例如驗證某個假設），輸出到 stdout，不落檔。
 *
 *   node tools/derive-progress.mjs [board-log.jsonl 路徑]
 *
 * ## 為什麼要這支
 * 2026-07-31 的實測資料顯示，「同一個職業的高難+ 任務會不會出現」是目前最強的解釋變數：
 * 鍛造／園藝的靈風與月塵任務出現率 42%／14%，而木工／皮革／裁縫／烹調的**同型任務
 * 在 12 與 29 次機會中一次都沒出現**——那四職的任務本身有在板上，代表職業有練，
 * 缺的是該職的宇宙探索階級。
 *
 * 這是 per-job 的門檻，不是全域的。先前站上放過一個全域的「我的階級」選擇器，
 * 形狀就不對（Owner 也正確地指出它沒用），已移除。改由記錄自動推導，使用者零設定。
 *
 * ## ⚠ 不要用這份記錄算「出現率」
 * 曾經算過逐筆任務的「機會數 vs 出現數」並顯示在面板上，**那是錯的**：一個快照只包含
 * 當下那個職業／分頁的清單，把「靈風期間的每一個快照」都當成某任務的一次機會，
 * 等於把「根本不可能出現在這份清單裡」也算成「沒中」。分母是取樣偏差的產物，不是遊戲行為。
 * 已於 2026-08-01 全部移除。**本檔只做 maxRank 這種正向斷言**（看到過 ⇒ 至少解到那階）。
 *
 * ## 只做正向斷言
 * **看到過**某階的任務上板 ⇒ 該職至少解到那一階（硬事實）。
 * **沒看到**不能反過來斷定沒解——抽選會讓任何單次缺席都不算數。所以本檔只寫
 * 「已確認解到第幾階」與「該階以上有幾次機會、幾次出現」，把判斷留給消費端。
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
  process.exit(2);
}

const dataPath = join(HERE, '..', 'data', 'missions.json');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const byId = new Map(data.missions.map((m) => [m.id, m]));

const entries = readFileSync(logPath, 'utf8').replace(/^﻿/, '')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 統計單位＝不同的看板快照（看板只在重抽時才變，用記錄筆數當分母會灌大幾十倍）
const snapshots = [];
for (const e of entries) {
  const key = e.missions.join(',');
  if (snapshots.at(-1)?.key === key) continue;
  snapshots.push({ key, e });
}

/** 每職：曾在板上出現過的最高階；以及各階的機會／出現次數。 */
const jobs = new Map();
function slot(jobId) {
  if (!jobs.has(jobId)) jobs.set(jobId, { maxRank: 0, ranks: {} });
  return jobs.get(jobId);
}

function condOpen(m, e) {
  for (const id of m.conds ?? []) {
    const c = data.conditions[id];
    if (!c) return null;
    if (c.type === 'weather' && e.weather !== c.weatherId) return false;
    if (c.type === 'time') {
      const h = Number(e.et.split(':')[0]);
      const ok = c.start <= c.end ? (h >= c.start && h < c.end) : (h >= c.start || h < c.end);
      if (!ok) return false;
    }
    if (c.type !== 'weather' && c.type !== 'time') return null;
  }
  return true;
}

for (const { e } of snapshots) {
  const onBoard = new Set(e.missions);
  for (const id of onBoard) {
    const m = byId.get(id);
    if (!m) continue;
    for (const j of m.jobs) {
      const s = slot(j);
      if (m.rank > s.maxRank) s.maxRank = m.rank;
    }
  }
  // 機會／出現次數：只算條件成立、且非 blocked 的（blocked 那批另有未知門檻）
  for (const m of data.missions) {
    if (m.blocked || (m.conds ?? []).length === 0) continue;
    if (condOpen(m, e) !== true) continue;
    for (const j of m.jobs) {
      const s = slot(j);
      s.ranks[m.rank] ??= { chances: 0, seen: 0 };
      s.ranks[m.rank].chances++;
      if (onBoard.has(m.id)) s.ranks[m.rank].seen++;
    }
  }
}

const out = {
  _note: '由 tools/derive-progress.mjs 從 ICE 的任務板記錄推出。'
    + 'maxRank ＝「曾在板上看到過的最高階」＝硬事實；沒看到不代表沒解（抽選）。',
  generatedFrom: { entries: entries.length, snapshots: snapshots.length, until: entries.at(-1)?.t ?? 0 },
  jobs: Object.fromEntries([...jobs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([j, s]) => [j, { maxRank: s.maxRank, ranks: s.ranks }])),
};

const RANK = { 1: 'D', 2: 'C', 3: 'B', 4: 'A', 5: '高難', 6: '高難+' };
console.log(`快照 ${snapshots.length} 個（記錄 ${entries.length} 筆）\n`);
console.log('職業      已確認解到   各階（出現/機會）');
for (const [j, s] of [...jobs.entries()].sort((a, b) => a[0] - b[0])) {
  const detail = Object.entries(s.ranks)
    .sort((a, b) => a[0] - b[0])
    .map(([r, v]) => `${RANK[r] ?? r} ${v.seen}/${v.chances}`).join('  ');
  console.log(`${(data.jobs[j]?.label ?? j).padEnd(8)}  ${(RANK[s.maxRank] ?? '—').padEnd(10)} ${detail}`);
}
console.log(`\n（純分析輸出，不寫檔。快照 ${snapshots.length} 個）`);
