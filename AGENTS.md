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

⚠️ **不得加回「天氣閘」**（「只有特殊天氣才出緊急事件」）。該假設已於 2026-08-02 用 ICE
`board-log.jsonl` **證偽**：唯一一次記錄到的緊急事件（`weather=196`）發生時，底層演算法天氣
**15/15 都是晴朗**；同一份記錄的非緊急 171 筆演算法與實測 171/171 吻合 ⇒ 不是演算法或記錄的問題。
加回去只會把真實通報靜默退掉。

### 5. 設計系統

`../ffxiv-tw-tools-portal/_DESIGN-SYSTEM.md` 是權威。本 repo 私有 class 一律 `cos-` 前綴；
不定義也不覆寫任何 `.codex-*` 根 selector；accent 統一 cyan；金色高亮**全頁只有一處**
（靈風視窗倒數 — 限時語意）。

---

## VERIFY（改動後必跑）

| 改了什麼 | 跑什麼 | 綠燈 |
|---|---|---|
| **任何改動（canonicalTest；`process/fleet.json` 逐字對照本行）** | `node tools/validate.mjs` | 資料不變量全過（544 任務／63 有條件／88 連續／11 條工具鏈）；不需遊戲 client，任何機器可跑 |
| `tools/cosmic-dump/**` 或台服改版 | `dotnet run -c Release --project tools/cosmic-dump` | 內建健全性閘全過（544 任務／天氣總和 100%／11 條 9 階工具鏈），任一不過**不寫檔** |
| `worker/**`（緊急事件後端） | cwd=`worker/`：`pnpm test`＋`pnpm test:logic`＋`pnpm cf:deploy:dry` | 38 整合（vitest-pool-workers）＋20 純函式（node --test）全綠；dry-run 0 error。**測試絕不打真 Discord**（fetch 被 stub） |
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
