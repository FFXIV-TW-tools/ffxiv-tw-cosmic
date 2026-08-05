---
status: implementing
type: feature
cycle: 2026-08-05-B-024-emergency-discord-deeplink
date: 2026-08-05
---

# 緊急事件 Discord 通知：補網址 ＋ 附議／否認按鈕 設計

> 執行風險：中
> Gate 1 依據：2026-08-05 Owner 看過 probe 4 真機截圖後定案「按鈕・在模塊內」＝Components V2 Container（見 D6）
> 狀態流轉：draft →(Gate 1 Owner 拍板)→ approved → implementing → done

## 1. 背景與目標

Owner 2026-08-05：「cosmic 的緊急事件通知 麻煩在 Discord 通知上面 補上網址 然後看能不能直接補兩個按鈕 是跟 cosmic 頁面一樣的 覆議跟否認」

現況 `worker/src/logic.js:409 discordPayload()` 只送一個 embed（標題＋一句倒數），**沒有任何連結**：收到通知的人想確認、想附議、想看還剩幾分鐘，都得自己找書籤回站上、切到緊急事件分頁、找到那張卡。而**附議正是這個功能的社交層命脈**——通報可信度靠附議，下架靠否認（`logic.js:361 applyVote`、`DISPUTE_THRESHOLD`）。通知裡不給入口，等於把最可能出手的那群人（正在看 Discord、人在遊戲裡的那些）擋在流程外。

**目標**：Discord 通知裡直接給 ① 事件頁連結 ② 附議 ③ 否認 三個入口，點下去落在正確的事件上。

## 2. 拍板決策

### D1：按鈕能不能做 —— 技術上可以（走 link button），但**外觀不可控 → 最終由 D6 否決**

> 本節保留探測前的推理與探測結果，是 D6 的依據；**最終形態看 D6**。

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

> **探測已完成（2026-08-05，Owner 真機）→ A / A2 / B 三種形態全部可行，最終採用 A2（Container），理由見 D6。**
> `~/_claude_scratch/discord-probe/probe.sh` 打 Owner 的測試 webhook，六發實測：
>
> | probe | 送什麼 | 結果 |
> |---|---|---|
> | 1 | embed + 3 顆 link button，`?with_components=true` | **204，按鈕真的渲染出來**，標題連結可點 |
> | 2 | 同樣帶 components 但**不帶** query | 204，**無按鈕** ⇒ 那個 query 參數就是關鍵（對照組成立） |
> | 3 | markdown 連結行（B 案） | 204，三條藍字連結 |
> | 4 | Components V2 Container（`flags: 32768`） | 204，可渲染（按鈕包在色框內）——**不採用**，見 D6 |
> | 5 | A 案 + 按鈕 emoji | 204 |
> | 6 | **紅色按鈕**（`style: 4` + `url`） | **400 `{"components":["0"]}`** ⇒ 彩色按鈕確定做不到 |
>
> ⚠️ 探測過程本身有兩個坑值得留著：① 把含中文的 JSON 當 `-d` 參數傳給 Windows 的 `curl.exe`，經 MSYS 轉碼後位元組被弄壞，Discord 回 400「invalid JSON」——**症狀與「payload 寫錯」完全相同**，害我先往錯的方向查；改用 `--data-binary @檔案` 即正常。② `curl -s` 會把連線層錯誤一起吞掉，網址壞掉與 Discord 拒收在畫面上都只是 `HTTP 000`。

⚠️ **不因為想要按鈕就去申請 Discord application**：那要求使用者把我們的 bot 邀進他的伺服器，換來的只是按鈕樣式——與「一個連結就能完成的事」不成比例。

### D6：最終採用 **A2 案＝Components V2 Container**（真按鈕，包在色框內，接受 ↗）

實測後 Owner 逐項看過真機畫面，四件「想要但做不到」全部有實測或文件依據，**不要再試一次**：

| 想要的 | 能不能 | 依據 |
|---|---|---|
| 「查無此事」是紅色 | **不能** | probe 6 實測 **400 `{"components":["0"]}`**。彩色 style（1/3/4）一律要 `custom_id`＝互動元件＝非 app webhook 禁送 |
| 按鈕**文字**上色 | **不能** | `label` 是純文字欄位，不吃 markdown、無顏色參數；Discord 唯一能上色的 ANSI code block 裡**連結不可點**，而我們要的正是連結 |
| 拿掉按鈕右邊的外連圖示 **⧉** | **不能**（且 Owner 最終確認不需要拿掉） | 官方 Button 物件全部欄位＝`type`/`id`/`style`/`label`/`emoji`/`custom_id`/`sku_id`/`url`/`disabled`，**沒有一個控制它**；由客戶端固定渲染 |
| 自訂彩色 emoji | **不採用** | 自訂 emoji 只在擁有它的伺服器渲染；通知發到**使用者自己的**伺服器 ⇒ 退化成字面 `<:no:123>`，比沒有更糟 |

**Owner 裁示（2026-08-05，看過 probe 4 真機截圖後）：採用 Container 版**——按鈕包在色框內，按鈕上的外連圖示保留（本來就無法移除）。

> ⚠️ **用字警告（本輪實際造成一輪來回）**：文件裡把那個外連圖示寫成「↗」，但 Discord 客戶端**實際畫的是 ⧉**（方框加箭頭）。Owner 據此以為我在提議換掉某個既有符號，回了「不要 ↗，用原本的那個符號」——**其實兩者是同一個東西**。往後描述客戶端渲染的視覺元素，用它實際長相或官方名稱（external link indicator），不要自創字形。

定案＝**A2 案：Components V2 Container**（`flags: 32768`）。

```
┃ ### ⚡ 伊弗利特　緊急事件進行中          ← 標題是連結
┃ **約 12 分鐘後開始**，持續約 20 分鐘。
┃ -# 依回報顯示，實際以遊戲內為準           ← subtext（小灰字）
┃ ┌────────┐┌──────────────┐┌─────────────┐
┃ │看事件 ⧉││✅ 我也看到了 ⧉││🚫 查無此事 ⧉│
┃ └────────┘└──────────────┘└─────────────┘
   ↑ 左側色條（accent_color）涵蓋整塊，按鈕在框內
```

- emoji 留著（✅／🚫）：顏色與樣式都用不了，emoji 是**唯一**還能區分贊成／反對的軸，而且它是語意不是裝飾。
- 「看事件」不加 emoji——它與標題連結指向同一處，多一個圖示只是噪音。
- 順序固定：左＝查看、中＝附議、右＝否認。**否認放最右**（後果最重的動作放最難誤觸的位置）。

**落選：A 案（embed + 下方 link button，probe 1/5）**——同樣可行，但按鈕掛在色框外，視覺上與事件本體斷開。Owner 明確要「在模塊內」。

**落選：B 案（markdown 連結行，probe 3）**——沒有 ⧉ 也沒有方塊，但點擊目標是文字、觸控難按；且既然 ⧉ 本來就不是問題，放棄按鈕沒有理由。

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

> 更正（Build，2026-08-05）：上面寫「短暫高亮」，實作是**維持到該事件結束**——高亮綁在 `[data-ev-id]` 上，事件一結束那一列就不再帶這個屬性 ⇒ 自然消失，不需要計時器（那只是多一個會錯的條件）。尤其 `?ev` only（「看事件」按鈕）沒有確認列可關，計時器一到就什麼痕跡都不剩，等於點了沒反應。捲動則**只做一次**（每秒重捲會把使用者鎖在原地）。措辭以本塊為準；外審 post 閘 ⑤ 指出的正是這處文件與實作不一致。

### D3：三個入口都指向 `https://cosmic.xivtc.com/`

| 入口 | URL |
|---|---|
| embed 標題（`embed.url`） | `https://cosmic.xivtc.com/?ev=<id>#emergency` |
| 附議 | `…/?ev=<id>&vote=confirm#emergency` |
| 否認 | `…/?ev=<id>&vote=dispute#emergency` |

- 用**自訂網域**不用 `pages.dev`：舊網址會被交接頁轉走（`functions/_middleware.js`），多繞一跳且已知會掉 hash 以外的狀態。
- **URL 全由 worker 端組**，變數只有整數 `ev.id`（DO 自增），無使用者輸入拼接 ⇒ 無注入面。
- 文案沿用站上既有標籤：**「我也看到了」／「查無此事」**（`emergency-view.js:535/538`）。Owner 口語說的「覆議／否認」對應的就是這兩顆；通知與頁面用同一組字，才不會讓人以為是兩個不同功能。

### D4：預告（`warn`）通知**同樣給三顆按鈕**（Owner 2026-08-05 修正）

`startAt === 0` 的預告分支（`logic.js:413`）代表「遊戲內出現預兆通告、事件還沒開始」。

> **原設計是「預告只給查看」，Owner 看過樣本後推翻：「可以加，因為有預告通知，有看到的人也能點」。**
> 原推理錯在把預告當成「還沒有東西可以看」——實際上**預兆通告本身就是遊戲內看得到的東西**，所以「我也看到了」在預告階段有明確、可觀測的指涉（我也看到那則通告），不是在投「我相信」。附議的語意（親眼看到）沒有被稀釋。

⇒ 預告與開始兩則的按鈕列**完全相同**，差別只在文案與 `accent_color`（預告橘、進行中藍）。

**附帶效果（正向）**：預告是**最早**能收到的訊號，也是最需要旁證的階段（此時只有一個人回報）。開放附議等於把驗證前移到事件真正開始之前——而 `applyVote` 對同一個 event id 累加，預告期收到的附議會**直接沿用到開始那一則**（warn→start 刻意共用 id）。

## 3. 設計

### 3.1 動到的檔

| 檔 | 改動 |
|---|---|
| `worker/src/logic.js` | `discordPayload(ev, now)` 改輸出 Container 形狀（`flags: 32768`）；新增 `SITE_ORIGIN` 常數、`eventUrl(id, vote)` 與 **`legacyEmbedPayload(ev, now)`**（退回用，見 3.3） |
| `worker/src/events-do.js:735` | fan-out 的 `fetch` 打 `webhookUrl + '?with_components=true'`（**Container 必要**；query 不影響 `isAllowedWebhook` 的 hostname 判定），＋ 400 一次退回重送 |
| `modules/emergency-view.js` | 收端：讀 `?ev`/`?vote` → 捲動＋高亮＋確認列（**新增，不改既有 `vote()`**——確認列按下去呼叫的就是既有那支） |
| `modules/app.js` | 無（hash 路由已支援 `#emergency`） |
| `css/style.css` | 高亮與確認列樣式（用 `.codex-*` 既有元件，只加 `.cos-em__hl` 一個本地 class） |

### 3.2 payload 形狀（A2 Container —— 定案，實測樣本＝probe 4/5）

```js
{
  username: 'FFXIV 宇宙探索',
  flags: 32768,                                  // IS_COMPONENTS_V2
  components: [{
    type: 17,                                    // Container
    accent_color: 0x00b5d8,                      // 左側色條（原 embed.color 搬來）
    components: [
      { type: 10,                                // Text Display（吃 markdown）
        content:
          `### [⚡ ${ev.world}　緊急事件進行中](${eventUrl(ev.id)})\n` +
          `**${when}**，持續約 20 分鐘。\n` +
          `-# 依回報顯示，實際以遊戲內為準` },   // -# ＝ subtext 小灰字
      { type: 1,                                 // Action Row
        components: [
          // emoji 取捨見 D6：查看不加（與 ⧉ 語意重複），投票兩顆加（語意不是裝飾）
          { type: 2, style: 5, label: '看事件',     url: eventUrl(ev.id) },
          { type: 2, style: 5, label: '我也看到了', emoji: { name: '✅' }, url: eventUrl(ev.id, 'confirm') },
          { type: 2, style: 5, label: '查無此事',   emoji: { name: '🚫' }, url: eventUrl(ev.id, 'dispute') },
        ] },
    ],
  }],
}
```

⚠️ **設了 `flags: 32768` 就不能再有 `embeds`／`content`**（一律 400）⇒ 現行 embed 的 title/description/color 全部搬進 Container：title → Text Display 的 `###` 標題連結、description → 內文、color → `accent_color`。
⚠️ **fan-out 必須帶 `?with_components=true`**（probe 2 對照組實測：不帶就整組 components 被靜默忽略，訊息照樣 204 送出但**什麼按鈕都沒有**——零錯誤訊號）。

### 3.3 錯誤處理

- 送出端：既有的 4 秒逾時、連續失敗熔斷（`WEBHOOK_TIMEOUT_MS`、`broken`）全部沿用。
- ⚠️ **新增一條退回路徑（本案唯一的真風險）**：Components V2 對 non-application-owned webhook **沒有官方明文保證**（我們是靠實測知道它可行的）。哪天 Discord 收緊，整則訊息會變 400 ⇒ 連續失敗 → 熔斷 → 使用者看到「你的 webhook 已被暫停」，**而他的 webhook 根本沒壞**，症狀完全指向錯的方向。因此 fan-out 收到 **400** 時：**用 `legacyEmbedPayload()`（純 embed + 下方連結行）立刻重送一次**，成功就不計失敗、不熔斷，並記 `fanout_v2_reject` 分桶到 `GET /admin/stats`。
  - 這條同時是「失敗時保留前一個好狀態」的落實：**版面退化，通知不中斷**。
  - 只退回一次，不做指數重試——400 是確定性拒絕，重試同一份 payload 沒有意義。
- ⚠️ Text Display `content` 上限 **4000 字元**；現行內容 < 200 ⇒ 不設截斷，但 `eventUrl()` 必須保證輸出長度有界（只吃整數 id）。
- 收端：`?ev` 非正整數、事件不存在、已結束 → 一律走 D2 的 graceful 分支。

## 4. 範圍（in / out）

**in**：`discordPayload` 改 Container 形狀、`legacyEmbedPayload` 退回路徑、fan-out 帶 `?with_components=true` ＋ 400 退回、`fanout_v2_reject` 分桶、前端深連結收端＋確認列、測試。

**out**：
- 真正的互動按鈕（需 Discord application，D1 已否決）。
- **A 案（embed + 框外按鈕）與 B 案（純連結行）**——皆實測可行，因 Owner 要「按鈕在模塊內」而落選（D6）；B 案的 payload 以 `legacyEmbedPayload()` 形式**留在程式碼裡當退回路徑**，不是死碼。
- 在 Discord 裡直接顯示票數／狀態更新（要編輯已送出的訊息＝得存 message id 並在每次投票後 PATCH，寫入量與複雜度不成比例）。
- 通知內容重寫（措辭、倒數演算法照舊；「不揭露 `source`」的既有鐵則不變）。
- @身分組／@everyone（portal cycle `2026-08-05-B-062-discord-mention-target` 的 §4 已把本站列為 out——本站是後端 fan-out，拿不到瀏覽器裡的 SDK，要另外把 mention 存進本站 DO）。

## 5. 驗證計畫

`worker/test/logic.test.mjs` 加（後端基線 +5）：

1. 標題連結與三顆按鈕的 `url` **都含正確的 `ev.id`**，且 confirm／dispute 兩顆**不相同**（複製貼上寫成同一個 vote 值，是這種三連結最容易犯且最無訊號的錯——兩顆看起來都正常，按下去都變附議）。
2. URL 一律 `https://cosmic.xivtc.com/` 開頭，**不得出現 `pages.dev`**（該站有 `check-domain-migration.js` ratchet 在數 occurrence，寫錯會同時觸發它）。
3. **預告分支與進行中分支的按鈕列一致**（三顆、url 相同規則、含投票；D4）——只有文案與 `accent_color` 不同。⚠️ 斷言要**逐顆比對 url**，不是只數數量：預告分支是另一段程式碼，最可能的退化是「按鈕有了但 vote 參數漏帶」。
4. **Container payload 的三個硬條件同時成立**：`flags === 32768`、**無 `embeds`／`content` 欄位**（有就是 400）、`components[0].type === 17`。⚠️ 這三條是「送得出去」的前提，錯一條整則通知全滅——而本地看不出來（JSON 完全合法）。
5. 按鈕形狀合規：`style: 5` + 有 `url` + **無 `custom_id`**（帶了就 400，且錯誤訊息 `{"components":["0"]}` 不會告訴你是這個原因——probe 6 實測）。
6. **`legacyEmbedPayload()` 的退回版本仍含三條投票連結且 URL 與主版本一致**（退回路徑最容易腐爛：它平常不執行，壞了要等 Discord 收緊那天才會發現，而那天正是最需要它的時候）。
7. **fan-out 對 400 會退回重送且不計失敗次數**（斷言 `failCount` 未增、`broken` 未觸發）——否則 Discord 一改政策，全體訂閱者會被誤標成「webhook 壞掉」。

前端（本站目前零自動化測試，B-021 已列管）：本輪**不建測試框架**，改以手動驗收清單逐條走，並把「深連結收端」寫進 B-021 的第一批案例。

**手動驗收**（Owner）：
- 真機點三顆按鈕，各自落在正確事件、確認列文案對應正確的動作。
- **手機 Discord app 看版面**：三顆按鈕在窄螢幕會不會折行、色條有沒有正常渲染（Container 在行動端的實測樣本目前是 0）。
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

| 「彩色按鈕做不到」 | probe 6 實測（`style:4` + `url`） | **400 `{"components":["0"]}`** |
| 「link button 的外連圖示 ⧉ 拿不掉」 | Discord Components Reference 的 Button 物件欄位全表 | 欄位僅 `type`/`id`/`style`/`label`/`emoji`/`custom_id`/`sku_id`/`url`/`disabled`，無一控制它；客戶端固定渲染（最終不需要拿掉） |
| 「按鈕 label 不能上色」 | 同上：`label` 型別為 string，無 markdown／顏色語意 | 唯一能上色的是 ANSI code block，而 code block 內連結不可點 |

**已由探測轉為已知（原「未覆蓋」項已關閉）**：
- `non-application-owned webhook + ?with_components=true + link button` → **204 且真的渲染**（probe 1/5）；對照組不帶 query → 送出成功但**無按鈕**（probe 2）。
- **Components V2 Container（`flags: 32768`）在非 app webhook 上可用**（probe 4，Owner 截圖佐證：色條涵蓋整塊、三顆按鈕在框內）——這是 D6 的直接依據。官方文件對此**沒有明文保證**，故 3.3 設了退回路徑。

**仍未覆蓋**：Container 在**手機 Discord app** 的渲染沒有樣本（probe 4 是桌面版截圖）——三顆按鈕在窄螢幕的折行行為留手動驗收看。

## 7. 開放問題

1. ~~要不要第三顆「看事件」按鈕~~ → **已無此問題**（改用連結行後不存在折行風險，三段連結一行放得下）。「看事件」保留：標題連結不夠明顯，而「只是想看看」是最常見的意圖。
2. **附議連結要不要限「訂閱者」**？現在任何拿到連結的人（例如被轉貼到別的群）都能投票。本站的投票本來就是匿名 UUID 制、無此限制，通知只是多一條入口。**建議：不限**，但若 `GET /admin/stats` 出現異常投票量再回頭處理（併入 B-018 的觀察項）。
