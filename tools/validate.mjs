/**
 * 站台資料的不變量檢查——**不需要遊戲 client**，只驗已經產出的 `data/*.json`。
 *
 *   node tools/validate.mjs
 *
 * ## 跟 `tools/cosmic-dump` 的健全性閘差在哪
 * 那一支在**產生時**擋（需要 sqpack，只有裝了台服 client 的機器跑得動）；這一支在**推送時**擋，
 * 任何人／任何機器都能跑。兩者守的東西刻意重疊——資料是 commit 進 repo 的靜態檔，
 * 有人手改、merge 衝突解錯、或產生器換版後忘記重跑，只有這一層抓得到。
 *
 * ## 為什麼這些數字可以寫死
 * 它們是台服 7.2 client 的事實，且每一項都有獨立佐證（見 `tools/cosmic-dump/TcCosmicSheets.cs`
 * 的證據鏈與 `CHANGELOG.md`）。台服改版導致數字變動時**本檢查會紅**——那正是要的：
 * 逼人回去確認欄位對照還成不成立，而不是靜默接受新數字。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

// ── 天氣 ──────────────────────────────────────────────────────────────
const weather = read('weather.json');
const rateSum = weather.table.reduce((a, w) => a + w.rate, 0);
check(rateSum === 100, `渴望灣天氣機率總和 = ${rateSum}，應為 100`);
check(weather.zone.territoryId === 1237, `territoryId = ${weather.zone.territoryId}，應為 1237（渴望灣）`);
check(weather.periodSeconds === 1400, `天氣週期 = ${weather.periodSeconds}，應為 1400 秒`);
check(weather.emergencyWeathers.length > 0, '緊急事件天氣清單為空（它是「無法離線預測」這個結論的依據）');

// ── 任務 ──────────────────────────────────────────────────────────────
const m = read('missions.json');
check(m.missions.length === 544, `任務數 = ${m.missions.length}，應為 544`);

const cls = (k) => m.missions.filter((x) => x.class === k).length;
// 2026-08-01 修：分類判準從「rank≤4＝基礎」改成「rank≥5 **或**帶條件／前置＝臨時」。
// 由來＝Owner 在遊戲內看到 #400（rank A、ET 02:00–04:00）出現在**臨時任務**分頁；
// 交叉表顯示 rank 4 裡帶條件的剛好 11 筆、全是 ET 條件 ⇒ 有子標籤就進臨時分頁，與階級無關。
check(cls('basic') === 308, `基礎任務 = ${cls('basic')}，應為 308`);
check(cls('temporary') === 203, `臨時任務 = ${cls('temporary')}，應為 203（高難 96 ＋ 高難+ 96 ＋ 11 個帶 ET 條件的 A 階）`);
check(cls('critical') === 33, `緊急任務 = ${cls('critical')}，應為 33`);

const conditioned = m.missions.filter((x) => x.conds.length > 0);
check(conditioned.length === 63, `有條件任務 = ${conditioned.length}，應為 63（LotterySpecialCond＝col[15]）`);
check(m.missions.every((x) => x.conds.length <= 1), '有任務帶超過一個條件（LotterySpecialCond 是單一欄）');

// ET 條件任務 22 筆——與 ICE fork 手工表 SinusMapV2 逐筆吻合，是欄位對照正確的關鍵佐證
const etIds = new Set(Object.entries(m.conditions).filter(([, c]) => c.type === 'time').map(([k]) => Number(k)));
const etMissions = m.missions.filter((x) => x.conds.some((c) => etIds.has(c)));
check(etMissions.length === 22, `ET 時段任務 = ${etMissions.length}，應為 22（對照 ICE 的 SinusMapV2）`);

// 前置任務（＝遊戲的「連續任務」）
const withPrereq = m.missions.filter((x) => x.prereq);
check(withPrereq.length === 88, `連續任務 = ${withPrereq.length}，應為 88`);
const ids = new Set(m.missions.map((x) => x.id));
check(withPrereq.every((x) => ids.has(x.prereq)), '有前置任務指向不存在的任務');
check(withPrereq.every((x) => x.class === 'temporary'), '有連續任務落在臨時分頁之外');

// 子標籤只掛臨時任務
check(m.missions.every((x) => x.tags.length === 0 || x.class === 'temporary'), '有子標籤掛在臨時分頁之外');

// 配方（→ crafter 深連結的依據）。**不是**「有需求物就有配方」——採集/釣魚任務有需求物、無配方。
const withRecipes = m.missions.filter((x) => x.recipes.length > 0);
check(withRecipes.length === 400, `有配方的任務 = ${withRecipes.length}，應為 400（8 製作職 × 50）`);
check(withRecipes.every((x) => x.jobs.some((j) => m.jobs[j]?.role === 'crafter')),
  '有配方的任務落在非製作職上（配方欄接錯 WKSMissionRecipe？）');
// ⚠ 已知缺口（非本輪造成）：117 個任務抓不到需求物，其中 40 個有配方、含全部 16 個雙職業任務。
// `WKSMissionUnit` 有多個 ToDo 槽（上游 BestCraft 的 entity 是 ToDo0/1/2），本站只讀了 col[11] 一個。
// 數字寫死＝**追蹤而非默許**：修好會讓這條紅、逼人回來把數字改小；變多同樣紅。
const noItems = m.missions.filter((x) => x.items.length === 0);
check(noItems.length === 117, `抓不到需求物的任務 = ${noItems.length}，應為 117（已知 ToDo 槽缺口）`);
check(withRecipes.filter((x) => x.items.length === 0).length === 40,
  '有配方卻沒有需求物的任務數變動（已知 40，見 ToDo 槽缺口）');
check(m.missions.every((x) => x.recipes.every((r) => r > 0)), '配方陣列含 0（空槽應在產生端剔除）');
// 舊版把三段品質門檻塞在 _unverified.evalThresholds，且用任務 id 去查 WKSMissionToDoEvalutionRefin
// ——那是錯的 join（真鍵是 Recipe.CollectableMetadata）。門檻已移到 crafter 側，這裡守著別回來。
check(m.missions.every((x) => !x._unverified),
  '任務仍帶 _unverified（三段品質門檻已移交 crafter 的 recipe_quality_stages，不該在此重生）');

// 每筆都要有職業與獎勵——這兩欄空掉代表欄位對照崩了，UI 會整片空白但不報錯
check(m.missions.every((x) => x.jobs.length > 0), '有任務沒有職業');
check(m.missions.every((x) => x.reward.cosmo > 0 || x.reward.lunar > 0), '有任務信用點全為 0');

// ── 工具鏈 / 開發階段 ──────────────────────────────────────────────────
const tools = read('cosmic-tools.json');
check(tools.chains.length === 11, `宇宙工具鏈 = ${tools.chains.length} 條，應為 11（DoH 8 ＋ DoL 3）`);
check(tools.chains.every((c) => c.stages.length === 9), '有工具鏈不是 9 階');

const dev = read('dev-stages.json');
check(dev.phases.length === 16, `開拓紀錄 = ${dev.phases.length} 期，應為 16`);
check(dev.worlds.length === 7, `繁中服伺服器 = ${dev.worlds.length} 個，應為 7`);

// ── 結果 ──────────────────────────────────────────────────────────────
if (problems.length > 0) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\n${problems.length} 項不變量失敗 — 資料可能被手改、merge 解錯，或台服改版後欄位對照失效。`);
  process.exit(1);
}
console.log(`✓ 資料不變量全過（544 任務／63 有條件／88 連續／11 條工具鏈／client ${m.meta.clientVersion}）`);
