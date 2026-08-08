# ffxiv-tw-cosmic 修復計畫（2026-08-08 健檢）

報告：[`2026-08-08-full-health-review.md`](2026-08-08-full-health-review.md)

## 批次 0 — 本輪已執行（不需拍板者）

全部已完成並通過 canonicalTest。逐項的「為什麼」寫在各檔註解與 CHANGELOG。

| 項目 | 檔案 | 驗收 |
|---|---|---|
| 路由層補傳 `weatherObserved` / `variantConflicts` | `worker/src/index.js` | 新整合測試；**反向對照**：移除修正後恰一條轉紅 |
| 鬧鐘「開啟當下」修好（含 60 秒回溯窗，避免打開鬧鐘時一次炸滿） | `modules/alarm.js` | `tests/alarm-lead.test.mjs` 4 條，含反向對照 |
| 靈風視窗改用 `currentRunEnd`（連續同天氣一路算到底） | `modules/weather-forecast.js`／`forecast-view.js` | `tests/time-weather.test.mjs` |
| 錯誤碼 `error`／`reason` 雙讀 ＋ 補 4 個中文訊息 ＋ 修 `bad_lead` 文案 drift | `modules/emergency-api.js` | `tests/error-messages.test.mjs`（涵蓋率哨兵） |
| CORS 白名單收窄成 `ffxiv-tw-cosmic.pages.dev` | `worker/src/index.js` | 整合測試含 3 條負向控制 |
| 核心時間／天氣數值測試（本輪之前 0 條） | `tests/time-weather.test.mjs` | 8 條 |
| `TEST-BASELINE` 標記（本 repo 原本被 gate 6 整個跳過） | `AGENTS.md` | `check-test-baseline.js --audit` 實跑 3 項比對通過 |
| 文件 drift：README／`worker/README` ×3／B-017／`_headers` 註解 | 各該檔 | 目視對照事實來源 |

**測試檔 4 → 7、worker 整合 64 → 66。**

## 批次 1 — 高風險（建議最先，但都需要拍板）

### 1-1 · DO SQLite 索引與 `_sweep`（B-030，high）

`events`／`subs` 全表零索引，而 `_sweep()` 掛在 `/state` 這條最熱的讀路徑上，
每次請求約掃全表四趟。免費額度的下一面牆是 rows-read 而不是 invocations。

**為什麼需要拍板**：動的是**線上 DO 的 schema**。`CREATE INDEX IF NOT EXISTS` 本身安全，
但要決定 ① 索引開在哪幾個欄（`world`+`status`、`endAt`）② `_sweep` 改成多久跑一次
（每次讀 → 每 N 秒／alarm 帶）③ 要不要先量一輪 rows-read 再動。

### 1-2 · 每秒重建 DOM（B-031，high）

`emergency-view.render()` 每秒 `replaceChildren` 整份列表，`now-panel` 同型。
後果：焦點被銷毀（鍵盤使用者無法操作）、跨 tick 的點擊有機率被吞——而被吞的正是
附議／否認／通報這三個核心動作。

**為什麼需要拍板**：修法是**改渲染架構**（差分更新 or 只更新會變的文字節點），
不是單點修補；且要決定「哪些東西真的需要每秒動」（倒數需要，列表結構不需要）。

## 批次 2 — 正確性缺口

### 2-1 · 「只有預告」事件的三個語意缺口（B-033）

① 對只有預告的事件附議**不觸發任何推播**（與 `events-do.js` 自己的註解宣稱相反）
② 手動通報撞上預告中的事件會被吞成附議，事件永遠停在 `startAt=0` 並提前約 5 分鐘消失
③ 前端網頁通知把只有預告的事件說成「進行中 · 還剩 15 分鐘」（後端 Discord 版有處理，前端漏了）

**為什麼需要拍板**：三者都牽涉「預告該不該推播」的既有裁示（Owner 2026-08-03：預告一律不推播）。
②③ 是明確的 bug，但 ① 的修法會改變通知行為，需確認是否符合原意。

### 2-2 · 開發進度最後一階（B-034）

`dev-stage-view` 的區間篩選讓最後一個施工階段永遠顯示不出來，第 15 期還會印
「還要經過 0 個施工階段」。

**為什麼需要拍板**：finding 自己的建議就是「動之前先用遊戲內開拓紀錄核對 `fromStage`
到底是『起』還是『達成』，別在未定性的語意上疊修補」（鐵則 §2）。**這需要進遊戲確認**。

### 2-3 · 事件結束時間偏晚（B-038，主迴圈獨立發現）

ICE log 實測：7 筆有彈窗倒數可對照的事件裡，**2 筆插件偵測延遲 81／137 秒**。
而 `endAt = 偵測時刻 + 1200s` ⇒ 那兩筆的倒數與結束時間整體偏晚 1.4–2.3 分鐘。
同時 `startExact` 欄送到前端卻**從未被消費**，插件 start 一律標 `=1`（宣稱精確）。

**修法方向**（需拍板選一）：① 插件改送彈窗上的真實剩餘時間（根因，屬 ICE fork）
② 站上不再宣稱精確（讓 `startExact` 真的影響顯示，例如加「約」）。

## 批次 3 — UX / a11y（多數與行動版政策綁在一起）

- **B-035** 現況列的操作結果寫進藏在通報彈窗裡的 `el.msg` ⇒ 附議／否認／撤回失敗完全靜默
- **B-032** 窄螢幕「臨時任務」面板固定欄寬溢出約 600px，任務名稱欄被壓成 0 寬
  （⚠️ 行動版尚未 opt-in 是既有政策，要不要改屬 Owner 決定）
- **B-036** 關鍵說明只掛 `title` 屬性：觸控裝置取不到，且違反本 repo 自己的「禁原生 title」鐵則
- **B-037** `subs` 無保留期／fan-out 無整體 deadline
- **B-039** `[observability] enabled = false`、關鍵路徑無 correlation id

## 執行備註

- **commit 顆粒度**：本輪已按「程式修正」「文件修正」「健檢產物」三筆分開。
- **worker 已改但尚未部署** —— Worker 的部署與 Pages **完全脫鉤**，只 push git 的話
  `weatherObserved` 與 CORS 收窄**線上不會生效**，而且測試全綠、畫面全正常（零訊號）。
  ⚠️ **部署屬對外行為，留給 Owner**：`cd worker && pnpm cf:deploy`。
- **B-030 / B-031 動工前**建議各自先寫一份 spec（動的分別是線上 schema 與渲染架構）。
- **B-034 需要進遊戲**才能動，不要先改程式。
- 本計畫的「已執行」批次**沒有經過獨立計畫審 gate**（那是為多步驟高風險修復設計的）——
  本輪執行的都是單點、有測試、且多數帶反向對照的修正，逐項證據列在上表。
