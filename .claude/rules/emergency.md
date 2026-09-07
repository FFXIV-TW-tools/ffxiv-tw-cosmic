---
paths:
  - "worker/**"
  - "modules/emergency-*.js"
---

# 緊急事件通報／推播鐵則（動到 `worker/**` 或 `modules/emergency-*.js` 時載入）

> 規則本體；由來／實測數字見 `docs/rules-rationale.md` 對應段。**非 Claude 的 agent 動這兩處前手動讀本檔。**
> 上位鐵則＝`AGENTS.md` §4：不預測、不排程、不猜下一次；**不得加回天氣閘**；兩種來源（`插件偵測`／`玩家通報`）
> 畫面上分別標示、不得混為一談；覆蓋率天花板要寫在 UI 上。

## 推播時機

- **預告（`warn`）一律不推播**。該觸發通知的是**確定發生**：天氣真的翻轉（`start`）或有人附議。
- **手動通報靜置 30 秒才推播**：誤按可在此期間撤回，撤回了就一則都不送。靜置期在「別人附議」或
  「通報者自己按確定」時提前結束——它擋的是沒人確認的孤例，不是已經有第二個人看到的事件。
  **插件通報不適用**：它回報的是遊戲天氣本身，不存在誤按。
- 靜置實作用 **DO alarm**，**不得**改成在 `waitUntil` 裡睡——DO 會被回收，通知會靜默消失且無任何訊號。
- **提前量上限 5 分鐘**：玩家唯一的資訊來源是遊戲的預兆通告 ⇒ 沒有管道能知道更早的事。這是「通報者能知道
  什麼」的上界，不是對遊戲行為的猜測；放寬上限會讓**所有人**都能填一個沒有依據的大數字，故不動。

## 觀測 > 推導：天氣以 `weatherId` 為準，衝突的變體一律丟掉

緊急事件的兩個訊號**可信度不對等**，不得平等對待：

| 欄 | 來源 | 可信度 |
|---|---|---|
| `weatherId` | 插件直接讀遊戲的 `ActiveWeather` | **觀測**——start/end 那一刻一定是對的 |
| `variant` | 插件比對**畫面通告文字** | 推導——**上一場的值會殘留** |

- **插件 start/end 帶的天氣一律覆寫**先前的值（`weatherObserved`）。COALESCE 的「先到的贏」在這裡是錯的：
  事件的第一筆常常是**預告**，那時天氣還沒翻轉。
- **手動通報的天氣沒有覆寫權**——那是使用者自己選的，跟先到的值同一級，照舊 COALESCE。
  給它覆寫權會讓「第三個人選錯」蓋掉前兩個人的正確值。
- **`weatherKindOf(variant) !== weather` ⇒ 把 `variant` 與 `groupKey` 一起清空**（`_dropConflictingVariant`）。
  清空而不是改成推導值：我們知道「這個變體是錯的」，不知道「正確的是哪一個」。
- **預告階段不由 variant 推天氣**。`validatePluginReport` 已刻意把 warn 的 weather 設 null（weatherId 是殘留值），
  再從 variant 推導等於把剛擋掉的錯值從後門放進來——variant 是同一個殘留問題。

## 通知的 @ 對象存在訂閱裡，不是即時讀設定

fan-out 由 worker 送，那時使用者的瀏覽器可能根本沒開 ⇒ @ 對象**必須存進 `subs`**。

- **改了 portal 全域設定要回本頁再按一次「儲存訂閱」**才會生效（畫面上要寫）。
- **payload 必須 per-target 組**，不得組一份大家共用——否則所有訂閱者都吃到某一個人的 @ 設定
  （含「設定成不提及的人被 `@everyone` 炸」）。哨兵＝`worker/test/http.test.ts` 那條「兩份 body 不同」。
- 存的是**正規化後**的 `{mentionType, mentionTargetId}`（`discordMentionTarget()` 的輸出）。
  **本 repo 不自己判斷「user 取 userId／role 取 mentionId」**。判準＝`worker/test/mention-vectors.json`
  （portal 那份的 vendoring 副本，digest 相符才算數）。
- ⚠️ **不提及時也一定要送 `allowed_mentions: { parse: [] }`**。Container（Components V2）不能有 `content`，
  但**元件內的提及照樣會 ping**，管轄它的是訊息層的 `allowed_mentions`——省掉它等於回到 Discord 預設解析，
  日後任何一次文案調整引入像提及的字串就會炸整個頻道。

## 前端輪詢（`emergency-view.js`）

上位鐵則＝`AGENTS.md` §5（預設不輪詢／一律綁前景／`visibilitychange` 補打）。本頁現行三檔（`pollIntervalFor()`）：

| 檔 | 條件 | 間隔 |
|---|---|---|
| ACTIVE | **我關心的伺服器**有進行中事件，或我剛通報／附議／否認（30 分鐘內） | 60 秒 |
| IDLE | 其餘 | 300 秒（心跳）|
| 停止 | `document.hidden` | 不打 |

- 「我關心的伺服器」＝跨工具身份的 `character.mainWorld`（同步讀、不花請求）；**沒設定就視為全部**
  ——不能因為使用者沒填過設定就讓他漏看自己那台。
- 真正的「有事了」通道是 **Discord → 人 → 分頁**：後端 DO 收到通報就自己發 webhook（`events-do.js`），
  使用者切回分頁時 `visibilitychange` 當場 poll 一次並進 ACTIVE。⚠️ 但**閒置不能直接歸零**：瀏覽器沒有任何
  管道能自己發現「別人通報了」——心跳的唯一任務是接住「沒訂 Discord、又剛好開著頁面」的人。
- `/state` 的**首次**請求由 `app.js` 在進入 `await` 前先發、view 接手（`prefetch`，**逾 10 秒視為過期重打**
  ——舊資料標成「剛更新」在這一頁是 `AGENTS.md` §4 等級的錯）；拿到資料就重畫，不等下一個 tick。
