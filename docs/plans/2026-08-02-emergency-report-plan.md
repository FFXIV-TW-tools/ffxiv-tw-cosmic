---
status: done
type: feature
cycle: 2026-08-02-emergency-report
date: 2026-08-02
---

# 緊急事件玩家通報 Implementation Plan

> 執行風險：中

**Goal:** 緊急事件由 ICE 插件自動偵測與玩家手動通報兩路回報，訂閱者依自己的伺服器
收到 Discord 與網頁通知。**無天氣閘**（該假設已被 ICE log 證偽，見 spec §推翻了什麼）。

**Global Constraints:**
- 資料檔 `data/*.json` 一律由 `tools/cosmic-dump` 產生，本 cycle **不碰**（AGENTS §1）。
- 未定性的東西一律標明（AGENTS §2）：**天氣閘已被證偽故整個不做**；改以 `stats` 對 plugin／manual
  兩種來源分桶，讓通報品質可事後觀測（B-018）。
- 新檔一律 < 500 行、單一職責（monorepo AGENTS 檔案大小鐵則）。
- 私有 class 一律 `cos-` 前綴、不覆寫 `.codex-*`、金色高亮全頁仍只有一處（AGENTS §5）。
- 對外邊界 fail-closed：新增的可發佈檔案必須進 `deploy-allow.txt`，`worker/` 必須進
  `deploy-deny.txt`（monorepo 鐵則「對外邊界一律 fail-closed」）。
- commit 前先知會 Owner；push 與 `wrangler deploy` 一律 STOP（cosmic `CLAUDE.md` Git 邊界）。
- **跨子系統**：Task 5 動的是 `XIVpluginsDev/ICE-Dev/`，工件歸該子樹（`P-NNN`／其 CHANGELOG），
  commit 也在 monorepo 而非 cosmic repo（歸屬判準＝改哪些檔，monorepo AGENTS「開發循環」段）。
- 插件端沿用 ICE 既有鐵則：唯讀、預設關閉、不改變任何遊戲行為、`except` 走父層例外 c。

---

### Task 1: worker 純邏輯層與測試

**Files:**
- Create: `worker/src/logic.js`、`worker/test/logic.test.mjs`

**Interfaces:**
- Consumes: `data/dev-stages.json` 的 `worlds`（7 台伺服器，repo 內既有唯一來源）。
- Produces: `WORLDS`、`EVENT_DURATION`、`EMERGENCY_WEATHER`、`validateManualReport`、
  `validatePluginReport`、`validateVote`、`validateSub`、`isActive`、`applyVote`、
  `fanoutTargets`、`maskWebhook`、`isAllowedWebhook`。

- [x] **Step 1: 寫 `logic.js`**——全部純函式、零 I/O、零 CF API。
      `EVENT_DURATION = 1200`（＝33 個 critical 任務的 `timeLimit`，有 client 依據，註解寫明來源）。
      `EMERGENCY_WEATHER = [194,195,196,197]`。`validatePluginReport` 要做**證據自洽檢查**：
      `weatherId` 必須是緊急天氣（自相矛盾的 payload 不收）；`missionIds` **選填**（任務板沒開就
      讀不到），有給才檢查至少一個落在 critical id 範圍。token 走 header `X-Plugin-Token` 不放 body。
      `applyVote` 實作 `disputes ≥ 3 && confirms === 0 → disputed` 的狀態轉移。
      `isAllowedWebhook` 只放行 `discord.com`／`discordapp.com`（SSRF，照抄 sub-timer 語意）。
- [x] **Step 2: 寫測試**（`node --test`，本 task 不需 CF runtime）。狀態轉移矩陣逐格釘住：
      `active→active`（附議）／`active→disputed`（3 否認 0 附議）／`active→revoked`（管理）／
      `disputed` 後再附議不回頭／過期（`now >= endAt`）不再 active。
      邊界：`startsInMinutes` 0 與 15 收、−1 與 16 退；`world` 非 7 台之一即退；
      webhook 白名單的近似域名（`discord.com.evil.tld`、`evildiscord.com`、`http://` 明文）全退。
- [x] **Step 3: 驗證**：`node --test worker/test/logic.test.mjs` → 全綠；`node tools/validate.mjs` → 仍全綠。
- [x] **Step 4: Commit**：`feat(cosmic): 緊急事件通報 — worker 純邏輯層`

---

### Task 2: worker DO、路由與整合測試

**Files:**
- Create: `worker/src/index.js`、`worker/src/events-do.js`、`worker/wrangler.toml`、
  `worker/package.json`、`worker/vitest.config.ts`、`worker/test/http.test.ts`、`worker/README.md`
- Modify: `.gitignore`（`worker/node_modules`、`worker/.wrangler`）

**Interfaces:**
- Consumes: Task 1 的 `logic.js` 全部匯出。
- Produces: spec「對外介面」表的 8 條路由。

**Blocked by:** Task 1（router 與 DO 都消費 `logic.js`）

- [x] **Step 1: `events-do.js`**——SQLite 建表（spec 資料模型段：`events`／`subs`／`blocked`／`stats`）、
      `report`／`vote`／`putSub`／`getSub`／`revoke`／`block`／`stats` 方法、Discord fan-out。
      **fan-out 不重試、不做 outbox**（事件只有 20 分鐘，遲到的通知沒價值）：失敗只累計 `failCount`，
      連續 4 次標 `broken` 停送；併發上限 5。保留期：每次寫入順手刪 `endAt < now - 7d` 的事件；
      `worlds` 為空的訂閱**實體刪列**。lazy 過期，不排 alarm。
- [x] **Step 2: `index.js`**——origin 白名單（照抄 portal `ORIGIN_PATTERNS`）、CORS、
      `Content-Type`／body ≤ 8KB 閘、rate limit binding、`Authorization: Bearer` 解析（admin）、
      錯誤碼對照（spec 錯誤碼段）、`/state` **不加 edge cache**（算過額度不划算，換來的是
      「撤銷後仍顯示進行中」這類 staleness；濫用防線是 rate limiter）。
      插件路徑改吃 `PLUGIN_TOKEN`（header `X-Plugin-Token`），**不套 origin 白名單**（插件沒有 Origin）。
- [x] **Step 3: `wrangler.toml`**——DO binding ＋ migration ＋ 三個 ratelimit binding
      （`REPORT_RATE_LIMITER` 2/60s、`VOTE_RATE_LIMITER` 5/60s、`GET_RATE_LIMITER` 120/60s）、
      `observability = false`（沿用 portal 慣例省額度）、`[dev] port = 8789`（避開 8787／8788）。
- [x] **Step 4: 整合測試 `http.test.ts`**（`@cloudflare/vitest-pool-workers`，portal／sub-timer 已有前例）。
      **時間**：正式路由只用伺服器時鐘，另測「body 裡的 `now` 被完全忽略」；純函式層的 `now`
      由測試注入，那是 `logic.js` 的參數、不是 HTTP 欄位。
      覆蓋：origin 被拒→403／content-type→415／body 超限→413／manual 重複通報→409 且轉附議／
      plugin 證據不自洽→400／plugin token 錯→401／被封鎖 UUID→403／admin 撤銷後 `/state` 不再列／
      webhook SSRF 變形被拒／fan-out 連續失敗 4 次標 `broken`／`GET /sub` 只回遮罩 webhook／
      `worlds:[]` 後該列消失。Discord 端點以 mock fetch 攔截，**測試絕不打真 Discord**。
- [x] **Step 5: `README.md`**——部署 SOP、secret 清單（`ADMIN_TOKEN`／`PLUGIN_TOKEN`）、
      endpoint 表、安全模型（UUID＝假名識別＋capability、webhook＝敏感憑證只回遮罩、保留期）。
- [x] **Step 6: 驗證**：`pnpm test` 全綠；`npx wrangler deploy --dry-run` 0 error。
- [x] **Step 7: Commit**：`feat(cosmic): 緊急事件通報 — worker DO、路由與整合測試`

---

### Task 3: 前端「緊急事件」分頁（現況／通報／附議）

**Files:**
- Create: `modules/emergency-api.js`、`modules/emergency-view.js`
- Modify: `index.html`（新分頁按鈕＋ panel）、`modules/app.js`（接線）、`css/style.css`（`cos-em-*`）

**Interfaces:**
- Consumes: Task 2 的 `/state`／`/report`／`/vote`；`data/dev-stages.json` 的 `worlds`。
- Produces: `createEmergencyView(root, {...})` → `{ render(now), setWorld(w) }`，供 `app.js` tick 呼叫。

**Blocked by:** Task 2（消費其 HTTP 介面）

- [x] **Step 1: `emergency-api.js`**——`fetchRetry`（429／503 指數退避，照 `FFXIV_API.md` 鐵則）、
      base URL 依 hostname 切 dev（`http://127.0.0.1:8789`）／prod、
      錯誤碼 → 人話訊息對照表（`already_active` 要說「已轉為附議」而不是「失敗」）。
      後端不可用時**降級為唯讀＋一行說明**，不得白屏或無限重試。
- [x] **Step 2: `emergency-view.js`**——現況卡（每台伺服器一列：進行中倒數／無事件；
      **來源徽章 `插件偵測`／`玩家通報`** 並列附議與否認數）、通報表單（伺服器 select ＋
      「已開始／1／3／5／10 分鐘後」＋送出）、附議／否認鈕。
      面板底部固定文案：「靠回報，沒人回報＝這裡不會亮，**不代表沒有事件**」。
- [x] **Step 3: 接線**——`index.html` 加第四個 tab、`app.js` 建立 view 並納入既有 tick
      （現況每 60 秒才打一次後端，倒數用本地時鐘算，不是每秒打 API）。
- [x] **Step 4: 驗證**：`node C:/FFXIVProject/tools/check-design-drift.js --files index.html css/style.css --strict`
      → exit 0；本機 `wrangler dev` ＋ `svc start portal` 開
      `http://127.0.0.1:8774/ffxiv-tw-cosmic/` → console 零 error、四個分頁都出得來、
      `documentElement.scrollWidth - clientWidth === 0`；手動 POST 一筆通報後畫面 60 秒內出現。
- [x] **Step 5: Commit**：`feat(cosmic): 緊急事件分頁 — 現況、通報與附議`

---

### Task 4: 訂閱與網頁通知（頁內輪詢，不做 Service Worker）

**Files:**
- Create: `modules/emergency-notify.js`
- Modify: `modules/emergency-view.js`（訂閱區塊）、`index.html`（訂閱 UI）

**Interfaces:**
- Consumes: Task 2 的 `/sub`；portal `window.FFXIVSettings` 的 `discord.webhookUrl`
  （**跨工具共用那一份，本站不自建欄位**）；`alarm.js` 既有的三管道通知手法。
- Produces: `createEmergencyNotify({...})` → `{ sync(), status(), onState(state) }`。

**Blocked by:** Task 3（訂閱 UI 掛在同一個面板）

- [x] **Step 1: `emergency-notify.js`**——`Notification.requestPermission`、
      把「要收哪幾台伺服器 ＋ Discord webhook」PUT 到 `/sub`；沒填 webhook 時**不報錯**，
      顯示「只會有網頁通知」並附 portal 設定連結。同一 `eventId` 只響一次（去重集合有上界）。
- [x] **Step 2: 狀態誠實化**——訂閱區明說兩種管道的差別：**網頁通知＝分頁開著才有**
      （SW 在沒有分頁時會被瀏覽器終止，做不到「關掉還會響」）；**Discord＝關機也收得到**。
      禁止任何暗示「關掉瀏覽器仍會通知」的文案。
- [x] **Step 3: 驗證**：訂閱伊弗利特後對本機 worker POST 一筆該伺服器通報 → 一輪輪詢內跳通知；
      POST 一筆非訂閱伺服器 → 不跳；退訂（worlds 清空）後再 POST → 不跳。
- [x] **Step 4: Commit**：`feat(cosmic): 緊急事件訂閱與網頁通知`

---

### Task 5: ICE 插件自動通報

**Files:**
- Create: `XIVpluginsDev/ICE-Dev/ICE/Utilities/EmergencyReporter.cs`
- Modify: `XIVpluginsDev/ICE-Dev/ICE/ICE.cs`（Tick 接線）、該插件的設定與 `/ice` 指令說明

**Interfaces:**
- Consumes: Task 2 的 `POST /report`（plugin 形狀：header `X-Plugin-Token` ＋
  `{world, weatherId, missionIds[]（選填）, phase}`）。
- Produces: 無（終端）。

**Blocked by:** Task 2（消費其 HTTP 介面）

- [x] **Step 1: `EmergencyReporter.cs`**——**照抄 `BoardLogger.cs` 的形狀**（唯讀、預設關閉、
      節流、`try/catch` 走父層鐵則例外 c）。在渴望灣（territory 1237）每秒讀一次
      `EnvManager->ActiveWeather`：進入 194–197 → `phase:'start'`；離開 → `phase:'end'`。
      **只在「翻轉當下」送**，不是每秒送；送失敗只 `IceLogging.Warning`，不重試、不影響遊戲流程。
      世界名取 `Player.CurrentWorld`（繁中服 7 台之一，非其一即不送）。
- [x] **Step 2: 開關與設定**——預設 **關閉**，`/ice emergency on` 開啟；
      token 與端點寫在插件設定（不進 git）。狀態行比照 `BoardLogger.StatusLine`。
- [x] **Step 3: 驗證**——`dotnet build -c Release` 過；本機 worker 收得到假造的 start／end 一對
      （用 `curl` 模擬插件 payload 驗端點；遊戲內實測留給下次事件發生時）。
- [x] **Step 4: 工件**——`XIVpluginsDev/docs/BACKLOG.md` 加 `P-NNN` 條目交叉索引本 spec，
      `XIVpluginsDev/CHANGELOG.md` 加一段（歸屬判準＝改的是該子樹的檔）。
- [x] **Step 5: Commit**（在 monorepo，不是 cosmic repo）：
      `feat(plugins/ICE): 緊急事件自動通報 — 天氣 194–197 翻轉即回報`

---

### Task 6: 文案更正、鐵則改寫與部署面

**Files:**
- Modify: `modules/forecast-view.js`、`AGENTS.md`、`_headers`、`deploy-allow.txt`／`deploy-deny.txt`、
  `index.html`（footer）、`docs/BACKLOG.md`、`CHANGELOG.md`、
  `docs/specs/2026-07-31-cosmic-site-design.md`（就地加更正區塊，不改寫歷史）

**Interfaces:**
- Consumes: Task 1–5 的實際檔案清單（決定 `deploy-allow.txt` 要加什麼）。
- Produces: 可部署且 fail-closed 的發佈面。

**Blocked by:** Task 4（allow 清單要等所有新檔定案）

- [x] **Step 1: 修 `forecast-view.js`**——`N 個緊急任務的必要條件` →
      `N 個天氣限定臨時任務的必要條件`；129／148 行註解的「11 個」一併更正
      （實際 20 個，且它們是 `temporary` 不是 `critical`）。
- [x] **Step 2: 修 `index.html` footer**——「緊急任務為伺服器端狀態，本站不提供」→
      改成「緊急事件由插件偵測與玩家通報，覆蓋率取決於回報者，沒亮不代表沒事件」。
- [x] **Step 3: 改 `AGENTS.md`**——§4 改寫（演算法仍不預測；新增回報層與其天花板）、
      §2 表格新增一列記錄「天氣閘假設已被 ICE log 證偽（2026-08-02）」、
      VERIFY 表加 worker 測試命令。
- [x] **Step 4: 補 2026-07-31 spec 的更正區塊**——在該檔「11 個緊急任務的天候條件（靈風）」那列
      下方加 `> 更正（Build，2026-08-02）：…`（DEVLOOP §4.7 三條件：anchored 首行／連續 `>` 行／不含 heading）。
- [x] **Step 5: 部署面**——`_headers` 的 `connect-src` 加
      `https://ffxiv-tw-cosmic-api.ffxiv-tw-tools.workers.dev`；`deploy-deny.txt` 加 `worker`；
      `deploy-allow.txt` 不需新增（本 cycle 未新增根層可發佈檔，`modules/` 已在清單內）——
      **執行時實跑 `deploy-prepare.sh` 核對，不憑推斷**。
- [x] **Step 6: 工件**——`docs/BACKLOG.md`：B-006 標為被本 cycle 取代並註明理由、
      新增 B-018（上線後用 `stats` 分桶觀察 plugin／manual 兩種來源的通報量與否認率）；
      `CHANGELOG.md` 加 2026-08-02 段落（含天氣閘證偽的完整證據鏈）。
- [x] **Step 7: 驗證**：`node tools/validate.mjs` 綠；`deploy-prepare.sh` 跑完 `_site/` **不含**
      `worker/` 與 `docs/`；`grep -rn "本站不提供" index.html` 無殘留。
- [x] **Step 8: Commit**：`fix(cosmic): 緊急任務誤稱修正 ＋ 通報功能的鐵則與部署面更新`

---

## 外審 triage（前閘）

<!-- external-gate:begin v=4 phase=pre cycle=2026-08-02-emergency-report fp=sha256:0dfee55d27bb1d88ec41d800536afd9152e83f550fb08851e6832936a87656b2 -->
<!-- external-gate:meta
{
  "v": 4,
  "phase": "pre",
  "cycle": "2026-08-02-emergency-report",
  "override": null,
  "overrideActual": null,
  "materialSha256": "8e682dbd5a7efdbf6dac3f1a2cff0464f3d484d1ac87b69a31d22c04c6e4104b",
  "diffBase": null,
  "diffSha256": null,
  "specSha256": "d8d4dd3cdb3d9519b115d77fb6ffbcd58540f68508dbbbc0e326e5bd62113477",
  "reviewedTree": "58694a2ab1fbf8264c5926b69b69525c249a949b",
  "remediation": null,
  "round": null,
  "sourceFp": null,
  "baseSha": null,
  "reviewHeadSha": null,
  "rangeCommits": null,
  "outputsFile": "docs/plans/2026-08-02-emergency-report-plan.reviews.md",
  "reviewers": [
    {
      "cli": "codex",
      "model": "gpt-5.6-sol",
      "argv": [
        "codex.EXE",
        "exec",
        "-m",
        "gpt-5.6-sol",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "project_doc_max_bytes=0",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--cd",
        "<tmp>"
      ],
      "startedAt": "2026-08-02T07:04:52.265Z",
      "finishedAt": "2026-08-02T07:08:45.281Z",
      "exitCode": 0,
      "outputBytes": 5877,
      "outputSha256": "af0434d0e168c3940b0ed256b68c93853f5ad24211ccff3538a3d9ad6e685689"
    }
  ]
}
-->


| # | CLI/模型 | 開始 (UTC) | 耗時 | exit | 輸出 bytes | sha256 |
|---|---|---|---|---|---|---|
| 1 | codex/gpt-5.6-sol | 2026-08-02T07:04:52.265Z | 233s | 0 | 5877 | `af0434d0e168…` |

命令逐字：
```text
codex: codex.EXE exec -m gpt-5.6-sol -c model_reasoning_effort=high -c project_doc_max_bytes=0 --skip-git-repo-check --sandbox read-only --cd <tmp>
```

- 1. codex 原文見 `docs/plans/2026-08-02-emergency-report-plan.reviews.md` §0dfee55d27bb-1（sha256:af0434d0e168…）
<!-- external-gate:end -->

### triage 結論（執行者填，不由工具產生）

> 前提：本輪外審之後，Owner 的兩項裁示與一項實證推翻了原設計的兩個支柱——
> ① ICE `board-log.jsonl` 證偽「緊急事件只在特殊天氣發動」（緊急期間底層天氣 15/15 是晴朗）
> ⇒ **天氣閘整個移除**；② Owner 拍板插件與人工並行、反惡意走社交層。
> 因此下列 triage 已把「因設計變更而消滅」與「採納後修正」分開標示。

1. **【致命】Service Worker 無法可靠背景輪詢** — ✅ **採納**。W3C service-worker lifetime
   明定無事件即可被終止、計時器不喚醒；`sw.js` 只在有分頁存活時才跑得動，等於原承諾
   「關掉分頁、瀏覽器開著仍會響」不成立。**處置：整個拿掉 `sw.js`**，改頁內 60 秒輪詢
   （既有 `alarm.js` 已是同一形狀），UI 明說「網頁通知＝分頁開著才有；要關掉也收得到就用 Discord」。
   少一個檔、少一個假承諾（Task 4 已改寫）。

2. **【嚴重】Discord 退避缺持久排程與 outbox** — ✅ **部分採納，但反向處置**。診斷正確
   （`waitUntil` 撐不起持久重試），但結論不適用：sub-timer 需要重試是因為它送的是**排程提醒**，
   遲到仍有價值；本站送的是**20 分鐘即時事件**，遲到的通知反而有害。**處置：明確不重試、不做 outbox**，
   只保留 `failCount` → 4 次 `broken` 熔斷（防燒額度）。plan 已刪除「指數退避」字樣。

3. **【嚴重】UUID 授權語意缺席** — ✅ **採納**。`GET /sub` 改為**只回遮罩 webhook**，
   UUID 明列為「假名識別資料＋capability」（與 portal settings 既有信任模型一致，README 寫明）。
   ❌ **駁回**其中「另立 128-bit bearer secret、公開 reporter id 與管理憑證分離」一節：
   本站的 UUID 本來就是 122-bit 隨機且不公開，再疊一層憑證是為既有模型重造輪子，
   跨工具使用者要多記一組祕密，成本高於收益。封鎖可被換 UUID 繞過是**已知且接受**的
   （社交層防線的固有上限，Owner 2026-08-02 拍板）。

4. **【嚴重】admin 反惡意層無實作落點** — ✅ **採納**。spec 資料模型加 `blocked` 表，
   對外介面表補三個 admin 端點的完整契約（`Authorization: Bearer`、401/403 語意），
   Task 2 Step 4 補「被封鎖 UUID→403」「撤銷後 `/state` 不再列」測試。

5. **【嚴重】worker 無自動化行為測試** — ✅ **採納**。Task 2 加
   `@cloudflare/vitest-pool-workers` 整合測試（portal／sub-timer 已有前例，不是新技術決策），
   覆蓋路由、狀態轉移、SSRF 變形、封鎖／撤銷、`broken` 熔斷、遮罩、退訂刪列；
   Discord 端點以 mock fetch 攔截，**測試絕不打真 Discord**。

6. **【嚴重】驗收受牆鐘控制（天氣閘）** — ⚪ **因設計變更而消滅**。天氣閘已移除，
   通報不再有任何時間相依的通過條件；測試一律傳明確 `now`。

7. **【嚴重】保存期限與識別資料** — ✅ **採納**。`events` 保留 7 天（寫入時順手清）、
   `subs` 在 `worlds` 為空時實體刪列、webhook 一律遮罩後才出現在任何回應或紀錄。

8. **【一般】Task 5 漏兩個已列入 Files 的修改** — ✅ **採納**。`index.html` footer 與
   2026-07-31 spec 的更正區塊各自獨立成 Step（現 Task 6 Step 2／Step 4），
   並在 Step 7 加 `grep` 驗證舊文案無殘留。

9. **【一般】單一 `rejectedByWeather` 無法驗證假設** — ⚪ **因設計變更而消滅**，
   但**批評本身正確且已被實證**：它擔心的「單一累計值看不出誤擋」正是此假設的失敗形態，
   而我們用 ICE log 在寫任何程式碼之前就把假設證偽了。改以 `stats` 對
   plugin／manual 兩種來源分桶（通報量、附議率、否認率），開成 B-018 追蹤。

---

## 外審 triage（前閘・第 2 輪）

<!-- external-gate:begin v=4 phase=pre cycle=2026-08-02-emergency-report fp=sha256:d2b53e48099084dc1cb3c0f3926402660e68a77b96696a113e1bebe4435de0a5 -->
<!-- external-gate:meta
{
  "v": 4,
  "phase": "pre",
  "cycle": "2026-08-02-emergency-report",
  "override": null,
  "overrideActual": null,
  "materialSha256": "0bbbed636086a8e5b934d4c323a8d499aa9864b3c0b7ea913a6439846684c4f9",
  "diffBase": null,
  "diffSha256": null,
  "specSha256": "28a01ce2d923cf48000de9399786813260cc7bf8e496538ed9968e57de73038c",
  "reviewedTree": "1da8e64b36410086af765a2bd940ea7d02df2b85",
  "remediation": null,
  "round": 2,
  "sourceFp": "0dfee55d27bb1d88ec41d800536afd9152e83f550fb08851e6832936a87656b2",
  "baseSha": null,
  "reviewHeadSha": null,
  "rangeCommits": null,
  "outputsFile": "docs/plans/2026-08-02-emergency-report-plan.reviews.md",
  "reviewers": [
    {
      "cli": "codex",
      "model": "gpt-5.6-sol",
      "argv": [
        "codex.EXE",
        "exec",
        "-m",
        "gpt-5.6-sol",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "project_doc_max_bytes=0",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--cd",
        "<tmp>"
      ],
      "startedAt": "2026-08-02T07:58:30.491Z",
      "finishedAt": "2026-08-02T08:01:09.943Z",
      "exitCode": 0,
      "outputBytes": 5980,
      "outputSha256": "2d4da115afc5a9219fc839c04509bf3a5ca195ce890a35329c76a4e0d6469b8f"
    }
  ]
}
-->


| # | CLI/模型 | 開始 (UTC) | 耗時 | exit | 輸出 bytes | sha256 |
|---|---|---|---|---|---|---|
| 1 | codex/gpt-5.6-sol | 2026-08-02T07:58:30.491Z | 159s | 0 | 5980 | `2d4da115afc5…` |

命令逐字：
```text
codex: codex.EXE exec -m gpt-5.6-sol -c model_reasoning_effort=high -c project_doc_max_bytes=0 --skip-git-repo-check --sandbox read-only --cd <tmp>
```

- 1. codex 原文見 `docs/plans/2026-08-02-emergency-report-plan.reviews.md` §d2b53e480990-1（sha256:2d4da115afc5…）
<!-- external-gate:end -->

### triage 結論（執行者填，不由工具產生）

- <逐條 finding 標 ✅採納／❌駁回（附技術理由）／❓待釐清>

### triage 結論（round 2 前閘，post-hoc）

> **本輪的性質**：round 1 之後設計被 Owner 裁示與 ICE log 實證改掉（天氣閘整個移除、
> 改雙來源），依 R9 必須重綁材料，但重綁要求 spec/plan 已在 git ⇒ 先落地再審，
> 因此這一輪實際上是 **post-hoc**。**12 條逐條對照實際程式碼**後：兩條「致命」與
> 多數「嚴重」是**計畫文字沒跟上 Build 期決定**（程式碼本身正確且一致），
> 一條是事實錯誤，兩條是真缺口（已補測試與一處程式碼修正）。

1. **【致命】插件契約互相衝突（`missionIds` 必填 vs 選填、token 在 body vs header）** —
   ✅ **採納（文件缺陷）**。程式碼從頭到尾一致：token 在 header、`missionIds` 選填。
   錯的是 plan Task 1／Task 5 與 spec 介面表沒跟上 Build 期的更正。三處文字已改。
2. **【致命】測試用的 `now` 會讓公開客戶端控制安全時鐘** — ✅ **採納（但程式碼原本就安全）**。
   `index.js` 只用 `Date.now()`，從不讀 body 的 `now`；那句話講的是 `logic.js` 的參數。
   **已補整合測試**「body 裡的 `now` 被完全忽略」把它釘死，並改寫 plan 措辭。
3. **【嚴重】單一 `source` 無法表達「玩家先報、插件後證實」** — ✅ **已實作，補測試**。
   `events-do.js` 的 `report()` 在插件命中既有事件時把 `source` 升級為 `plugin`；
   插件沒有 UUID 故不偽造成附議。已補整合測試 manual→plugin 升級。
4. **【嚴重】`phase:'end'` 沒有狀態轉移定義** — ✅ **採納（補定義＋測試）**。
   spec 補明：`end` 關掉該伺服器當前 active 事件（含 manual 來源——插件看到的是遊戲真實天氣）；
   找不到就什麼都不做。**殘留風險據實寫入 spec**（遲到的 `end` 可能提早關掉下一起事件；
   窗口窄、後果僅止於畫面提早收掉）。已補「無 active 事件時 end 不做事」測試。
5. **【嚴重】前端沒有 UUID 取得方案** — ✅ **已實作，文件補**。
   `emergency-api.js` 的 `currentUuid()` 走 portal 跨工具 `FFXIVSettings.getUuid()`，
   不自建、不進 URL。
6. **【嚴重】`PUT /sub` 沒有 rate limit** — ❌ **駁回：事實錯誤**。
   `index.js` 的 `/sub` PUT 走 `VOTE_RATE_LIMITER`（5/60s）。plan 只列了三個 binding 名稱，
   審者由此推論成「沒保護」。**訂閱數上限與過期清理的部分另行採納**為 B-018 的觀測項——
   現階段沒有真實流量，先設一個猜的上限只是另一個沒有依據的數字。
7. **【嚴重】25 分鐘冷卻沒有落入步驟或驗收** — ✅ **已實作，補整合測試**。
   `inCooldown` ＋ DO 內查該 UUID 上一筆；已補「撤銷後同人仍被冷卻擋、別人不受影響」測試。
8. **【嚴重】投票唯一性與改票規則未定義** — ✅ **已實作且已測**。
   `applyVote` 以 Set 處理、改票原子換邊；純函式測試已涵蓋重複投票與改票。
9. **【嚴重】`startsInMinutes > 0` 的語意未定義** — ✅ **採納（補文件）**。
   行為早已實作（占用 active 槽、Discord 立刻送並寫明幾分鐘後、UI 顯示倒數），spec 補明。
10. **【嚴重】Task 2 仍要求 edge cache，與 spec 更正矛盾** — ✅ **採納（文件）**。程式碼沒有快取，
    plan 文字已刪。
11. **【嚴重】preflight／admin 無 Origin 的驗收缺口** — ✅ **採納，補測試**。
    `/admin/*` 本來就不套 origin 白名單（已補測試證明無 Origin＋正確 token 可用）；
    另補 OPTIONS preflight 允許／拒絕兩個案例。
12. **【一般】殘留天氣閘要求；checklist 全 `[x]`** — ✅ **前者採納**（Global Constraints 已改寫）；
    後者**說明而非修正**：本輪是 post-hoc，Build 確實已完成，`[x]` 反映事實。

**本輪另外抓到一個真的程式缺陷**（測試寫出來才發現，不在 12 條之內）：
插件路徑的重複通報回 `200`、手動路徑回 `409`，與 README 不一致 ⇒ 已統一為 `409`。

---

## 外審 triage（後閘）

<!-- external-gate:begin v=4 phase=post cycle=2026-08-02-emergency-report fp=sha256:7ccc8b22022466af385c0e752f061c098b2037b52ffe94f49ba7cfc3e7d0ec44 -->
<!-- external-gate:meta
{
  "v": 4,
  "phase": "post",
  "cycle": "2026-08-02-emergency-report",
  "override": null,
  "overrideActual": null,
  "materialSha256": "f305178bdf3df38cc24c283b2adca563671082e927930c2cc111febe9cf46668",
  "diffBase": "8f5f7d7^",
  "diffSha256": "6d8337f1d6b560e5a93ec86179508aad8ecb6eb9c828073add91fd1f9f504dcc",
  "specSha256": "0d884a1855e60c83e7aa8cf824188b66f46e04c7f7958ee884da6556183185aa",
  "reviewedTree": "6826f27d79f2b1e5364a9da2fa22630c0f0de8aa",
  "remediation": null,
  "round": null,
  "sourceFp": null,
  "baseSha": "1da8e64b36410086af765a2bd940ea7d02df2b85",
  "reviewHeadSha": "6826f27d79f2b1e5364a9da2fa22630c0f0de8aa",
  "rangeCommits": [
    {
      "sha": "6826f27d79f2b1e5364a9da2fa22630c0f0de8aa",
      "subject": "perf(cosmic): 時間軸只在天氣時段變動時重建，平時只更新倒數格",
      "files": [
        "modules/forecast-view.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "da5aab28612480878471bd1edb49fff9b7ce1e0b",
      "subject": "data(cosmic): 重跑產生器 — 伺服器順序改為官方排列",
      "files": [
        "data/cosmic-tools.json",
        "data/dev-stages.json",
        "data/missions.json",
        "data/weather.json"
      ],
      "omittedCount": 0
    },
    {
      "sha": "5e0a3f2cc6c42a992c55a8b74653b783cca663f2",
      "subject": "feat(cosmic): 天氣預報改兩欄、任務清單按可做性排序、說明文字精簡",
      "files": [
        "css/style.css",
        "index.html",
        "modules/forecast-view.js",
        "modules/mission-view.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "257a6d524c6d3467b2bc88ea2745cd99b166f54b",
      "subject": "feat(cosmic): 各伺服器現況補「上次結束時間」，通知設定改為彈窗",
      "files": [
        "css/style.css",
        "index.html",
        "modules/emergency-notify.js",
        "modules/emergency-view.js",
        "worker/src/events-do.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "5326899bf3453cbeebffdec34752649f9dccea95",
      "subject": "feat(cosmic): 天氣四格升為全頁共用、緊急事件排第一，相對時間一律附時鐘",
      "files": [
        "css/style.css",
        "index.html",
        "modules/emergency-view.js",
        "modules/forecast-view.js",
        "modules/now-panel.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "d1ce7efb2fa8a3ce08a81d060060044aa1c618a2",
      "subject": "fix(cosmic): 通報時間選單改用「再 N 分鐘／剩餘時間 N 分鐘」，否認進度上檯面",
      "files": [
        "modules/emergency-view.js",
        "worker/src/events-do.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "e64414b5a53088678e23cc73ab1118a435ec52b0",
      "subject": "docs(cosmic): 補 8/3 靜置期段落，修正「後端上限仍是 15」",
      "files": [
        "AGENTS.md",
        "CHANGELOG.md"
      ],
      "omittedCount": 0
    },
    {
      "sha": "1ed5640261a9822e83f805860ab89454973ebcea",
      "subject": "fix(cosmic): 通報提前量上限 15 → 5 分鐘",
      "files": [
        "worker/src/logic.js",
        "worker/test/logic.test.mjs"
      ],
      "omittedCount": 0
    },
    {
      "sha": "6049f9c90ff80905f0a83080c5a0951971013c53",
      "subject": "feat(cosmic): 靜置期可提前結束 — 附議或通報者確認即刻推播",
      "files": [
        "modules/emergency-api.js",
        "modules/emergency-view.js",
        "worker/src/events-do.js",
        "worker/src/index.js",
        "worker/test/http.test.ts"
      ],
      "omittedCount": 0
    },
    {
      "sha": "5c41f0352b191447bda7f08e6e68947fe66664b8",
      "subject": "feat(cosmic): 手動通報靜置 30 秒才推播，誤按可在此期間撤回",
      "files": [
        "modules/emergency-view.js",
        "worker/src/events-do.js",
        "worker/src/logic.js",
        "worker/test/http.test.ts"
      ],
      "omittedCount": 0
    },
    {
      "sha": "ca05bf508c5e4295d9dc74504e1134981ec2c43a",
      "subject": "fix(cosmic): CSP connect-src 放行 discord.com — 設定的「測試發送」被擋",
      "files": [
        "_headers"
      ],
      "omittedCount": 0
    },
    {
      "sha": "da0e6e09127e3c07c469a81ff4eea942c46389b0",
      "subject": "feat(cosmic): /admin/purge 清掉已撤銷／已撤回的事件",
      "files": [
        "AGENTS.md",
        "CHANGELOG.md",
        "worker/README.md",
        "worker/src/events-do.js",
        "worker/src/index.js",
        "worker/test/http.test.ts"
      ],
      "omittedCount": 0
    },
    {
      "sha": "7e742b3d191aafb507ad1105a82644c4da0193dc",
      "subject": "docs(cosmic): 更正預告關鍵字的記述（爆發的預兆 → 觀測到）",
      "files": [
        "CHANGELOG.md"
      ],
      "omittedCount": 0
    },
    {
      "sha": "bf580f284785f507a6e7d8b12aeb1e927ca725da",
      "subject": "feat(cosmic): 記住看的是哪一個分頁，F5 不再跳回第一頁",
      "files": [
        "CHANGELOG.md",
        "modules/app.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "6a98b317cd08e3a698bff5c0c6f2ca9e82f709ae",
      "subject": "fix(cosmic): footer 也不提插件",
      "files": [
        "index.html"
      ],
      "omittedCount": 0
    },
    {
      "sha": "dc1c91a12621dc60f82b5d911f8e8ca96c6ae838",
      "subject": "feat(cosmic): 可通報「已開始 N 分鐘」＋ /admin/adjust 校正時間",
      "files": [
        "AGENTS.md",
        "CHANGELOG.md",
        "modules/emergency-view.js",
        "worker/README.md",
        "worker/src/events-do.js",
        "worker/src/index.js",
        "worker/src/logic.js",
        "worker/test/http.test.ts",
        "worker/test/logic.test.mjs"
      ],
      "omittedCount": 0
    },
    {
      "sha": "12d2a72b995bf4f779b9aa45f0350afa02249926",
      "subject": "feat(cosmic): 緊急事件預告 → 進行中兩段式",
      "files": [
        "AGENTS.md",
        "CHANGELOG.md",
        "index.html",
        "modules/emergency-history.js",
        "modules/emergency-view.js",
        "worker/README.md",
        "worker/src/events-do.js",
        "worker/src/logic.js",
        "worker/test/http.test.ts",
        "worker/test/logic.test.mjs"
      ],
      "omittedCount": 0
    },
    {
      "sha": "03db2fc90ec2c627d4791cbd98fbd6c88d96f87f",
      "subject": "feat(cosmic): 通報者可撤回自己按錯的那一筆",
      "files": [
        "AGENTS.md",
        "CHANGELOG.md",
        "modules/emergency-api.js",
        "modules/emergency-history.js",
        "modules/emergency-view.js",
        "worker/README.md",
        "worker/src/events-do.js",
        "worker/src/index.js",
        "worker/src/logic.js",
        "worker/test/http.test.ts",
        "worker/test/logic.test.mjs"
      ],
      "omittedCount": 0
    },
    {
      "sha": "d0deb32c607d8565e8813b5a4bb0c01b24ad6efc",
      "subject": "feat(cosmic): 緊急事件歷史紀錄 ＋ 不揭露回報來源 ＋ 預設伺服器修正",
      "files": [
        "AGENTS.md",
        "CHANGELOG.md",
        "css/style.css",
        "index.html",
        "modules/app.js",
        "modules/emergency-api.js",
        "modules/emergency-history.js",
        "modules/emergency-notify.js",
        "modules/emergency-view.js",
        "worker/README.md",
        "worker/src/events-do.js",
        "worker/src/index.js",
        "worker/src/logic.js",
        "worker/test/http.test.ts"
      ],
      "omittedCount": 0
    },
    {
      "sha": "ef7aee123157b617f11d691265cbd9df8d83e9b7",
      "subject": "fix(cosmic): 第 2 輪外審 triage — 插件重複通報統一回 409、補 6 個整合測試",
      "files": [
        "AGENTS.md",
        "docs/plans/2026-08-02-emergency-report-plan.md",
        "docs/plans/2026-08-02-emergency-report-plan.reviews.md",
        "docs/specs/2026-08-02-emergency-report-design.md",
        "worker/README.md",
        "worker/src/index.js",
        "worker/test/http.test.ts"
      ],
      "omittedCount": 0
    },
    {
      "sha": "06e629f370577e6a86e0011666fdae2eca1cc9e3",
      "subject": "fix(cosmic): 緊急任務誤稱修正 ＋ 鐵則與部署面更新",
      "files": [
        "AGENTS.md",
        "CHANGELOG.md",
        "deploy-deny.txt",
        "docs/BACKLOG.md",
        "docs/specs/2026-07-31-cosmic-site-design.md",
        "modules/forecast-view.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "e3953c71c785c5f924d75855a90115646db335f1",
      "subject": "feat(cosmic): 緊急事件分頁 — 現況、通報、附議與訂閱通知",
      "files": [
        "_headers",
        "css/style.css",
        "index.html",
        "modules/app.js",
        "modules/emergency-api.js",
        "modules/emergency-notify.js",
        "modules/emergency-view.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "8f5f7d7a8823f2ca8f1f317d055cad692bcc4696",
      "subject": "feat(cosmic): 緊急事件通報後端 — worker DO、路由與測試",
      "files": [
        ".gitignore",
        "worker/README.md",
        "worker/package.json",
        "worker/pnpm-lock.yaml",
        "worker/src/events-do.js",
        "worker/src/index.js",
        "worker/src/logic.js",
        "worker/test/http.test.ts",
        "worker/test/logic.test.mjs",
        "worker/vitest.config.ts",
        "worker/wrangler.toml"
      ],
      "omittedCount": 0
    }
  ],
  "outputsFile": "docs/plans/2026-08-02-emergency-report-plan.reviews.md",
  "reviewers": [
    {
      "cli": "codex",
      "model": "gpt-5.6-sol",
      "argv": [
        "codex.EXE",
        "exec",
        "-m",
        "gpt-5.6-sol",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "project_doc_max_bytes=0",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--cd",
        "<tmp>"
      ],
      "startedAt": "2026-08-02T20:06:58.708Z",
      "finishedAt": "2026-08-02T20:10:44.315Z",
      "exitCode": 0,
      "outputBytes": 5495,
      "outputSha256": "2e9170931d77f25a9a5ae8028a2410f6b5f771935d5827eab6677ead04fc148e"
    }
  ]
}
-->


| # | CLI/模型 | 開始 (UTC) | 耗時 | exit | 輸出 bytes | sha256 |
|---|---|---|---|---|---|---|
| 1 | codex/gpt-5.6-sol | 2026-08-02T20:06:58.708Z | 226s | 0 | 5495 | `2e9170931d77…` |

命令逐字：
```text
codex: codex.EXE exec -m gpt-5.6-sol -c model_reasoning_effort=high -c project_doc_max_bytes=0 --skip-git-repo-check --sandbox read-only --cd <tmp>
```

- 1. codex 原文見 `docs/plans/2026-08-02-emergency-report-plan.reviews.md` §7ccc8b220224-1（sha256:2e9170931d77…）
<!-- external-gate:end -->

### triage 結論（後閘，2026-08-03）

> **受審區間刻意設得比本 cycle 大**（`8f5f7d7^..HEAD`，23 筆）——因此有數條 finding 是
> 「區間選擇」的產物而非實作缺陷。已分開標示，不混為一談。
> 標 ✅ 的都**實際讀過對應程式碼確認**，不是照單全收。

| # | finding | 判定 | 理由 |
|---|---|---|---|
| 1 | 【致命】實作偏離核准 spec（延遲推播／保留 90 天／lead −19～5／warn·history·withdraw 等未列介面）| ❌ 駁回定性＋✅ 採納流程債 | 這些全部是 cycle 收官**之後** Owner 逐項下的新需求，各自有 commit 與理由。駁回「偏離 spec」的定性；採納「後續需求沒補 spec 就掛在同一個 cycle 底下」——那是真的流程債。 |
| 2 | 【致命】ICE 插件路徑不在受審區間，Task 5 無法核實 | ✅ 採納（已知） | 事實正確：`XIVpluginsDev/ICE-Dev` 是獨立 repo（monorepo gitignored fork），本 repo 的 diff 看不到它。遊戲內實測本來就還沒做，本檔一直寫著未驗。確認「後閘無法替它背書」。 |
| 3 | 【嚴重】混入計畫外變更，違反「本 cycle 不碰 `data/*.json`」| ❌ 駁回後半 | `da5aab2` 動 `data/*.json` 是 Owner 裁定的伺服器順序，且**是跑 `tools/cosmic-dump` 產生的**——AGENTS §1 要求的正是「由產生器產生、不手改」，沒有違反。UI／排序／效能那批確實計畫外，同 #1。 |
| 4 | 【嚴重】插件證實既有手動事件時沒有校正時間 | ✅ 採納（已驗證） | 讀 `events-do.js#report()` 確認：既有事件分支只改 `source` 並呼叫 `_notifyNow()`，`startAt`／`endAt`／`startExact` 全部保留手動估值。插件的時間才是精確的 ⇒ 白白丟掉唯一可信的時間來源。 |
| 5 | 【嚴重】通報者可替自己的事件附議，永久繞過否認門檻 | ✅ 採納（已驗證） | 讀 `logic.js#applyVote()` 確認未排除 `ev.reporter`。本人一 confirm，`confirms.size === 0` 永遠不成立 ⇒ 該筆**再也不可能被 3 個否認下架**。反惡意機制的直接繞道。 |
| 6 | 【嚴重】warn 通知誤報「進行中」，真正開始時反而不通知 | ✅ 採納（已驗證） | 兩半都成立：`emergency-notify.js` 的 `fired` 以 **event id** 去重，而 warn→start 刻意沿用同一 id ⇒ start 被擋掉；且 warn 時 `startAt === 0`，`ev.startAt > now` 為 false ⇒ 走「進行中」文案。預告被說成進行中，真開始時靜默。 |
| 7 | 【嚴重】插件 payload 驗證把格式錯誤靜默當成合法 start | ✅ 採納（已驗證） | `logic.js` 是 `['end','warn'].includes(body.phase) ? body.phase : 'start'` ⇒ 缺 phase、拼錯（`strat`）全部變成高可信度的 start。**靜默地把錯誤升級成最可信的來源**，正是本 repo 反覆吃虧的形狀。 |
| 8 | 【一般】重複 `/report` 形成的附議不觸發提前推播 | ✅ 採納（低） | 屬實但影響小：最多讓通知晚 30 秒。與 #5 一起改比較省事（都要動 `report()` 的 existing 分支）。 |
| 9 | 【一般】`events-do.js` 602 行、`http.test.ts` 690 行超過 500 行門檻 | ✅ 採納 | 屬實。AGENTS 檔案大小鐵則：新檔 >500 行禁止，這兩支是本 cycle 新建的，當時就該拆。拆分方案要先列「職責 → 檔名」給 Owner 拍板。 |
| 10 | 【一般】token 用 `!==` 比較，非 constant-time | ❓ 待釐清 | 屬實，但威脅模型要先講清楚：CF 邊緣前置、token 長度固定、比較在 worker 內。可利用性極低，修起來也便宜。不急。 |
| 11 | 【一般】Task 3／4 的瀏覽器驗收只有勾選、沒有可執行測試 | ✅ 採納 | 屬實，而且 #6 正好是「全綠測試抓不到」的實例——那是最有說服力的證據。前端零自動化測試是真缺口。 |

**動作**（不在本 cycle 內做，各自開條目）：

- `B-019` 修 #4 #5 #6 #7 #8 —— 前四個是線上服務的正確性缺陷，優先。
- `B-020` 拆 `events-do.js` 與 `http.test.ts`（#9）。
- `B-021` 前端自動化測試（#11），把 #6 當第一個回歸案例。
- `B-022` token constant-time 比較（#10）。
- **流程債（#1）**：8/2 收官後的需求（靜置期、提前結束、lead 上限、UI 批次、lastEnded、
  通知彈窗）應補一份接續 cycle 的 spec／plan，不再掛本 cycle。本檔維持 `done` 不動。
