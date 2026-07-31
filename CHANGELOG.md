# Changelog

> 日期段落制（cycle 收官為段）；條目含人話「為什麼」，不從 git log 自動生成。格式見 DEVLOOP §4.3。

## 2026-07-31 — 建站（cycle [2026-07-31-cosmic-site](docs/specs/2026-07-31-cosmic-site-design.md)）

### Added

- **`tools/cosmic-dump`（C#／Lumina）** — 從台服 client sqpack 產生 `data/weather.json`、`missions.json`、
  `cosmic-tools.json`。內建健全性閘（544 任務／天氣機率總和 100%／11 條 ×9 階工具鏈），**任一不過就整批不寫檔**
  ——分次落地會留下「舊檔／新檔／缺檔」三種狀態，而網站是逐檔讀的，等於靜默混用兩個 client 版本的資料。
- **三分頁靜態站** — 天氣時間軸／任務清單（544 筆，可依職業‧難度‧條件‧「現在符合條件」篩選）／宇宙工具升級鏈。
- DEVLOOP 工件、`AGENTS.md` 鐵則、portal 設計系統接線（accent cyan、`cos-` 私有前綴、`.codex-*` 零覆寫）。

### 為什麼是這個範圍

原始需求是「自動偵測各伺服器緊急任務與天氣任務的時間」。動工前先做離線查證，結論把範圍砍成兩半：

**一般天氣（月塵／晴朗／靈風）是 unix 時間的純函數**，全 7 個繁中服伺服器同步 ⇒ 可推算到任意未來，
而且「各伺服器」這個維度根本不存在。演算法正確性用中薩納蘭與摩杜納回推、與既有 sightseeing 的手打表逐項比對確認。

**緊急事件天氣（磁暴／流星雨／孢子霧，Weather#194–197）不出現在 client 全部 172 張 `WeatherRate` 的任何一列**
⇒ 時間演算法永遠擲不出來 ⇒ 只能由伺服器推播，離線零資訊。這是決定性證據，不是推測，所以本站**不提供也不假裝提供**，
改為給出唯一算得出來的線索：11 個緊急任務的必要條件視窗（靈風時段），並在頁面上把理由講明白。

### 刻意沒做的事

- **未定性欄位不填合理值**：`WKSMissionLotterySpecialCond` row 15–22 在台服 client 三欄全 0（上游國際服當它們是
  Clouds/Rain，但渴望灣天氣表根本沒這兩種天氣）⇒ 標 `unknown`、可接欄顯示「未知」。評價門檻與未實裝的工具階數同理。
  **由來是 ICE fork 那輪連續五次拿 0 當佔位**（`MapPosition` 讓採集完全不執行、`missionText` 讓技能完全不放）——
  0 在這批 sheet 裡是有意義的哨兵值；在網站上的同型錯誤形式是「把 6 個緊急任務標成隨時可接」。
- **欄位索引不複製第二份**：三張任務表的欄位索引由 csproj 直接編譯 ICE fork 的唯一定義。產生器本來就只能在
  有遊戲 client 的本機跑，依賴本機路徑可接受；抄一份的代價是台服改版後兩邊漂移，症狀是「數字合理但錯」。

### 順帶發現

- `ffxiv-tw-sightseeing/modules/weather.js` 的**月夜峰機率表是錯的**（手打表把 client 的「晴朗 70」拆成
  Fair 30 ＋ Clear 40）。已記 `docs/BACKLOG.md` B-001。
- portal 的 `.codex-empty` 設了 `display:flex` 但**不在** header.css 的集中 `[hidden]` 守衛名單內 ⇒
  帶 `hidden` 的空狀態照樣顯示。本站用自有 class `.cos-hideable[hidden]` 繞過，已記 B-002 提報 portal。
- `WKSMissionToDoEvalutionRefin`（544 列 × 3 欄）是 ICE fork `TcCapability` 仍停用的「銅星門檻」的候選——
  那邊掃了三張表沒找到，因為它在第四張。已記 B-005。

### 驗證

產生器健全性閘全過；瀏覽器 1920×1080 實測三分頁皆正常、console 零 error、水平溢出 0、
`.page-header` top=64／高 51px（生態基準值）；天候篩選實測 11 筆全為緊急且靈風時段內全標「可接」。
