---
status: done
type: feature
cycle: 2026-08-02-emergency-report
date: 2026-08-02
---

# 緊急事件通報 — 設計 spec

> 執行風險：中

## 目標

緊急事件（磁暴／流星雨／孢子霧）是伺服器推播、**離線永遠算不出來**（`Weather#194–197` 不在
client 全部 172 張 `WeatherRate` 的任何一列）。本站至今的立場是「不提供、也不假裝能提供」。

本 cycle 換一條路：**不預測，改成回報**。兩個來源並行——

1. **插件自動偵測**（ICE fork）：在渴望灣時發現 `EnvManager->ActiveWeather ∈ {194–197}` 就自動通報。
   訊號是遊戲自己的狀態，不需要任何人自我宣稱。**但一個插件只看得到它所在的那一台伺服器**。
2. **玩家手動通報**：沒裝插件的人按一下。覆蓋率靠人數，可信度較低，UI 要分級標示。

Owner 2026-08-02 拍板：兩者同一輪一起做；插件先用 Owner 本機那一份跑，**功用是累積數據量**，
等使用人數上來就不必只依賴插件。

訂閱者依自己的伺服器收到 Discord 與網頁通知。天花板＝**覆蓋率等於回報者人數**，
沒人在線的伺服器就是黑的——這件事必須在 UI 上講明白，不能讓人以為「沒通知＝沒事件」。

## 這個 cycle 推翻了什麼

### ① 「緊急事件只在特殊天氣發動」——**已用 ICE log 證偽（2026-08-02）**

原設計要把「通報當下是靈風／月塵」當反惡意硬閘（Owner 2026-07-31 觀察：靈風進行中轉孢子霧）。
拿 Owner 本機的 `board-log.jsonl`（186 筆，2026-07-31 20:37–2026-08-01 00:34 台北）驗證：

| 檢查 | 結果 |
|---|---|
| 非緊急天氣的 171 筆，演算法預測 vs 遊戲實測 | **171/171 全吻合** ⇒ log 的天氣欄可信、演算法正確 |
| 緊急事件 15 筆（`weather=196`，00:27–00:34，同時板上出現 5 個 critical 任務 518/522/530/537/543） | 那 15 筆的**底層演算法天氣全部是「晴朗」** |

⇒ **緊急事件會在晴朗時段發動**，天氣閘會把真實事件整個退掉。**一筆陽性觀察即足以否證**
（板上真的跳出緊急天氣＋critical 任務）——與「條件開了卻沒出現」那種可被 Lottery 解釋的
陰性觀察不同，判讀不對稱見 `tools/compare-board-log.mjs` 開頭。

**因此本 cycle 不設任何天氣閘。** 手動通報**沒有任何伺服器端可驗證的閘**：天氣不行、ET 不行、
client 裡沒有任何欄位與緊急事件相關。反惡意只能靠社交層（Owner 2026-08-02 拍板）。

### ② 「緊急任務的必要條件是靈風」——站上文案本來就寫錯

`modules/forecast-view.js:140` 把 20 個掛靈風條件的**臨時**任務講成「緊急任務」；129／148 行的
註解還停在更舊的「11 個」。實據：`missions.json` 裡 33 個 `critical` 的 `conds` **全部是空的**，
掛 cond 13（靈風）的 20 個 `class` 全是 `temporary`。2026-07-31 分類判準修正（commit `2577acf`）
之後沒人回來改這幾句。本 cycle 一併修（主題正好踩到，不是 scope creep）。

### ③ `AGENTS.md` 鐵則 §4 要改寫

「本站不提供、也不假裝能提供」→ **演算法的部分不變**（照樣不預測、不排程、不猜下一次），
但要改成「不由演算法提供，改由插件偵測與玩家通報，覆蓋率＝回報者人數、不保證」。
`BACKLOG B-006`（Owner 2026-07-31「不要有人主動偵測」）由本 cycle 取代——那時的顧慮是
「要別人裝插件才有資料」，現在的做法是插件與人工並行、且插件先只跑 Owner 自己那一台。

## 有 client 依據的常數

| 常數 | 依據 |
|---|---|
| 事件時長 1200 秒 | `missions.json` 33 個 `critical` 的 `timeLimit` **全部 1200**（分布只有一個值） |
| 緊急天氣 id 194–197 | client 全 172 張 `WeatherRate` 皆無此四者（2026-07-31 spec 已證） |
| 7 台繁中服伺服器 | `data/dev-stages.json` 的 `worlds`（repo 內既有唯一來源，不自寫陣列） |

**沒有依據、因此不做的**：事件的「幾分鐘後開始」預告是什麼機制（chat？addon？）——插件端
**只回報看得見的天氣翻轉＝實際開始**，不猜預告。手動通報保留「N 分鐘後開始」選項，因為那是
**人**看到的東西，責任歸屬清楚。

## 反惡意（社交層，Owner 2026-08-02 拍板）

| 層 | 機制 | 擋掉什麼 |
|---|---|---|
| 1 | Origin 白名單＋`Content-Type` 檢查（照抄 portal `/feedback`） | 跨站 simple POST 灌水 |
| 2 | CF 原生 rate limit（通報 2/60s、附議 5/60s、讀取 120/60s；fail-open） | 單 IP 洗版 |
| 3 | 每伺服器同時只有一個 active 事件，重複通報自動變「附議」 | 一個事件被推播多次 |
| 4 | per-UUID 冷卻：同 UUID 同伺服器 25 分鐘內只能開一個新事件 | 同一人連開多起 |
| 5 | 附議／否認；`disputes ≥ 3 且 confirms == 0` → 標 `disputed`、停止顯示為進行中 | 事後糾正 |
| 6 | 管理端點（`ADMIN_TOKEN`）：撤銷事件、封鎖 UUID（`blocked` 表，封鎖後所有寫入端點回 403） | 需要人工處理時 |
| 7 | 插件來源另需 `PLUGIN_TOKEN`＋`weatherId ∈ 194–197`（自相矛盾的 payload 不收） | 冒充高可信來源 |

> 更正（Build，2026-08-02）：第 7 層原本還要求 `missionIds` 至少一個 critical。實作插件端時發現
> **任務板沒開著就讀不到那個欄位**，而緊急事件不會等人開任務板 ⇒ 這條會讓「真的偵測到卻報不上去」。
> 用一個擋不住「已經拿到 token 的偽造者」的檢查，換掉真實訊號，不划算。
> 改為**選填**：有給才檢查自洽（純粹用來抓接線寫錯）。真正的門是 `PLUGIN_TOKEN`。
>
> 同樣在 Build 期拿掉的還有 `/state` 的 `caches.default` 15 秒 edge cache：算過額度後不划算——
> 前端 60 秒才輪詢一次，50 人同時開著也只有 72k DO reads/day（免費額度 1M/day），
> 換來的卻是「事件已撤銷但快取還說進行中」這類 staleness。濫用防線是 rate limiter，不是快取。

**已推播的通知不追回**（Discord 訊息送出即無法收回）；撤銷只影響網站顯示與後續推播。
UI 必須把 `plugin`／`manual` 兩種來源分別標示，不可混為一談。

## 資料模型

**單一 Durable Object**（`idFromName('v1')`，SQLite）。不分片：量體是「每台伺服器每小時最多幾筆」，
單實例完全吃得下，而 fan-out 需要跨伺服器讀訂閱表——分片只會把簡單的事變複雜。

```
events(id INTEGER PK AUTOINCREMENT, world TEXT, source TEXT('plugin'|'manual'),
       startAt INT, endAt INT, startExact INT(0|1), createdAt INT,
       reporter TEXT, confirms TEXT(json uuid[]), disputes TEXT(json uuid[]),
       status TEXT('active'|'disputed'|'revoked'))
subs(uuid TEXT PK, worlds TEXT(json), webhookUrl TEXT,
     failCount INT, broken INT, updatedAt INT)
blocked(uuid TEXT PK, at INT, note TEXT)
stats(k TEXT PK, v INT)     -- 分桶：report_ok_plugin / report_ok_manual / report_dup / vote_* / fanout_fail
```

- **過期用 lazy 判定**（`now >= endAt` 即非 active），不排 DO alarm：沒有任何事需要在結束那一刻發生。
- **保留期**：`events` 只留 7 天（每次寫入時順手刪 `endAt < now - 7d`）；`subs` 在 `worlds` 為空時
  **實體刪列**（不是留空字串），退訂即消失。
- **`webhookUrl` 是敏感憑證**：`GET /sub` 只回遮罩值（`https://discord.com/api/webhooks/…abcd`），
  任何 log／管理端點都不得回完整值。UUID 是**假名識別資料**（等同 access token），README 寫明。

## 對外介面（worker `ffxiv-tw-cosmic-api`）

| Method | Path | 語意 |
|---|---|---|
| `GET` | `/health` | 健康檢查 |
| `GET` | `/state` | 全 7 伺服器現況 |
| `POST` | `/report` | 通報。manual：`{uuid, world, startsInMinutes}`（0–15）。plugin：`{token, world, weatherId, missionIds[], phase:'start'\|'end'}` |
| `POST` | `/vote` | 附議／否認：`{uuid, eventId, kind:'confirm'\|'dispute'}` |
| `PUT` | `/sub` | 訂閱：`{uuid, worlds[], webhookUrl?}`；`worlds` 空陣列＝退訂並刪列 |
| `GET` | `/sub?uuid=` | 讀回自己的訂閱（webhook 遮罩） |
| `POST` | `/admin/revoke` `/admin/block` `/admin/stats` | `Authorization: Bearer <ADMIN_TOKEN>`；缺／錯 → 401 |

錯誤碼：`401` admin token 不符／`403` origin 不合、UUID 已封鎖／`415` content-type 不合／
`400` 欄位不合或插件證據不自洽／`409 already_active`（已有進行中事件，已轉為附議）／
`429` rate limit／`503` 未設定 secret。

## 通知

- **Discord**：DO 對「訂閱該伺服器且有 webhook 且未 `broken`」的人逐一 POST（併發上限 5）。
  SSRF 白名單只放行 `discord.com`／`discordapp.com`（照抄 sub-timer）。
  **不重試、不做 outbox**：事件只有 20 分鐘，遲到的通知沒有價值；失敗只累計 `failCount`，
  連續 4 次標 `broken` 停送（防 runaway 燒額度），使用者重存訂閱即重置。
- **網頁**：**頁內輪詢**（60 秒），命中就 `Notification` ＋音效＋ toast（沿用 `alarm.js` 的三管道）。
  **不做 Service Worker**：SW 在沒有分頁時會被瀏覽器終止、計時器不會喚醒它
  （[W3C service-worker lifetime](https://www.w3.org/TR/service-workers/#service-worker-lifetime)），
  「關掉分頁還會響」是做不到的承諾。UI 必須明說：分頁開著才有網頁通知，要關掉也收得到就用 Discord。
- 兩者都**只送使用者訂閱的伺服器**。

## 不做什麼

- 不預測、不排程、不猜下一次事件時間（演算法上不可能，AGENTS §4 的這半邊不變）。
- 不做真 Web Push（VAPID）：工程量約 3 倍且本 monorepo 無前例（Owner 2026-08-02 拍板）。
- 不做「N 人附議才推播」：覆蓋率低的伺服器永遠達不到門檻，等於功能對冷門伺服器不存在。
- 不猜「預告」的機制；插件只回報看得見的天氣翻轉。
- 不存 IP／UA（沿用 portal `/feedback` 的「內容落地、身份不落地」）。
