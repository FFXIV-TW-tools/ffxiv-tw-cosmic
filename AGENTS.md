# AGENTS.md — ffxiv-tw-cosmic（宇宙探索）

FFXIV 繁中服「宇宙探索」（月球 / 渴望灣）規劃站。**主體純靜態**：四份 JSON 由 `tools/cosmic-dump`
從台服 client 解出後 commit 進 repo，網站是它們的檢視層。

**唯一的例外是「緊急事件」分頁**：離線算不出來，改由 ICE 插件偵測與玩家通報，後端是 `worker/`
（Cloudflare Worker ＋ 單一 Durable Object）。**其餘所有分頁在後端掛掉時必須照常運作。**

> **規則分三層**：本檔＝做什麼／禁什麼／怎麼驗；`docs/rules-rationale.md`＝由來／事故／實測數字／拍板日期
> （同標題對應，要改某條鐵則時才讀）；`.claude/rules/emergency.md`＝緊急事件通報／推播／fan-out 的路徑專屬規則
> （Claude 動到 `worker/**` 或 `modules/emergency-*.js` 才載入；**其他 agent 動這兩處前手動讀**）。

---

## 🔒 鐵則

### 1. 資料只能來自台服 client，不手打

`data/*.json` **一律由 `tools/cosmic-dump` 產生**，禁止手改。要改內容＝改產生器再重跑。

### 2. 未定性的欄位一律標明，禁止拿 0 或「合理值」冒充

處理方式**只有兩種**：標成 `unknown`，或放進 `_unverified` 且不進 UI。**禁止**填一個看起來對的值——0 在這批 sheet 裡是有意義的哨兵值。

具體現況（改動前先讀）：

| 項目 | 狀態 | 處理 |
|---|---|---|
| `WKSMissionLotterySpecialCond` row 15–22 | 台服 client 三欄全 0 | `type: "unknown"`／UI 顯示「條件未定」、可接欄顯示「未知」 |
| ET 時段條件的**單位** | c0/c1 上游命名 Start/End Time、值是 2 小時階梯 | 照 ET 小時呈現；已於 2026-07-31 遊戲內驗證（B-004） |
| 需求物（`items`） | **77 個任務抓不到** | 數字寫死進 `validate.mjs`（修好會讓該條紅、逼人改小） |
| 由配方補的需求物（`viaRecipe`） | 40 筆 ToDo 沒填需求物，改由配方產出（`Recipe.c4`）補 | **數量一律不填**（`qty` 缺席、UI 顯示 `×?`）；`validate.mjs` 兩條斷言：筆數＝40、不得帶 `qty` |
| 宇宙工具 c23–c27 五階 | client 內名稱為空＝台服未實裝 | 只報階數（`unreleasedStages`），不編造名稱 |

### 3. 台服欄位索引表不在本 repo 複製

`WKSMissionUnit` / `WKSMissionToDo` / `WKSMissionReward` 的欄位索引**唯一定義在 ICE fork**
（`XIVpluginsDev/ICE-Dev/ICE/Utilities/TcSheets/`），由 `CosmicDump.csproj` 的 `<Compile Include>` 直接編譯。
本 repo 只在 `TcCosmicSheets.cs` 放**那邊沒有的**表（抄第二份的後果見 rationale）。

### 4. 算得準的用算的，算不準的用回報的——但兩者不得混為一談

- 一般天氣（月塵／晴朗／靈風）與 ET 時段是**時間的純函數**，全 7 個繁中服伺服器同步 ⇒ 可推算到任意未來。
- 緊急事件天氣（磁暴／流星雨／孢子霧，Weather id 194–197）**不在 client 任何一張 WeatherRate 內**
  ⇒ 只能由伺服器推播 ⇒ **不預測、不排程、不猜下一次**（演算法這一半永遠不變）。
- 緊急事件改由回報（`worker/` ＋「緊急事件」分頁）。**天花板必須寫在 UI 上**：覆蓋率＝回報者人數，一個插件只
  看得到它所在的那台伺服器，**沒亮不代表沒事件**。兩種來源畫面上分別標示（`插件偵測`／`玩家通報`），不得混為
  一談。通報／推播機制細則＝`.claude/rules/emergency.md`。
- ⚠️ **不得加回「天氣閘」**（「只有特殊天氣才出緊急事件」）：該假設已用 ICE `board-log.jsonl` 證偽並經統計複核
  （推導與取數陷阱 → **`docs/emergency-weather-analysis.md`**，動這條前先讀）。加回去只會把真實通報靜默退掉。
- ⚠️ 已排除的**只有天氣**，不是「解出了觸發規則」；per-server 週期是**觀察到的形狀**、無 client 欄位佐證 ⇒ 照舊不預測。

### 5. 輪詢是最後手段，且一律綁前景

**Owner 裁示：通知一律以 Discord 為主，網頁輪詢類功能能少做就少做。**

- 新功能**預設不輪詢**。先問「這資訊是不是只有使用者看著時才有意義」——是的話綁前景，不是的話該走後端推播。
- 真的要輪詢：**一律 `if (document.hidden) return;`**，並在 `visibilitychange` 回前景時 `poll(true)`
  立刻補一次（缺後者＝「切回來看到舊資料」被誤讀成「沒有事件」——這一頁的最嚴重失效模式，鐵則 §4）。
- 需要「人不在也要知道」的，答案是 **Discord 訂閱**，不是把輪詢調密。
- **但「少打」不等於「晚打」**：唯一那一發**首次**請求要**盡量早**發、不跟頁面其他東西排隊，**拿到資料就重畫**
  （`/state` 的 `prefetch` 細則見 `.claude/rules/emergency.md`）。
- ⚠️ **驗輪詢改動先確認 `document.hidden` 的真值**：headless／未聚焦分頁本身就是 hidden，量到「都沒打」
  多半只是撞到 hidden 閘、沒測到間隔邏輯。

現行輪詢三檔（`emergency-view.js` `pollIntervalFor()`）與「我關心的伺服器」判準＝`.claude/rules/emergency.md`。

### 6. 兩種時鐘一律標記

現實時鐘與艾奧傑亞時鐘（ET）格式完全相同（`18:30`／`15:42`）⇒ **散文裡的現實時鐘一律用
`localClockText()`**（「本地 18:30」），ET 用 `etClockText()`（「ET 15:42」）。裸值 `clockText()`
**只准用在欄位標題已標明時鐘種類的表格欄位**，且該檔要登記進 `tests/clock-labelling.test.mjs`
白名單（**逐檔逐次數**，理由見 rationale）。

⚠️ **ET 的繁中名是「艾奧傑亞」，不是「艾歐澤亞」**。同一支測試守門，**連註解一起掃**。

### 7. 設計系統

`../ffxiv-tw-tools-portal/_DESIGN-SYSTEM.md` 是權威。本 repo 私有 class 一律 `cos-` 前綴；
不定義也不覆寫 `.codex-*` 根 selector；accent 統一 cyan；金色高亮**全頁只有一處**（靈風視窗倒數＝限時語意）。

### 8. 版面位移（CLS）

- **逐斷點釘實測高度，不要用單一 `min-height`**：`.cos-stats` 是 `auto-fit minmax(240px,1fr)`，欄數／列數隨寬度變
  ⇒ 一個值只對「一排」是對的。量 CLS 一律**逐寬度**（1920…390px）取**最差**的那個寬度。
- **`.cos-header-tools` 釘 `min-height`／`min-width`**，讓「換不換行」在首次繪製定案（`#job-picker` 由 JS 填）。
- **條件式警語不要用「不顯示」表達「沒問題」**：兩種狀態都要有文案（`#np-caveat` 晴朗時講「沒有天氣限定任務
  會被覆蓋」），槽位恆定。HTML 端放中性等待文案、**不放正式文案**（猜錯會先顯示錯的判斷再改口）。

---

## VERIFY（改動後必跑）

- **canonicalTest（safe-push 實跑的那一條；`process/fleet.json` 逐字對照本行）**：`node tools/validate.mjs && node tests/run-all.mjs && cd worker && pnpm test`
  > `tests/*.test.{js,mjs}` 由 `tests/run-all.mjs` 自動掃描，新增測試檔不必記得掛進來。

<!-- B-048-HANDOFF -->
> **舊網址交接機制已退役**：301 改由 Cloudflare 帳號層 Bulk Redirects 在邊緣執行，本 repo 不再有 functions 層 middleware／inline 交接腳本；`_routes.json` 的 include 只留 API 代理路徑（HTML 路徑不進 Pages Functions、不再計費）。細節見 rationale。

| 改了什麼 | 跑什麼 | 綠燈 |
|---|---|---|
| **任何改動（canonicalTest；`process/fleet.json` 逐字對照本行）** | `node tools/validate.mjs` | 資料不變量全過（544 任務／63 有條件／88 連續／11 條工具鏈）；不需遊戲 client |
| `tools/cosmic-dump/**` 或台服改版 | `dotnet run -c Release --project tools/cosmic-dump` | 內建健全性閘全過（544 任務／天氣總和 100%／11 條 9 階工具鏈），任一不過**不寫檔**；地圖底圖匯不出來也**整批不寫**（`img/map/sinus-ardorum.png` 512²） |
| `worker/**`（緊急事件後端） | cwd=`worker/`：`pnpm test`＋`pnpm test:logic`＋`pnpm cf:deploy:dry` | 66 整合（vitest-pool-workers）＋41 純函式（node --test）全綠；dry-run 0 error。**測試絕不打真 Discord**（fetch 被 stub） |
| `modules/emergency-*.js` | `node tests/run-all.mjs`（**8 個測試檔**）＋本機 `wrangler dev` ＋瀏覽器走一次通報→附議→訂閱 | 測試全綠；console 零 error；後端關掉時該分頁降級唯讀、其他分頁不受影響。⚠️ 前景輪詢時序量不到（自動化分頁本身就 `document.hidden`），要驗間隔得用真人分頁 |
| 任何 CSS／HTML | `node C:/FFXIVProject/tools/check-design-drift.js --files <改動檔> --strict` | exit 0 |
| 任何前端改動 | 瀏覽器開 `http://127.0.0.1:8774/ffxiv-tw-cosmic/`（`svc start portal`） | console 零 error；四個分頁都出得來；`documentElement.scrollWidth - clientWidth === 0` |
| 動 `deploy-*` 三件組／**新增任何頂層項** | `sh deploy-prepare.sh` | 印出「✓ 部署輸出就緒」（未分類的頂層項讓它 exit 1＝設計，去 `deploy-allow.txt`／`deploy-deny.txt` 歸類） |
| commit 前 | monorepo 共用 pre-commit（已掛 `core.hooksPath`） | secret／檔案大小／design-lint／DEVLOOP 工件 全過 |

<!-- TEST-BASELINE cmd="node tests/run-all.mjs" match="(\d+)/\d+ 測試檔通過" expect="8" label="前端 run-all" -->
<!-- TEST-BASELINE cmd="npx vitest run" cwd="worker" match="Tests\s+(\d+) passed" expect="66" label="worker 整合" -->
<!-- TEST-BASELINE cmd="node --test test/logic.test.mjs" cwd="worker" match="pass (\d+)" expect="41" label="worker 純函式" -->

> **測試基線**：動到測試檔或本檔時實跑並與上列三行標記雙向比對，**只准升不准降**（gate 6 與 `check-test-baseline.js` 靠它們）。

**欄位索引在台服改版後失效時**：先跑 `XIVpluginsDev/ICE-Dev/tools/tc-sheet-verify`（一鍵重驗三張表），不要在這裡重新反解。

---

## 開發循環（DEVLOOP）

正典 `~/.claude/process/DEVLOOP.md`。本 repo 工件：`docs/BACKLOG.md`（`B-NNN`）／
`docs/specs/<cycle>-design.md`／`docs/plans/<cycle>-plan.md`／`CHANGELOG.md`。

### 🔒 部署面鐵則（2026-08-01，勿回退）

本 repo 的 CF Pages 部署**不是「發佈 repo 根目錄」**，而是由 `deploy-prepare.sh` 依 `deploy-allow.txt` 產出 `_site/`。CF dashboard 必須設 Build command = `sh deploy-prepare.sh`、Build output directory = `_site`。

> 本段為 12 個 external repo 的**共用權威版本**：改本段須同步全部副本。事故與實證見 rationale。

- **允許清單而非排除清單**：頂層出現未列入 `deploy-allow.txt`／`deploy-deny.txt` 的項目 → **build 直接失敗**（新增內部資產預設「不發佈」）。分類閘另有兩條靜默放行（npm 產物 skip 清單、`git check-ignore`）＝只是提醒層；**真正的部署邊界是第 2 段複製迴圈的 allow-list 比對**——該比對不可動，skip 清單只放建置環境產物、不得用來繞分類。
- **新增站台資產**（新頁面／新資料夾）→ `deploy-allow.txt`；**新增內部資產** → `deploy-deny.txt`。改完跑 `sh deploy-prepare.sh` 確認印出「✓ 部署輸出就緒」。
- **腳本改動禁忌**：① 只用 POSIX 語法（CF 容器的 `sh` 是 dash；bashism 靜默失敗＝輸出 0 檔而 build 仍「成功」⇒ 整站 404）② 根層檔名不可無條件 `mkdir "$OUT/${f%/*}"`（會建出「叫 index.html 的目錄」⇒ `/` 404）③ 不得移除出貨前驗收閘（輸出 <3 檔／缺 index.html／內部檔混入 → 非零 exit，CF 保留前一版）④ **產物路徑不得假設獨佔**（並行 session／cron 互踩固定 `_site`）——接排程／並行寫入者時照 ranking 現行解改：`_site.tmp.$$`＋`mktemp` 清單＋`mkdir` 鎖（由來見 rationale）。
- **部署後驗**（**務必帶 cache-bust**）：`curl -sI "https://<repo>.pages.dev/AGENTS.md?cb=$(date +%s)"` → `text/html`＝正常（走 SPA fallback）、`text/markdown`＝紅燈。不帶 cache-bust 會得到**假紅燈**（邊緣快取殘留，判別法與自癒時間見 rationale）。
