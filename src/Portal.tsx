import { useState } from "react";
import EncryptionTab from "./EncryptionTab";
import SingleMailTab from "./SingleMailTab";

export default function Portal() {
  const [tab, setTab] = useState<"encrypt" | "mail">("encrypt");
  return <main>
    <header className="topbar"><div className="brand"><span className="brand-mark">P</span><span>PDF 安全工具</span></div><div className="security-pill"><span className="dot" />PDF 在瀏覽器內加密</div></header>
    <div className="shell">
      <section className="hero"><p className="eyebrow">PDF ENCRYPTION · SECURE MAIL</p><h1>加密與寄送，分開處理。</h1><p>同一個網頁、兩個獨立功能。需要哪一項就進哪個分頁，不必完成另一套流程。</p></section>
      <nav className="feature-tabs">
        <button className={tab === "encrypt" ? "active" : ""} onClick={() => setTab("encrypt")}><b>01</b><span><strong>PDF 加密</strong><small>批次一檔一密碼</small></span></button>
        <button className={tab === "mail" ? "active" : ""} onClick={() => setTab("mail")}><b>02</b><span><strong>Mail 寄送</strong><small>多份 PDF 批次配對 Email</small></span></button>
      </nav>
      {tab === "encrypt" ? <EncryptionTab /> : <SingleMailTab />}
      <footer><span>兩項功能獨立</span><span>AES-256 PDF 加密</span><span>每封一附件一收件人</span><span>寄送後刪除附件</span></footer>
    </div>
  </main>;
}
