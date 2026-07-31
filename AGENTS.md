# AGENTS.md — ffxiv-tw-cosmic（宇宙探索）

FFXIV 繁中服「宇宙探索」（月球 / 渴望灣）規劃站。**純靜態、零後端**：三份 JSON 由 `tools/cosmic-dump`
從台服 client 解出後 commit 進 repo，網站只是它們的檢視層。

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
| `WKSMissionToDoEvalutionRefin` 三欄 | 與銀星／金星不同量綱，疑為銅/銀/金百分比門檻，**未核對** | 落 `_unverified.evalThresholds`，**不進 UI** |
| 宇宙工具 c23–c27 五階 | client 內名稱為空＝台服未實裝 | 只報階數（`unreleasedStages`），不編造名稱 |

**由來**：ICE fork（`XIVpluginsDev/ICE-Dev`）那輪連續五次拿 0 當佔位，其中 `MapPosition` 讓採集完全不執行、
`missionText` 讓技能完全不放——0 在這批 sheet 裡到處都是有意義的哨兵值。同型錯誤在網站上的形式是
「把 6 個緊急任務標成隨時可接」。

### 3. 台服欄位索引表不在本 repo 複製

`WKSMissionUnit` / `WKSMissionToDo` / `WKSMissionReward` 的欄位索引**唯一定義在 ICE fork**
（`XIVpluginsDev/ICE-Dev/ICE/Utilities/TcSheets/`），由 `CosmicDump.csproj` 的 `<Compile Include>` 直接編譯。
本 repo 只在 `TcCosmicSheets.cs` 放**那邊沒有的**表。抄第二份＝台服改版後兩邊各自漂移。

### 4. 只做算得準的東西

一般天氣（月塵／晴朗／靈風）與 ET 時段是**時間的純函數**，全 7 個繁中服伺服器同步 ⇒ 可推算到任意未來。
緊急事件天氣（磁暴／流星雨／孢子霧，Weather id 194–197）**不在 client 任何一張 WeatherRate 內**
⇒ 時間演算法永遠擲不出來、只能由伺服器推播 ⇒ **本站不提供、也不假裝能提供**。

要加「緊急任務即時偵測」＝需要遊戲內插件回報後端，那是另一個架構（見 `docs/BACKLOG.md`），
不得用推測性排程矇混。

### 5. 設計系統

`../ffxiv-tw-tools-portal/_DESIGN-SYSTEM.md` 是權威。本 repo 私有 class 一律 `cos-` 前綴；
不定義也不覆寫任何 `.codex-*` 根 selector；accent 統一 cyan；金色高亮**全頁只有一處**
（靈風視窗倒數 — 限時語意）。

---

## VERIFY（改動後必跑）

| 改了什麼 | 跑什麼 | 綠燈 |
|---|---|---|
| `tools/cosmic-dump/**` 或台服改版 | `dotnet run -c Release --project tools/cosmic-dump` | 內建健全性閘全過（544 任務／天氣總和 100%／11 條 9 階工具鏈），任一不過**不寫檔** |
| 任何 CSS／HTML | `node C:/FFXIVProject/tools/check-design-drift.js --files <改動檔> --strict` | exit 0 |
| 任何前端改動 | 瀏覽器開 `http://127.0.0.1:8774/ffxiv-tw-cosmic/`（`svc start portal`） | console 零 error；三個分頁都出得來；`documentElement.scrollWidth - clientWidth === 0` |
| commit 前 | monorepo 共用 pre-commit（已掛 `core.hooksPath`） | secret／檔案大小／design-lint／DEVLOOP 工件 全過 |

**欄位索引在台服改版後失效時**：先跑 `XIVpluginsDev/ICE-Dev/tools/tc-sheet-verify`（一鍵重驗那三張表），
不要在這裡重新反解。

---

## 開發循環（DEVLOOP）

正典 `~/.claude/process/DEVLOOP.md`。本 repo 工件：`docs/BACKLOG.md`（`B-NNN`）／
`docs/specs/<cycle>-design.md`／`docs/plans/<cycle>-plan.md`／`CHANGELOG.md`。
