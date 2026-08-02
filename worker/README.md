# ffxiv-tw-cosmic-api — 緊急事件通報後端

宇宙探索的緊急事件（磁暴／流星雨／孢子霧）**離線算不出來**（那四個天氣不在 client 任何一張
`WeatherRate` 內）。這支 worker 收「插件自動偵測」與「玩家手動通報」兩種回報，
並對訂閱者的 Discord webhook 廣播。

**天花板要講清楚**：覆蓋率＝回報者人數。沒人在線的伺服器就是黑的，**沒通知不代表沒事件**。

---

## 架構

```
[ 網站（Pages） ] --Origin 白名單+UUID--> ┐
                                          ├─> [ Worker router ] ─> [ CosmicEventsDO ('v1') ]
[ ICE 插件 ] --X-Plugin-Token+證據自洽--> ┘                            ├ SQLite: events/subs/blocked/stats
                                                                      └ fan-out → 每人自填的 Discord webhook
```

- **單一 DO 實例**（`idFromName('v1')`）裝全部 7 台伺服器。不分片：量體是「每台每小時最多幾筆」，
  而 fan-out 必須跨伺服器讀訂閱表。
- **不排 alarm**：事件過期用 lazy 判定（`now >= endAt`），沒有任何事需要在結束那一刻發生。
- **不做 outbox、不重試 webhook**：事件只有 20 分鐘，遲到的通知比沒有更糟。失敗只累計
  `failCount`，連續 4 次標 `broken` 停送（防 runaway 燒額度），使用者重存訂閱即解除。

### 為什麼**沒有**天氣閘

原設計要用「通報當下是不是靈風／月塵」當反惡意閘。2026-08-02 用 ICE `board-log.jsonl` 驗證後
**證偽**：該檔唯一一次緊急事件（`weather=196`）發生時，底層演算法天氣 **15/15 都是晴朗**，
而同一份記錄裡非緊急的 171 筆演算法與實測 171/171 吻合。**不要把天氣閘加回來**——
它會把真實事件整個退掉。詳見 `../docs/specs/2026-08-02-emergency-report-design.md`。

---

## 部署 SOP（cwd = `worker/`）

```bash
pnpm install
pnpm test              # 28 個整合測試（vitest-pool-workers）
pnpm test:logic        # 17 個純函式測試（node --test）
pnpm cf:deploy:dry     # 0 error 才往下
# STOP（對外發佈，由 shawn 執行）：
pnpm cf:deploy
```

首次／換機需先 `npx wrangler login`（STOP）。DO migration 首次 deploy 自動建，不需手動準備資源。

### Secret（皆不進 git；STOP，由 shawn 執行）

```bash
npx wrangler secret put ADMIN_TOKEN     # 管理端點的 Bearer token
npx wrangler secret put PLUGIN_TOKEN    # ICE 插件回報用的共享密鑰
```

- `ADMIN_TOKEN` 未設 → `/admin/*` 一律 503；`PLUGIN_TOKEN` 未設 → 插件回報 503（網站不受影響）。
- 兩個 token 都是 capability：知道就能用，**不要貼進任何頻道或 commit**。

---

## Endpoints

| Method | Path | 說明 |
|---|---|---|
| `GET` | `/health` | 健康檢查（回伺服器數量，順便驗資料有載進來） |
| `GET` | `/state` | 全 7 台現況。每台只回最新的一個 active 事件 |
| `GET` | `/history?world=&limit=` | 歷史紀錄：已結束／已撤銷的事件（新→舊）。**只回計數不回 UUID**；撤銷的也列出來並標明 |
| `POST` | `/report` | 通報。**manual**：`{uuid, world, startsInMinutes}`（0–15，需白名單 Origin）。**plugin**：header `X-Plugin-Token` ＋ `{world, weatherId, missionIds[], phase}` |
| `POST` | `/vote` | `{uuid, eventId, kind:'confirm'\|'dispute'}` |
| `PUT` | `/sub` | `{uuid, worlds[], webhookUrl?}`；`worlds: []` ＝退訂並**實體刪列** |
| `GET` | `/sub?uuid=` | 讀回自己的訂閱，**webhook 只回遮罩值** |
| `POST` | `/admin/revoke` | `{eventId}` — 撤銷。⚠ 已推播的 Discord 訊息收不回來 |
| `POST` | `/admin/block` | `{uuid, note}` — 封鎖並刪除其訂閱 |
| `GET` | `/admin/stats` | 分桶計數（plugin／manual 通報量、附議率、否認率、fan-out 失敗、熔斷數） |

**狀態碼**：`401` token 不符／`403` origin 不合或 UUID 已封鎖／`404` 事件不存在／
`409` 該伺服器已有進行中事件（本筆自動轉為附議，**不是失敗**）／`413` body > 8KB／
`415` content-type 非 json／`429` 限流或冷卻中／`503` secret 未設。

**限流**（CF 原生 binding、per-IP、fail-open）：通報 2/60s、寫入 5/60s、讀取 120/60s。

**CORS**：只認 `https://[hash.]ffxiv-*.pages.dev` 與 `http://localhost|127.0.0.1[:port]`；
其餘**完全不回 `Access-Control-Allow-Origin`**（不回字面 `'null'`——它會被 opaque origin 命中）。
插件路徑**不套 origin 白名單**：它不是瀏覽器發的、根本沒有 `Origin`，用白名單擋只會擋到自己人。

---

## 安全與資料保存

- **UUID＝假名識別資料＋capability**（沿用 portal settings 的信任模型，122-bit 隨機、不公開）。
  知道 UUID 就能改該人的訂閱，所以不要外流。封鎖可被換 UUID 繞過——這是社交層防線的
  **已知上限**，不是疏漏（Owner 2026-08-02 拍板）。
- **webhook URL 是敏感憑證**：白名單只放行 `discord.com`／`discordapp.com` 的 https（防 SSRF，
  寫入與送出前各驗一次），任何回應與紀錄都只出現遮罩值。
- **保留期兩段**：事件列留 **90 天**（「什麼時候出過事件」是這功能唯一能累積的資料，7 天等於留不下東西）；
  結束滿 **7 天**即**去識別**——清掉 `reporter`／`confirms`／`disputes` 的 UUID，只留
  `nConfirm`／`nDispute` 計數（投票當下就同步維護，所以清掉陣列不失資訊）。
  `subs` 在 `worlds` 為空時實體刪列。
- **不存 IP／UA**（IP 只供 CF 原生限流短暫計數）。
