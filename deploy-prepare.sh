#!/bin/sh
# CF Pages build step — 只部署站台檔，且對未分類的新東西 fail-closed。
#
# ── 為什麼需要這支 ────────────────────────────────────────────────────────
# CF Pages 的 Git 整合在沒有 build 步驟時，把 repo 根整棵目錄當靜態資產上傳
# → AGENTS.md / docs/ / tools/ / tests/ / worker 後端源碼全部變成該網域下可直接 GET
# 的公開檔（2026-08-01 實測 12/13 站皆如此，含 Worker 的 oauth.ts 與 FFLogs 資料管線）。
# private repo 只保護「誰能 clone」，不保護已部署的檔案；.gitignore（檔是 tracked）、
# _headers（只加標頭）、robots.txt（只擋收錄不擋直取）三者都擋不到。
#
# ── 為什麼是允許清單而不是排除清單 ──────────────────────────────────────
# 排除清單（本檔第一版）預設「全部發佈」、靠清單擋掉不該發的 → **新增的目錄天生外洩**，
# 只能靠人記得補。實測當天就漏兩次：worker/（106 支後端 .ts）、_tools/ 與 _cache/（141 檔）。
# 改成允許清單後預設變「不發佈」：頂層出現任何未分類的項目 → **build 直接失敗**，
# 逼開發者當場歸類，不可能靜默上線。安全來自結構，不是來自紀律。
#
# ── 維護方式 ──────────────────────────────────────────────────────────
# 新增站台資產（新頁面、新資料夾）→ 把它加進 deploy-allow.txt。
# 新增內部資產（新工具、新文件夾）→ 加進 deploy-deny.txt（或什麼都不做，build 會擋下來提醒你）。
#
# ── dashboard 設定 ────────────────────────────────────────────────────
#   Build command          : sh deploy-prepare.sh
#   Build output directory : _site
#
# ── 踩過的坑（勿回退）────────────────────────────────────────────────
#   1. 本檔由 `sh` 執行，CF 容器的 sh 是 **dash 不是 bash**：`read -r -d ''` 之類 bashism
#      會靜默失敗、一個檔都沒複製，build 仍「成功」但輸出 0 檔 ⇒ **整站 404**（實際發生過）。
#      本檔一律只用 POSIX 語法。
#   2. 根層檔名的 ${f%/*} 會回傳檔名本身，直接 mkdir 會建出「叫 index.html 的目錄」⇒ / 404。
#   3. git ls-files 對非 ASCII 檔名加引號 → 需 core.quotepath=false；且不假設容器有 git。
set -eu

OUT=_site
ALLOW=deploy-allow.txt
DENY=deploy-deny.txt

[ -f "$ALLOW" ] || { echo "✗ 缺 $ALLOW（允許清單是部署的唯一依據）" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT"

# ── 1. 頂層分類閘：未列入允許或拒絕清單的項目一律擋下 ──────────────────
UNKNOWN=""
for e in * .[!.]* ..?*; do   # ..?*＝codex 外審：.[!.]* 匹配不到「..internal」這種兩點開頭的名稱
  [ -e "$e" ] || continue
  case "$e" in
    "$OUT"|.git|"$ALLOW"|"$DENY"|deploy-prepare.sh|.deploy-minify) continue ;;
  esac
  # git 忽略的本機產物（.venv / node_modules / _site / 快取…）本來就不會進 CF 的 checkout，
  # 不該被分類閘擋下（否則本機跑不動、線上又用不到）。git 不可用時此檢查自動略過。
  if git check-ignore -q "$e" 2>/dev/null; then continue; fi
  if grep -qxF "$e" "$ALLOW" 2>/dev/null; then continue; fi
  if [ -f "$DENY" ] && grep -qxF "$e" "$DENY" 2>/dev/null; then continue; fi
  UNKNOWN="$UNKNOWN  $e
"
done
if [ -n "$UNKNOWN" ]; then
  echo "✗ 頂層出現未分類項目，拒絕部署（避免靜默外洩）：" >&2
  printf '%s' "$UNKNOWN" >&2
  echo "  → 站台資產請加進 $ALLOW；內部資產請加進 $DENY" >&2
  exit 1
fi

# ── 2. 複製：分類靠允許清單，內容只取 git tracked 檔 ────────────────────
# 為什麼不直接 cp -r 允許的目錄：本機的 data/ 之類可能混有大量**未追蹤**的快取
#（ranking 實測 12 萬個），cp -r 會一起複製 → 本機跑不完，且與 CF 的 checkout 不一致
#（線上驗不到本機驗的東西）。只取 tracked 檔可保證「本機驗的 == 線上發的」。
# git 不可用時退回 cp -r（CF 的 checkout 沒有未追蹤雜物，行為等價）。
if git rev-parse --git-dir >/dev/null 2>&1; then
  # grok 外審【高】：原本寫成 `git ls-files | while ... done`，while 跑在 subshell，
  # cp 失敗（磁碟滿／路徑異常）不保證讓整支腳本中止 → 可能出貨殘缺產物。
  # 改成先落檔再 `done < 檔案`：無 subshell，set -e 直接生效。
  LIST=.deploy-filelist.tmp
  git -c core.quotepath=false ls-files > "$LIST"
  while IFS= read -r f; do
    top=${f%%/*}
    [ "$f" = ".deploy-filelist.tmp" ] && continue
    grep -qxF "$top" "$ALLOW" 2>/dev/null || continue
    # 根層檔名的 ${f%/*} 會回傳檔名本身 → 只有含斜線才建目錄，
    # 否則會建出「叫 index.html 的目錄」，cp 進去 ⇒ / 404（實際踩過）
    # codex 外審【高】：cp 會解參照 symlink → data/foo.json -> ../worker/secret 這種連結
    # 會把 deny 區內容複製成看似安全的 .json，最終驗收也攔不到。一律拒絕。
    [ -L "$f" ] && { echo "✗ 允許路徑下有符號連結，拒絕部署：$f" >&2; exit 1; }
    case "$f" in */*) mkdir -p "$OUT/${f%/*}" ;; esac
    cp "$f" "$OUT/$f" || { echo "✗ 複製失敗：$f" >&2; rm -f "$LIST"; exit 1; }
  done < "$LIST"
  rm -f "$LIST"
else
  # codex 外審【中】：原本 git 不可用時退回 cp -r，會把「只複製 tracked 檔」的保證換成
  # 「複製目錄內全部內容」（含未追蹤快取／憑證／產物）＝安全語意被悄悄放寬。
  # 寧可 build 失敗（CF 保留前一版）也不出貨語意不明的產物。
  echo "✗ git 不可用，無法確認 tracked 檔清單，中止（不退回語意更寬鬆的 cp -r）" >&2
  exit 1
fi

# ── 3. 二次清理：允許的目錄內部若混有內部檔（如 data/ 裡的 README.md）一併移除 ──
find "$OUT" -type f \( -name '*.md' -o -name '*.py' -o -name '*.ps1' -o -name '*.sh' \
  -o -name '*.rs' -o -name '*.ts' -o -name '*.toml' -o -name '*.lock' -o -name '*.yml' \
  -o -name '*.yaml' -o -name '*.ini' -o -name '*.example' -o -name 'package.json' \
  -o -name 'package-lock.json' -o -name 'tsconfig*.json' -o -name '.gitignore' \
  -o -name '.gitattributes' -o -name '.rgignore' -o -name '.env*' -o -name '*.d.ts' \) \
  ! -name 'LICENSE*.txt' -delete 2>/dev/null || true
find "$OUT" -type d \( -name __pycache__ -o -name .pytest_cache -o -name node_modules \) \
  -prune -exec rm -rf {} + 2>/dev/null || true

# ── 4. 選用：壓縮 JS（剝註解 + 壓區域變數名，一般網站的標準做法）─────────
# 由 .deploy-minify 標記檔開關。注意這**不是隱藏**：壓縮碼丟進 formatter 仍可讀，
# 前端邏輯本質公開。目的是對齊一般網站常態並剝掉內部決策脈絡的註解。
# 刻意不產 source map（產了等於把原始碼還原回去）。
if [ -f .deploy-minify ]; then
  for f in "$OUT"/*.js; do
    [ -f "$f" ] || continue
    npx --yes esbuild@0.28.1 "$f" --minify --charset=utf8 --target=es2022 --outfile="$f.min" >/dev/null 2>&1 \
      || { echo "✗ 壓縮失敗：$f（網路或 registry 問題）" >&2; exit 1; }
    mv "$f.min" "$f"
  done
fi

# ── 5. 出貨前驗收：任一不過就讓 build 失敗（CF 保留前一版，站不會掛）──────
N=$(find "$OUT" -type f | wc -l)
[ "$N" -ge 3 ] || { echo "✗ 輸出只有 $N 個檔案，複製失敗，中止" >&2; exit 1; }
[ -f "$OUT/index.html" ] || { echo "✗ 輸出缺 index.html（/ 會 404），中止" >&2; exit 1; }
# codex 外審【高】：原本最終驗收只查 4 種副檔名＝另一份不完整的黑名單。
# 改成**白名單**：輸出中出現任何不在站台資產副檔名清單內的檔案即中止。
# 新增合法資產類型時要在這裡一起加（這正是我們要的：逼你當場決定）。
LEAK=$(find "$OUT" -type f \
  ! -name '*.html' ! -name '*.css' ! -name '*.js' ! -name '*.mjs' ! -name '*.json' \
  ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.webp' ! -name '*.svg' \
  ! -name '*.ico' ! -name '*.gif' ! -name '*.avif' \
  ! -name '*.woff' ! -name '*.woff2' ! -name '*.ttf' \
  ! -name '*.mp3' ! -name '*.ogg' ! -name '*.wav' \
  ! -name '*.wasm' ! -name '*.gz' ! -name '*.br' ! -name '*.xml' ! -name '*.csv' \
  ! -name 'robots.txt' ! -name '_headers' ! -name '_redirects' ! -name '_routes.json' \
  ! -name 'LICENSE' ! -name 'LICENSE*.txt' ! -name 'NOTICE' \
  ! -path "$OUT/.well-known/*" | head -8)
[ -z "$LEAK" ] || { echo "✗ 輸出含非站台資產（副檔名不在白名單），中止：" >&2; echo "$LEAK" >&2; exit 1; }
echo "✓ 部署輸出就緒：$N 個檔案"
