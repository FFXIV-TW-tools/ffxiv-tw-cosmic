# ffxiv-tw-cosmic 健檢報告（2026-08-08）

## 總評：專案體質 **6.9** / 10 · 使用者友善 **6.4** / 10 — 內外皆需排修（涵蓋 14/14 維，無 failed、無截斷高風險項）

雙視角都落在「需排修」帶（5.5–6.9），但**不是地基有洞**：0 個 critical、2 個 high，其餘全是
medium/low，而且集中在**同一個形狀**——「功能靜默失效」：選項在畫面上但永遠不會響、
訊息表寫好了但永遠用不到、修正部署了但路由層沒把參數傳下去。這類缺陷沒有錯誤、沒有警告、
測試全綠，只有實際去走一遍或有人看得懂正確答案時才會發現。

這與這個 repo 自己的鐵則高度呼應（§2「未定性不得冒充」、§4「沒亮不代表沒事件」），
說明問題不在意識而在**機械防護網的覆蓋面**：整站最核心的天氣／ET 純函式在本輪之前
**一條數值斷言都沒有**，而那正是「時間資訊要對」這個核心承諾的所在。

> memory-audit 維度標 **not_applicable** 並從分母剔除：對應目錄為空，且該 repo CLAUDE.md
> 明文規定教訓寫進 AGENTS.md、不另寫 per-cwd memory —— 這是刻意設計，不是缺漏。

## 機械基線

- **審查快照**：`be0bfc1`（working tree clean）
- `node tools/validate.mjs` ✓ 資料不變量全過（544 任務／63 有條件／88 連續／11 條工具鏈）
- `node tests/run-all.mjs` ✓ 4/4（**修復後 7/7**）｜`node tests/handoff.test.mjs` ✓
- worker `pnpm test` ✓ 64（**修復後 66**）｜`pnpm test:logic` ✓ 41｜`cf:deploy:dry` ✓ 0 error
- `pnpm audit --prod` ✓ 無已知漏洞；lockfile 存在
- design-lint `--strict` ✓ exit 0（含 R5 禁覆寫 `.codex-*` 根 selector、R7 命名 ratchet）
- monorepo 跨 repo 哨兵全綠：`_headers` 基線（14 repo 違規 0）／網域遷移（cosmic 殘留 **0**）／
  交接頁一致性（13 站與樣板一致）／**部署面探測 12/12 站乾淨無外洩**
- 首載資產：`data/missions.json` **478 KB**（最大宗）、index.html 40 KB、css 31 KB；
  `img/` 2.2 MB／371 張（`loading="lazy"`）
- 瀏覽器實測：四分頁皆可建、console 零 error、`scrollWidth - clientWidth === 0`（1420／1920）

## 維度評分

### 專案體質（project）

| 維度 | 分 | 採納 | 一句話 |
|---|---|---|---|
| sec-frontend | 8.0 | 3 | 無 `innerHTML` 注入面、CSP 完整、輸出面不吐 UUID |
| correctness-data | 8.0 | 7 | 產生器有健全性閘、資料不變量守得緊；一個開發階段 off-by-one |
| sec-backend | 7.5 | 5 | 防護密度高於一般個人專案；問題在**信任等級的傳遞**而非注入 |
| tests-ci | 7.5 | 7 | 哨兵文化紮實，但最核心的時間函式零數值測試 |
| quality | 7.0 | 8 | 註解品質罕見地高；檔案大小鐵則持續超標且追蹤數字過期 |
| docs-drift | 7.0 | 8 | 公開 README 複述**自己已證偽的結論** |
| design-system | 7.0 | 6 | 58 個 hex **全部**在 token fallback 內；少數本地重刻 |
| resilience | **6.0** | 8 | ⛔ 封頂（confirmed high）：DO 零索引 ＋ `_sweep` 掛在最熱讀路徑 |
| observability | 6.5 | 5 | 有分桶計數，但 `[observability] enabled = false`、無 correlation id |
| data-lifecycle | 6.0 | 6 | `subs` 表無保留期、無 migration 路徑 |
| correctness-core | **6.0** | 6 | 六個 confirmed，全是「畫面上有、實際不會動」 |

### 使用者友善（user）

| 維度 | 分 | 採納 | 一句話 |
|---|---|---|---|
| ux-flows | 7.0 | 7 | 通報流程設計細膩；但關鍵操作的錯誤訊息寫進看不見的元素 |
| perf-ux | **6.0** | 5 | ⛔ 封頂（confirmed high）：每秒無條件重建 DOM |
| a11y-compat | 6.0 | 4 | 每秒重建吃焦點與點擊；窄螢幕破版；`title` 違反自家鐵則 |

**加權**：安全 0.25／正確性 **0.35**（「時間資訊要對」是本站核心承諾）／韌性 **0.20**
（免費額度自架，且 2026-08-04 真的發生過額度事故）／品質 0.10／測試 0.10／文件 0.10
＋三個可選維各 0.10，該視角重新正規化。使用者側 perf-ux **0.45**（長駐分頁工具）。

## 須修改項目（必做）

已在本輪執行的標 ✅，其餘進 BACKLOG。

| # | 項目 | 視角·維度 | 狀態 |
|---|---|---|---|
| 1 | 路由層丟掉 `weatherObserved` ⇒ 鐵則 §5.5 在正式環境從未生效 | 專案·sec-backend | ✅ 已修 |
| 2 | 鬧鐘「開啟當下」（0 分）永遠不會響 | 專案·correctness-core | ✅ 已修 |
| 3 | 靈風視窗結束時刻在連續兩段靈風時提早 23 分 20 秒（實測 12.8% 的時段） | 專案·correctness-core | ✅ 已修 |
| 4 | DO 回 `reason`、前端只讀 `error` ⇒ 八個錯誤訊息全部退化成「請稍後再試」 | 專案·resilience | ✅ 已修 |
| 5 | README 複述已證偽的「靈風是緊急任務必要條件」；緊急事件功能整段缺席 | 專案·docs-drift | ✅ 已修 |
| 6 | `worker/README` 三處過期（「不排 alarm」實際有、0–15 實際 −19–5、缺 `/admin/variant-map`、測試數 38/20） | 專案·docs-drift | ✅ 已修 |
| 7 | B-017（open）指向已證偽的修法、數字停在 117 | 專案·docs-drift | ✅ 已修 |
| 8 | 缺 `TEST-BASELINE` 標記 ⇒ monorepo gate 6 整個跳過本 repo | 專案·quality | ✅ 已修 |
| 9 | 核心時間／天氣純函式零數值測試 | 專案·tests-ci | ✅ 已補 8 條 |
| 10 | CORS 白名單放行任何 `ffxiv-*.pages.dev` 專案 | 專案·sec-backend | ✅ 已收窄 |
| 11 | **DO SQLite 零索引 ＋ `_sweep` 掛最熱讀路徑**（每次 `/state` 掃全表約四趟） | 專案·resilience | ⏳ B-030 |
| 12 | **每秒無條件重建按鈕節點**：焦點被清、點擊有機率被吞（打到附議／否認核心流程） | 使用者·perf-ux + a11y | ⏳ B-031 |
| 13 | 「只有預告」的事件：附議不觸發推播、手動通報被吞成附議、前端通知說成「進行中」 | 專案·correctness-core | ⏳ B-033 |
| 14 | 現況列的附議／否認／撤回結果寫進**藏在彈窗裡**的元素 ⇒ 失敗完全靜默 | 使用者·ux-flows | ⏳ B-035 |
| 15 | 開發進度：最後一個施工階段永遠顯示不出來（**需先進遊戲核對 `fromStage` 語意**，鐵則 §2） | 專案·correctness-data | ⏳ B-034 |

## 建議修改項目（可選）

| 項目 | 視角·維度 | 追蹤 |
|---|---|---|
| 窄螢幕「臨時任務」面板破版（固定欄寬溢出約 600px） | 使用者·a11y + ux-flows | B-032（行動版尚未 opt-in，屬 Owner 政策） |
| 關鍵說明只掛 `title` 屬性 — 觸控取不到，且違反自家「禁原生 title」鐵則 | 使用者·a11y | B-036 |
| `subs` 表無保留期／fan-out 無整體 deadline | 專案·sec-backend + data-lifecycle | B-037 |
| 事件結束時間在插件偵測延遲時偏晚（實測 2/7 筆延遲 81–137 秒）；`startExact` 送出卻從未被消費 | 專案·correctness-core | B-038（**主迴圈獨立發現**） |
| `emergency-view.js` 743 行且整支是一個 588 行的函式；`events-do.js` 602→**890**、`http.test.ts` 690→**1137** | 專案·quality | B-020（數字已更新） |
| `[observability] enabled = false`、無 correlation id | 專案·observability | B-039 |

## 誤報 / 校正

**本輪 refuted 0 筆**——依 skill 規定觸發「橡皮圖章」警語，主迴圈**加倍抽驗**：

| 親自複驗的 finding | 方法 | 結果 |
|---|---|---|
| sec-backend/A1 `weatherObserved` 未傳遞 | 讀 `index.js:143-149` ＋ 全 repo grep（只出現在產出與消費兩點） | ✅ 屬實，且**反向對照確認**：移除修正後恰好一條測試轉紅 |
| resilience/R1 DO 零索引 | `grep -c "CREATE INDEX" worker/src/events-do.js` = 0 | ✅ 屬實 |
| correctness-core/A1 鬧鐘 0 分 | 讀 `check()`：已開視窗被跳過 ⇒ `eta > 0 = leadSeconds` 恆真 | ✅ 屬實 |
| correctness-core/A2 靈風視窗 | 自行掃 20000 段實算連續靈風比例 = **12.8%**（agent 稱 ~13%） | ✅ 屬實 |
| docs-drift/A2 README | fan-out **之前**就已獨立發現同一條 | ✅ 交叉驗證一致 |

**partial 降級 15 筆**（verifier 確實有在降）：例 `sec-backend/A2` 由 medium 降 low
（「通知可被灌到事件結束後」屬誇大——`BROKEN_AFTER=4` 熔斷會先擋住）、`sec-backend/A3`
由 medium 降 low（否認門檻可繞是 README 明文拍板的已知上限，非新缺陷）。

**recall 反查（verifier 只驗「找到的」，不驗「漏掉的」）** — 主迴圈另跑五項獨立抽查：

| 抽查 | 結果 |
|---|---|
| 靜默吞錯（鐵則 §10） | ✅ 無裸 `catch {}`，每處都有說明註解 |
| 硬編色碼（設計系統） | ✅ 58 個 hex **全部**在 `var(--token, #fallback)` 內 |
| `document.hidden` 輪詢閘（鐵則 §5） | ✅ 3 處都在 |
| 文件路徑存在性 | ✅ 無死連結（`data/*.json` 是 glob、裸檔名是行文用法） |
| **ICE 執行 log 對帳** | ⚠️ 抓到 **2 項 agent 找不到的**（它們沒有 log）：結束時間偏晚、`startExact` 未消費 |

## 文件稽核

- `AGENTS.md` 243 行（>200 預設上限）。**建議放寬不改**：本檔是「鐵則＋索引」型，
  10 條鐵則各自都有實證由來且被反覆引用，搬走會讓「改動前先讀」的入口散掉。
  已在本輪新增 §5.5（觀測 > 推導）與測試基線段，行數還會增加——若日後超過 300 行，
  建議把「鐵則由來」的長段落搬進 `docs/` 並在 AGENTS 只留一行結論＋連結。
- `CLAUDE.md` 10 行薄 adapter ✅ 正確做法。
- memory 目錄為空 ✅ 刻意設計（教訓落 AGENTS.md），無去重／升級候選。

## 既有設計亮點

**專案體質側**

- **註解品質是這個 repo 最大的資產**。幾乎每個非顯而易見的決定都寫明「為什麼」與「由來日期」，
  且大量記錄**被推翻過的想法**（c14/c15 翻案五次、天氣閘證偽、`WKSMissionToDoEvalutionRefin`
  錯 join）。這讓外部審查者能在幾分鐘內取得多個月的脈絡——本輪 14 個維度全部 0 個 agent 失敗，
  很大程度是因為 CONTEXT 能寫得具體。
- **哨兵文化**：漂移偵測（modulepreload／時鐘標記／譯名／交接頁／部署面）覆蓋了一整類
  「零回饋訊號」缺陷，而且每支哨兵都在註解裡寫明「不裝這個會怎樣」。
- **鐵則 §2「未定性不得冒充」被真的執行**：40 筆推不出數量的需求物顯示橘色 `×?` 而不是補 ×1；
  緊急事件的變體衝突時清空而不是猜一個。這在個人專案裡罕見。
- SSRF 防線做了**兩層**（寫入時驗、送出前再驗一次），DB 被寫髒仍擋得住。

**使用者友善側**

- 「**沒亮不代表沒事件**」在四個位置重複出現（面板內文、help、頁尾、通知），
  把一個安全性等級的資訊主張講到不可能被誤讀。
- 通報流程的防呆密度高：就地通報（按鈕長在那一列上，消掉「選錯伺服器」整類錯誤）、
  30 秒靜置可撤回、Discord 深連結回站不自動投票。
- 本地時間 vs ET 的對照式標記（`ET 15:42` ↔ `本地 18:30`）解掉一個很難自己發現的誤讀。
