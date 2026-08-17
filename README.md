# PDF 批次加密寄送 — 前端

React + TypeScript + Vite 前端，以及 Node.js + SQLite + Lark SMTP 後端。

## 本機啟動

需要 Node.js 20 以上版本。

```bash
npm install
npm run dev
```

另一個終端機啟動後端：

```bash
cp .env.example .env
# 修改 .env 後，程式會自動讀取
npm run server
```

整合啟動（後端同時提供建置後的前端）：

```bash
npm run local
```

正式建置：

```bash
npm run build
npm run preview
```

## Excel 欄位

第一列請放：

```text
姓名 | Email | 密碼
```

檔名會以完整姓名或 `_`、`-`、空格等分隔段落比對，英文不分大小寫。以下都會配對姓名 `Sierra`：

```text
Sierra.pdf
薪資202607_Sierra.pdf
薪資202607_sierra.pdf
202607-Sierra.pdf
薪資_202607_Sierra.pdf
```

年月或前綴可以變動，只要姓名仍是獨立段落即可。若同一檔名命中多位員工，系統會標記衝突並禁止寄送，不做模糊猜測。

## 後端 API

目前以前後端同網域的 `/api/*` 為預設。此專案已預留以下 API：

- `GET /api/config`
- `POST /api/jobs`
- `GET /api/jobs/:jobId`
- `POST /api/jobs/:jobId/files/:itemId`
- `POST /api/jobs/:jobId/start`

郵箱密鑰只放在後端 `.env`，不得寫入前端或提交 Git。

Lark Mail 使用 `smtp.larksuite.com`、SSL 連線埠 `465`。管理員必須先允許第三方郵件用戶端，寄件帳號再產生第三方專用密碼；`.env` 的 `SMTP_PASSWORD` 填專用密碼，不是平常登入密碼。

## 目前涵蓋

- 最多 1,000 份資料的介面與流程
- 多 PDF + 單一 Excel 上傳
- 重複姓名、缺少 Email、缺少密碼、找不到 PDF 等檢查
- 匹配結果可切換全部、可寄送、全部異常，並依異常類型與數量篩選
- 檔名無法辨識時，可直接在異常列選擇 Excel 員工重新配對，不必重傳 PDF 或 Excel
- 郵件主旨與內文支援 `{{name}}`、`{{email}}`、`{{filename}}` 欄位
- 送出前逐封預覽，可用上一封、下一封與滑桿檢查全部郵件
- 瀏覽器內使用 qpdf WebAssembly 進行 AES-256 加密
- 將第 1 份加密 PDF 分別寄到 3 個不同的指定測試信箱，不寄給正式員工
- 3 封測試確認後，再放行正式名單
- 進度顯示與結果匯出

正式放行後由後端背景 Worker 持續寄送，關閉瀏覽器也不會中斷。每封最多重試三次，寄送完成後立即刪除全部附件；結果紀錄預設保留 24 小時後自動刪除。資料使用暫存目錄，Zeabur 不掛 Volume，因此不做永久保存。
