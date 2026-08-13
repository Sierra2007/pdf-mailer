import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), "pdf-mailer-runtime"));
fs.mkdirSync(dataDir, { recursive: true });
export const filesDir = path.join(dataDir, "encrypted-files");
fs.mkdirSync(filesDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "mailer.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
    filename TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting_upload', error TEXT,
    is_test INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT, created_at TEXT NOT NULL,
    UNIQUE(job_id, filename), FOREIGN KEY(job_id) REFERENCES jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_items_job_status ON items(job_id, status);
`);

export function createJob({ id, subject, body, items, now }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO jobs(id,status,subject,body,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, "uploading", subject, body, now, now);
    const insert = db.prepare("INSERT INTO items(id,job_id,name,email,filename,status,created_at) VALUES(?,?,?,?,?,'waiting_upload',?)");
    for (const item of items) insert.run(item.id, id, item.name, item.email, item.filename, now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function getJob(id) { return db.prepare("SELECT * FROM jobs WHERE id=?").get(id); }
export function getItem(id, jobId) { return db.prepare("SELECT * FROM items WHERE id=? AND job_id=?").get(id, jobId); }
export function getItems(jobId) { return db.prepare("SELECT * FROM items WHERE job_id=? ORDER BY created_at,id").all(jobId); }
export function updateItem(id, fields) {
  const allowed = ["status", "error", "is_test", "attempts", "sent_at"];
  const keys = Object.keys(fields).filter((key) => allowed.includes(key));
  if (!keys.length) return;
  db.prepare(`UPDATE items SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=?`).run(...keys.map((key) => fields[key]), id);
}
export function updateJob(id, status) { db.prepare("UPDATE jobs SET status=?,updated_at=? WHERE id=?").run(status, new Date().toISOString(), id); }
export function nextQueued(jobId, limit) { return db.prepare("SELECT * FROM items WHERE job_id=? AND status='queued' ORDER BY is_test DESC,created_at,id LIMIT ?").all(jobId, limit); }
export function activeJobs() { return db.prepare("SELECT * FROM jobs WHERE status='all_queued' ORDER BY updated_at").all(); }
export function recoverInterruptedItems() { db.prepare("UPDATE items SET status='queued',error='服務重啟後自動恢復' WHERE status='sending'").run(); }
export function expiredJobs(beforeIso) { return db.prepare("SELECT id FROM jobs WHERE status='completed' AND updated_at<?").all(beforeIso); }
export function deleteJob(id) {
  db.exec("BEGIN IMMEDIATE");
  try { db.prepare("DELETE FROM items WHERE job_id=?").run(id); db.prepare("DELETE FROM jobs WHERE id=?").run(id); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function snapshot(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  const items = getItems(jobId);
  return {
    job: {
      id: job.id, status: job.status, totalCount: items.length,
      uploadedCount: items.filter((item) => !["waiting_upload"].includes(item.status)).length,
      sentCount: items.filter((item) => item.status === "sent").length,
      failedCount: items.filter((item) => item.status === "failed").length,
    },
    items: items.map((item) => ({ id: item.id, name: item.name, email: item.email, filename: item.filename, status: item.status, error: item.error, isTest: Boolean(item.is_test) })),
  };
}
