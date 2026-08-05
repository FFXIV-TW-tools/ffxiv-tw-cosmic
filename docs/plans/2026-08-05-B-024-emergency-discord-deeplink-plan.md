---
status: implementing
type: feature
cycle: 2026-08-05-B-024-emergency-discord-deeplink
date: 2026-08-05
---

# 緊急事件 Discord 通知：補網址 ＋ 附議／否認按鈕 Implementation Plan

> 執行風險：中

**Goal:** Discord 通知改成 Components V2 Container（標題連結 ＋ 三顆 link button），點按鈕落在該事件並就地確認投票；Discord 若拒收 V2 則自動退回純 embed 版，通知不中斷。

**Global Constraints:**
- 樣本已由 Owner 真機驗收（`~/_claude_scratch/discord-probe/final.sh` 送出的兩則），**實作輸出必須與該樣本逐欄一致**——文案、emoji、順序、`accent_color` 都照它。
- 測試基線**只准升不准降**：worker `pnpm test` 56 整合 ＋ `pnpm test:logic` 27 純函式（AGENTS.md:142）。
- canonicalTest：`node tools/validate.mjs && node tests/run-all.mjs && cd worker && pnpm test`。
- **測試絕不打真 Discord**——沿用 `worker/test/http.test.ts` 既有的 `stubDiscord(status)`（`vi.stubGlobal('fetch', …)`）。
- worker 改動要 deploy 才生效：`pnpm cf:deploy:dry`（0 error）→ **STOP**，`pnpm cf:deploy` 由 Owner 執行。
- commit 顆粒度按主題；commit 前先知會 Owner（本 repo Git 慣例）。

---

### Task 1: worker payload —— Container 形狀 ＋ 退回版本（純函式層）

**Files:**
- Modify: `worker/src/logic.js`
- Modify: `worker/test/logic.test.mjs`

**Interfaces:**
- Produces: `SITE_ORIGIN`、`eventUrl(id, vote?)`、`discordPayload(ev, now)`（改輸出 Container）、`legacyEmbedPayload(ev, now)`（新增，退回用）

**Blocked by:** 無

- [x] **Step 1: 加 `SITE_ORIGIN` 與 `eventUrl()`**

  ```js
  /** 站台自訂網域。**不用 pages.dev**：舊網址會被交接頁轉走，多繞一跳。 */
  const SITE_ORIGIN = 'https://cosmic.xivtc.com';

  /**
   * 事件深連結。`vote` 給了就帶投票意圖（收端不會自動送出，只展開確認列）。
   * 參數只吃整數 id ⇒ 輸出長度有界、無使用者輸入拼接、markdown 連結不會被 `)` 提前關閉。
   */
  export function eventUrl(id, vote) {
    const q = vote ? `?ev=${id}&vote=${vote}` : `?ev=${id}`;
    return `${SITE_ORIGIN}/${q}#emergency`;
  }
  ```

- [x] **Step 2: `discordPayload()` 改輸出 Container**（spec §3.2 逐欄照抄）

  兩個分支（預告 `!ev.startAt` / 進行中）**共用同一個按鈕列**（D4 Owner 修正），差別只有文案與 `accent_color`：
  - 進行中：`accent_color: 0x00b5d8`（＝46552）、標題 `⚡ {world}　緊急事件{進行中|預告}`、內文 `**{when}**，持續約 20 分鐘。`
  - 預告：`accent_color: 0xb58900`（＝11897088；⚠️ 樣本腳本誤用 11886848＝`0xb56100`，實作以既有 embed 色 `0xb58900` 為準）、標題 `⚡ {world}　緊急事件預告`、內文 `遊戲內已出現預兆通告，**再過幾分鐘就會開始**。`
  - 第三行一律 `-# ` 開頭的 subtext（進行中＝`依回報顯示，實際以遊戲內為準`；預告＝`實際開始時會再通知一次`）
  - 按鈕列：`看事件`（無 emoji）／`✅ 我也看到了`／`🚫 查無此事`，全部 `style: 5`、**無 `custom_id`**
  - 訊息層 `flags: 32768`、**不得有 `embeds`／`content`**

  ⚠️ 既有的「不揭露 `source`」鐵則不變；`when` 的計算邏輯（`mins`／`已經開始`）原封不動搬過去，**不順手改文案**。

- [x] **Step 3: 新增 `legacyEmbedPayload(ev, now)`**

  退回路徑（spec §3.3）。形狀＝原本的純 embed ＋ `embed.url` ＋ description 末尾三段 markdown 連結：
  `[看事件](…)　·　[✅ 我也看到了](…)　·　[🚫 查無此事](…)`。
  **URL 一律呼叫 `eventUrl()`**，不得另行拼字串——兩份 payload 的連結必須同源，否則退回版會悄悄指到錯的地方。

- [x] **Step 4: 測試（`worker/test/logic.test.mjs`，純函式層 +6）**

  1. 三顆按鈕的 `url` 都含正確 `ev.id`，且 confirm／dispute **不相同**。
  2. 全部 URL 以 `https://cosmic.xivtc.com/` 開頭，**不出現 `pages.dev`**。
  3. Container 三個硬條件：`flags === 32768`、**無 `embeds`／`content` 欄位**、`components[0].type === 17`。
  4. 按鈕形狀：`style === 5` 且有 `url` 且 **無 `custom_id`**（帶了就 400，錯誤訊息 `{"components":["0"]}` 不會指出原因）。
  5. **預告與進行中的按鈕列逐顆 url 相同**（只有文案／`accent_color` 不同）——不是只比數量。
  6. `legacyEmbedPayload()` 同樣含三條投票連結，且**與 `discordPayload()` 的 url 逐條相等**。

- [x] **Step 5: 驗證**

  ```bash
  cd worker && pnpm test:logic        # 27 → 33，全綠
  ```
  **恆綠自我驗證**（本 repo 慣例）：把 `dispute` 的 `eventUrl` 參數改成 `confirm` → 斷言 1 必須轉紅並指名；還原即綠。

- [x] **Step 6: Commit** — `feat(worker): 緊急事件通知改 Components V2 Container ＋ 深連結（B-024 Task 1）`

---

### Task 2: fan-out —— 帶 `?with_components=true` ＋ 400 一次退回

**Files:**
- Modify: `worker/src/events-do.js`（`_fanout` / `_send`）
- Modify: `worker/test/http.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `discordPayload()` / `legacyEmbedPayload()`
- Produces: `fanout_v2_reject` stats 分桶

**Blocked by:** Task 1（消費它的兩支 payload 函式）

- [x] **Step 1: `_fanout` 準備兩份 payload**

  ```js
  const payload = JSON.stringify(L.discordPayload(ev, now));
  const legacy  = JSON.stringify(L.legacyEmbedPayload(ev, now));
  … this._send(t, payload, legacy)
  ```

- [x] **Step 2: `_send` 打帶 query 的網址**

  `fetch(target.webhookUrl + '?with_components=true', …)`。
  ⚠️ **這個 query 是必要的**：probe 2 實測不帶就整組 components 被**靜默忽略**——訊息照樣 204 送出，但按鈕全部消失、零錯誤訊號。
  ⚠️ query 不影響 `isAllowedWebhook()`（它只比對 hostname），SSRF 防線不變；且**白名單驗的仍是原始 `target.webhookUrl`**，不要改成驗拼接後的字串。

- [x] **Step 3: 400 退回重送一次**

  ```js
  if (res.ok) { …清 failCount…; return; }
  if (res.status === 400 && legacy) {
    // Components V2 對非 app webhook 沒有官方保證（我們是靠實測知道可行的）。
    // Discord 哪天收緊 ⇒ 這裡會連續 400 ⇒ 熔斷 ⇒ 使用者被告知「你的 webhook 壞了」，
    // 而它根本沒壞。退回純 embed：**版面退化，通知不中斷**。
    this._bump('fanout_v2_reject');
    const res2 = await fetch(target.webhookUrl, { …, body: legacy, signal: ctrl.signal });
    if (res2.ok) { this.sql.exec('UPDATE subs SET failCount = 0 WHERE uuid = ?', target.uuid); return; }
  }
  this._fail(target);
  ```
  **只退一次、不做指數重試**——400 是確定性拒絕，重送同一份 payload 沒有意義（且既有註解已言明本路徑刻意不重試，不要在這裡開例外）。
  退回時**不帶** `?with_components=true`（legacy 沒有 components，帶了無意義）。

- [x] **Step 4: 測試（`worker/test/http.test.ts`，整合層 +4）**

  沿用既有 `stubDiscord(status)`：
  1. 正常路徑：`stubDiscord(204)` → 收到的 `url` **含 `with_components=true`**、body 有 `flags: 32768`。
  2. 退回路徑：`stubDiscord(400)` → **收到兩次呼叫**；第二次 body **有 `embeds`、無 `components`**，且 url **不含** query。
  3. 退回成功後 **`failCount` 未增、`broken` 未觸發**（讀 DO 的 subs 列斷言）——否則 Discord 一改政策，全體訂閱者會被誤標成 webhook 壞掉。
  4. 非 400 的失敗（如 500）**不退回**、照舊計 `failCount`（退回只針對「payload 被拒」這一種原因）。

  > `stubDiscord` 目前只吃單一 status；需要「第一次 400、第二次 204」的話，Build 時擴充成可傳序列（`stubDiscord([400, 204])`），**保持既有單參數呼叫相容**。

- [x] **Step 5: 驗證**

  ```bash
  cd worker && pnpm test              # 56 → 59，全綠
  pnpm cf:deploy:dry                 # 0 error
  ```
  **恆綠自我驗證**：把 `res.status === 400` 改成 `=== 999` → 斷言 2 必須轉紅；還原即綠。

- [x] **Step 6: Commit** — `feat(worker): fan-out 帶 with_components ＋ V2 被拒時退回 embed（B-024 Task 2）`

- [x] **Step 7: STOP — 由 Owner 執行 `pnpm cf:deploy`**（worker 與 Pages 部署脫鉤，不 deploy 則線上仍是舊 payload）

---

### Task 3: 前端深連結收端 —— `?ev` / `?vote`

**Files:**
- Modify: `modules/emergency-view.js`
- Modify: `css/style.css`

**Interfaces:**
- Consumes: Task 1 產生的 URL 形狀 `?ev=<id>[&vote=confirm|dispute]#emergency`
- Produces: 無（終端消費者）

**Blocked by:** 無（可與 Task 1／2 平行；URL 形狀已由 spec §D3 固定）

- [x] **Step 1: 開場讀參數並記進狀態（不是直接動 DOM）**

  ```js
  // 深連結意圖存成狀態，不是一次性 DOM 操作：render() 每秒重建列，
  // 一次性高亮會在下一次 render 就被抹掉。
  let deepLink = null;   // { evId, vote } | null
  ```
  來源＝`new URLSearchParams(location.search)`；`ev` 必須是**正整數**（`/^\d+$/`），`vote` 只認 `confirm`／`dispute`，其餘一律忽略。
  讀完立刻 `history.replaceState` 清掉 `?ev`／`?vote`（保留其他參數與 hash）——避免使用者重整時又跳一次確認列。

- [x] **Step 2: 事件列加 `data-ev-id` 並套高亮**

  `renderRow()` 建立 `li` 時 `li.dataset.evId = ev.id`；`render()` 尾端依 `deepLink.evId` 找到該列加 `.cos-em__hl` class 並 `scrollIntoView({ block: 'center' })`（只在**第一次**找到時捲，之後只維持 class——每秒重捲會把使用者鎖在原地）。

- [x] **Step 3: 確認列**

  在事件列表上方插入 `#em-deeplink`（`hidden` 由 class 控制，⚠️ 本 repo 踩過 `[hidden]` 被 `display:flex` 蓋掉，見 portal `_DESIGN-SYSTEM`）：

  ```
  要對「伊弗利特 · 約 12 分鐘後開始」附議嗎？   [確認附議] [取消]
  ```
  - 文案依 `deepLink.vote` 切換（附議／否認），否認用 `codex-btn--danger`（與站上 `voteBtn()` 一致）。
  - 「確認」呼叫**既有的 `vote(evId, kind)`**，不另寫送出邏輯；送完 `deepLink = null` 收起。
  - 「取消」只清 `deepLink`，不投票。
  - 找不到該事件（已結束／已下架／id 不存在）→ 顯示「這則通報已經結束了」並在 5 秒後自動收起，**不白屏、不報錯**。

- [x] **Step 4: CSS**

  `.cos-em__hl`：一圈短暫外框（用既有 token，例如 `outline: 2px solid var(--color-accent)` + 淡背景），2 秒後靠 class 移除或直接維持到確認列關閉。確認列本身用 `.codex-*` 既有元件，不自造 panel。

- [~] **Step 5: 驗證（本 repo 前端零自動化測試，B-021 已列管）** — 桌面五條已實測；**手機 Discord 內建瀏覽器那條未做**（外審 post 閘 ①）

  手動逐條（本機 svc dev server，改 JS 後**必硬重載**）：
  1. `?ev=<進行中事件id>&vote=confirm#emergency` → 落在緊急分頁、該列高亮、確認列文案為「附議」。
  2. 按「確認附議」→ 票數 +1、確認列收起、網址已無 `?ev`。
  3. `&vote=dispute` → 確認列是否認樣式（danger）。
  4. `?ev=999999`（不存在）→ 顯示「已結束」、不白屏。
  5. `?ev=abc`／`?vote=hack` → 完全忽略，畫面如常。
  6. 手機 Discord app 內建瀏覽器點按鈕 → hash + query 併用時分頁切換正常（**最可能出問題的路徑**）。

  把第 1、4 條寫進 B-021 條目當第一批自動化案例（不在本輪實作測試框架）。

- [x] **Step 6: Commit** — `feat(cosmic): Discord 通知按鈕的深連結收端 ＋ 就地確認投票（B-024 Task 3）`

---

### Task 4: Record

**Files:**
- Modify: `CHANGELOG.md`、`docs/BACKLOG.md`、`docs/specs/…-design.md`、本檔

**Blocked by:** Task 1、2、3

- [x] **Step 1: CHANGELOG 一則**（使用者看得到的變化：通知可直接點進事件並附議）
- [x] **Step 2: BACKLOG B-024 打勾**，尾巴追加實測結論（含「探測六發的結果」與「⧉ 無法移除」兩條，免得日後重跑）
- [~] **Step 3: spec 與本檔 front-matter 同翻 `done`** — **退回 `implementing`**：部署後驗收（手機 Container／正式站端到端）未完成，cycle 不收官
- [x] **Step 4: AGENTS.md 測試基線更新**（27→33 純函式、56→60 整合）
- [x] **Step 5: Commit** — `docs(B-024): Record — 通知深連結上線`

---

## 外審 triage（前閘）

<!-- external-gate:begin v=4 phase=pre cycle=2026-08-05-B-024-emergency-discord-deeplink fp=sha256:adcd9a3c42df71f6edf600b50c1d416d61e003f71bf53078f0e3aa4c9ec423c1 -->
<!-- external-gate:meta
{
  "v": 4,
  "phase": "pre",
  "cycle": "2026-08-05-B-024-emergency-discord-deeplink",
  "override": null,
  "overrideActual": null,
  "materialSha256": "e60d9ac8c7f6dd588f6ce54bc7d18bd4c93ee9528220c6c3c868fd16d90efdb9",
  "diffBase": null,
  "diffSha256": null,
  "specSha256": "6077122e30ee66d8361fa010355fa92c178ea3a7120a956933a9c43a922aacc5",
  "reviewedTree": "403fc737f1222bc150e16ead5824186e5fab27dc",
  "remediation": null,
  "round": null,
  "sourceFp": null,
  "baseSha": null,
  "reviewHeadSha": null,
  "rangeCommits": null,
  "outputsFile": "docs/plans/2026-08-05-B-024-emergency-discord-deeplink-plan.reviews.md",
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
      "startedAt": "2026-08-05T03:12:24.860Z",
      "finishedAt": "2026-08-05T03:15:05.464Z",
      "exitCode": 0,
      "outputBytes": 4550,
      "outputSha256": "951095a6e536891e598c892bcb3b0855956e98c68664a2858e2a8deb6e15f9cc"
    }
  ]
}
-->


| # | CLI/模型 | 開始 (UTC) | 耗時 | exit | 輸出 bytes | sha256 |
|---|---|---|---|---|---|---|
| 1 | codex/gpt-5.6-sol | 2026-08-05T03:12:24.860Z | 161s | 0 | 4550 | `951095a6e536…` |

命令逐字：
```text
codex: codex.EXE exec -m gpt-5.6-sol -c model_reasoning_effort=high -c project_doc_max_bytes=0 --skip-git-repo-check --sandbox read-only --cd <tmp>
```

- 1. codex 原文見 `docs/plans/2026-08-05-B-024-emergency-discord-deeplink-plan.reviews.md` §adcd9a3c42df-1（sha256:951095a6e536…）
<!-- external-gate:end -->

### triage 結論（執行者填，不由工具產生）

> ⚠️ **本輪前閘是 post-hoc 補跑的**：Build 已完成、四個 commit 已落地，才被 pre-commit gate 5（R9）擋下 Record commit 而發現漏跑。**這是流程缺失，記在這裡不掩飾**——外審看到的因此是全部勾選、`status: done` 的版本，finding ① 正是被這個狀態誤導的產物。下次執行風險中／高的 cycle，Gate 1 拍板後、動第一行 code 前就要跑。

- **① 【致命】plan 把未開始的工作標成已完成** — ❌ **駁回（前提不成立）**。外審被告知「實作尚未開始」，事實相反：勾選與 `status: done` 對應四個已落地的 commit（`4c0bbae`／`a6cf105`／`3beb3e1`／`403fc73`），不是預先勾選。**這條真正的價值在上面那段警語**：它精準指出「審的與做的不是同一個時間點」。

- **② 【嚴重】部署順序：worker 先上會讓按鈕指向沒有收端的正式站** — ✅ **採納**。前端與 worker 部署完全脫鉤（Pages 走 git push、worker 走 `wrangler deploy`）⇒ 先 deploy worker 的話，使用者點按鈕會落在**沒有 `?ev` 收端**的線上版：畫面不會壞，但確認列不出現、高亮沒有，等於按鈕沒作用**且無錯誤訊號**。交付順序已明定：先 push（Pages 自動部署）→ 線上 smoke test 深連結 → 再 deploy worker → 發一則測試通知驗三顆按鈕。

- **③ 【嚴重】資料未載入時把有效事件誤判為「已結束」** — ✅ **採納（Build 中已自行發現並修）**。`renderDeepLink()` 開頭有 `if (!state) return`。**殘留邊界**：曾成功載入、之後後端掛掉 ⇒ `state` 是舊快照，此時對「快照裡沒有的 id」仍會說已結束。判斷為**可接受**——那代表它在我們最後一次看到世界時就不存在，且狀態列本身會顯示連線異常。記為已知邊界，不另做。

- **④ 【嚴重】確認列位置與捲動策略衝突** — ❌ **駁回（版面前提不同）**。本站事件列是**固定七列**（七個伺服器各一列，不會增長），整份表約 250px、與確認列同屏；瀏覽器實測截圖可證兩者同時在畫面內。外審假設的「目標事件在列表末段、確認列被捲出視窗」在七列固定版面下不會發生。日後若改成可增長列表，這條要重新評估。

- **⑤ 【嚴重】「與樣本逐欄一致」無可執行驗證，且 plan 內顏色值矛盾** — ✅ **採納（實測確認外審算對）**：`0xb58900` ＝ **11897088**，我在 plan 與測試樣本寫的 `11886848` 其實是 `0xb56100`。**實作是對的**（`logic.js` 用 `0xb58900`＝原本 embed 的既有色，符合「原封不動搬過去」），錯的是 plan 註記與 Owner 驗收過的那則樣本 ⇒ **Owner 看到的預告橘色與正式版差一點點**，已於交付說明告知。plan 註記已修正。至於整包 golden test：**刻意不加**——那會把每次文案微調變成假紅，維護成本高於它擋到的東西；現有六條覆蓋 url／flags／形狀／兩分支按鈕列一致性。

- **⑥ 【嚴重】退回路徑與第一發共用 AbortController／timer** — ✅ **採納，已修**。原寫法讓退回那一發繼承第一發燒掉的時間：第一發拖到 3.9 秒才回 400 時，退回只剩 0.1 秒就被 abort ⇒ **正好在最需要它的時候失效**，症狀還是「退回也失敗」，看不出是逾時被砍。改成 `postWebhook()` 每次呼叫自建 controller／timer。

- **⑦ 【一般】字串相接 `?with_components=true` 會破壞含 query 的 webhook URL** — ✅ **採納，已修**。查證 `isAllowedWebhook()` 只驗 scheme／hostname／長度，**沒有**「不得含 query」這條不變量 ⇒ 使用者貼進帶 `?` 的網址時第二個 `?` 讓參數解析不出來，退化成「204 但按鈕全部消失」的靜默失敗。改用 `new URL()` + `searchParams.set()`（`withComponents()`）。

- **⑧ 【一般】view-only 深連結的高亮沒有結束條件** — ❌ **駁回（有自然終止）**。`?ev` only 時保留 `deepLink` 是**刻意的**（狀態清掉就沒東西可標，「看事件」會變成點了什麼都沒發生）；高亮綁在 `[data-ev-id]` 上，事件結束後該列不再帶這個屬性 ⇒ 高亮自然消失。加計時器只會多一個會錯的條件。

- **⑨ 【一般】`fanout_v2_reject` 無斷言；canonicalTest 未含 `test:logic`** — ✅ **前半採納，已補**（退回案例讀 `GET /admin/stats` 斷言該桶 ≥ 1，並以移除 `_bump` 反證轉紅）。❌ **後半駁回**：`pnpm test` 的定義就是 `vitest run && node --test test/logic.test.mjs`（`worker/package.json`），純函式測試本來就在裡面。

---

## 外審 triage（後閘）

<!-- external-gate:begin v=4 phase=post cycle=2026-08-05-B-024-emergency-discord-deeplink fp=sha256:e2786580d1010e66297594c1753375aa443946bc75e080bbfcdd2ba49920256a -->
<!-- external-gate:meta
{
  "v": 4,
  "phase": "post",
  "cycle": "2026-08-05-B-024-emergency-discord-deeplink",
  "override": null,
  "overrideActual": null,
  "materialSha256": "7fc9679569019bf144e305a53b58db3325f99a89dd1bda3c3379696409c8386e",
  "diffBase": "bc5de49",
  "diffSha256": "8d9585cbbc837b09e17d41215120b35170387d9ac41c2174b17175ca08f9dd67",
  "specSha256": "6077122e30ee66d8361fa010355fa92c178ea3a7120a956933a9c43a922aacc5",
  "reviewedTree": "7fd4a297d667b697321516bd5023e14fcb5ec1bd",
  "remediation": null,
  "round": null,
  "sourceFp": null,
  "baseSha": "bc5de49d13747b59972f53618dd7da30d3e86471",
  "reviewHeadSha": "7fd4a297d667b697321516bd5023e14fcb5ec1bd",
  "rangeCommits": [
    {
      "sha": "7fd4a297d667b697321516bd5023e14fcb5ec1bd",
      "subject": "fix(worker): 退回路徑自帶逾時 ＋ URL 物件組 query ＋ Record（B-024 外審採納）",
      "files": [
        "AGENTS.md",
        "CHANGELOG.md",
        "docs/BACKLOG.md",
        "docs/plans/2026-08-05-B-024-emergency-discord-deeplink-plan.md",
        "docs/plans/2026-08-05-B-024-emergency-discord-deeplink-plan.reviews.md",
        "docs/specs/2026-08-05-B-024-emergency-discord-deeplink-design.md",
        "worker/src/events-do.js",
        "worker/test/http.test.ts"
      ],
      "omittedCount": 0
    },
    {
      "sha": "403fc737f1222bc150e16ead5824186e5fab27dc",
      "subject": "fix(cosmic): 確認列改用真的 token（--color-surface-raised 不存在，fallback 等於寫死色）",
      "files": [
        "css/style.css"
      ],
      "omittedCount": 0
    },
    {
      "sha": "3beb3e1efe6dcaa51c51db8ca49cc79529d1f91f",
      "subject": "feat(cosmic): Discord 通知按鈕的深連結收端 ＋ 就地確認投票（B-024 Task 3）",
      "files": [
        "css/style.css",
        "index.html",
        "modules/emergency-view.js"
      ],
      "omittedCount": 0
    },
    {
      "sha": "a6cf10560c82b4431b83f5ee2d98484810813afe",
      "subject": "feat(worker): fan-out 帶 with_components ＋ V2 被拒時退回 embed（B-024 Task 2）",
      "files": [
        "worker/src/events-do.js",
        "worker/test/http.test.ts"
      ],
      "omittedCount": 0
    },
    {
      "sha": "4c0bbae850d50f03a3bc2dccd0f73d8e52b7b9a0",
      "subject": "feat(worker): 緊急事件通知改 Components V2 Container ＋ 深連結（B-024 Task 1）",
      "files": [
        "worker/src/logic.js",
        "worker/test/logic.test.mjs"
      ],
      "omittedCount": 0
    }
  ],
  "outputsFile": "docs/plans/2026-08-05-B-024-emergency-discord-deeplink-plan.reviews.md",
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
      "startedAt": "2026-08-05T03:27:41.966Z",
      "finishedAt": "2026-08-05T03:31:24.832Z",
      "exitCode": 0,
      "outputBytes": 1826,
      "outputSha256": "5289c58f0f62664733ed4cd6f754a5be9f452ef1195ed58e57a5c5a0bfc635ec"
    }
  ]
}
-->


| # | CLI/模型 | 開始 (UTC) | 耗時 | exit | 輸出 bytes | sha256 |
|---|---|---|---|---|---|---|
| 1 | codex/gpt-5.6-sol | 2026-08-05T03:27:41.966Z | 223s | 0 | 1826 | `5289c58f0f62…` |

命令逐字：
```text
codex: codex.EXE exec -m gpt-5.6-sol -c model_reasoning_effort=high -c project_doc_max_bytes=0 --skip-git-repo-check --sandbox read-only --cd <tmp>
```

- 1. codex 原文見 `docs/plans/2026-08-05-B-024-emergency-discord-deeplink-plan.reviews.md` §e2786580d101-1（sha256:5289c58f0f62…）
<!-- external-gate:end -->

### triage 結論（執行者填，不由工具產生）

> **本輪為 post 第 2 輪**（第 1 輪的三處採納已隨 `7fd4a29` 落地，該輪 findings 因此不再出現在受審 diff 裡）。三條新 findings 全屬**機械可修**（加斷言／改狀態），非架構級 ⇒ 依 DEVLOOP 紅線 8（輪數停損）修正落稿後直接落地，**不開第 3 輪**。

- **① 【嚴重】驗收未完成卻把 cycle／Task 3 驗證／B-024 全標完成** — ✅ **採納，已回退**。這條對：`CHANGELOG` 與前一輪 triage **自己就寫著**「手機 Container 與正式站端到端尚未驗」，卻同時把 spec/plan 翻 `done`、BACKLOG 打勾——自相矛盾，而且勾起來之後沒有人會再回頭看。已改：spec/plan 退回 `status: implementing`；Task 3 Step 5 與 Task 4 Step 3 改標 `[~]` 並註明缺什麼；BACKLOG 的 B-024 取消勾選、改寫成「程式碼與桌面驗收完成，待部署後驗收」。**cycle 由 Owner 部署並驗過手機／端到端之後才收官。**

- **② 【一般】標題深連結沒有測試證明** — ✅ **採納，已補**。原六條只看 `buttonsOf()`，而標題是 embed 時代唯一的入口、現在最大的點擊目標，它壞掉不會有任何斷言轉紅。新增案例解析 Text Display 的 `### [文字](url)`，斷言 id／origin／`#emergency`，預告與進行中兩分支都測。純函式 33→**34**。

- **③ 【一般】含 query 的 webhook URL 沒有回歸案例** — ✅ **採納，已補**。`withComponents()` 雖已改用 `URL`，但測試只斷言「字串包含 `with_components=true`」⇒ **退回字串相接照樣全綠**，等於那個修正沒有守衛。新增整合案例：訂閱 `…?wait=true` 的 webhook，解析實際呼叫 URL 斷言兩個參數同時存在。整合 59→**60**。回流注入（改回字串相接）已驗證精確轉紅。
