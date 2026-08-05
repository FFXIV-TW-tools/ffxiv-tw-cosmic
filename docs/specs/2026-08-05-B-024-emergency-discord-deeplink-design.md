---
status: draft
type: feature
cycle: 2026-08-05-B-024-emergency-discord-deeplink
date: 2026-08-05
---

# 緊急事件 Discord 通知：補網址 ＋ 附議／否認按鈕 設計

> 執行風險：中
> 狀態流轉：draft →(Gate 1 Owner 拍板)→ approved → implementing → done

## 1. 背景與目標

Owner 2026-08-05：「cosmic 的緊急事件通知 麻煩在 Discord 通知上面 補上網址 然後看能不能直接補兩個按鈕 是跟 cosmic 頁面一樣的 覆議跟否認」

現況 `worker/src/logic.js:409 discordPayload()` 只送一個 embed（標題＋一句倒數），**沒有任何連結**：收到通知的人想確認、想附議、想看還剩幾分鐘，都得自己找書籤回站上、切到緊急事件分頁、找到那張卡。而**附議正是這個功能的社交層命脈**——通報可信度靠附議，下架靠否認（`logic.js:361 applyVote`、`DISPUTE_THRESHOLD`）。通知裡不給入口，等於把最可能出手的那群人（正在看 Discord、人在遊戲裡的那些）擋在流程外。

**目標**：Discord 通知裡直接給 ① 事件頁連結 ② 附議 ③ 否認 三個入口，點下去落在正確的事件上。

## 2. 拍板決策

### D1：按鈕能不能做 —— 可以，但走 link button，且**必須先實測**

事實（Discord 官方文件，§6 勘查）：

- Execute Webhook 的 `components` 欄位註腳：「Application-owned webhooks can always send components. **Non-application-owned webhooks cannot send interactive components**, and the `components` field will be ignored unless they set the `with_components` query param.」
- 使用者在自己伺服器建立的 incoming webhook＝**non-application-owned**（我們沒有 bot 在對方伺服器裡）⇒ **帶 `custom_id` 的互動按鈕做不到**，而且就算送得出去，按下去的 interaction 也沒有任何端點收得到（要收 interaction 得有 Discord application + 公開 endpoint + 簽章驗證，那是另一個量級的東西）。
- 但 **link button（`style: 5` + `url`）不送 interaction**（官方：「Link buttons do not send an interaction to your app when clicked」）⇒ 屬非互動元件，理論上加上 `?with_components=true` 就送得出去。

**決策**：目標形態＝**兩顆 link button**（外觀就是 Discord 原生按鈕，最接近 Owner 要的「跟頁面一樣的按鈕」），但「非互動元件是否確實包含 link button」這句是**從兩段文件推導出來的，沒有實測**。所以：

> **Build 第一步是 60 秒探測**：拿 Owner 的測試 webhook `curl` 送一發帶 `components` 的 payload（`?with_components=true`），看 204 還是 400。結果決定走 A 或 B，**兩條都要能跑**：
>
> - **A（按鈕可用）**：`components` = 一個 Action Row + 三顆 link button（查看／附議／否認）。
> - **B（被忽略或 400）**：embed 的 `description` 末尾加一行 markdown 連結 `[✅ 我也看到了](…)　·　[🚫 查無此事](…)`，視覺上是三條藍字連結。
>
> payload builder 一律回傳 A 的形狀＋B 的 fallback 字串，**由一個常數切換**，不寫成「兩份 payload 函式」。

⚠️ **不因為想要按鈕就去申請 Discord application**：那要求使用者把我們的 bot 邀進他的伺服器，換來的只是按鈕樣式——與「一個連結就能完成的事」不成比例。

### D2：點下去**不自動投票**，落在事件卡並要求就地確認

否決「`?vote=confirm` 一載入就送出投票」，三個理由：

1. **GET 型副作用**：Discord 會為連結抓 preview、部分客戶端／防毒會預抓，都會變成幽靈票。
2. **誤點不可挽回**：手機上兩顆按鈕靠很近，而否認是有後果的（三個否認且無人附議＝下架，`applyVote` 的 `disputed` 是**單向**的，不因後來的附議回頭）。
3. **投票要 UUID**：新裝置點進來是全新 uuid，自動投票等於憑一個連結就製造一張匿名票；而人在畫面上按，至少是「他真的打開了那一頁」。

**收端行為**（`?ev=<id>&vote=confirm|dispute`）：

- 切到 `#emergency` 分頁（hash 已支援，`app.js:158 initialTab()`，且 emergency 本來就是 `tabIds[0]`）。
- 捲到該事件卡、加一圈短暫高亮。
- 卡片上方出現一條確認列：「要對『伊弗利特 · 約 12 分鐘後開始』**附議**嗎？ [確認附議] [取消]」——**按下才送**。
- 事件已結束／已下架／id 不存在 → 不白屏、不報錯，顯示「這則通報已經結束了」並清掉自己的 query 參數（沿用本站深連結慣例，`_NEW-TOOL.md` 深連結 checklist）。

### D3：三個入口都指向 `https://cosmic.xivtc.com/`

| 入口 | URL |
|---|---|
| embed 標題（`embed.url`） | `https://cosmic.xivtc.com/?ev=<id>#emergency` |
| 附議 | `…/?ev=<id>&vote=confirm#emergency` |
| 否認 | `…/?ev=<id>&vote=dispute#emergency` |

- 用**自訂網域**不用 `pages.dev`：舊網址會被交接頁轉走（`functions/_middleware.js`），多繞一跳且已知會掉 hash 以外的狀態。
- **URL 全由 worker 端組**，變數只有整數 `ev.id`（DO 自增），無使用者輸入拼接 ⇒ 無注入面。
- 文案沿用站上既有標籤：**「我也看到了」／「查無此事」**（`emergency-view.js:535/538`）。Owner 口語說的「覆議／否認」對應的就是這兩顆；通知與頁面用同一組字，才不會讓人以為是兩個不同功能。

### D4：預告（`warn`）通知也帶連結，但只有「查看」沒有投票

`startAt === 0` 的預告分支（`logic.js:413`）代表「遊戲內出現預兆、還沒開始」。這時候沒有東西可以附議——人還沒看到事件本身，投票會變成投「我相信這個預兆」，污染附議的語意（它現在的意思是「我親眼看到了」）。**預告只給 `embed.url`**，開始時的那一則才有三顆。

## 3. 設計

### 3.1 動到的檔

| 檔 | 改動 |
|---|---|
| `worker/src/logic.js` | `discordPayload(ev, now)` 加 `embed.url` + `components`／fallback 連結行；新增 `SITE_ORIGIN` 常數與 `eventUrl(id, vote)` 純函式 |
| `worker/src/events-do.js:735` | fan-out 的 `fetch(target.webhookUrl, …)` 改打 `webhookUrl + '?with_components=true'`（僅 A 案需要；query 不影響 `isAllowedWebhook` 的 hostname 判定） |
| `modules/emergency-view.js` | 收端：讀 `?ev`/`?vote` → 捲動＋高亮＋確認列（**新增，不改既有 `vote()`**——確認列按下去呼叫的就是既有那支） |
| `modules/app.js` | 無（hash 路由已支援 `#emergency`） |
| `css/style.css` | 高亮與確認列樣式（用 `.codex-*` 既有元件，只加 `.cos-em__hl` 一個本地 class） |

### 3.2 payload 形狀（A 案）

```js
{
  username: 'FFXIV 宇宙探索',
  embeds: [{
    title: `⚡ ${ev.world}　緊急事件進行中`,
    url: eventUrl(ev.id),                    // ← 標題變可點
    description: `**${when}**，持續約 20 分鐘。\n（依回報顯示，實際以遊戲內為準）`,
    color: 0x00b5d8,
  }],
  components: [{
    type: 1,                                  // Action Row
    components: [
      { type: 2, style: 5, label: '看事件',     url: eventUrl(ev.id) },
      { type: 2, style: 5, label: '我也看到了', url: eventUrl(ev.id, 'confirm') },
      { type: 2, style: 5, label: '查無此事',   url: eventUrl(ev.id, 'dispute') },
    ],
  }],
}
```

B 案＝拿掉 `components`，`description` 末尾 append `\n\n[看事件](…)　·　[✅ 我也看到了](…)　·　[🚫 查無此事](…)`。

⚠️ **不要用 `IS_COMPONENTS_V2` flag**：設了它之後訊息**只能**有 components，`content`／`embeds` 一律 400——現有 embed 全部得重做，換不到任何東西。

### 3.3 錯誤處理

- 送出端：既有的 4 秒逾時、連續失敗熔斷（`WEBHOOK_TIMEOUT_MS`、`broken`）全部沿用。若 A 案在正式環境開始回 400（Discord 政策變動），fan-out 會連續失敗 → 熔斷 → 使用者看到「webhook 已被暫停」，**症狀會誤導**。因此 A 案上線後 `fanout` 對 **400** 要與逾時分開計數（`fanout_fail_400`），並在 `GET /admin/stats` 看得到——這是「Discord 那邊變了」與「使用者 webhook 壞了」的唯一分辨點。
- 收端：`?ev` 非正整數、事件不存在、已結束 → 一律走 D2 的 graceful 分支。

## 4. 範圍（in / out）

**in**：`discordPayload` 加連結／按鈕、fan-out query 參數、前端深連結收端＋確認列、`fanout_fail_400` 分桶、測試。

**out**：
- 真正的互動按鈕（需 Discord application，D1 已否決）。
- 在 Discord 裡直接顯示票數／狀態更新（要編輯已送出的訊息＝得存 message id 並在每次投票後 PATCH，寫入量與複雜度不成比例）。
- 通知內容重寫（措辭、倒數演算法照舊；「不揭露 `source`」的既有鐵則不變）。
- @身分組／@everyone（portal cycle `2026-08-05-B-062-discord-mention-target` 的 §4 已把本站列為 out——本站是後端 fan-out，拿不到瀏覽器裡的 SDK，要另外把 mention 存進本站 DO）。

## 5. 驗證計畫

`worker/test/logic.test.mjs` 加（後端基線 +5）：

1. `discordPayload` 的 `embed.url` 與三顆按鈕的 `url` **都含正確的 `ev.id`**，且 confirm／dispute 兩條**不相同**（複製貼上寫成同一個 vote 值，是這種三連結最容易犯且最無訊號的錯——兩顆按鈕看起來都正常，按下去都變附議）。
2. URL 一律 `https://cosmic.xivtc.com/` 開頭，**不得出現 `pages.dev`**（該站有 `check-domain-migration.js` ratchet 在數 occurrence，寫錯會同時觸發它）。
3. **預告分支只有 `embed.url`，沒有 `components`／投票連結**（D4）。
4. link button 形狀合規：`style: 5` + 有 `url` + **無 `custom_id`**（帶了就是 400，且錯誤訊息不會告訴你是這個原因）。
5. B 案 fallback：切到 B 時 `components` 不存在，且 description 含三條連結——**兩案不得同時輸出投票連結**（那會在 Discord 裡出現一排連結又一排按鈕）。

前端（本站目前零自動化測試，B-021 已列管）：本輪**不建測試框架**，改以手動驗收清單逐條走，並把「深連結收端」寫進 B-021 的第一批案例。

**手動驗收**（Owner）：
- 真機點三顆按鈕，各自落在正確事件、確認列文案對應正確的動作。
- 事件已結束的舊通知點進去 → 顯示「已結束」不白屏。
- 手機 Discord app 內建瀏覽器點進去 → hash 分頁切換正常（**這是最可能出問題的路徑**：內建瀏覽器對 hash + query 併用的處理各家不同）。

> **測試 seams**：`logic.js` 的 `discordPayload()` 與新增的 `eventUrl()`（皆純函式，既有 `logic.test.mjs` 已在測 `discordPayload` 鄰近的純函式，不新增 seam）。

## 6. 勘查

| 斷言 | 查法 | 結果 |
|---|---|---|
| 「現在的通知沒有任何連結」 | 讀 `worker/src/logic.js:409-437` | 是：兩個分支都只有 `username` + 單一 embed（title/description/color） |
| 「使用者自建 webhook 送不了互動按鈕」 | Discord 官方 Execute Webhook 文件的 `components` 註腳 | 「Non-application-owned webhooks cannot send interactive components…unless they set the `with_components` query param」 |
| 「link button 不算互動元件」 | Discord Components Reference | 「Link buttons do not send an interaction to your app when clicked」；required＝`style:5` + `url`，禁 `custom_id`；必須放在 Action Row 內 |
| 「hash 深連結已支援」 | 讀 `modules/app.js:158-172` | `initialTab()` 認 `location.hash`，且 emergency＝`tabIds[0]` |
| 「站上兩顆投票鈕的文案」 | 讀 `modules/emergency-view.js:535/538` | 「我也看到了」(confirm)／「查無此事」(dispute) |
| 「自訂網域」 | `README.md:3`、`index.html:62` | `https://cosmic.xivtc.com/` |

**未覆蓋（即 D1 的探測步驟）**：**沒有實測**「non-application-owned webhook + `?with_components=true` + link button」會回 204 還是 400。文件兩段話推導出「應該可以」，但 Discord 的 components 政策這一年改過數次，**不拿實際 webhook 打一發就不算知道**。Build 第一步就做這件事，結果直接決定 A/B。

## 7. 開放問題

1. **要不要第三顆「看事件」按鈕**？三顆在手機 Discord 上會折行。**建議：留著**——標題雖然也可點，但按鈕比藍字標題明顯得多，而「只是想看看」是最常見的意圖。
2. **附議連結要不要限「訂閱者」**？現在任何拿到連結的人（例如被轉貼到別的群）都能投票。本站的投票本來就是匿名 UUID 制、無此限制，通知只是多一條入口。**建議：不限**，但若 `GET /admin/stats` 出現異常投票量再回頭處理（併入 B-018 的觀察項）。
