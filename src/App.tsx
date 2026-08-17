"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createQpdfRunner } from "qpdf-run";
import { normalizeMatchValue, pdfBaseName, resolveFilename } from "./filenameMatching";

type Recipient = {
  row: number;
  name: string;
  email: string;
  password: string;
};

type MatchStatus = "ready" | "missing_pdf" | "missing_email" | "missing_password" | "duplicate" | "invalid_filename";
type StatusFilter = "all" | "problem" | MatchStatus;

type MatchRow = Recipient & {
  key: string;
  pdf?: File;
  status: MatchStatus;
  manualMatched?: boolean;
  sendStatus?: "encrypting" | "uploaded" | "sending" | "sent" | "failed";
  message?: string;
};

type JobSnapshot = {
  job: { id: string; status: string; totalCount: number; uploadedCount: number; sentCount: number; failedCount: number };
  items: Array<{ id: string; name: string; email: string; filename: string; status: string; error?: string | null; isTest: boolean }>;
};

const aliases = {
  name: ["姓名", "名字", "name", "recipient", "收件人"],
  email: ["email", "e-mail", "mail", "信箱", "郵箱", "收件信箱", "電子郵件"],
  password: ["密碼", "密码", "password", "pdf密碼", "pdf密码"],
};

function normalize(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim();
}

function matchKey(value: unknown) {
  return normalizeMatchValue(value);
}

function baseName(filename: string) {
  return pdfBaseName(filename);
}

function findColumn(headers: string[], choices: string[]) {
  return headers.findIndex((header) => choices.some((choice) => matchKey(header) === matchKey(choice)));
}

function passwordStrength(password: string) {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^\w]/.test(password)) score++;
  return score;
}

function ownerPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function statusLabel(status: MatchStatus) {
  return {
    ready: "可以寄送",
    missing_pdf: "找不到 PDF",
    missing_email: "缺少 Email",
    missing_password: "缺少密碼",
    duplicate: "名稱重複",
    invalid_filename: "檔名無法辨識",
  }[status];
}

export default function Home() {
  const pdfInput = useRef<HTMLInputElement>(null);
  const excelInput = useRef<HTMLInputElement>(null);
  const [pdfs, setPdfs] = useState<File[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [excelName, setExcelName] = useState("");
  const [excelError, setExcelError] = useState("");
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [jobId, setJobId] = useState("");
  const [jobSnapshot, setJobSnapshot] = useState<JobSnapshot | null>(null);
  const [progressText, setProgressText] = useState("");
  const [larkReady, setLarkReady] = useState<boolean | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [subject, setSubject] = useState("【個人文件】{{name}} 您的加密 PDF 文件");
  const [mailBody, setMailBody] = useState("{{name}} 您好：\n\n附件是您的加密 PDF 文件，請使用約定的密碼開啟。\n\n如有問題，請聯絡相關承辦人員。\n謝謝");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [testEmails, setTestEmails] = useState(["", "", ""]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const summary = useMemo(() => ({
    total: rows.length,
    ready: rows.filter((row) => row.status === "ready").length,
    problem: rows.filter((row) => row.status !== "ready").length,
    sent: rows.filter((row) => row.sendStatus === "sent").length,
  }), [rows]);

  const problemCounts = useMemo(() => ({
    missing_pdf: rows.filter((row) => row.status === "missing_pdf").length,
    missing_email: rows.filter((row) => row.status === "missing_email").length,
    missing_password: rows.filter((row) => row.status === "missing_password").length,
    duplicate: rows.filter((row) => row.status === "duplicate").length,
    invalid_filename: rows.filter((row) => row.status === "invalid_filename").length,
  }), [rows]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "problem") return row.status !== "ready";
    return row.status === statusFilter;
  }), [rows, statusFilter]);

  const previewRows = useMemo(() => rows.filter((row) => row.status === "ready" && row.pdf), [rows]);
  const previewRow = previewRows[previewIndex];

  function renderTemplate(template: string, row: MatchRow) {
    return template
      .replace(/{{\s*name\s*}}/gi, row.name)
      .replace(/{{\s*email\s*}}/gi, row.email)
      .replace(/{{\s*filename\s*}}/gi, row.pdf?.name || "");
  }

  function openPreview() {
    if (summary.problem || previewRows.length === 0) return;
    setPreviewIndex(0);
    setPreviewOpen(true);
  }

  useEffect(() => {
    fetch("/api/config").then((response) => response.json()).then((value: { larkReady?: boolean }) => setLarkReady(Boolean(value.larkReady))).catch(() => setLarkReady(false));
    const saved = localStorage.getItem("pdf-mailer-active-job");
    if (saved) {
      setJobId(saved);
      void refreshJob(saved);
    }
    // The saved task is intentionally loaded once when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshJob(id = jobId) {
    if (!id) return null;
    try {
      const response = await fetch(`/api/jobs/${id}`);
      if (response.status === 404 || response.status === 410) {
        localStorage.removeItem("pdf-mailer-active-job");
        setJobId("");
        setJobSnapshot(null);
        setProgressText("");
        setConfirmed(false);
        return null;
      }
      if (!response.ok) throw new Error(`讀取任務失敗：${response.status}`);
      const snapshot = await response.json() as JobSnapshot;
      setJobSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      console.error("讀取寄送任務失敗", error);
      return null;
    }
  }

  function rebuild(nextPdfs = pdfs, nextRecipients = recipients) {
    const nameCounts = new Map<string, number>();
    nextRecipients.forEach((person) => nameCounts.set(matchKey(person.name), (nameCounts.get(matchKey(person.name)) ?? 0) + 1));

    const pdfMap = new Map<string, File[]>();
    const unmatchedPdfs: Array<{ pdf: File; message: string }> = [];
    nextPdfs.forEach((pdf) => {
      const resolved = resolveFilename(pdf.name, nextRecipients.map((person) => person.name));
      if (resolved.status === "matched") {
        const key = matchKey(resolved.name);
        pdfMap.set(key, [...(pdfMap.get(key) ?? []), pdf]);
      } else if (resolved.status === "ambiguous") {
        unmatchedPdfs.push({ pdf, message: `檔名同時符合多位員工：${resolved.names.join("、")}` });
      } else {
        unmatchedPdfs.push({ pdf, message: "PDF 檔名中找不到可辨識的員工姓名" });
      }
    });

    const matched = nextRecipients.map<MatchRow>((person) => {
      const key = matchKey(person.name);
      const files = pdfMap.get(key) ?? [];
      let status: MatchStatus = "ready";
      if (!person.email) status = "missing_email";
      else if (!person.password) status = "missing_password";
      else if ((nameCounts.get(key) ?? 0) > 1 || files.length > 1) status = "duplicate";
      else if (files.length === 0) status = "missing_pdf";
      return { ...person, key: `recipient-${person.row}-${key}`, pdf: files[0], status };
    });

    unmatchedPdfs.forEach(({ pdf, message }, index) => {
      const key = matchKey(baseName(pdf.name));
      matched.push({ row: 0, name: baseName(pdf.name), email: "", password: "", key: `unmatched-${key}-${index}`, pdf, status: "invalid_filename", message });
    });
    setRows(matched);
    setConfirmed(false);
  }

  function manualAssignPdf(sourceKey: string, recipientRow: number) {
    if (!recipientRow) return;
    setRows((current) => {
      const source = current.find((row) => row.key === sourceKey && row.row === 0 && row.pdf);
      const person = recipients.find((recipient) => recipient.row === recipientRow);
      const target = current.find((row) => row.row === recipientRow);
      if (!source?.pdf || !person || !target || target.pdf) return current;

      const normalizedName = matchKey(person.name);
      const duplicatedName = recipients.filter((recipient) => matchKey(recipient.name) === normalizedName).length > 1;
      let status: MatchStatus = "ready";
      if (!person.email) status = "missing_email";
      else if (!person.password) status = "missing_password";
      else if (duplicatedName) status = "duplicate";

      return current
        .filter((row) => row.key !== sourceKey)
        .map((row) => row.row === recipientRow
          ? { ...row, ...person, pdf: source.pdf, status, manualMatched: true, message: undefined }
          : row);
    });
    setConfirmed(false);
  }

  function removePdf(row: MatchRow) {
    if (!row.pdf || jobId || isSending) return;
    if (!window.confirm(`確定要從這一批移除「${row.pdf.name}」嗎？\n其他 PDF 與 Excel 名單不會受到影響。`)) return;

    const targetPdf = row.pdf;
    const nextPdfs = pdfs.filter((pdf) => pdf !== targetPdf);
    setPdfs(nextPdfs);
    setRows((current) => {
      if (row.row === 0) return current.filter((item) => item.key !== row.key);

      const recipientNameCounts = recipients.filter((person) => matchKey(person.name) === matchKey(row.name)).length;
      const remainingMatches = nextPdfs.filter((pdf) => {
        const resolved = resolveFilename(pdf.name, recipients.map((person) => person.name));
        return resolved.status === "matched" && matchKey(resolved.name) === matchKey(row.name);
      });
      let status: MatchStatus = "ready";
      if (!row.email) status = "missing_email";
      else if (!row.password) status = "missing_password";
      else if (recipientNameCounts > 1 || remainingMatches.length > 1) status = "duplicate";
      else if (remainingMatches.length === 0) status = "missing_pdf";

      return current.map((item) => item.key === row.key
        ? { ...item, pdf: remainingMatches[0], status, manualMatched: false, message: undefined }
        : item);
    });
    setConfirmed(false);
  }

  function handlePdfs(files: FileList | null) {
    const next = Array.from(files ?? []).filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    setPdfs(next);
    rebuild(next, recipients);
  }

  async function handleExcel(file?: File) {
    if (!file) return;
    setExcelError("");
    setExcelName(file.name);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const values = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
      const headers = (values[0] ?? []).map(normalize);
      const nameIndex = findColumn(headers, aliases.name);
      const emailIndex = findColumn(headers, aliases.email);
      const passwordIndex = findColumn(headers, aliases.password);
      if (nameIndex < 0 || emailIndex < 0 || passwordIndex < 0) {
        throw new Error("Excel 第一列必須包含：姓名、Email、密碼");
      }
      const next = values.slice(1)
        .map((row, index) => ({ row: index + 2, name: normalize(row[nameIndex]), email: normalize(row[emailIndex]), password: normalize(row[passwordIndex]) }))
        .filter((person) => person.name);
      setRecipients(next);
      rebuild(pdfs, next);
    } catch (error) {
      setRecipients([]);
      setRows([]);
      setExcelError(error instanceof Error ? error.message : "Excel 讀取失敗");
    }
  }

  function downloadTemplate() {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["姓名", "Email", "密碼"],
      ["Sierra", "sierra@example.com", "Si@2026-001"],
    ]);
    sheet["!cols"] = [{ wch: 18 }, { wch: 30 }, { wch: 22 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "寄送名單");
    XLSX.writeFile(workbook, "PDF寄送名單範本.xlsx");
  }

  async function prepareJob(fromPreview = false) {
    const ready = rows.filter((row) => row.status === "ready" && row.pdf);
    if ((!confirmed && !fromPreview) || ready.length === 0 || isSending || jobId) return;
    setConfirmed(true);
    setPreviewOpen(false);
    setIsSending(true);
    setProgressText("正在建立安全寄送任務…");
    let runner: Awaited<ReturnType<typeof createQpdfRunner>> | null = null;
    try {
      const createResponse = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body: mailBody, items: ready.map((item) => ({ name: item.name, email: item.email, filename: item.pdf!.name })) }),
      });
      const created = await createResponse.json() as { jobId?: string; items?: Array<{ itemId: string; filename: string }>; error?: string };
      if (!createResponse.ok || !created.jobId || !created.items) throw new Error(created.error || "建立任務失敗");
      setJobId(created.jobId);
      localStorage.setItem("pdf-mailer-active-job", created.jobId);
      const itemIds = new Map(created.items.map((item) => [item.filename, item.itemId]));
      runner = await createQpdfRunner({
        workerUrl: new URL("qpdf-run/worker", import.meta.url).href,
        qpdfJsUrl: new URL("qpdf-run/qpdf.js", import.meta.url).href,
        wasmUrl: new URL("qpdf-run/qpdf.wasm", import.meta.url).href,
        timeoutMs: 60000,
      });
      for (let index = 0; index < ready.length; index++) {
        const item = ready[index];
        setProgressText(`正在加密並上傳 ${index + 1} / ${ready.length}：${item.name}`);
        setRows((current) => current.map((row) => row.key === item.key ? { ...row, sendStatus: "encrypting", message: "正在加密…" } : row));
        try {
          const input = new Uint8Array(await item.pdf!.arrayBuffer());
          const encrypted = await runner.runOne({
            input,
            inputName: "input.pdf",
            outputName: "encrypted.pdf",
            args: ["--encrypt", item.password, ownerPassword(), "256", "--", "input.pdf", "encrypted.pdf"],
          });
          const itemId = itemIds.get(item.pdf!.name);
          if (!itemId) throw new Error("找不到任務項目");
          const encryptedBuffer = Uint8Array.from(encrypted).buffer;
          const response = await fetch(`/api/jobs/${created.jobId}/items/${itemId}/upload`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: new Blob([encryptedBuffer], { type: "application/pdf" }) });
          const result = await response.json() as { ok?: boolean; error?: string };
          if (!response.ok || !result.ok) throw new Error(result.error || "加密附件上傳失敗");
          setRows((current) => current.map((row) => row.key === item.key ? { ...row, sendStatus: "uploaded", message: "已進入安全佇列" } : row));
        } catch (error) {
          setRows((current) => current.map((row) => row.key === item.key ? { ...row, sendStatus: "failed", message: error instanceof Error ? error.message : "處理失敗" } : row));
        }
      }
      await refreshJob(created.jobId);
      setProgressText("所有加密附件已安全排入佇列，下一步先寄 3 封測試信。");
    } catch (error) {
      setProgressText(error instanceof Error ? error.message : "準備任務失敗");
    } finally {
      await runner?.destroy();
      setIsSending(false);
    }
  }

  async function runQueue(mode: "test" | "all") {
    if (!jobId || isSending) return;
    setIsSending(true);
    try {
      if (mode === "test") {
        const normalized = testEmails.map((email) => email.trim().toLocaleLowerCase());
        if (normalized.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("請完整填寫 3 個有效的測試信箱");
        if (new Set(normalized).size !== 3) throw new Error("3 個測試信箱不可重複");
        setProgressText("正在把同一份加密 PDF 寄到 3 個測試信箱…");
        const response = await fetch(`/api/jobs/${jobId}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails: normalized }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || "測試寄送失敗");
        await refreshJob(jobId);
        setProgressText("同一份加密 PDF 已寄到 3 個不同測試信箱，請確認後再放行全部。");
        return;
      }
      const start = await fetch(`/api/jobs/${jobId}/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      const startResult = await start.json() as { error?: string };
      if (!start.ok) throw new Error(startResult.error || "無法啟動寄送");
      setProgressText("正式批次寄送已開始，可安全續跑。");
      for (let cycle = 0; cycle < 1200; cycle++) {
        const snapshot = await refreshJob(jobId);
        if (!snapshot) throw new Error("無法讀取任務進度");
        if (mode === "all" && snapshot.job.status === "completed") { setProgressText("整批寄送完成，可匯出結果清單。"); break; }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error) {
      setProgressText(error instanceof Error ? error.message : "寄送失敗");
    } finally {
      setIsSending(false);
    }
  }

  function exportResults() {
    if (!jobSnapshot) return;
    const data = jobSnapshot.items.map((item) => ({ 姓名: item.name, Email: item.email, PDF檔案: item.filename, 寄送狀態: item.status, 錯誤訊息: item.error || "" }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), "寄送結果");
    XLSX.writeFile(workbook, `PDF寄送結果_${jobSnapshot.job.id.slice(0, 8)}.xlsx`);
  }

  function clearFinishedJob() {
    localStorage.removeItem("pdf-mailer-active-job");
    setJobId(""); setJobSnapshot(null); setProgressText(""); setRows([]); setPdfs([]); setRecipients([]); setConfirmed(false); setExcelName("");
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">P</span><span>PDF 安全寄送</span></div>
        <div className="security-pill"><span className="dot" />檔案在瀏覽器內加密</div>
      </header>

      <div className="shell">
        {larkReady === false && <div className="setup-banner"><strong>Lark Mail 尚未連接</strong><span>目前可檢查 PDF 與 Excel 配對；完成寄件應用設定後，才會開放建立正式任務。</span></div>}
        <section className="hero">
          <p className="eyebrow">BATCH ENCRYPTION · LARK MAIL</p>
          <h1>批次加密，確認後再寄出。</h1>
          <p>一次放入所有 PDF 與一份 Excel 名單。系統會依檔名配對姓名、密碼與 Email，先讓你核對，再逐封寄送。</p>
        </section>

        <section className="workflow-card">
          <div className="steps">
            <div className="step active"><span>1</span><strong>上傳資料</strong></div>
            <div className={`step ${rows.length ? "active" : ""}`}><span>2</span><strong>核對匹配</strong></div>
            <div className={`step ${rows.length && !summary.problem ? "active" : ""}`}><span>3</span><strong>預覽郵件</strong></div>
            <div className={`step ${confirmed ? "active" : ""}`}><span>4</span><strong>加密寄送</strong></div>
          </div>

          <div className="upload-grid">
            <button className="dropzone" onClick={() => pdfInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handlePdfs(event.dataTransfer.files); }}>
              <input ref={pdfInput} type="file" multiple accept="application/pdf,.pdf" onChange={(event) => handlePdfs(event.target.files)} />
              <span className="upload-icon">PDF</span>
              <strong>上傳全部 PDF</strong>
              <small>可一次選擇多份，檔名需對應姓名</small>
              <em>{pdfs.length ? `已選擇 ${pdfs.length} 份 PDF` : "拖曳到這裡，或點擊選擇"}</em>
            </button>

            <button className="dropzone" onClick={() => excelInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleExcel(event.dataTransfer.files[0]); }}>
              <input ref={excelInput} type="file" accept=".xlsx,.xls" onChange={(event) => handleExcel(event.target.files?.[0])} />
              <span className="upload-icon excel">XLS</span>
              <strong>上傳 Excel 名單</strong>
              <small>第一列包含「姓名、Email、密碼」</small>
              <em>{excelName || "拖曳到這裡，或點擊選擇"}</em>
            </button>
          </div>

          <div className="template-row">
            <span>{excelError || "支援：Sierra.pdf、薪資202607_Sierra.pdf、202607-Sierra.pdf　→　Excel 姓名：Sierra"}</span>
            <button onClick={downloadTemplate}>下載 Excel 範本</button>
          </div>
        </section>

        {rows.length > 0 && <section className="results-card">
          <div className="section-head">
            <div><p className="eyebrow">MATCHING REVIEW</p><h2>匹配結果</h2></div>
            <div className="filter-area">
              <div className="stats" role="group" aria-label="狀態篩選">
                <button className={statusFilter === "all" ? "selected" : ""} onClick={() => setStatusFilter("all")}><b>{summary.total}</b> 全部</button>
                <button className={`ok ${statusFilter === "ready" ? "selected" : ""}`} onClick={() => setStatusFilter("ready")}><b>{summary.ready}</b> 可寄送</button>
                <button className={`warn ${statusFilter !== "all" && statusFilter !== "ready" ? "selected" : ""}`} onClick={() => setStatusFilter("problem")}><b>{summary.problem}</b> 需處理</button>
              </div>
              {summary.problem > 0 && <label className="problem-select">異常類型
                <select value={statusFilter === "all" || statusFilter === "ready" ? "problem" : statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                  <option value="problem">全部異常（{summary.problem}）</option>
                  {problemCounts.missing_pdf > 0 && <option value="missing_pdf">找不到 PDF（{problemCounts.missing_pdf}）</option>}
                  {problemCounts.missing_email > 0 && <option value="missing_email">缺少 Email（{problemCounts.missing_email}）</option>}
                  {problemCounts.missing_password > 0 && <option value="missing_password">缺少密碼（{problemCounts.missing_password}）</option>}
                  {problemCounts.duplicate > 0 && <option value="duplicate">名稱重複（{problemCounts.duplicate}）</option>}
                  {problemCounts.invalid_filename > 0 && <option value="invalid_filename">檔名無法辨識（{problemCounts.invalid_filename}）</option>}
                </select>
              </label>}
            </div>
          </div>

          <div className="filter-summary"><strong>目前顯示 {filteredRows.length} 筆</strong><span>{statusFilter === "all" ? "全部資料" : statusFilter === "ready" ? "只顯示可寄送" : statusFilter === "problem" ? "只顯示所有異常" : `只顯示：${statusLabel(statusFilter)}`}</span></div>

          <div className="table-wrap">
            <table>
              <thead><tr><th>姓名</th><th>PDF 檔案</th><th>收件 Email</th><th>密碼檢查</th><th>狀態</th></tr></thead>
              <tbody>{filteredRows.map((row) => <tr key={row.key}>
                <td><strong>{row.name}</strong>{row.row > 0 && <small>Excel 第 {row.row} 列</small>}</td>
                <td>
                  <div className="pdf-file-line">
                    <span className="pdf-name">{row.pdf?.name || "—"}</span>
                    {row.pdf && !jobId && <button type="button" className="remove-pdf-button" disabled={isSending} onClick={() => removePdf(row)} aria-label={`移除 ${row.pdf.name}`}>移除 PDF</button>}
                  </div>
                  {row.status === "invalid_filename" && row.pdf && <label className="manual-match">
                    <span>不用重傳，手動指定員工</span>
                    <select defaultValue="" onChange={(event) => manualAssignPdf(row.key, Number(event.target.value))}>
                      <option value="" disabled>選擇 Excel 員工…</option>
                      {recipients.map((person) => {
                        const occupied = rows.some((item) => item.row === person.row && Boolean(item.pdf));
                        return <option key={person.row} value={person.row} disabled={occupied}>{person.name} — Excel 第 {person.row} 列{occupied ? "（已有 PDF）" : ""}</option>;
                      })}
                    </select>
                  </label>}
                </td>
                <td>{row.email || "—"}</td>
                <td>{row.password ? <span className={passwordStrength(row.password) >= 3 ? "strength good" : "strength weak"}>{"•".repeat(Math.min(row.password.length, 10))}　{passwordStrength(row.password) >= 3 ? "良好" : "偏弱"}</span> : "—"}</td>
                <td><span className={`badge ${row.sendStatus || row.status}`}>{row.sendStatus === "encrypting" ? "正在加密" : row.sendStatus === "uploaded" ? "已排入佇列" : row.sendStatus === "sending" ? row.message : row.sendStatus === "sent" ? "已寄送" : row.sendStatus === "failed" ? "處理失敗" : statusLabel(row.status)}</span>{row.manualMatched && <small className="manual-message">已在前端手動配對</small>}{row.message && !["encrypting", "sending"].includes(row.sendStatus || "") && <small className="row-message">{row.message}</small>}</td>
              </tr>)}{filteredRows.length === 0 && <tr><td colSpan={5} className="empty-filter">這個篩選條件目前沒有資料</td></tr>}</tbody>
            </table>
          </div>

          <div className="compose-grid">
            <label>郵件主旨模板<input value={subject} onChange={(event) => { setSubject(event.target.value); setConfirmed(false); }} /></label>
            <label>郵件內容模板<textarea value={mailBody} onChange={(event) => { setMailBody(event.target.value); setConfirmed(false); }} /></label>
          </div>
          <div className="variable-help"><strong>可套用欄位：</strong><code>{"{{name}}"}</code> 員工姓名　<code>{"{{email}}"}</code> 收件信箱　<code>{"{{filename}}"}</code> PDF 檔名</div>

          <div className="send-panel">
            <div className="review-note"><strong>下一步會逐封預覽</strong><span>可使用左右按鈕檢查全部郵件，預覽不會寄出。</span></div>
            <div>
              <p>{progressText || (summary.problem ? "請先修正所有問題，再進入預覽。" : `共 ${summary.ready} 封郵件等待預覽`)}</p>
              <button className="send-button" disabled={summary.problem > 0 || isSending || Boolean(jobId)} onClick={openPreview}>{jobId ? "已建立安全任務" : "下一步：預覽全部郵件"}</button>
            </div>
          </div>
        </section>}

        {previewOpen && previewRow && <div className="preview-overlay" role="dialog" aria-modal="true" aria-label="郵件預覽">
          <section className="preview-dialog">
            <div className="preview-head">
              <div><p className="eyebrow">EMAIL REVIEW</p><h2>預覽郵件內容</h2></div>
              <div className="preview-count">第 <b>{previewIndex + 1}</b> 封／共 {previewRows.length} 封</div>
            </div>
            <div className="preview-recipient"><span>收件人</span><strong>{previewRow.name}</strong><em>{previewRow.email}</em></div>
            <div className="email-preview">
              <div className="email-line"><span>主旨</span><strong>{renderTemplate(subject, previewRow)}</strong></div>
              <div className="email-body">{renderTemplate(mailBody, previewRow)}</div>
              <div className="attachment-chip"><span>PDF</span><div><strong>{previewRow.pdf?.name}</strong><small>加密附件・AES-256</small></div></div>
            </div>
            <div className="preview-nav">
              <button className="secondary-button" disabled={previewIndex === 0} onClick={() => setPreviewIndex((value) => value - 1)}>← 上一封</button>
              <input aria-label="預覽進度" type="range" min="1" max={previewRows.length} value={previewIndex + 1} onChange={(event) => setPreviewIndex(Number(event.target.value) - 1)} />
              <button className="secondary-button" disabled={previewIndex === previewRows.length - 1} onClick={() => setPreviewIndex((value) => value + 1)}>下一封 →</button>
            </div>
            <div className="preview-actions">
              <button className="text-button" onClick={() => setPreviewOpen(false)}>返回修改模板</button>
              <button className="send-button" disabled={isSending || larkReady !== true} onClick={() => void prepareJob(true)}>{larkReady === false ? "請先連接 Lark Mail" : `確認全部 ${previewRows.length} 封，建立加密任務`}</button>
            </div>
            <p className="preview-warning">此按鈕會建立加密任務，但仍不會立刻整批寄出；後續會先寄 3 封測試信。</p>
          </section>
        </div>}

        {jobSnapshot && <section className="queue-card">
          <div className="section-head"><div><p className="eyebrow">DURABLE DELIVERY QUEUE</p><h2>安全寄送佇列</h2></div><span className={`job-status ${jobSnapshot.job.status}`}>{jobSnapshot.job.status}</span></div>
          <div className="queue-metrics">
            <div><b>{jobSnapshot.job.totalCount}</b><span>總件數</span></div><div><b>{jobSnapshot.job.uploadedCount}</b><span>已加密上傳</span></div><div><b>{jobSnapshot.job.sentCount}</b><span>寄送成功</span></div><div><b>{jobSnapshot.job.failedCount}</b><span>最終失敗</span></div>
          </div>
          <div className="progress-track"><i style={{ width: `${Math.round((jobSnapshot.job.sentCount + jobSnapshot.job.failedCount) / jobSnapshot.job.totalCount * 100)}%` }} /></div>
          <div className="test-mail-panel">
            <div><strong>3 個測試收件信箱</strong><span>只會將第 1 份加密附件「{jobSnapshot.items[0]?.filename}」分別寄到以下信箱，不會寄給正式員工。</span></div>
            <div className="test-email-grid">{testEmails.map((email, index) => <label key={index}>測試信箱 {index + 1}<input type="email" value={email} placeholder={`test${index + 1}@example.com`} disabled={isSending || jobSnapshot.job.status === "test_complete" || jobSnapshot.job.status === "completed"} onChange={(event) => setTestEmails((current) => current.map((value, emailIndex) => emailIndex === index ? event.target.value : value))} /></label>)}</div>
          </div>
          <div className="queue-actions">
            <p>{progressText || "正式寄送前，將同一份加密 PDF 寄到 3 個指定測試信箱。"}</p>
            <div>
              <button className="secondary-button" disabled={isSending || jobSnapshot.job.status !== "uploading" || jobSnapshot.job.uploadedCount !== jobSnapshot.job.totalCount} onClick={() => runQueue("test")}>寄到 3 個測試信箱</button>
              <button className="send-button" disabled={isSending || jobSnapshot.job.status !== "test_complete"} onClick={() => runQueue("all")}>測試確認，放行全部</button>
              <button className="secondary-button" onClick={exportResults}>匯出結果</button>
              {jobSnapshot.job.status === "completed" && <button className="text-button" onClick={clearFinishedJob}>建立下一批</button>}
            </div>
          </div>
        </section>}

        <footer><span>AES-256 PDF 加密</span><span>最多 1,000 人一批</span><span>中斷後保留任務進度</span><span>成功後刪除附件</span></footer>
      </div>
    </main>
  );
}
