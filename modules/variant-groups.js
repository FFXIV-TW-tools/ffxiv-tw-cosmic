/**
 * 六個變體各自的緊急任務 id。**前端（地圖）與後端（自動定案）共用這一份。**
 *
 * 權威＝ICE fork `GatheringUtil.UpdateCriticalWeather()`（國際服來源），但已用台服 client
 * 幾何交叉驗證（2026-08-03）：33 筆完整分割無遺漏、每組的製作任務座標與該組錨點差 4–19 單位；
 * 差得遠的 8 筆全是採集／釣魚職，因為上游存交付點、client 存採集區。
 *
 * **只放 id，不放座標**——座標一律從 `missions.json` 的 `marker` 現查。抄第二份就是第二份真相，
 * 台服改版後兩邊各自漂移（同 AGENTS 鐵則 §3 的道理）。
 *
 * 分組只到「渴望灣」為止。上游另有 Phaenna（第二張圖）的 18 筆，台服未實裝 ⇒ 不放。
 *
 * ⚠️ **α／β 只是組的名字，不是「哪則通告對應哪一組」**。那個對應由
 * `resolveGroup()` 從實際證據解出來（見 logic.js），解不出來就留白，不寫「比較像」的那一組。
 *
 * 對應現況（2026-08-06，後端 `/state.variantMap`，全部由實測共現定案）：
 * `storm-b→storm-α`／`spore-a→spore-β`／`meteor-a→meteor-α`，另三組由排除法得出。
 * **三種天氣的 A／B 都已解出**，且**沒有一個符合「client 內排列順序相同」的直覺推定**
 * ——磁暴甚至完全相反。當初沒有硬套順序、而是等共現證據，這是留對了的一次。
 */
export const VARIANT_MISSIONS = {
  'storm-α': [518, 522, 530, 537, 543],
  'storm-β': [512, 521, 527, 533, 536, 542],
  'meteor-α': [515, 524, 538, 519, 523],
  'meteor-β': [516, 520, 525, 531, 534, 539],
  'spore-α': [517, 532, 514, 529, 541],
  'spore-β': [513, 526, 528, 535, 540, 544],
};

/** `storm-α` → `storm`。 */
export function kindOfGroup(group) {
  return group.split('-')[0];
}

/**
 * 從任務板上看到的任務 id 判斷是哪一組。**判不出來就回 null，不回「比較像」的那一組**——
 * 這個結果會被寫成永久對應，猜錯會讓地圖之後一直指錯半張圖（AGENTS 鐵則 §2）。
 *
 * 判準（兩條都要成立）：
 * 1. 至少命中 2 筆——1 筆可能是任務板剛好還留著上一次事件的殘留。
 * 2. 同天氣的另一組**零命中**——兩組都有命中代表資料本身有問題，不該從中挑一個。
 *
 * @param {number[]} missionIds 任務板上的任務 id（可含非緊急任務，會自動忽略）
 * @param {string=} kind 限定天氣種類（`storm`…）；給了就只比那兩組
 * @returns {string|null} `storm-α` 之類的組名
 */
export function resolveGroup(missionIds, kind) {
  if (!Array.isArray(missionIds) || missionIds.length === 0) return null;
  const ids = new Set(missionIds.filter((n) => Number.isInteger(n)));

  const counts = new Map();
  for (const [group, members] of Object.entries(VARIANT_MISSIONS)) {
    if (kind && kindOfGroup(group) !== kind) continue;
    counts.set(group, members.filter((id) => ids.has(id)).length);
  }

  let best = null;
  for (const [group, n] of counts) {
    if (n >= 2 && (best === null || n > counts.get(best))) best = group;
  }
  if (best === null) return null;

  // 同天氣的另一組也有命中 ⇒ 資料自相矛盾，不定案
  const sibling = [...counts.keys()].find(
    (g) => g !== best && kindOfGroup(g) === kindOfGroup(best),
  );
  if (sibling && counts.get(sibling) > 0) return null;
  return best;
}
