import nodemailer from "nodemailer";

let transporter;

export function mailReady() {
  if (process.env.SMTP_JSON_TRANSPORT === "true") return true;
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.MAIL_FROM);
}

function client() {
  if (!mailReady()) throw new Error("Lark SMTP 尚未設定完成");
  if (process.env.SMTP_JSON_TRANSPORT === "true") {
    transporter ||= nodemailer.createTransport({ jsonTransport: true });
    return transporter;
  }
  transporter ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    pool: true,
    maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS || 2),
    maxMessages: 50,
  });
  return transporter;
}

function applyTemplate(text, item) {
  return String(text)
    .replace(/{{\s*name\s*}}/gi, item.name)
    .replace(/{{\s*email\s*}}/gi, item.email)
    .replace(/{{\s*filename\s*}}/gi, item.filename);
}

export async function verifyMailer() { return client().verify(); }
export async function sendEncryptedPdf({ job, item, filePath, to, subjectPrefix = "" }) {
  return client().sendMail({
    from: process.env.MAIL_FROM || "test@example.com",
    to: to || item.email,
    replyTo: process.env.MAIL_REPLY_TO || undefined,
    subject: `${subjectPrefix}${applyTemplate(job.subject, item)}`,
    text: applyTemplate(job.body, item),
    attachments: [{ filename: item.filename, path: filePath, contentType: "application/pdf" }],
  });
}
