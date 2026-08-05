---
status: approved
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

- [ ] **Step 1: 加 `SITE_ORIGIN` 與 `eventUrl()`**

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

- [ ] **Step 2: `discordPayload()` 改輸出 Container**（spec §3.2 逐欄照抄）

  兩個分支（預告 `!ev.startAt` / 進行中）**共用同一個按鈕列**（D4 Owner 修正），差別只有文案與 `accent_color`：
  - 進行中：`accent_color: 0x00b5d8`（46552）、標題 `⚡ {world}　緊急事件{進行中|預告}`、內文 `**{when}**，持續約 20 分鐘。`
  - 預告：`accent_color: 0xb58900`（11886848）、標題 `⚡ {world}　緊急事件預告`、內文 `遊戲內已出現預兆通告，**再過幾分鐘就會開始**。`
  - 第三行一律 `-# ` 開頭的 subtext（進行中＝`依回報顯示，實際以遊戲內為準`；預告＝`實際開始時會再通知一次`）
  - 按鈕列：`看事件`（無 emoji）／`✅ 我也看到了`／`🚫 查無此事`，全部 `style: 5`、**無 `custom_id`**
  - 訊息層 `flags: 32768`、**不得有 `embeds`／`content`**

  ⚠️ 既有的「不揭露 `source`」鐵則不變；`when` 的計算邏輯（`mins`／`已經開始`）原封不動搬過去，**不順手改文案**。

- [ ] **Step 3: 新增 `legacyEmbedPayload(ev, now)`**

  退回路徑（spec §3.3）。形狀＝原本的純 embed ＋ `embed.url` ＋ description 末尾三段 markdown 連結：
  `[看事件](…)　·　[✅ 我也看到了](…)　·　[🚫 查無此事](…)`。
  **URL 一律呼叫 `eventUrl()`**，不得另行拼字串——兩份 payload 的連結必須同源，否則退回版會悄悄指到錯的地方。

- [ ] **Step 4: 測試（`worker/test/logic.test.mjs`，純函式層 +6）**

  1. 三顆按鈕的 `url` 都含正確 `ev.id`，且 confirm／dispute **不相同**。
  2. 全部 URL 以 `https://cosmic.xivtc.com/` 開頭，**不出現 `pages.dev`**。
  3. Container 三個硬條件：`flags === 32768`、**無 `embeds`／`content` 欄位**、`components[0].type === 17`。
  4. 按鈕形狀：`style === 5` 且有 `url` 且 **無 `custom_id`**（帶了就 400，錯誤訊息 `{"components":["0"]}` 不會指出原因）。
  5. **預告與進行中的按鈕列逐顆 url 相同**（只有文案／`accent_color` 不同）——不是只比數量。
  6. `legacyEmbedPayload()` 同樣含三條投票連結，且**與 `discordPayload()` 的 url 逐條相等**。

- [ ] **Step 5: 驗證**

  ```bash
  cd worker && pnpm test:logic        # 27 → 33，全綠
  ```
  **恆綠自我驗證**（本 repo 慣例）：把 `dispute` 的 `eventUrl` 參數改成 `confirm` → 斷言 1 必須轉紅並指名；還原即綠。

- [ ] **Step 6: Commit** — `feat(worker): 緊急事件通知改 Components V2 Container ＋ 深連結（B-024 Task 1）`

---

### Task 2: fan-out —— 帶 `?with_components=true` ＋ 400 一次退回

**Files:**
- Modify: `worker/src/events-do.js`（`_fanout` / `_send`）
- Modify: `worker/test/http.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `discordPayload()` / `legacyEmbedPayload()`
- Produces: `fanout_v2_reject` stats 分桶

**Blocked by:** Task 1（消費它的兩支 payload 函式）

- [ ] **Step 1: `_fanout` 準備兩份 payload**

  ```js
  const payload = JSON.stringify(L.discordPayload(ev, now));
  const legacy  = JSON.stringify(L.legacyEmbedPayload(ev, now));
  … this._send(t, payload, legacy)
  ```

- [ ] **Step 2: `_send` 打帶 query 的網址**

  `fetch(target.webhookUrl + '?with_components=true', …)`。
  ⚠️ **這個 query 是必要的**：probe 2 實測不帶就整組 components 被**靜默忽略**——訊息照樣 204 送出，但按鈕全部消失、零錯誤訊號。
  ⚠️ query 不影響 `isAllowedWebhook()`（它只比對 hostname），SSRF 防線不變；且**白名單驗的仍是原始 `target.webhookUrl`**，不要改成驗拼接後的字串。

- [ ] **Step 3: 400 退回重送一次**

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

- [ ] **Step 4: 測試（`worker/test/http.test.ts`，整合層 +4）**

  沿用既有 `stubDiscord(status)`：
  1. 正常路徑：`stubDiscord(204)` → 收到的 `url` **含 `with_components=true`**、body 有 `flags: 32768`。
  2. 退回路徑：`stubDiscord(400)` → **收到兩次呼叫**；第二次 body **有 `embeds`、無 `components`**，且 url **不含** query。
  3. 退回成功後 **`failCount` 未增、`broken` 未觸發**（讀 DO 的 subs 列斷言）——否則 Discord 一改政策，全體訂閱者會被誤標成 webhook 壞掉。
  4. 非 400 的失敗（如 500）**不退回**、照舊計 `failCount`（退回只針對「payload 被拒」這一種原因）。

  > `stubDiscord` 目前只吃單一 status；需要「第一次 400、第二次 204」的話，Build 時擴充成可傳序列（`stubDiscord([400, 204])`），**保持既有單參數呼叫相容**。

- [ ] **Step 5: 驗證**

  ```bash
  cd worker && pnpm test              # 56 → 60，全綠
  pnpm cf:deploy:dry                 # 0 error
  ```
  **恆綠自我驗證**：把 `res.status === 400` 改成 `=== 999` → 斷言 2 必須轉紅；還原即綠。

- [ ] **Step 6: Commit** — `feat(worker): fan-out 帶 with_components ＋ V2 被拒時退回 embed（B-024 Task 2）`

- [ ] **Step 7: STOP — 由 Owner 執行 `pnpm cf:deploy`**（worker 與 Pages 部署脫鉤，不 deploy 則線上仍是舊 payload）

---

### Task 3: 前端深連結收端 —— `?ev` / `?vote`

**Files:**
- Modify: `modules/emergency-view.js`
- Modify: `css/style.css`

**Interfaces:**
- Consumes: Task 1 產生的 URL 形狀 `?ev=<id>[&vote=confirm|dispute]#emergency`
- Produces: 無（終端消費者）

**Blocked by:** 無（可與 Task 1／2 平行；URL 形狀已由 spec §D3 固定）

- [ ] **Step 1: 開場讀參數並記進狀態（不是直接動 DOM）**

  ```js
  // 深連結意圖存成狀態，不是一次性 DOM 操作：render() 每秒重建列，
  // 一次性高亮會在下一次 render 就被抹掉。
  let deepLink = null;   // { evId, vote } | null
  ```
  來源＝`new URLSearchParams(location.search)`；`ev` 必須是**正整數**（`/^\d+$/`），`vote` 只認 `confirm`／`dispute`，其餘一律忽略。
  讀完立刻 `history.replaceState` 清掉 `?ev`／`?vote`（保留其他參數與 hash）——避免使用者重整時又跳一次確認列。

- [ ] **Step 2: 事件列加 `data-ev-id` 並套高亮**

  `renderRow()` 建立 `li` 時 `li.dataset.evId = ev.id`；`render()` 尾端依 `deepLink.evId` 找到該列加 `.cos-em__hl` class 並 `scrollIntoView({ block: 'center' })`（只在**第一次**找到時捲，之後只維持 class——每秒重捲會把使用者鎖在原地）。

- [ ] **Step 3: 確認列**

  在事件列表上方插入 `#em-deeplink`（`hidden` 由 class 控制，⚠️ 本 repo 踩過 `[hidden]` 被 `display:flex` 蓋掉，見 portal `_DESIGN-SYSTEM`）：

  ```
  要對「伊弗利特 · 約 12 分鐘後開始」附議嗎？   [確認附議] [取消]
  ```
  - 文案依 `deepLink.vote` 切換（附議／否認），否認用 `codex-btn--danger`（與站上 `voteBtn()` 一致）。
  - 「確認」呼叫**既有的 `vote(evId, kind)`**，不另寫送出邏輯；送完 `deepLink = null` 收起。
  - 「取消」只清 `deepLink`，不投票。
  - 找不到該事件（已結束／已下架／id 不存在）→ 顯示「這則通報已經結束了」並在 5 秒後自動收起，**不白屏、不報錯**。

- [ ] **Step 4: CSS**

  `.cos-em__hl`：一圈短暫外框（用既有 token，例如 `outline: 2px solid var(--color-accent)` + 淡背景），2 秒後靠 class 移除或直接維持到確認列關閉。確認列本身用 `.codex-*` 既有元件，不自造 panel。

- [ ] **Step 5: 驗證（本 repo 前端零自動化測試，B-021 已列管）**

  手動逐條（本機 svc dev server，改 JS 後**必硬重載**）：
  1. `?ev=<進行中事件id>&vote=confirm#emergency` → 落在緊急分頁、該列高亮、確認列文案為「附議」。
  2. 按「確認附議」→ 票數 +1、確認列收起、網址已無 `?ev`。
  3. `&vote=dispute` → 確認列是否認樣式（danger）。
  4. `?ev=999999`（不存在）→ 顯示「已結束」、不白屏。
  5. `?ev=abc`／`?vote=hack` → 完全忽略，畫面如常。
  6. 手機 Discord app 內建瀏覽器點按鈕 → hash + query 併用時分頁切換正常（**最可能出問題的路徑**）。

  把第 1、4 條寫進 B-021 條目當第一批自動化案例（不在本輪實作測試框架）。

- [ ] **Step 6: Commit** — `feat(cosmic): Discord 通知按鈕的深連結收端 ＋ 就地確認投票（B-024 Task 3）`

---

### Task 4: Record

**Files:**
- Modify: `CHANGELOG.md`、`docs/BACKLOG.md`、`docs/specs/…-design.md`、本檔

**Blocked by:** Task 1、2、3

- [ ] **Step 1: CHANGELOG 一則**（使用者看得到的變化：通知可直接點進事件並附議）
- [ ] **Step 2: BACKLOG B-024 打勾**，尾巴追加實測結論（含「探測六發的結果」與「⧉ 無法移除」兩條，免得日後重跑）
- [ ] **Step 3: spec 與本檔 front-matter 同翻 `done`**
- [ ] **Step 4: AGENTS.md 測試基線更新**（27→33 純函式、56→60 整合）
- [ ] **Step 5: Commit** — `docs(B-024): Record — 通知深連結上線`
