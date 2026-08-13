import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import { createJob, filesDir, getItem, getItems, getJob, snapshot, updateItem, updateJob } from "./store.mjs";
import { mailReady, sendEncryptedPdf, verifyMailer } from "./mailer.mjs";
import { startWorker, wakeWorker } from "./worker.mjs";

const app = express();
const port = Number(process.env.PORT || 3000);
const maxPdfBytes = Number(process.env.MAX_PDF_MB || 15) * 1024 * 1024;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req, res) => res.json({ larkReady: mailReady(), maxRecipients: 1000, maxPdfMb: maxPdfBytes / 1024 / 1024 }));
app.post("/api/config/verify", async (_req, res) => {
  try { await verifyMailer(); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "SMTP 驗證失敗" }); }
});

app.post("/api/jobs", (req, res) => {
  try {
    const { subject, body, items } = req.body || {};
    if (!mailReady()) return res.status(503).json({ error: "Lark SMTP 尚未設定" });
    if (!String(subject || "").trim() || !String(body || "").trim()) return res.status(400).json({ error: "主旨與郵件內容不得空白" });
    if (!Array.isArray(items) || items.length < 1 || items.length > 1000) return res.status(400).json({ error: "每批必須包含 1 到 1,000 筆" });
    const names = new Set(); const emails = new Set(); const filenames = new Set();
    const prepared = items.map((item) => {
      const name = String(item.name || "").trim(); const email = String(item.email || "").trim().toLowerCase(); const filename = path.basename(String(item.filename || ""));
      if (!name || !emailPattern.test(email) || !filename.toLowerCase().endsWith(".pdf")) throw new Error("名單包含無效的姓名、Email 或 PDF 檔名");
      if (names.has(name.toLowerCase()) || emails.has(email) || filenames.has(filename.toLowerCase())) throw new Error("名單包含重複姓名、Email 或檔名");
      names.add(name.toLowerCase()); emails.add(email); filenames.add(filename.toLowerCase());
      return { id: crypto.randomUUID(), name, email, filename };
    });
    const id = crypto.randomUUID();
    createJob({ id, subject: String(subject), body: String(body), items: prepared, now: new Date().toISOString() });
    fs.mkdirSync(path.join(filesDir, id), { recursive: true });
    res.status(201).json({ jobId: id, items: prepared.map((item) => ({ itemId: item.id, filename: item.filename })) });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "建立任務失敗" }); }
});

app.get("/api/jobs/:jobId", (req, res) => {
  const result = snapshot(req.params.jobId);
  if (!result) return res.status(404).json({ error: "找不到任務" });
  res.json(result);
});

app.post("/api/jobs/:jobId/items/:itemId/upload", express.raw({ type: "application/pdf", limit: maxPdfBytes }), (req, res) => {
  const item = getItem(req.params.itemId, req.params.jobId);
  if (!item) return res.status(404).json({ error: "找不到任務項目" });
  if (!Buffer.isBuffer(req.body) || req.body.length < 8 || req.body.subarray(0, 5).toString() !== "%PDF-") return res.status(400).json({ error: "附件不是有效 PDF" });
  const target = path.join(filesDir, req.params.jobId, `${item.id}.pdf`);
  fs.writeFileSync(target, req.body, { flag: "w", mode: 0o600 });
  updateItem(item.id, { status: "uploaded", error: null });
  res.json({ ok: true });
});

app.post("/api/jobs/:jobId/start", (req, res) => {
  const job = getJob(req.params.jobId); if (!job) return res.status(404).json({ error: "找不到任務" });
  const items = getItems(job.id);
  if (items.some((item) => item.status === "waiting_upload")) return res.status(409).json({ error: "仍有附件尚未上傳" });
  if (req.body?.mode === "all" && job.status === "test_complete") {
    items.filter((item) => item.status === "uploaded").forEach((item) => updateItem(item.id, { status: "queued" }));
    updateJob(job.id, "all_queued");
    wakeWorker();
  } else return res.status(409).json({ error: "目前任務狀態不允許這項操作" });
  res.json({ ok: true });
});

app.post("/api/jobs/:jobId/test", async (req, res) => {
  const job = getJob(req.params.jobId); if (!job) return res.status(404).json({ error: "找不到任務" });
  if (job.status !== "uploading") return res.status(409).json({ error: "目前任務狀態不允許測試寄送" });
  const emails = Array.isArray(req.body?.emails) ? req.body.emails.map((email) => String(email).trim().toLowerCase()) : [];
  if (emails.length !== 3 || emails.some((email) => !emailPattern.test(email))) return res.status(400).json({ error: "必須提供 3 個有效的測試信箱" });
  if (new Set(emails).size !== 3) return res.status(400).json({ error: "3 個測試信箱不可重複" });
  const items = getItems(job.id);
  if (items.some((item) => item.status === "waiting_upload")) return res.status(409).json({ error: "仍有附件尚未上傳" });
  const item = items.find((value) => value.status === "uploaded");
  if (!item) return res.status(409).json({ error: "沒有可用的測試附件" });
  const filePath = path.join(filesDir, job.id, `${item.id}.pdf`);
  try {
    for (let index = 0; index < emails.length; index++) await sendEncryptedPdf({ job, item, filePath, to: emails[index], subjectPrefix: `[TEST ${index + 1}/3] ` });
    updateJob(job.id, "test_complete");
    res.json({ ok: true, filename: item.filename, deliveredTo: emails });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message.slice(0, 500) : "測試寄送失敗" }); }
});

const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((error, _req, res, _next) => res.status(error?.status || 500).json({ error: error?.message || "伺服器錯誤" }));
startWorker();
app.listen(port, "0.0.0.0", () => console.log(`PDF Mailer listening on http://localhost:${port} (background worker enabled)`));
