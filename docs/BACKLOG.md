# BACKLOG — ffxiv-tw-cosmic

> 排序即優先序（上=先做）。條目由 agent 提、Owner 排序/否決；Owner 也可直接加。**不經 Owner 核可不得自主實作**。
> 完成打勾並附 cycle；否決用刪除線並留一行原因。格式見 DEVLOOP §4.2。

- [ ] **B-003** (P1, chore)【建議 高｜延遲風險 中｜執行風險 中｜副作用 觸發 CF Pages 首次部署】上線部署（見 `../_NEW-TOOL.md` step 2–5）：`gh repo create FFXIV-TW-tools/ffxiv-tw-cosmic` + CF Pages 連接 + portal `tools.json` 註冊（icon 🌙／accent cyan／category daily）+ `functions/_middleware.js` 的貓小胖白名單 + `header.js` 的 `FALLBACK_TOOLS` + `tools/git-hooks/README.md` 涵蓋清單 + GSC 提交 sitemap。不做的後果：站做好但沒有入口、也不會被搜到。來源: 2026-07-31-cosmic-site

- [ ] **B-004** (P2, chore)【建議 中｜延遲風險 中｜執行風險 低｜副作用 無】遊戲內核對「ET 時段條件」的單位與語意。`WKSMissionLotterySpecialCond` c0/c1 是 2 小時階梯、上游命名為 Start/End Time，但**沒有任何遊戲內證據**證明單位是 ET 小時；且分布很偏（cond#1 有 59 筆、#3–#10 各只有 1 筆），不像自然的時段分配。驗法＝在 ET 00:00–02:00 與其他時段各看一次任務板，比對 cond#1 的 53 個【高難】任務是否只在該窗出現。**若證偽，`conditions` 的 label 與「現在」欄要一起改**。來源: 2026-07-31-cosmic-site

- [ ] **B-001** (P2, chore)【建議 中｜延遲風險 低｜執行風險 低｜副作用 修正別的 repo 的既有錯誤】修 `ffxiv-tw-sightseeing/modules/weather.js` 的**月夜峰（Mare Lamentorum）機率表錯誤**：該手打表寫 `[[15,"Umbral Wind"],[30,"Moon Dust"],[60,"Fair Skies"],[100,"Clear Skies"]]`（＝Fair 30 ＋ Clear 40），但台服 client（territory 959 → `WeatherRate#135`）是**靈風 15／月塵 15／晴朗 70，沒有碧空**。影響＝探索筆記若有月夜峰的天氣條件點位，預測會錯。順帶評估把「天氣演算法 + client 產生的機率表」升格到 portal 共用層（rule of two：本站與 sightseeing 各一份），需 Owner Gate1。來源: 2026-07-31-cosmic-site 勘查

- [ ] **B-002** (P3, chore)【建議 低｜延遲風險 低｜執行風險 低｜副作用 動 portal 共用 CSS】提報 portal 把 `.codex-empty[hidden]` 收進集中 `[hidden]` 守衛。`.codex-empty` 設了 `display:flex`，會蓋過 UA 的 `[hidden]{display:none}` ⇒ 帶 `hidden` 屬性的空狀態照樣顯示（本站踩到，已用工具自有 class `.cos-hideable[hidden]` 本地繞過）。header.css 現有守衛涵蓋 btn／chip／icon-btn／modal-overlay／help-pop，**就是漏了 empty**。需 Owner Gate1。來源: 2026-07-31-cosmic-site 實作

- [ ] **B-005** (P3, chore)【建議 低｜延遲風險 低｜執行風險 低｜副作用 無】定性 `WKSMissionToDoEvalutionRefin` 三欄（值如 20/40/70、50/60/85）。與 `WKSMissionUnit` 的銀星／金星（絕對分數）不同量綱，疑為銅/銀/金百分比門檻。目前落在 `_unverified.evalThresholds`、不進 UI。**同一張表也是 ICE fork `TcCapability` 仍停用的「銅星門檻」的候選**——那邊掃了三張表沒找到，因為它在第四張。定性後兩邊一起解。來源: 2026-07-31-cosmic-site

- [ ] **B-006** (P3, feature)【建議 低｜延遲風險 低｜執行風險 高｜副作用 需要後端 + 插件回報】緊急任務即時偵測。**離線做不到**（Weather#194–197 不在任何 WeatherRate ⇒ 只能伺服器推播），唯一路徑＝Dalamud 插件偵測後 push 到後端，網站顯示。天花板＝覆蓋率等於回報者數量，沒人在線的伺服器/實例就是黑的。架構上是後掛的一層，不影響現有靜態站。**Owner 已表示暫不做**（2026-07-31：「不要有人主動偵測」）。來源: 2026-07-31-cosmic-site

- [ ] **B-007** (P3, feature)【建議 低｜延遲風險 低｜執行風險 低｜副作用 無】深連結收端：`?mission=<id>` 直開某任務、`?job=<id>` 預選職業篩選；出端＝任務需求物接 marketboard `#/item/<itemId>` 查價。未知 id 要 graceful fallback（toast + 清掉自己的參數），禁白屏。來源: `../_NEW-TOOL.md` 深連結 checklist
