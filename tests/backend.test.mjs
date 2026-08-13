import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("完整任務：上傳、測試三封、放行全部、刪除附件", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-mailer-"));
  const port = 3900 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SMTP_JSON_TRANSPORT: "true", WORKER_INTERVAL_MS: "250" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { server.kill("SIGTERM"); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const recipients = ["Sierra", "Amy", "Ben", "Cathy"].map((name) => ({ name, email: `${name.toLowerCase()}@example.com`, filename: `${name}.pdf` }));
  const createdResponse = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "文件：{{name}}", body: "{{name}} 您好", items: recipients }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
  for (const item of created.items) {
    const upload = await fetch(`${base}/api/jobs/${created.jobId}/items/${item.itemId}/upload`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf });
    assert.equal(upload.status, 200);
  }
  let response = await fetch(`${base}/api/jobs/${created.jobId}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails: ["test1@example.com", "test2@example.com", "test3@example.com"] }) });
  assert.equal(response.status, 200);
  let snapshot = await (await fetch(`${base}/api/jobs/${created.jobId}`)).json();
  assert.equal(snapshot.job.status, "test_complete"); assert.equal(snapshot.job.sentCount, 0);
  assert.equal(fs.readdirSync(path.join(dataDir, "encrypted-files", created.jobId)).length, 4);
  response = await fetch(`${base}/api/jobs/${created.jobId}/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "all" }) });
  assert.equal(response.status, 200);
  for (let attempt = 0; attempt < 120; attempt++) {
    snapshot = await (await fetch(`${base}/api/jobs/${created.jobId}`)).json();
    if (snapshot.job.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(snapshot.job.status, "completed"); assert.equal(snapshot.job.sentCount, 4);
  assert.equal(fs.existsSync(path.join(dataDir, "encrypted-files", created.jobId)), false);
});
