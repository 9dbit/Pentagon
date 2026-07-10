import React, { useState } from "react";

const REASON_TIPS = {
  BLOCKED_BY_PROVIDER:
    "Domain diblokir ISP/provider. Tindakan:\n• Cooling down 24-48 jam\n• Ganti IP server jika memungkinkan\n• Submit reinclusion request ke Google Search Console\n• Pertimbangkan domain backup atau subdomain baru",
  SSL_ISSUE:
    "Sertifikat SSL bermasalah. Langkah:\n• Cek validitas & tanggal expiry sertifikat\n• Renew sertifikat jika expired\n• Pastikan certificate chain lengkap\n• Verifikasi konfigurasi HTTPS redirect",
  REDIRECT_ISSUE:
    "Too many redirects / redirect loop. Langkah:\n• Cek konfigurasi redirect di server\n• Hapus circular redirect (HTTP↔HTTPS loop)\n• Batasi panjang redirect chain",
  REDIRECT:
    "Domain melakukan redirect. Tips:\n• Verifikasi URL tujuan benar dan aktif\n• Pertimbangkan update DNS langsung ke target\n• Hapus redirect yang tidak perlu",
  TIMEOUT:
    "Server tidak merespons tepat waktu. Kemungkinan penyebab:\n• Server overload atau kehabisan resource\n• Firewall memblokir koneksi dari luar\n• Bandwidth atau latency tinggi",
  UNKNOWN:
    "Penyebab belum teridentifikasi. Disarankan:\n• Cek domain secara manual di browser\n• Review server error logs terbaru",
};

const STATUS_TIPS = {
  warning:
    "Domain-domain ini mengalami masalah intermittent. Monitor secara berkala dan cek penyebab spesifik masing-masing.",
  blocked:
    "Domain-domain ini terdeteksi bermasalah. Tindakan bergantung pada penyebab — lihat saran di tiap domain.",
};

function blockedAction(item) {
  const lr = item.latestResult;
  if (lr?.final_url) {
    return `↪️ Diredirect ke ${lr.final_url}\nSaran: Akses langsung via subdomain atau update DNS ke target. Buka GSC → Submit reinclusion request.`;
  }
  return "🔴 Diblokir langsung\nSaran: Cooling down 24–48 jam → Cek apakah IP di-blacklist → Submit reinclusion ke Google Search Console.";
}

function StatusBadge({ status }) {
  const map = {
    working: ["dpBadgeOk", "Normal"],
    warning: ["dpBadgeWarn", "Warning"],
    blocked: ["dpBadgeBlock", "Blocked"],
  };
  const [cls, label] = map[status] || ["dpBadgeUnk", status || "?"];
  return <span className={`dpBadge ${cls}`}>{label}</span>;
}

function DomainRow({ item, popupType }) {
  const [open, setOpen] = useState(false);
  const hasTip = popupType === "blocked" || popupType === "warning";
  const tip = popupType === "blocked" ? blockedAction(item) : (popupType === "warning" ? "⚠️ Monitor domain ini. Cek server logs dan pastikan tidak ada masalah SSL atau redirect." : null);

  return (
    <div className={`dpRow${open ? " dpRowOpen" : ""}`}>
      <div className="dpRowTop">
        <a
          href={`https://${item.domain}`}
          target="_blank"
          rel="noopener noreferrer"
          className="dpDomain"
        >
          {item.domain}
        </a>
        <div className="dpRowMeta">
          {item.project_name && <span className="dpProject">{item.project_name}</span>}
          {item.status && <StatusBadge status={item.status} />}
          {item.checker && (
            <span className="dpChecker">{item.checker}</span>
          )}
          {hasTip && (
            <button className="dpExpandBtn" onClick={() => setOpen(o => !o)}>
              {open ? "▲ Tutup" : "▼ Saran"}
            </button>
          )}
        </div>
      </div>
      {item.detail && <div className="dpDetail">{item.detail}</div>}
      {open && tip && (
        <div className="dpTip">
          {tip.split("\n").map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DomainPopup({ popup, onClose }) {
  const [search, setSearch] = useState("");

  if (!popup) return null;

  const allItems = popup.items || [];
  const items = search
    ? allItems.filter(item =>
        (item.domain || "").toLowerCase().includes(search.toLowerCase()) ||
        (item.project_name || "").toLowerCase().includes(search.toLowerCase())
      )
    : allItems;

  const tip = REASON_TIPS[popup.reasonType] || popup.globalTip || null;

  return (
    <div className="dpOverlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dpPanel">
        <div className="dpHead">
          <div className="dpHeadInfo">
            <span className="dpIcon">{popup.icon}</span>
            <div>
              <h2 className="dpTitle">{popup.title}</h2>
              <span className="dpCount">{allItems.length} domain</span>
            </div>
          </div>
          <button className="dpClose" onClick={onClose}>✕</button>
        </div>

        {tip && (
          <div className="dpGlobalTip">
            <strong>💡 Saran & Solusi</strong>
            <div className="dpTipBody">
              {tip.split("\n").map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </div>
        )}

        <div className="dpSearch">
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="🔍 Cari domain atau project..."
          />
          {search && (
            <button className="dpSearchClear" onClick={() => setSearch("")}>✕</button>
          )}
        </div>

        <div className="dpList">
          {items.map((item, i) => (
            <DomainRow key={item.domain || i} item={item} popupType={popup.type} />
          ))}
          {items.length === 0 && (
            <div className="dpEmpty">Tidak ada domain yang cocok.</div>
          )}
        </div>
      </div>
    </div>
  );
}
