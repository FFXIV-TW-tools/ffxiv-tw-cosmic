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

### d2b53e480990-1 codex sha256:2d4da115afc5a9219fc839c04509bf3a5ca195ce890a35329c76a4e0d6469b8f

```text
【致命】插件回報契約互相衝突，照 Task 1 實作會直接漏掉真實事件。spec「反惡意」更正明定 `missionIds` 選填，因任務板未開時插件讀不到；但 Task 1 Step 1 仍要求至少一個 critical ID，且使用未定義的「critical id 範圍」。此外 spec 把 token 放在 body、Task 2 Step 2 改成 `X-Plugin-Token`、Task 5 的介面又寫回 body。應先定稿唯一 wire contract：token 固定放 header、`missionIds` 缺省或空陣列均可，有值時才依 `missions.json` 的精確集合驗證，並加入三方契約測試。

【致命】測試用的 `now` 看似要由 HTTP 呼叫者傳入，會讓公開客戶端控制安全時鐘。Task 2 Step 4 寫「測試呼叫端一律傳明確的 `now`」，但 spec 的任何 request schema 都沒有 `now`；若路由接受它，攻擊者可繞過 25 分鐘冷卻、事件過期和保留期。正式路由只能使用伺服器時間；測試時應由 test-only binding、依賴注入或假時鐘控制，並測試 body/query 中的 `now` 被拒絕或忽略。

【嚴重】單一 `source` 欄位無法表達「玩家先報、插件稍後證實」這個必然情境。spec 資料模型只有 `source: plugin|manual`，反惡意第 3 層又規定重複通報轉附議，但插件 payload 沒有 UUID，無法合法加入 `confirms uuid[]`；若保留原列，UI 仍會錯標為低可信的「玩家通報」。應定義來源提升規則，例如插件命中既有 manual event 時將來源提升為 plugin 並記錄 `pluginObservedAt`，插件重複不得偽造成玩家附議，並測試 manual→plugin 與 plugin→manual 兩種順序。

【嚴重】`phase:'end'` 沒有資料模型或狀態轉移定義，可能錯誤結束別人的事件。Task 5 會送 start/end，但 Task 2 的 DO 方法與測試只描述 `report`、固定 1200 秒到期和 admin revoke，沒有說 end 要更新哪一筆；僅靠 world 無法分辨遲到的 end、新一輪事件或先前的 manual event。應決定取消 end、只靠固定時長，或加入可配對的 observation/event token；若保留 end，必須明定離開 territory／讀取失敗不等於事件結束，並補 stale end、重複 end、manual event 不受影響等測試。

【嚴重】前端沒有 UUID 的取得與持久化方案，三個核心寫入流程無法接線。`POST /report`、`POST /vote`、`PUT /sub` 都要求 UUID，但 Task 3 沒列 UUID 來源，Task 4 的既有設定介面只明列 `discord.webhookUrl`。應指定沿用哪個既有欄位，或以 `crypto.randomUUID()` 建立並持久化；同時定義跨分頁、重載、清除資料後的行為，以及禁止出現在 URL、DOM、log，並加入重載後仍可讀回訂閱的驗收。

【嚴重】`PUT /sub` 完全沒有 rate limit，攻擊者可無限建立持久訂閱並放大每次 Discord fan-out。spec 與 Task 2 Step 3 只有 report、vote、GET 三個 limiter，而 Origin header 並不是非瀏覽器客戶端的身分驗證；任意 UUID 加合法 Discord webhook 即可持續填滿 `subs`。應加入訂閱寫入 limiter、資料量與單次 fan-out 上限、過久未更新訂閱的清理策略，並測試大量 UUID、限流 fail-open 時的可控退化。

【嚴重】spec 已拍板的 per-UUID 25 分鐘冷卻沒有落入任何明確步驟或驗收。反惡意第 4 層要求同 UUID、同 world 25 分鐘內不能開新事件，但 Task 1 沒有相應純邏輯，Task 2 Step 1 未描述判定，整合測試清單也沒有此案例。應補上伺服器時間判定、明確錯誤碼，並測試事件已結束但未滿 25 分鐘、滿 25 分鐘、不同 world、插件來源等邊界。

【嚴重】投票陣列沒有唯一性與改票規則，一個 UUID 可能自行湊滿三票或同時存在兩邊。Task 1 只要求 `applyVote` 判斷 `disputes ≥ 3 && confirms === 0`，卻未規定重複 vote 是否冪等、confirm→dispute 是否移除舊票。應把兩個 JSON 陣列當集合處理，同一 UUID 至多一票，改票時原子移除另一側，並加入重複投票、改票和並發投票測試。

【嚴重】未定義 `startsInMinutes > 0` 在狀態、去重及通知上的語意。manual 可報 1–15 分鐘後開始，但 Task 3 現況卡只有「進行中／無事件」，Task 2 也沒說未開始事件是否占用每 world 的唯一 active 槽，Discord 要立即送還是開始時送。應明定 upcoming 狀態、倒數文案、去重窗口與各通知管道的送出時點，並測試未開始期間的第二筆通報及跨越 `startAt` 的狀態轉換。

【嚴重】Task 2 仍要求 `/state` 使用 15 秒 edge cache，與 spec 的 Build 更正及撤銷驗收直接矛盾。spec 已明確移除快取以避免撤銷後仍顯示進行中，但 Task 2 Step 2 保留 `caches.default`，Step 4 又要求 admin revoke 後 `/state` 不再列出。應刪除快取步驟；若堅持保留，就必須設計所有狀態變更的精確失效機制並驗證，而不能讓測試繞過 cache。

【嚴重】跨網域瀏覽器呼叫的 preflight 與非瀏覽器管理路由沒有驗收矩陣。Task 2 Step 2 只概括寫 CORS，測試清單沒有 `OPTIONS`；JSON `POST` 及 `PUT /sub` 會先 preflight。另一方面只明確豁免 plugin 的 Origin，可能讓沒有 Origin 的 bearer-token 管理命令全部 403。應逐路由定義 Origin 規則，為 report/vote/sub 測試 OPTIONS、允許 methods/headers，並驗證 admin 無 Origin 但 token 正確時可用、瀏覽器公開寫入仍受白名單限制。

【一般】計畫仍保留已被推翻的驗收要求，而且所有未執行步驟都標成完成。Global Constraints 第二點仍要求在 UI 顯示天氣閘及觀測「被擋筆數」，與 Goal、spec 的「完全移除天氣閘」相反；Task 1–6 又全部使用 `[x]`，不符合「實作尚未開始」的前閘狀態。應刪除殘留天氣閘要求、改為來源分桶指標，並把執行 checklist 重設為 `[ ]`，避免後續工具與 Owner 誤判已完成或已驗收。
```

### 7ccc8b220224-1 codex sha256:2e9170931d77f25a9a5ae8028a2410f6b5f771935d5827eab6677ead04fc148e

```text
【致命】受審實作已偏離核准 spec，原驗收基準無法判定此 head 通過。依據：spec 要求 UI 分級顯示 `plugin/manual`，但 `modules/emergency-view.js` 明確隱藏來源；spec 要求手動通報立即推播、事件保留 7 天、`startsInMinutes=0–15`，實作卻在 `worker/src/logic.js` 改成延遲 30 秒、保留 90 天、範圍 −19～5，並額外加入 `warn`、history、withdraw、notify-now、adjust、purge 等未列介面。建議動作：把後續需求另立 cycle 並補新版 spec／plan 後重跑後閘，或將受審區間縮回原 cycle 的實作 commits。

【致命】核心的 ICE 插件自動偵測路徑沒有出現在受審區間，Task 5 無法核實。依據：材料 3 與 commit metadata 均沒有 `XIVpluginsDev/ICE-Dev/**`、`EmergencyReporter.cs`、設定或指令修改；Task 5 Step 3 的 curl 只驗證 worker 接口，且明說遊戲內實測留待下次事件。建議動作：附上 monorepo 對應 commit range、實際 C# diff、Release build 輸出，以及至少可重現的 weather 翻轉／territory／停用狀態測試，再驗收雙來源目標。

【嚴重】受審區間混入大量計畫外變更，且直接違反「本 cycle 不碰 `data/*.json`」。依據：`da5aab286124` 修改四份資料檔；`modules/mission-view.js` 排序、天氣時間軸雙欄與效能重構、分頁記憶、通知 modal 等也不在 Task 1–6；同一區間還加入整套歷史與撤回功能。建議動作：將資料重跑、一般 UX／效能改善及後續功能拆到各自 cycle；本後閘只保留能對應原 plan 的 commits。

【嚴重】插件證實既有手動事件時沒有用遊戲實測時間校正事件。依據：`worker/src/events-do.js` 的 `report()` 在既有事件分支只把 `source` 改為 `plugin` 並呼叫 `_notifyNow()`，沒有把 `startAt`、`endAt`、`startExact` 更新為插件 `phase:'start'` 的伺服器時間；`manual→plugin` 整合測試也只檢查 id 與 source。建議動作：插件 start 命中 manual event 時原子更新三個時間欄位，並測試 manual 預告過早、已開始數分鐘兩種情境。

【嚴重】通報者可以替自己的事件附議，從而永久繞過「3 否認、0 附議即下架」。依據：`events-do.js#vote()` 與重複 manual report 都直接呼叫 `logic.js#applyVote()`，未排除事件的 `reporter`；一旦本人加入 `confirms`，`confirms === 0` 永遠不成立。建議動作：禁止 reporter 對自己的事件 confirm，自己的重複通報應冪等；補 `/vote` 與重複 `/report` 的自我附議攻擊測試。

【嚴重】warn 階段的網頁通知會誤報「進行中」，且真正開始時反而不再通知。依據：`events-do.js` 將 warn→start 升級維持同一 event id；`modules/emergency-notify.js#fire()` 對 `startAt=0` 走「進行中」分支，而 `onState()` 又只按 event id 去重，後續 start 會被 `fired.has(ev.id)` 擋掉。建議動作：為 warn 建立明確通知分支，去重鍵改為事件 id＋phase，並補 warn→start 的前端通知測試。

【嚴重】插件 payload 驗證會把格式錯誤靜默解讀成合法 start。依據：`logic.js#validatePluginReport()` 對任何不是 `end/warn` 的 phase 一律改成 `start`，所以缺 phase 或 `phase:'strat'` 都會建立高可信事件；提供非陣列 `missionIds` 也會被當成未提供而放行。建議動作：phase 必須明確屬於允許 enum；`missionIds` 若存在就必須是陣列，並加入缺值、拼錯及錯型別的 400 測試。

【一般】重複通報形成的附議不會依新規則提前結束 30 秒靜置期。依據：`events-do.js#report()` 的 existing 分支會寫入 confirm，但只有插件來源升級才呼叫 `_notifyNow()`；相同附議若走 `vote()` 才會立即推播。現有測試只覆蓋 `/vote` 提前送出。建議動作：排除 reporter 自我附議後，其他 UUID 的重複 `/report` 也應呼叫 `_notifyNow()`，並補對應 alarm／fan-out 測試。

【一般】計畫宣告的結構契約沒有全部落實。依據：Global Constraints 要求所有新檔少於 500 行，但 `worker/src/events-do.js` 為 602 行、`worker/test/http.test.ts` 為 690 行；Task 3 宣告 view 回傳 `{render,setWorld}`，實作只回 `{render}`；Task 4 宣告 notify 回傳 `{sync,status,onState}`，實作只回 `{onState}`。建議動作：拆分 DO／測試職責，並實作宣告介面或先修訂 plan 後再標 done。

【一般】ADMIN_TOKEN 與 PLUGIN_TOKEN 使用直接字串比較，不符合 Worker 的 secret 驗證安全慣例。依據：`worker/src/index.js` 使用 `pluginToken !== env.PLUGIN_TOKEN` 與 `auth !== Bearer ...`；Cloudflare 明確建議固定長度雜湊後使用 `crypto.subtle.timingSafeEqual()`。[Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 建議動作：集中成 constant-time token 驗證 helper，兩個入口共用並補錯誤 token 測試。

【一般】Task 3／4 的瀏覽器端驗收仍只有勾選敘述，未被可執行測試證明。依據：`worker/test/http.test.ts` 只跑 Worker/DO；沒有測試覆蓋後端離線降級、訂閱伺服器過濾、同事件只響一次、warn→start、四分頁與水平溢位，且上述 warn 通知缺陷正好逃過全綠測試。建議動作：加入瀏覽器整合測試，或附上具時間與版本的人工驗收紀錄；未補前不得把 Task 3 Step 4、Task 4 Step 3 視為已證明。
```
