import fs from "node:fs";
import path from "node:path";
import { activeJobs, deleteJob, expiredJobs, filesDir, getItems, nextQueued, recoverInterruptedItems, updateItem, updateJob } from "./store.mjs";
import { sendEncryptedPdf } from "./mailer.mjs";

const intervalMs = Math.max(Number(process.env.WORKER_INTERVAL_MS || 2000), 250);
const retentionHours = Math.max(Number(process.env.RESULT_RETENTION_HOURS || 24), 1);
let running = false;

async function processJob(job) {
  const queued = nextQueued(job.id, 1);
  for (const item of queued) {
    const filePath = path.join(filesDir, job.id, `${item.id}.pdf`);
    try {
      updateItem(item.id, { status: "sending", attempts: item.attempts + 1, error: null });
      await sendEncryptedPdf({ job, item, filePath });
      updateItem(item.id, { status: "sent", sent_at: new Date().toISOString() });
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      const attempts = item.attempts + 1;
      updateItem(item.id, { status: attempts < 3 ? "queued" : "failed", attempts, error: error instanceof Error ? error.message.slice(0, 500) : "寄送失敗" });
    }
  }
  const current = getItems(job.id);
  if (current.length && current.every((item) => ["sent", "failed"].includes(item.status))) {
    updateJob(job.id, "completed");
    fs.rmSync(path.join(filesDir, job.id), { recursive: true, force: true });
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    for (const job of activeJobs()) await processJob(job);
    const cutoff = new Date(Date.now() - retentionHours * 3600_000).toISOString();
    for (const { id } of expiredJobs(cutoff)) { fs.rmSync(path.join(filesDir, id), { recursive: true, force: true }); deleteJob(id); }
  } finally { running = false; }
}

export function startWorker() {
  recoverInterruptedItems();
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
}

export function wakeWorker() { void tick(); }
