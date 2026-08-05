# AGENTS.md — ffxiv-tw-cosmic（宇宙探索）

FFXIV 繁中服「宇宙探索」（月球 / 渴望灣）規劃站。**主體純靜態**：四份 JSON 由 `tools/cosmic-dump`
從台服 client 解出後 commit 進 repo，網站是它們的檢視層。

**唯一的例外是「緊急事件」分頁**（2026-08-02 起）：那件事離線算不出來，改由 ICE 插件偵測與玩家通報，
後端是 `worker/`（Cloudflare Worker ＋ 單一 Durable Object）。**其餘所有分頁在後端掛掉時必須照常運作。**

---

## 🔒 鐵則

### 1. 資料只能來自台服 client，不手打

`data/*.json` **一律由 `tools/cosmic-dump` 產生**，禁止手改。要改內容＝改產生器再重跑。
手改一次就沒有任何機制會在台服改版後把它糾正回來，而錯誤形式是「數字看起來很合理但是錯的」。

### 2. 未定性的欄位一律標明，禁止拿 0 或「合理值」冒充

台服 7.2 client 有幾處欄位是空的或語意未經核對，處理方式**只有兩種**：標成 `unknown`，或放進
`_unverified` 且不進 UI。**禁止**填一個看起來對的值。

具體現況（改動前先讀）：

| 項目 | 狀態 | 處理 |
|---|---|---|
| `WKSMissionLotterySpecialCond` row 15–22 | 台服 client 三欄全 0（上游國際服當它們是 Clouds/Rain，但渴望灣天氣表根本沒這兩種天氣） | `type: "unknown"`／UI 顯示「條件未定」、可接欄顯示「未知」 |
| ET 時段條件的**單位** | 上游把 c0/c1 命名為 Start/End Time，值是 2 小時階梯；**未經遊戲內核對** | 照 ET 小時呈現，但列入 BACKLOG 待實地驗證 |
| ~~`WKSMissionToDoEvalutionRefin` 三欄~~ | ✅ 2026-08-01 定性＝**滿品質百分比**（官方欄名 `LowPercent`/`MidPercent`/`HighPercent`），且**不歸本站管** | 已移出本站。權威＝monorepo `game_ref.sqlite` 的 `recipe_quality_stages`，消費端 crafter。⚠ **鍵是配方的 `Recipe.CollectableMetadata`，不是任務 id**——本站原本用任務 id 查，錯得毫無訊號（見 CHANGELOG 2026-08-01） |
| 需求物（`items`） | **117 個任務抓不到**（含全部 16 個雙職業任務），`WKSMissionUnit` 有多個 ToDo 槽而本站只讀 col[11] 一個 | 數字寫死進 `validate.mjs`；修好會讓該條紅、逼人回來改小 |
| 宇宙工具 c23–c27 五階 | client 內名稱為空＝台服未實裝 | 只報階數（`unreleasedStages`），不編造名稱 |
| ~~「緊急任務的必要條件是靈風」~~ | ❌ **已證偽（2026-08-02）**：掛 cond 13（靈風）的 20 個任務 `class` 全是 `temporary`；33 個 `critical` 的 `conds` **全部是空的** | 站上文案已改為「20 個**天氣限定臨時任務**的必要條件」。**client 裡沒有任何欄位把緊急任務綁到任何天氣** |
| ~~「緊急事件只在特殊天氣發動」~~ | ❌ **已證偽（2026-08-02，ICE board-log）**：唯一一次記錄到的事件底層天氣 15/15 是晴朗 | 通報端**不設天氣閘**（見鐵則 §4） |

**由來**：ICE fork（`XIVpluginsDev/ICE-Dev`）那輪連續五次拿 0 當佔位，其中 `MapPosition` 讓採集完全不執行、
`missionText` 讓技能完全不放——0 在這批 sheet 裡到處都是有意義的哨兵值。同型錯誤在網站上的形式是
「把 6 個緊急任務標成隨時可接」。

### 3. 台服欄位索引表不在本 repo 複製

`WKSMissionUnit` / `WKSMissionToDo` / `WKSMissionReward` 的欄位索引**唯一定義在 ICE fork**
（`XIVpluginsDev/ICE-Dev/ICE/Utilities/TcSheets/`），由 `CosmicDump.csproj` 的 `<Compile Include>` 直接編譯。
本 repo 只在 `TcCosmicSheets.cs` 放**那邊沒有的**表。抄第二份＝台服改版後兩邊各自漂移。

### 4. 算得準的用算的，算不準的用回報的——但兩者不得混為一談

一般天氣（月塵／晴朗／靈風）與 ET 時段是**時間的純函數**，全 7 個繁中服伺服器同步 ⇒ 可推算到任意未來。
緊急事件天氣（磁暴／流星雨／孢子霧，Weather id 194–197）**不在 client 任何一張 WeatherRate 內**
⇒ 時間演算法永遠擲不出來、只能由伺服器推播 ⇒ **演算法這一半永遠不變：不預測、不排程、不猜下一次**。

2026-08-02 起補上另一半：**緊急事件改由回報**（`worker/` ＋「緊急事件」分頁）——
ICE 插件偵測到 `ActiveWeather ∈ 194–197` 自動回報，加上玩家手動通報。**天花板必須寫在 UI 上**：
覆蓋率＝回報者人數，一個插件只看得到它所在的那一台伺服器，**沒亮不代表沒事件**。
兩種來源在畫面上要分別標示（`插件偵測`／`玩家通報`），不得混為一談。

**預告（`warn`）一律不推播**（2026-08-03，一晚三筆假預告之後訂）。預告是所有訊號裡最不可靠的
——它來自畫面通告文字比對，而那個彈窗同時放著分頁標籤（`EMERGENCY`）、秒級倒數與三種不同
事件的文案；誤判成本卻是「已經吵到所有人，而且收不回來」。事件本身立刻就在網站上看得到，
延後的只有推播。該觸發通知的是**確定發生**：天氣真的翻轉（`start`）或有人附議。

**手動通報靜置 30 秒才推播**（2026-08-03）：誤按可在此期間撤回，撤回了就一則都不送。
**插件通報不適用**——它回報的是遊戲天氣本身，不存在誤按。靜置期在「別人附議」或
「通報者自己按確定」時提前結束：它擋的是沒人確認的孤例，不是已經有第二個人看到的事件。
實作用 **DO alarm**，不得改成在 `waitUntil` 裡睡——DO 會被回收，通知會靜默消失且無任何訊號。

**提前量上限 5 分鐘**：玩家唯一的資訊來源是遊戲的預兆通告，實測只提前 5:15／5:40
⇒ 沒有管道能知道更早的事。這是「通報者能知道什麼」的上界，不是對遊戲行為的猜測。

⚠️ **不得加回「天氣閘」**（「只有特殊天氣才出緊急事件」）。該假設已於 2026-08-02 用 ICE
`board-log.jsonl` **證偽**：唯一一次記錄到的緊急事件（`weather=196`）發生時，底層演算法天氣
**15/15 都是晴朗**；同一份記錄的非緊急 171 筆演算法與實測 171/171 吻合 ⇒ 不是演算法或記錄的問題。
加回去只會把真實通報靜默退掉。

### 5. 輪詢是最後手段，且一律綁前景（2026-08-04，額度事故後訂）

**Owner 裁示：通知一律以 Discord 為主，網頁輪詢類功能能少做就少做。**

由來：緊急事件分頁每 60 秒打一次 `/state`，看似便宜——但 `setInterval` 在**隱藏分頁照跑**
（只被節流到 ≥1s），一個開著不看的分頁一天仍打 **1440 次**。2026-08-04 實測
`ffxiv-tw-cosmic-api` 24 小時 **56k invocations**（比前期 +79%），佔掉帳號免費額度
100k/日 的一大半，且**曲線是持續平台不是尖峰**＝純粹是掛著的分頁在燒。

**這個成本沒有換到任何東西**：推播是後端 DO 自己發 webhook（`events-do.js`），
跟前端輪詢完全無關；輪詢只負責「你正在看的時候畫面是新的」。

**真正的「有事了」通道是 Discord → 人 → 分頁**，不是輪詢：後端 DO 收到通報就自己發 webhook，
使用者看到通知就會打開／切回分頁，`visibilitychange` 當場 poll 一次並進 ACTIVE。
⚠️ 但**閒置不能直接歸零**：瀏覽器沒有任何管道能自己發現「別人通報了」——那個訊號在伺服器側，
歸零等於「除非你自己按按鈕，否則永遠不會被觸發」。心跳的唯一任務是接住
「沒訂 Discord、又剛好開著頁面」的人。

現行三檔（`emergency-view.js` 的 `pollIntervalFor()`）：

| 檔 | 條件 | 間隔 |
|---|---|---|
| ACTIVE | **我關心的伺服器**有進行中事件，或我剛通報／附議／否認（30 分鐘內） | 60 秒 |
| IDLE | 其餘 | 300 秒（心跳）|
| 停止 | `document.hidden` | 不打 |

「我關心的伺服器」＝跨工具身份的 `character.mainWorld`（同步讀、不花請求）；
**沒設定就視為全部**——不能因為使用者沒填過設定就讓他漏看自己那台，這一頁最嚴重的
失效模式是「畫面沒亮被當成沒事」（鐵則 §4）。

規則：

- 新功能**預設不輪詢**。先問「這個資訊是不是只有在使用者看著的時候才有意義」——
  是的話就綁前景，不是的話那它根本不該用輪詢，該走後端推播。
- 真的要輪詢：**一律 `if (document.hidden) return;`**，並在 `visibilitychange` 回前景時
  `poll(true)` 立刻補一次。缺後者的話「切回來看到舊資料」會被誤讀成「沒有事件」——
  在這一頁那是安全性等級的誤讀（見鐵則 §4）。
- 需要「人不在也要知道」的，答案是 **Discord 訂閱**，不是把輪詢調更密。

**但「少打」不等於「晚打」**（2026-08-05）：唯一那一發**首次**請求要**盡量早**發，不要跟著頁面其他
東西排隊。原本 `/state` 寫在四份離線 JSON 的 `await` 之後，被排到四層串行鏈的尾端（實測後端 25 ms、
卻要等到載入後 400 ms 才發），Owner 直接感受到「現況要等很久才展開」。現在由 `app.js` 在進入
`await` 前先發、view 接手（`prefetch`，逾 10 秒視為過期重打——舊資料標成「剛更新」在這一頁
是鐵則 §4 等級的錯）。同理，**拿到資料就重畫，不要等下一個 tick**。

⚠️ **驗這類改動時先確認 `document.hidden` 的真值**：headless／未聚焦的分頁本身就是 hidden，
量到「都沒打」很可能只是撞到 hidden 閘、根本沒測到間隔邏輯（2026-08-04 我自己踩過一次）。

### 6. 設計系統

`../ffxiv-tw-tools-portal/_DESIGN-SYSTEM.md` 是權威。本 repo 私有 class 一律 `cos-` 前綴；
不定義也不覆寫任何 `.codex-*` 根 selector；accent 統一 cyan；金色高亮**全頁只有一處**
（靈風視窗倒數 — 限時語意）。

---

## VERIFY（改動後必跑）
- **canonicalTest（safe-push 實跑的那一條；`process/fleet.json` 逐字對照本行）**：`node tools/validate.mjs && node tests/run-all.mjs && cd worker && pnpm test`
  > 2026-08-04 併入 `tests/run-all.mjs`：`tests/` 底下的測試檔先前沒有任何自動入口會跑到（跨 repo 稽核＝claude-skills `process/tools/check-orphan-tests.mjs`）。run-all 自動掃描`tests/*.test.{js,mjs}`，新增測試檔不必再記得掛進來。


<!-- B-048-HANDOFF -->
> **交接頁契約（B-048 Task 4）**——改 `functions/_middleware.js`／`_routes.json`／`tests/route-manifest.json` 後必跑：
>
> ```bash
> node tests/handoff.test.mjs
> ```
>
> ⚠️ 它**刻意不併進本 repo 既有的測試 runner**：該檔與 `functions/_middleware.js` 是 13 站逐站複製的樣板（每站只換 `OLD_HOST`／`NEW_ORIGIN` 兩個常數），檔名與介面必須跨站一致，不能為配合各站慣例改寫——改寫等於每站手動調整，正是 monorepo 交接頁一致性哨兵要防的漏抄。**既有測試基線不變。**

| 改了什麼 | 跑什麼 | 綠燈 |
|---|---|---|
| **任何改動（canonicalTest；`process/fleet.json` 逐字對照本行）** | `node tools/validate.mjs` | 資料不變量全過（544 任務／63 有條件／88 連續／11 條工具鏈）；不需遊戲 client，任何機器可跑 |
| `tools/cosmic-dump/**` 或台服改版 | `dotnet run -c Release --project tools/cosmic-dump` | 內建健全性閘全過（544 任務／天氣總和 100%／11 條 9 階工具鏈），任一不過**不寫檔**；地圖底圖匯不出來也**整批不寫**（`img/map/sinus-ardorum.png`，512²） |
| `worker/**`（緊急事件後端） | cwd=`worker/`：`pnpm test`＋`pnpm test:logic`＋`pnpm cf:deploy:dry` | 60 整合（vitest-pool-workers）＋34 純函式（node --test）全綠；dry-run 0 error。**測試絕不打真 Discord**（fetch 被 stub） |
| `modules/emergency-*.js` | 本機 `wrangler dev` ＋瀏覽器走一次通報→附議→訂閱 | console 零 error；後端關掉時該分頁降級為唯讀、其他分頁不受影響 |
| 任何 CSS／HTML | `node C:/FFXIVProject/tools/check-design-drift.js --files <改動檔> --strict` | exit 0 |
| 任何前端改動 | 瀏覽器開 `http://127.0.0.1:8774/ffxiv-tw-cosmic/`（`svc start portal`） | console 零 error；四個分頁都出得來；`documentElement.scrollWidth - clientWidth === 0` |
| commit 前 | monorepo 共用 pre-commit（已掛 `core.hooksPath`） | secret／檔案大小／design-lint／DEVLOOP 工件 全過 |

**欄位索引在台服改版後失效時**：先跑 `XIVpluginsDev/ICE-Dev/tools/tc-sheet-verify`（一鍵重驗那三張表），
不要在這裡重新反解。

---

## 開發循環（DEVLOOP）

正典 `~/.claude/process/DEVLOOP.md`。本 repo 工件：`docs/BACKLOG.md`（`B-NNN`）／
`docs/specs/<cycle>-design.md`／`docs/plans/<cycle>-plan.md`／`CHANGELOG.md`。
