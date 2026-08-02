# 外審原文 sidecar（external-gate 產生；內容由對應區塊 meta.outputSha256 綁定——改寫/截斷＝驗證不過；孤兒段＝中斷殘渣、無害不回收）

### 0dfee55d27bb-1 codex sha256:af0434d0e168c3940b0ed256b68c93853f5ad24211ccff3538a3d9ad6e685689

```text
【致命】Service Worker 無法可靠地每 5 分鐘自行背景輪詢。依據：Task 4 Step 1 把「背景 5 分鐘輪詢」放在 `sw.js`，Step 3 又承諾「瀏覽器開著（SW）」即可通知；但 Service Worker 沒有事件時可隨時被終止，計時器不會喚醒它，[W3C lifecycle](https://www.w3.org/TR/service-workers/#service-worker-lifetime) 明確如此規定。Periodic Background Sync 也只能由瀏覽器自行決定觸發時機且並非跨瀏覽器支援，[web.dev](https://web.dev/patterns/web-apps/periodic-background-sync) 的相容表只涵蓋 Chromium 系。Task 4 Step 4 的「背景分頁」測試仍有存活頁面，沒有驗證關閉網站、只留瀏覽器的承諾。建議動作：暫停此分支，請 Owner 在真 Web Push、僅頁面開啟時輪詢、或明確標成 Chromium/PWA best-effort 的 Periodic Sync 中重新選擇；同步重寫狀態文案與關站測試。

【嚴重】Discord 指數退避沒有可持久執行的排程與資料模型。依據：Task 2 Step 1 要求失敗後指數退避、四次後標記 `broken`，但 spec 的 `subs` 只有累計 `failCount`，沒有待送通知、下一次嘗試時間或冪等鍵；Task 2 也沒有 Queue、alarm 或 outbox。若在 `/report` 內同步重試，會拉長通報回應並占住單一 DO；若回應後非同步做，`waitUntil()` 最多只延長約 30 秒，不能承擔持久重試。Cloudflare 官方建議以 [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) 喚醒並保證至少一次執行。建議動作：加入通知 outbox 與 alarm/Queue，明定 `attemptCount`、`nextAttemptAt`、冪等鍵、最大併發和清除規則，並測試 Worker 中斷及 Discord 長時間失敗。

【嚴重】`uuid` 的產生、保存與授權語意完全缺席，導致前端介面無法落實且訂閱可能遭竄改。依據：`/report`、`/vote`、`PUT /sub` 與 `GET /sub?uuid=` 全依賴 UUID，但 Task 3、Task 4 沒有任何生成、持久化、匯入或輪替步驟；同時 `/sub?uuid=` 被稱為「讀回自己的訂閱」，卻沒有其他認證，Origin 白名單也不是身份驗證。若回傳完整 webhook，取得 UUID 者便能讀取或覆寫這項 Discord 憑證；封鎖者也可直接換 UUID。建議動作：定義至少 128-bit 隨機 bearer secret 的生命週期，將公開 reporter ID 與訂閱管理憑證分離，憑證放 Authorization header、查詢只回遮罩 webhook，並補上跨裝置匯入、輪替與撤銷流程。

【嚴重】管理端反惡意層在計畫的 schema 與 DO 介面中沒有實作落點。依據：spec 反惡意第 7 層要求撤銷、封鎖 UUID、讀 stats；但資料模型沒有 blocked UUID 表，Task 2 Step 1 明列的 RPC 只有 `report`／`vote`／`sub`，`/admin/*` 也沒有確切路徑、body、回應碼或封鎖檢查點。建議動作：新增 blocked-principal schema 與 admin RPC，列出每個 admin endpoint 的契約、token header、撤銷及封鎖後各公開端點的行為，並加入 token 錯誤、已封鎖與撤銷事件測試。

【嚴重】Worker 最關鍵的狀態、安全與通知程式沒有自動化行為測試。依據：Task 1 只測純函式；Task 2 Step 5 的 `wrangler deploy --dry-run` 只能驗證打包，無法驗證 SQLite migration、DO 狀態轉移、CORS、payload 閘、rate limit、重複通報、投票、admin、edge cache、webhook SSRF、失敗退避或 `broken`。Task 3–4 的瀏覽器驗證也只覆蓋少數 happy path。建議動作：在 Task 2 增加 Miniflare/Wrangler integration tests，以 mock Discord endpoint 覆蓋完整路由與資料狀態，尤其測重複／並發 report、投票切換、SSR​​F URL 變形、失敗重試及 admin 操作。

【嚴重】Task 4 的通報驗證受真實時間控制，無法保證執行當下能通過。依據：`startsInMinutes` 最多 15 分鐘，weather gate 只在當下或開始時刻落入 30% 特殊天氣時放行；Task 4 Step 4 卻要求直接手動 `POST /report` 後等待通知。若當時附近沒有特殊天氣，正確結果必然是 422，驗收會被迫等待未知時長。建議動作：為本機／測試注入固定 clock，或提供只存在測試 build 的 fixture 建立途徑；固定驗證一筆 accepted 與一筆 `not_special_weather`，不得依賴牆鐘。

【嚴重】資料保存設計違反「不存任何識別資料」的宣稱且沒有保留期限。依據：spec 資料模型永久保存 `reporter`、`confirms`、`disputes` UUID，以及可直接發訊息的 `webhookUrl`；lazy expiry 只判定事件不 active，沒有刪除任何列。Task 1–5 也沒有清理、退訂刪除或管理端遮罩步驟。建議動作：把 UUID 明確列為假名識別資料、webhook 列為敏感憑證；規定事件／投票保留期、空 worlds 物理刪除訂閱、過期清理機制，以及所有讀取與紀錄中的 webhook 遮罩。

【一般】Task 5 的實際 checklist 漏掉兩個已列入 Files 的必要修改。依據：Files 列出 `index.html` footer 與 `docs/specs/2026-07-31-cosmic-site-design.md`，但 Step 1–4 沒有任何 checkbox 修改這兩處；執行者照步驟完成時仍可能留下「本站不提供」舊文案及未補歷史更正。建議動作：各自加入明確步驟，並在驗證中搜尋禁止殘留的舊文案與確認更正區塊存在。

【一般】單一 `rejectedByWeather` 累計值無法驗證天氣閘假設。依據：spec 只要求被擋筆數，Task 2 只寫 stats 計數，Task 5 B-018 卻宣稱可藉此驗證假設；同時 `observability = false`。單一數字沒有 accepted 分母、時間分布或使用者後續訊號，無法區分亂按與遭誤擋的真實通報。建議動作：至少記錄不含身份的 accepted/rejected 分桶、日期與預告距離，並設計「我確實在遊戲中看到但被擋」的匿名回饋訊號及判定門檻。
```
