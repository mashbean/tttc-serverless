# Pocket TTTC · 口袋議題樹

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/tttc-serverless)

[Talk to the City](https://github.com/AIObjectives/tttc-light-js) 的輕量重寫：把一份 `id,interview,comment` 的 CSV 變成「主題 → 子主題 → 可辯論的主張 → 原句引述」的議題樹。整個系統是**一個 Cloudflare Worker**：Durable Object SQLite 存資料、DO alarm 跑管線、Workers AI（Gemma 4）做模型推論。沒有伺服器、沒有資料庫、沒有金鑰要設，按上面的按鈕就能部署，免費額度內可用。

## 它做什麼

四個步驟，順序與 Talk to the City 相同：

1. **分群** — 讀全部發言，提出最多 7 個主題、每個最多 6 個子主題（含描述）。
2. **抽取** — 每 8 則發言一批，抽出可辯論、原子性的主張，附上原句引述，對應到主題／子主題。抽不到就不抽。
3. **合併** — 同一子主題內至少 3 句主張時，把相近的主張歸成一句更高層次的主張，保留每句原始引述。
4. **摘要** — 每個主題 100–140 字。

結果頁可以展開到每一句引述，並標記發言者（`interview` 欄）。另有 `report.json` 與 `claims.csv` 下載。

## 免費額度怎麼撐

Workers AI 每日免費 10,000 神經元（UTC 重置）。每次模型呼叫前，系統用「UTF-8 位元組數 + 模板額外量」當輸入 token 上限、用強制的 `max_tokens` 當輸出，算出最壞情況的神經元數，並在兩層帳本預留：

- **每份報告**最多 9,000 神經元（`REPORT_NEURON_CEILING`），超過就標記失敗並說明原因；
- **全部署每日**最多 9,000（`DAILY_NEURON_CEILING`，留 1,000 餘裕），用完時報告進入 `waiting-budget`，隔日 00:05 UTC 自動續跑，已完成的步驟不重做。

預設每份最多 600 則發言（`MAX_ROWS`）。付費帳號可在 `wrangler.jsonc` 的 `vars` 調高兩個數字。

## 資料邊界

- 一份報告一個 Durable Object：輸入列、抽出的主張、議題樹都在裡面；報告網址是 10 碼隨機字串，知道網址的人能看。
- 建立時會拿到一次性的管理權杖（伺服器只存 SHA-256），可刪除整份報告或重新排程。
- 建立前必須傳 `confirmed: true`，代表呼叫者已確認資料沒有直接識別資訊、有權交給模型分析。
- 全站建立限制：每小時 10 份、每日 50 份。
- 沒有帳號、沒有追蹤、沒有第三方服務；模型推論留在 Cloudflare 帳號內。

## API

```
POST   /api/reports                     {title, description?, language?: "zh-Hant"|"en", csv, confirmed: true}
                                        → 201 {reportId, adminToken, urls:{report, api, manage}}
GET    /api/reports/:id                 進度與（完成後的）議題樹
GET    /api/reports/:id/report.json     只有議題樹
GET    /api/reports/:id/claims.csv      每句引述一列：topic,subtopic,claim,people,quote,interview,comment_id
POST   /api/reports/:id/retry           X-Report-Admin: <token>  失敗或等額度的報告重新排程
DELETE /api/reports/:id                 X-Report-Admin: <token>
GET    /api/health                      {ok, aiMode, maxRows, dailyNeuronsRemaining}
```

也可以用 `multipart/form-data` 上傳 `file`。CSV 接受任何欄位順序與多餘欄位，只要有 `id` 與 `comment`；`interview` 可省略。

## 和 delib 審議拼圖一起用

[delib.mashbean.net](https://delib.mashbean.net) 的 Pocket Polis 報告頁與 Call-in 都能直接匯出 `tttc.csv`，資料工作台可以把多份合併成一個檔；把那個檔貼進這裡就完成一輪文字綜整。

## 開發

```bash
npm install
npm run dev        # wrangler dev
npm test           # vitest（@cloudflare/vitest-pool-workers；AI_MODE=fake，不呼叫真正的模型）
npm run check      # typecheck + test + deploy --dry-run
npm run deploy
```

`AI_MODE=fake` 時模型呼叫回傳可預期的假結果，讓整條管線（含 DO alarm 與帳本）可以在測試裡跑完。

## 致謝與授權

管線設計（分群 → 抽取 → 合併 → 摘要）與提示詞結構來自 AI Objectives Institute 的 [Talk to the City](https://github.com/AIObjectives/tttc-light-js)（Apache-2.0）。免費額度神經元帳本的作法來自 [Pocket Polis](https://github.com/mashbean/pocket-polis)。本專案為獨立重寫，MIT 授權。
