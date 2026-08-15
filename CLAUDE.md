@AGENTS.md

# Claude 專屬

- 全 repo 鐵則（資料只能來自 client／未定性欄位禁填合理值／欄位索引不複製／只做算得準的／設計系統）與 VERIFY：見上方 `@AGENTS.md`，**不重複**。
- **Git 邊界**：commit 前先知會 shawn（動手前說「我要 commit `<檔>`，訊息 `<msg>`」，不把 stage+commit 塞同一連鎖）；**push 走 STOP**——本 repo 已註冊 fleet canonicalTest，由 Owner 跑 `bash ~/.claude/skills/process/tools/safe-push.sh --repo C:/FFXIVProject/external/ffxiv-tw-cosmic --reason "<原因>"`（絕對路徑防 `!` cwd 漂移；canonicalTest 綠才推＋JSONL 留痕，2026-07-21 裁示）。**裸 `git push` 被 hook 硬擋、不得繞**，也不要改列 `!git push` 請 Owner 代跑（不經 hook、少一筆 push-log）。憑證排錯：401 ＝ Windows Credential Manager 在 WSL 抓不到，改在 git-bash 重跑。觸發 CF Pages 部署一律 STOP。
- **改 UI/CSS 前先 Read** `../ffxiv-tw-tools-portal/_DESIGN-SYSTEM.md`（cd 進本目錄時 portal 的 CLAUDE.md 不會自動載）。
- **改資料前先看產生器**：`data/*.json` 是產物，改法是改 `tools/cosmic-dump/` 再重跑，不手改 JSON。
- **模型分工**（tier→型號、複審層級判定）：見全域 `~/.claude/CLAUDE.md`。
- 教訓落點：修完非顯而易見的 bug／踩坑 → 一兩行寫進 `@AGENTS.md` 對應鐵則（附日期），不另寫 per-cwd memory。
