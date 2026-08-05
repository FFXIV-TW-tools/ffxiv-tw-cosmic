# 外審原文 sidecar（external-gate 產生；內容由對應區塊 meta.outputSha256 綁定——改寫/截斷＝驗證不過；孤兒段＝中斷殘渣、無害不回收）

### adcd9a3c42df-1 codex sha256:951095a6e536891e598c892bcb3b0855956e98c68664a2858e2a8deb6e15f9cc

```text
【致命】計畫把尚未開始的工作全部標成已完成，前閘通過後可能直接跳過實作。依據：plan front matter 是 `status: done`，Task 1–4 所有步驟均為 `[x]`，甚至已記載 Commit 與「通知深連結上線」；這與題目前提「實作尚未開始」直接衝突。建議動作：前閘版本改成 `approved`／`planned`、所有執行項改回 `[ ]`，只有取得測試與 commit 證據後才能逐項勾選及轉成 `done`。

【嚴重】部署順序會讓新版 Discord 按鈕先指向尚未具備收端功能的正式站。依據：Task 2 Step 7 要 Owner 執行 worker deploy，但 Task 3 的前端收端尚無 Pages 部署步驟；而 Task 1 的 `eventUrl()` 固定指向 `https://cosmic.xivtc.com/`。建議動作：明定先部署前端收端並做正式站深連結 smoke test，再部署 worker、發測試 webhook 驗三條連結，最後才執行 Record；同時寫明兩側的回退方式。

【嚴重】有效事件可能在資料尚未載入時被誤判為「已結束」。依據：Task 3 Step 2 在每次 `render()` 尋找事件，Step 3 對「找不到」直接顯示已結束，但計畫沒有區分首次載入中、請求失敗、成功取得完整事件清單後確定不存在。建議動作：深連結先保持 pending，僅在第一次成功取得權威事件資料後才能判定不存在；另加延遲回應及暫時失敗的驗收案例。

【嚴重】確認列的位置與捲動策略互相衝突，目標事件不是第一筆時使用者可能看不到確認按鈕。依據：spec D2 要求確認列出現在事件卡上方；Task 3 Step 3 卻把 `#em-deeplink` 放在整個事件列表上方，Task 3 Step 2 又把目標列捲到畫面中央。建議動作：把確認列插在目標事件卡旁，或做成可見的 sticky 區塊並移入焦點；手動驗收必須包含目標事件位於列表中段或末段。

【嚴重】「與 Owner 樣本逐欄一致」沒有可執行的驗證，而且計畫內已有顏色值矛盾。依據：Global Constraints 要求文案、emoji、順序及 `accent_color` 逐欄一致，但 Task 1 Step 2 同時寫 `0xb58900` 與錯誤的十進位 `11886848`；`0xb58900` 實為 `11897088`。Step 4 的測試也未斷言完整文案、按鈕順序、label 與 emoji 分欄及兩種 accent color。建議動作：修正或刪除矛盾的十進位註記，並為預告、進行中及 legacy payload 加完整 golden/deep-equality 測試。

【嚴重】V2 退回路徑的逾時生命週期未定義，可能正好在需要退回時失效。依據：Task 2 Step 3 的第二次 `fetch` 重用 `ctrl.signal`，但未說明既有四秒 timer 是跨兩次請求共用、重設或已清除；第一發接近逾時才回 400 時，第二發可能立即 abort，另一種實作則可能讓第二發失去逾時保護。建議動作：明定每次嘗試各自建立 controller/timer，或明定總 deadline；增加第一發延遲後回 400、第二發成功及第二發逾時的測試。

【一般】以字串串接 `'?with_components=true'` 會破壞原本含 query 或 fragment 的 webhook URL。依據：Task 2 Step 2 使用 `target.webhookUrl + '?with_components=true'`，但計畫沒有建立「儲存的 webhook URL 絕不含 `?`／`#`」的不變量；結果可能令 `with_components` 無法被 Discord 解析，重現「204 但元件消失」的靜默失敗。建議動作：使用 `new URL()` 與 `searchParams.set()`，並測試保留既有 query 參數的情況。

【一般】不帶 `vote` 的「看事件」深連結沒有狀態結束條件，短暫高亮無法可靠落實。依據：Task 1 會產生只有 `?ev=<id>` 的標題及「看事件」URL；Task 3 Step 2 會在每次重建時依 `deepLink` 持續加 class，而 Step 4 又在「兩秒移除」與「維持到確認列關閉」間未定案；看事件路徑根本沒有確認列可關閉。建議動作：分離一次性捲動、限時高亮及投票意圖狀態，明確清理 view-only deep link，並加入連續數次 render 後的驗收。

【一般】計畫聲稱新增的統計與完整測試基線都沒有最終驗證。依據：Task 2 宣告產出 `fanout_v2_reject`，但四個整合案例沒有斷言該桶或 `GET /admin/stats`；Global Constraints 的 `canonicalTest` 也沒有 `pnpm test:logic`，且 Task 4 沒有在全部改動完成後重新執行 canonical suite。建議動作：增加 rejection bucket／admin stats 斷言，並在 Record 前明列一次包含 `pnpm test:logic`、整合測試、root validation 與 deploy dry-run 的最終驗證。
```

### fd77bc2ff01a-1 codex sha256:edc4959bc22085269bb07f24b64fae4e264cdeddd5259ff9efb2fbcdace1b0c2

```text
【嚴重】V2 退回請求仍共用第一發的逾時計時，慢速 400 時 fallback 會立即失效。依據：`worker/src/events-do.js::_send()` 只建立一組 `AbortController`／`setTimeout`，第一發與 `legacy` 重送皆使用同一個 `ctrl.signal`；這與 plan「外審 triage ⑥：已改為每次呼叫自建 controller／timer」不符。建議動作：抽出 `postWebhook()`，每次 POST 各自建立並清理 4 秒 timeout，再補「第一發接近逾時才回 400、第二發仍成功」測試。

【一般】`with_components=true` 仍以字串附加，既有 query 或 fragment 會令 Components V2 被靜默忽略。依據：`worker/src/events-do.js::_send()` 使用 `` `${target.webhookUrl}?with_components=true` ``；plan triage ⑦已確認 `isAllowedWebhook()` 沒有限制 webhook 不得含 query，並宣稱已改成 `new URL()`，但受審 diff 沒有該修正。建議動作：用 `new URL(target.webhookUrl)` 搭配 `searchParams.set('with_components', 'true')`，並加入原網址已含 query 的案例。

【嚴重】400 fallback 的關鍵驗收條件沒有被測試真正證明。依據：`worker/test/http.test.ts` 的退回案例只斷言 `got.broken === false`；單次 `_fail()` 本來也不會立刻把訂閱標成 broken，因此無法證明 `failCount` 沒增加；測試也沒有依 spec §5.7／plan triage ⑨斷言 `GET /admin/stats` 的 `fanout_v2_reject`，且立即回覆的 stub 無法揭露共用 timeout 問題。建議動作：直接斷言 `failCount === 0`、`fanout_v2_reject` 增加一次，並加入延遲 400 的 fallback 測試。

【嚴重】前端與手機端的必要手動驗收仍沒有完成證據，不能據此把 cycle 判為全綠。依據：spec §5要求真機點三顆按鈕、手機版 Container、已結束事件及 Discord 內建瀏覽器的 hash＋query 驗收；spec §6仍明載手機 Container「樣本目前是 0／仍未覆蓋」，而受審材料沒有驗收紀錄、截圖或等價自動化證據。建議動作：重新開啟驗收狀態，保存上述四類實測結果；尤其先部署 Pages 收端並 smoke test，再部署 worker、由實際通知逐顆驗證。

【一般】view-only 深連結的高亮不是 spec 所定義的「短暫高亮」。依據：spec D2要求「加一圈短暫高亮」；`modules/emergency-view.js::renderDeepLink()` 在沒有 vote 時刻意保留 `deepLink`，`highlightDeepLink()` 也沒有移除 class 的計時器，因此高亮會持續到事件結束，而非短暫顯示。建議動作：對 `?ev` only 在捲動後約 2 秒移除高亮，或由 Owner 明確修改 spec 接受持續高亮。

【嚴重】Task 4 與 B-021 記錄工作被標成完成，但不在受審提交區間內。依據：plan Task 3 Step 5要求把深連結案例寫入 B-021，Task 4要求修改 `CHANGELOG.md`、`docs/BACKLOG.md`、spec、plan、`AGENTS.md` 並建立 Record commit；commit metadata 僅列出 `4c0bbae`、`a6cf105`、`3beb3e1`、`403fc73`，其變更檔案沒有任何上述文件，整合測試基線更新也未落地。建議動作：不要維持這些勾選；補齊 Record／B-021／基線提交後，以新的 HEAD 重新產生後閘材料。
```
