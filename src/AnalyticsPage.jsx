import React, { useEffect, useState, useRef, useCallback } from "react";
import { Sparkles, RefreshCw, ChevronDown, ChevronUp, TrendingUp, Shield, AlertTriangle, BarChart3, Globe2, Zap, FileDown, Clock, Info, X, Search, FileText, Award, Tag, Link2, Layers, Cpu, Target, XCircle, BookOpen, Key, ClipboardList, Activity, CheckCircle2, History } from "lucide-react";

async function api(url, opt = {}) {
  const res = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opt });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) { const err = new Error(data.error || "Permintaan gagal"); err.status = res.status; throw err; }
  return data;
}

const CACHE_MS = 24 * 60 * 60 * 1000;

const DIM_INFO = {
  keyword_intent: {
    label: "Kesesuaian Kata Kunci & Niat Pencari",
    Icon: Search,
    max: 10,
    apa: "Mengukur seberapa tepat kata kunci yang ditargetkan sesuai dengan niat sebenarnya dari pengguna yang mencarinya — apakah informasional, komersial, transaksional, atau navigasional.",
    mengapa: "Google semakin pintar memahami konteks di balik pencarian. Halaman yang tidak cocok dengan niat pencari akan tergeser meski relevan secara topik, karena Google mengutamakan kepuasan pengguna (Search Intent Match).",
    saran: [
      "Analisis 10 hasil teratas Google untuk setiap kata kunci target — perhatikan format konten yang mendominasi (artikel, halaman produk, video, dll).",
      "Pisahkan kata kunci berdasarkan funnel: awareness (informasional), pertimbangan (komersial), pembelian (transaksional).",
      "Buat konten yang formatnya sesuai niat — jangan buat artikel panjang untuk kata kunci transaksional yang butuh halaman produk.",
      "Gunakan FAQ schema untuk kata kunci informasional agar muncul di Featured Snippets.",
    ],
  },
  content_depth: {
    label: "Kedalaman Konten",
    Icon: FileText,
    max: 15,
    apa: "Menilai seberapa komprehensif, original, dan berbobot konten yang ada — termasuk kedalaman pembahasan, adanya data/contoh nyata, struktur yang jelas, dan cakupan subtopik yang lengkap.",
    mengapa: "Google dengan Helpful Content Update secara eksplisit menghargai konten yang benar-benar membantu pengguna. Konten tipis atau sekadar mengumpulkan informasi umum tanpa nilai tambah akan diturunkan rankingnya secara sistematis.",
    saran: [
      "Perluas setiap artikel dengan subtopik terkait yang belum dibahas pesaing — gunakan 'People Also Ask' sebagai panduan.",
      "Tambahkan data original, studi kasus, atau pengalaman langsung yang tidak bisa ditemukan di tempat lain.",
      "Gunakan heading hierarki (H2 → H3 → H4) yang logis untuk membantu pembaca dan crawler memahami struktur.",
      "Targetkan panjang konten yang sesuai dengan kompleksitas topik — bukan sekedar panjang, tapi benar-benar tuntas menjawab pertanyaan pengguna.",
    ],
  },
  uniqueness: {
    label: "Keunikan Konten",
    Icon: Sparkles,
    max: 10,
    apa: "Mengukur seberapa unik dan berbeda konten Anda dibandingkan konten pesaing yang sudah ada di SERP — baik dari sudut pandang, data, contoh, maupun gaya penulisan.",
    mengapa: "Konten yang hanya mengulangi informasi yang sudah ada di ratusan situs lain tidak akan mendapat tempat di halaman pertama. Google mencari perspektif segar dan nilai tambah yang nyata untuk pengguna.",
    saran: [
      "Tambahkan data atau statistik original dari riset/survei internal Anda sendiri.",
      "Sertakan pengalaman, opini, atau wawasan dari pakar di bidang yang relevan (interview, quote).",
      "Buat perbandingan mendalam atau review jujur yang tidak ditemukan di situs lain.",
      "Sajikan konten dalam format yang berbeda dari pesaing — jika semua orang membuat artikel, coba infografis, kalkulator, atau template yang bisa diunduh.",
    ],
  },
  eeat: {
    label: "E-E-A-T (Pengalaman, Keahlian, Otoritas, Kepercayaan)",
    Icon: Award,
    max: 10,
    apa: "Menilai sinyal-sinyal kepercayaan pada situs: profil penulis dengan bio yang kredibel, halaman About/Tim, informasi kontak yang jelas, kebijakan privasi, dan bukti keahlian atau pengalaman nyata.",
    mengapa: "E-E-A-T adalah fondasi penilaian kualitas Google, terutama untuk topik YMYL (Your Money Your Life). Situs tanpa sinyal kepercayaan yang kuat sulit mendominasi SERP meski kontennya baik.",
    saran: [
      "Buat halaman 'Tentang Kami' yang menampilkan profil tim nyata dengan foto, gelar, dan pengalaman.",
      "Tambahkan bio penulis di setiap artikel lengkap dengan tautan ke profil LinkedIn atau portofolio.",
      "Tampilkan testimoni, sertifikasi, penghargaan, atau liputan media yang memperkuat otoritas.",
      "Pastikan informasi kontak (telepon, email, alamat) mudah ditemukan — idealnya di header atau footer setiap halaman.",
    ],
  },
  on_page_seo: {
    label: "SEO On-Page",
    Icon: Tag,
    max: 10,
    apa: "Memeriksa elemen teknis di dalam halaman: title tag, meta description, URL yang bersih, penggunaan H1/H2 yang tepat, optimasi gambar (alt text, ukuran), dan implementasi schema markup.",
    mengapa: "On-page SEO adalah fondasi dasar yang harus sempurna. Crawler Google bergantung pada sinyal ini untuk memahami topik dan relevansi halaman. Kesalahan dasar di sini menutup peluang ranking meski konten sangat bagus.",
    saran: [
      "Pastikan setiap halaman memiliki title tag unik (50-60 karakter) yang mengandung kata kunci utama di awal.",
      "Tulis meta description yang menarik (150-160 karakter) dengan call-to-action untuk meningkatkan CTR.",
      "Gunakan URL pendek, deskriptif, dan mengandung kata kunci — hindari URL dengan angka atau karakter acak.",
      "Implementasikan schema markup (Article, Product, FAQ, BreadcrumbList) sesuai jenis konten untuk Rich Snippets.",
    ],
  },
  internal_linking: {
    label: "Internal Linking",
    Icon: Link2,
    max: 10,
    apa: "Menilai struktur tautan internal situs — apakah ada arsitektur pillar-cluster yang jelas, tidak ada halaman yatim (orphan pages), dan distribusi link equity yang optimal ke halaman prioritas.",
    mengapa: "Internal linking mengontrol bagaimana Google crawl dan mendistribusikan PageRank di seluruh situs. Halaman yang tidak terhubung dengan baik akan sulit terindeks, sementara halaman pillar yang mendapat banyak link internal akan mendominasi SERP.",
    saran: [
      "Bangun struktur pillar-cluster: satu halaman utama (pillar) yang didukung oleh banyak halaman subtopik (cluster) yang saling menghubung.",
      "Audit halaman yatim secara rutin — setiap halaman harus dapat dicapai dalam maksimal 3 klik dari homepage.",
      "Gunakan anchor text yang deskriptif dan mengandung kata kunci relevan (bukan 'klik di sini').",
      "Tambahkan widget 'Artikel Terkait' atau 'Bacaan Selanjutnya' di akhir setiap artikel untuk meningkatkan kedalaman sesi.",
    ],
  },
  entity_coverage: {
    label: "Cakupan Entitas",
    Icon: Layers,
    max: 10,
    apa: "Mengukur seberapa baik situs membangun footprint entitas di web — termasuk keberadaan di Google Business Profile, Wikipedia/Wikidata, media sosial terverifikasi, direktori industri, dan penyebutan brand di situs otoritatif.",
    mengapa: "Google Knowledge Graph memahami dunia melalui entitas (brand, orang, tempat). Brand yang terdaftar sebagai entitas yang diakui akan mendapat keunggulan dalam pencarian branded dan terlindungi dari konten negatif yang mencoba mendominasi nama brand.",
    saran: [
      "Daftarkan bisnis ke Google Business Profile dan optimalkan secara lengkap (foto, jam operasional, posting rutin).",
      "Buat atau perbaiki entri Wikipedia/Wikidata jika memenuhi kriteria notability.",
      "Konsistenkan NAP (Name, Address, Phone) di semua direktori online — Yelp, Yellow Pages, direktori industri lokal.",
      "Kejar mention brand di media online otoritatif melalui PR digital, guest posting, dan wawancara media.",
    ],
  },
  technical_seo: {
    label: "SEO Teknikal",
    Icon: Cpu,
    max: 10,
    apa: "Menilai aspek teknis situs yang mempengaruhi kemampuan Google untuk crawl dan mengindeks: kecepatan halaman (Core Web Vitals), mobile-friendliness, HTTPS, sitemap XML, robots.txt, dan tidak adanya broken links atau redirect chain.",
    mengapa: "Masalah teknikal adalah penghambat tak terlihat yang membuat konten bagus pun tidak bisa ranking. Google tidak bisa mengindeks halaman yang lambat dimuat, tidak ramah mobile, atau memiliki masalah crawlability serius.",
    saran: [
      "Perbaiki Core Web Vitals (LCP < 2.5 detik, INP < 200ms, CLS < 0.1) — gunakan PageSpeed Insights untuk panduan spesifik.",
      "Pastikan situs sepenuhnya responsive di semua ukuran layar, terutama mobile (Mobile-First Indexing).",
      "Audit dan perbaiki broken links (404) serta redirect chain yang panjang secara berkala menggunakan Screaming Frog atau Ahrefs.",
      "Buat dan submit sitemap XML yang up-to-date ke Google Search Console; blokir halaman yang tidak perlu diindeks via robots.txt atau noindex tag.",
    ],
  },
  serp_gap: {
    label: "Kesenjangan SERP",
    Icon: Target,
    max: 10,
    apa: "Menganalisis seberapa besar peluang yang belum dimanfaatkan dibandingkan pesaing di halaman pertama Google — topik yang mereka cover tapi Anda tidak, format konten yang mendominasi yang belum Anda miliki, atau kata kunci turunan yang terbuka.",
    mengapa: "Strategi SEO yang efektif bukan hanya mengoptimalkan yang sudah ada, tapi menemukan celah di SERP yang bisa diisi dengan cepat. Gap analysis membantu memprioritaskan konten baru dengan potensi traffic tertinggi.",
    saran: [
      "Lakukan keyword gap analysis menggunakan Ahrefs atau SEMrush — temukan kata kunci yang dimiliki pesaing tapi belum Anda target.",
      "Perhatikan fitur SERP (Featured Snippet, People Also Ask, Image Pack) yang pesaing raih tapi belum Anda — optimalkan konten untuk format tersebut.",
      "Buat konten yang menjawab pertanyaan spesifik di sekitar topik utama yang pesaing tidak bahas mendalam (long-tail opportunities).",
      "Analisis halaman pesaing dengan trafik tinggi menggunakan SimilarWeb atau Semrush — identifikasi topik high-traffic yang bisa Anda buat versi yang lebih baik.",
    ],
  },
  spam_risk: {
    label: "Risiko Spam",
    Icon: XCircle,
    max: 5,
    apa: "Menilai risiko penalti dari praktik SEO yang melanggar kebijakan Google: konten tipis/doorway pages, keyword stuffing, link scheme, cloaking, atau pola backlink yang tidak natural.",
    mengapa: "Google Spam Update dan Manual Actions dapat menghapus situs dari indeks atau merusak ranking secara drastis. Bahkan tanpa penalti manual, sinyal spam melemahkan kepercayaan algoritma terhadap situs secara keseluruhan.",
    saran: [
      "Audit backlink profil secara rutin — disavow link dari situs spam, PBN, atau link farm menggunakan Google Disavow Tool.",
      "Hapus atau perbaiki halaman dengan konten tipis (< 300 kata tanpa nilai tambah nyata) — konsolidasi atau redirect ke halaman yang lebih kuat.",
      "Hindari keyword stuffing — gunakan kata kunci secara natural dan tambahkan sinonim serta LSI (Latent Semantic Indexing) keywords.",
      "Pastikan tidak ada redirect menyesatkan atau perbedaan konten antara yang dilihat crawler dan pengguna (cloaking).",
    ],
  },
};

const SCORE_DIMS = [
  { key: "keyword_intent",   label: DIM_INFO.keyword_intent.label,   max: 10,  Icon: Search },
  { key: "content_depth",    label: DIM_INFO.content_depth.label,    max: 15,  Icon: FileText },
  { key: "uniqueness",       label: DIM_INFO.uniqueness.label,        max: 10,  Icon: Sparkles },
  { key: "eeat",             label: DIM_INFO.eeat.label,              max: 10,  Icon: Award },
  { key: "on_page_seo",      label: DIM_INFO.on_page_seo.label,       max: 10,  Icon: Tag },
  { key: "internal_linking", label: DIM_INFO.internal_linking.label,  max: 10,  Icon: Link2 },
  { key: "entity_coverage",  label: DIM_INFO.entity_coverage.label,   max: 10,  Icon: Layers },
  { key: "technical_seo",    label: DIM_INFO.technical_seo.label,     max: 10,  Icon: Cpu },
  { key: "serp_gap",         label: DIM_INFO.serp_gap.label,          max: 10,  Icon: Target },
  { key: "spam_risk",        label: DIM_INFO.spam_risk.label,         max: 5,   Icon: XCircle },
];

const INTENT_COLORS = {
  informational:  { bg: "rgba(99,179,237,.15)",  color: "#63b3ed" },
  commercial:     { bg: "rgba(154,102,255,.15)", color: "#9a66ff" },
  transactional:  { bg: "rgba(0,212,90,.15)",    color: "#00d45a" },
  navigational:   { bg: "rgba(255,176,32,.15)",  color: "#ffb020" },
};

const INTENT_ID = {
  informational: "informasional",
  commercial: "komersial",
  transactional: "transaksional",
  navigational: "navigasional",
};

const THREAT_COLORS = {
  low:      { bg: "rgba(0,212,90,.15)",    color: "#00d45a", label: "Ancaman Rendah" },
  medium:   { bg: "rgba(255,176,32,.15)",  color: "#ffb020", label: "Ancaman Sedang" },
  high:     { bg: "rgba(255,80,80,.15)",   color: "#ff6b6b", label: "Ancaman Tinggi" },
  critical: { bg: "rgba(220,38,38,.2)",    color: "#ef4444", label: "Ancaman Kritis" },
};

const IMPACT_ID = { High: "Tinggi", Medium: "Sedang", Low: "Rendah" };

function msToCountdown(ms) {
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h}j ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}d`;
}

function useCountdown(cachedAt) {
  const [remaining, setRemaining] = useState(null);
  useEffect(() => {
    if (!cachedAt) { setRemaining(null); return; }
    const expiry = new Date(cachedAt).getTime() + CACHE_MS;
    const tick = () => {
      const r = expiry - Date.now();
      setRemaining(r > 0 ? r : 0);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cachedAt]);
  return remaining;
}

function ScoreInfoPopup({ dimKey, onClose }) {
  const info = DIM_INFO[dimKey];
  if (!info) return null;
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="seoDimPopupOverlay" onClick={onClose}>
      <div className="seoDimPopupCard" onClick={e => e.stopPropagation()}>
        <div className="seoDimPopupHead">
          <div className="seoDimPopupTitle">
            <span className="seoDimPopupIcon"><info.Icon size={20}/></span>
            <div>
              <b>{info.label}</b>
              <span className="seoDimPopupMax">Skor maks: {info.max} poin</span>
            </div>
          </div>
          <button className="seoDimPopupClose" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="seoDimPopupBody">
          <div className="seoDimPopupSection">
            <h4><BookOpen size={13}/> Apa yang diukur?</h4>
            <p>{info.apa}</p>
          </div>
          <div className="seoDimPopupSection">
            <h4><Target size={13}/> Mengapa penting untuk ranking Google?</h4>
            <p>{info.mengapa}</p>
          </div>
          <div className="seoDimPopupSection">
            <h4><Zap size={13}/> Cara meningkatkan skor ini</h4>
            <ul>
              {info.saran.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScoreRing({ score, size = 120, thickness = 9 }) {
  const s = Math.max(0, Math.min(100, score || 0));
  const color = s >= 70 ? "#00d45a" : s >= 45 ? "#ffb020" : "#ef4444";
  const r = (size / 2) - thickness;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - s / 100);
  return (
    <div className="seoScoreRing" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth={thickness}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={thickness}
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: "stroke-dashoffset 1s ease" }}/>
      </svg>
      <div className="seoScoreLabel">
        <b style={{ color, fontSize: size > 100 ? "28px" : "20px" }}>{s}</b>
        <span>Skor SEO</span>
      </div>
    </div>
  );
}

function ScoreSparkline({ history }) {
  if (!history || history.length < 2) return null;
  const W = 320, H = 64, PAD = 10;
  const scores = history.map(e => e.seo_score);
  const minS = Math.min(...scores);
  const maxS = Math.max(...scores);
  const rangeS = maxS - minS || 1;
  const pts = scores.map((s, i) => {
    const x = PAD + (i / (scores.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (s - minS) / rangeS) * (H - PAD * 2);
    return [x, y];
  });
  const first = scores[0], last = scores[scores.length - 1];
  const trendColor = last > first ? "#00d45a" : last < first ? "#ef4444" : "#ffb020";
  const polyline = pts.map(p => p.join(",")).join(" ");
  const gradId = "sg" + Math.random().toString(36).slice(2, 7);
  return (
    <div className="seoSparklineWrap">
      <svg className="seoSparklineSvg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={trendColor} stopOpacity="0.22"/>
            <stop offset="100%" stopColor={trendColor} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <polygon
          points={`${pts[0][0]},${H} ${polyline} ${pts[pts.length-1][0]},${H}`}
          fill={`url(#${gradId})`}
        />
        <polyline points={polyline} fill="none" stroke={trendColor} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"/>
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i === pts.length - 1 ? 4 : 2.8}
            fill={i === pts.length - 1 ? trendColor : "rgba(255,255,255,.7)"}
            stroke={trendColor} strokeWidth="1.5"/>
        ))}
      </svg>
      <div className="seoSparklineLegend">
        <span className="seoSparklineLow">{minS}</span>
        <span className="seoSparklineTrend" style={{ color: trendColor }}>
          {last > first ? `▲ +${last - first}` : last < first ? `▼ ${last - first}` : "– stabil"}
        </span>
        <span className="seoSparklineHigh">{maxS}</span>
      </div>
    </div>
  );
}

function ScoreDimBar({ dim, value, onInfo }) {
  const pct = Math.round(((value || 0) / dim.max) * 100);
  const color = pct >= 70 ? "#00e96b" : pct >= 40 ? "#ffb020" : "#ef4444";
  return (
    <div className="seoDimBar">
      <div className="seoDimTop">
        <span className="seoDimIcon"><dim.Icon size={13}/></span>
        <span className="seoDimLabel">{dim.label}</span>
        <button
          className="seoDimInfoBtn"
          onClick={() => onInfo(dim.key)}
          title={`Info: ${dim.label}`}
          aria-label={`Info tentang ${dim.label}`}
        >
          info
        </button>
        <span className="seoDimScore" style={{ color }}>{value ?? 0}<small>/{dim.max}</small></span>
      </div>
      <div className="seoDimTrack">
        <div className="seoDimFill" style={{ width: `${pct}%`, background: color }}/>
      </div>
    </div>
  );
}

function DomainAuditCard({ audit, projectName }) {
  const [open, setOpen] = useState(false);
  const [completions, setCompletions] = useState({});
  const [completionsLoaded, setCompletionsLoaded] = useState(false);
  const [toggling, setToggling] = useState({});

  useEffect(() => {
    if (!open || completionsLoaded || !audit.domain) return;
    api(`/api/analytics/suggestion-completion?domain=${encodeURIComponent(audit.domain)}`)
      .then(data => {
        const map = {};
        (data.completions || []).forEach(c => { map[c.suggestion_key] = c.marked_done; });
        setCompletions(map);
        setCompletionsLoaded(true);
      })
      .catch(() => setCompletionsLoaded(true));
  }, [open, completionsLoaded, audit.domain]);

  async function toggleCompletion(suggKey) {
    if (toggling[suggKey]) return;
    const next = !completions[suggKey];
    setToggling(t => ({ ...t, [suggKey]: true }));
    setCompletions(c => ({ ...c, [suggKey]: next }));
    try {
      await api("/api/analytics/suggestion-completion", {
        method: "POST",
        body: JSON.stringify({ domain: audit.domain, project_name: projectName || "", suggestion_key: suggKey, marked_done: next }),
      });
    } catch (_) {
      setCompletions(c => ({ ...c, [suggKey]: !next }));
    } finally {
      setToggling(t => ({ ...t, [suggKey]: false }));
    }
  }

  const score = audit.seo_score || 0;
  const scoreColor = score >= 70 ? "#00d45a" : score >= 45 ? "#ffb020" : "#ef4444";
  const intentStyle = INTENT_COLORS[audit.search_intent] || { bg: "rgba(255,255,255,.08)", color: "#9facbc" };
  const impactMap = { High: { bg: "rgba(255,80,80,.15)", color: "#ff6b6b" }, Medium: { bg: "rgba(255,176,32,.15)", color: "#ffb020" }, Low: { bg: "rgba(0,212,90,.12)", color: "#5fd4a0" } };
  const impactStyle = impactMap[audit.estimated_impact] || impactMap.Low;
  const intentLabel = INTENT_ID[audit.search_intent] || audit.search_intent;
  const impactLabel = IMPACT_ID[audit.estimated_impact] || audit.estimated_impact;

  return (
    <div className={`seoDomainCard${open ? " seoDomainCardOpen" : ""}`}>
      <div className="seoDomainCardHead" onClick={() => setOpen(o => !o)}>
        <div className="seoDomainCardLeft">
          <a href={`https://${audit.domain}`} target="_blank" rel="noopener noreferrer" className="seoDomainLink" onClick={e => e.stopPropagation()}>{audit.domain}</a>
          <div className="seoDomainMeta">
            {audit.target_keyword && <span className="seoDomainKw"><Key size={10}/> {audit.target_keyword}</span>}
            {intentLabel && <span className="seoIntentBadge" style={intentStyle}>{intentLabel}</span>}
            {impactLabel && <span className="seoImpactBadge" style={impactStyle}>Dampak {impactLabel}</span>}
          </div>
        </div>
        <div className="seoDomainCardRight">
          <span className="seoDomainScore" style={{ color: scoreColor }}>{score}</span>
          <button className="seoDomainToggle">{open ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}</button>
        </div>
      </div>
      {open && (
        <div className="seoDomainCardBody">
          {audit.priority_action && <div className="seoPriorityAction"><span className="seoPriorityLabel"><Zap size={11}/> Aksi Prioritas</span><p>{audit.priority_action}</p></div>}
          <div className="seoDomainGrid">
            {audit.main_problems?.length > 0 && <div className="seoDomainSection"><h4><AlertTriangle size={11}/> Masalah Utama</h4><ul>{audit.main_problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
            {audit.content_gap?.length > 0 && <div className="seoDomainSection"><h4><ClipboardList size={11}/> Celah Konten</h4><ul>{audit.content_gap.map((g, i) => <li key={i}>{g}</li>)}</ul></div>}
            {audit.entity_gap?.length > 0 && <div className="seoDomainSection"><h4><Layers size={11}/> Celah Entitas</h4><ul>{audit.entity_gap.map((g, i) => <li key={i}>{g}</li>)}</ul></div>}
          </div>
          <div className="seoDomainSuggestions">
            {audit.title_suggestion && (
              <div className={`seoSuggBox${completions.title_suggestion ? " seoSuggBoxDone" : ""}`}>
                <span>Saran Title Tag</span>
                <p>{audit.title_suggestion}</p>
                <button
                  className={`seoSuggMarkBtn${completions.title_suggestion ? " seoSuggMarkBtnDone" : ""}`}
                  onClick={() => toggleCompletion("title_suggestion")}
                  disabled={toggling.title_suggestion}
                  title={completions.title_suggestion ? "Batalkan penandaan selesai" : "Tandai sudah diimplementasikan"}
                >
                  <CheckCircle2 size={11}/>
                  {completions.title_suggestion ? "Sudah Selesai" : "Tandai Selesai"}
                </button>
              </div>
            )}
            {audit.meta_suggestion && (
              <div className={`seoSuggBox${completions.meta_suggestion ? " seoSuggBoxDone" : ""}`}>
                <span>Saran Meta Deskripsi</span>
                <p>{audit.meta_suggestion}</p>
                <button
                  className={`seoSuggMarkBtn${completions.meta_suggestion ? " seoSuggMarkBtnDone" : ""}`}
                  onClick={() => toggleCompletion("meta_suggestion")}
                  disabled={toggling.meta_suggestion}
                  title={completions.meta_suggestion ? "Batalkan penandaan selesai" : "Tandai sudah diimplementasikan"}
                >
                  <CheckCircle2 size={11}/>
                  {completions.meta_suggestion ? "Sudah Selesai" : "Tandai Selesai"}
                </button>
              </div>
            )}
            {audit.internal_link_suggestion && (
              <div className={`seoSuggBox${completions.internal_link_suggestion ? " seoSuggBoxDone" : ""}`}>
                <span>Strategi Internal Link</span>
                <p>{audit.internal_link_suggestion}</p>
                <button
                  className={`seoSuggMarkBtn${completions.internal_link_suggestion ? " seoSuggMarkBtnDone" : ""}`}
                  onClick={() => toggleCompletion("internal_link_suggestion")}
                  disabled={toggling.internal_link_suggestion}
                  title={completions.internal_link_suggestion ? "Batalkan penandaan selesai" : "Tandai sudah diimplementasikan"}
                >
                  <CheckCircle2 size={11}/>
                  {completions.internal_link_suggestion ? "Sudah Selesai" : "Tandai Selesai"}
                </button>
              </div>
            )}
          </div>
          {audit.suggestions_status?.length > 0 && (
            <div className="seoSuggStatus">
              <h4 className="seoSuggStatusTitle"><History size={11}/> Status Saran Sebelumnya</h4>
              <div className="seoSuggStatusList">
                {audit.suggestions_status.map((s, i) => {
                  const labelMap = { title_suggestion: "Title Tag", meta_suggestion: "Meta Deskripsi", priority_action: "Aksi Prioritas", internal_link_suggestion: "Internal Link" };
                  const label = labelMap[s.suggestion] || s.suggestion;
                  return (
                    <div key={i} className={`seoSuggStatusItem ${s.likely_implemented ? "seoSuggDone" : "seoSuggPending"}`}>
                      <span className="seoSuggStatusIcon">
                        {s.likely_implemented ? <CheckCircle2 size={13}/> : <Clock size={13}/>}
                      </span>
                      <div className="seoSuggStatusContent">
                        <span className="seoSuggStatusLabel">{label}</span>
                        <span className="seoSuggStatusReason">{s.reasoning}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function generatePdf(data, projectName) {
  const jspdfMod = await import("jspdf");
  const JsPDF = jspdfMod.jsPDF || jspdfMod.default;
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const LIGHT_GREY = [244, 245, 246];
  const NEON_GREEN = [0, 212, 90];
  const CHARCOAL = [45, 55, 72];
  const MUTED = [107, 114, 128];
  const WHITE = [255, 255, 255];
  const CARD = [235, 237, 240];

  doc.setFillColor(...LIGHT_GREY);
  doc.rect(0, 0, W, 297, "F");

  doc.setFillColor(...NEON_GREEN);
  doc.rect(0, 0, W, 28, "F");
  doc.setTextColor(...WHITE);
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("LAPORAN AUDIT SEO", 14, 12);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Proyek: ${projectName}`, 14, 19);
  doc.text(`Dibuat: ${new Date().toLocaleDateString("id-ID", { year: "numeric", month: "long", day: "numeric" })}`, 14, 25);

  const scoreColor = data.seo_score >= 70 ? [0, 180, 70] : data.seo_score >= 45 ? [255, 160, 0] : [239, 68, 68];
  doc.setFillColor(...WHITE);
  doc.roundedRect(14, 34, 55, 32, 3, 3, "F");
  doc.setFontSize(28);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...scoreColor);
  doc.text(String(data.seo_score || 0), 41, 52, { align: "center" });
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text("SKOR SEO KESELURUHAN", 41, 59, { align: "center" });

  if (data.overall_assessment) {
    doc.setFillColor(...WHITE);
    doc.roundedRect(74, 34, W - 88, 32, 3, 3, "F");
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...CHARCOAL);
    const lines = doc.splitTextToSize(data.overall_assessment, W - 96);
    doc.text(lines.slice(0, 4), 78, 42);
  }

  let y = 74;

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...NEON_GREEN);
  doc.text("RINCIAN SKOR 10 DIMENSI", 14, y);
  y += 4;

  const dimRows = SCORE_DIMS.map(d => {
    const v = data.score_breakdown?.[d.key] ?? 0;
    const pct = Math.round((v / d.max) * 100);
    return [DIM_INFO[d.key]?.label, `${v} / ${d.max}`, `${pct}%`];
  });

  autoTable(doc, {
    startY: y,
    head: [["Dimensi", "Skor", "Persentase"]],
    body: dimRows,
    theme: "plain",
    styles: { fillColor: LIGHT_GREY, textColor: CHARCOAL, fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: CARD, textColor: CHARCOAL, fontStyle: "bold", fontSize: 9 },
    alternateRowStyles: { fillColor: WHITE },
    margin: { left: 14, right: 14 },
    columnStyles: { 0: { cellWidth: 90 }, 1: { cellWidth: 25, halign: "center" }, 2: { cellWidth: 25, halign: "center" } },
  });

  y = doc.lastAutoTable.finalY + 10;

  if (data.domain_audits?.length > 0) {
    if (y > 230) { doc.addPage(); doc.setFillColor(...LIGHT_GREY); doc.rect(0, 0, W, 297, "F"); y = 14; }
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...NEON_GREEN);
    doc.text("AUDIT PER DOMAIN", 14, y);
    y += 4;

    const domainRows = data.domain_audits.map(a => [
      a.domain || "",
      a.target_keyword || "",
      String(a.seo_score || 0),
      (a.main_problems || []).slice(0, 2).join("; ") || "",
      a.priority_action || "",
    ]);

    autoTable(doc, {
      startY: y,
      head: [["Domain", "Kata Kunci", "Skor", "Masalah", "Aksi Prioritas"]],
      body: domainRows,
      theme: "plain",
      styles: { fillColor: LIGHT_GREY, textColor: CHARCOAL, fontSize: 8, cellPadding: 2.5, overflow: "linebreak" },
      headStyles: { fillColor: CARD, textColor: CHARCOAL, fontStyle: "bold", fontSize: 8 },
      alternateRowStyles: { fillColor: WHITE },
      margin: { left: 14, right: 14 },
      columnStyles: { 0: { cellWidth: 38 }, 1: { cellWidth: 28 }, 2: { cellWidth: 14, halign: "center" }, 3: { cellWidth: 52 }, 4: { cellWidth: 42 } },
    });

    y = doc.lastAutoTable.finalY + 10;
  }

  const sections = [
    { title: "QUICK WINS (LANGKAH CEPAT)", content: (data.quick_wins || []).map((w, i) => `${i + 1}. ${w}`).join("\n") },
    { title: "OTORITAS TOPIKAL", content: data.topical_cluster_advice || "" },
    { title: "STRATEGI ENTITAS BRAND", content: data.brand_entity_advice || "" },
    { title: "STRATEGI PERTAHANAN SERP", content: data.serp_strategy || "" },
    { title: "REKOMENDASI KATA KUNCI", content: (data.keyword_recommendations || []).map((k, i) => `${i + 1}. ${k}`).join("\n") },
  ].filter(s => s.content);

  for (const sec of sections) {
    if (y > 240) { doc.addPage(); doc.setFillColor(...LIGHT_GREY); doc.rect(0, 0, W, 297, "F"); y = 14; }
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...NEON_GREEN);
    doc.text(sec.title, 14, y);
    y += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...CHARCOAL);
    const lines = doc.splitTextToSize(sec.content, W - 28);
    const blockH = lines.length * 4.5;
    if (y + blockH > 270) { doc.addPage(); doc.setFillColor(...LIGHT_GREY); doc.rect(0, 0, W, 297, "F"); y = 14; }
    doc.setFillColor(...WHITE);
    doc.roundedRect(14, y - 2, W - 28, blockH + 4, 2, 2, "F");
    doc.text(lines, 18, y + 3);
    y += blockH + 12;
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`Domain Radar · Audit SEO · Halaman ${i} dari ${pageCount}`, W / 2, 292, { align: "center" });
  }

  const date = new Date().toISOString().slice(0, 10);
  const safeName = projectName.replace(/[^a-z0-9]/gi, "-");
  doc.save(`Audit-SEO-${safeName}-${date}.pdf`);
}

export default function AnalyticsPage() {
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [globalCtx, setGlobalCtx] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [activePopup, setActivePopup] = useState(null);
  const [scoreHistory, setScoreHistory] = useState([]);

  const resultsMap = useRef({});
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate(n => n + 1), []);

  async function fetchScoreHistory(proj) {
    try {
      const d = await api(`/api/analytics/seo-score-history?project_name=${encodeURIComponent(proj)}&limit=5`);
      setScoreHistory(Array.isArray(d.history) ? d.history : []);
    } catch (_) {
      setScoreHistory([]);
    }
  }

  const data = resultsMap.current[selectedProject] || null;
  const cachedAt = data?.cached_at || (data && !data.cached ? data.generated_at : null);
  const remaining = useCountdown(cachedAt);
  const isLocked = remaining !== null && remaining > 0;

  const projectName = selectedProject === "all" ? "Semua Proyek" : selectedProject;

  useEffect(() => {
    api("/api/projects").then(pr => {
      setProjects(Array.isArray(pr) ? pr : []);
    }).catch(() => {});
    api("/api/overview").then(r => setGlobalCtx(r)).catch(() => {});
  }, []);

  useEffect(() => {
    setScoreHistory([]);
    fetchScoreHistory(selectedProject);
    if (resultsMap.current[selectedProject]) return;
    probeCache(selectedProject);
  }, [selectedProject]);

  async function probeCache(proj) {
    try {
      const res = await fetch(
        `/api/analytics/seo-audit-cache?project_name=${encodeURIComponent(proj)}`,
        { credentials: "include" }
      );
      if (res.status === 204 || !res.ok) return;
      const d = await res.json();
      if (d && d.seo_score !== undefined) {
        resultsMap.current[proj] = d;
        rerender();
      }
    } catch (_) {}
  }

  async function runAudit(force = false) {
    setLoading(true);
    setError("");
    try {
      if (force) {
        await api(`/api/analytics/seo-audit-cache?project_name=${encodeURIComponent(selectedProject)}`, { method: "DELETE" });
        delete resultsMap.current[selectedProject];
        rerender();
      }
      const d = await api("/api/analytics/seo-audit", {
        method: "POST",
        body: JSON.stringify({ project_name: selectedProject }),
      });
      resultsMap.current[selectedProject] = d;
      rerender();
      fetchScoreHistory(selectedProject);
    } catch (err) {
      setError(err.message || "Audit SEO gagal. Periksa koneksi dan API key.");
    } finally {
      setLoading(false);
    }
  }

  async function downloadPdf() {
    if (!data) return;
    setPdfLoading(true);
    try {
      await generatePdf(data, projectName);
    } catch (e) {
      alert("Gagal membuat PDF: " + e.message);
    } finally {
      setPdfLoading(false);
    }
  }

  const breakdown = data?.score_breakdown || {};
  const threatInfo = THREAT_COLORS[data?.serp_threat_level] || THREAT_COLORS.low;
  const totalPossible = SCORE_DIMS.reduce((a, d) => a + d.max, 0);

  // Score delta vs the previous audit in history
  const prevHistoryScore = scoreHistory.length >= 2 ? scoreHistory[scoreHistory.length - 2].seo_score : null;
  const scoreDelta = (data && prevHistoryScore !== null) ? (data.seo_score - prevHistoryScore) : null;

  return (
    <div className="seoAuditPage">
      {activePopup && <ScoreInfoPopup dimKey={activePopup} onClose={() => setActivePopup(null)}/>}

      <div className="seoAuditHeader">
        <div className="seoAuditTitleRow">
          <Activity size={22} style={{ color: "#00e96b", flexShrink: 0 }}/>
          <div>
            <h2>Mesin Audit SEO dengan AI</h2>
            <p>Analisis ekosistem SEO per proyek/brand untuk naik peringkat di SERP &amp; melindungi dari situs phishing</p>
          </div>
        </div>
        {globalCtx && (
          <div className="seoCtxCards">
            <div className="seoCtxCard"><b>{globalCtx.total || 0}</b><span>Total Domain</span></div>
            <div className="seoCtxCard ok"><b>{globalCtx.working || 0}</b><span>Aktif</span></div>
            <div className="seoCtxCard warn"><b>{globalCtx.warning || 0}</b><span>Peringatan</span></div>
            <div className="seoCtxCard bad"><b>{globalCtx.blocked || 0}</b><span>Diblokir</span></div>
          </div>
        )}
      </div>

      <div className="seoProjectBar">
        <div className="seoProjectSelect">
          <Globe2 size={15} style={{ color: "#9facbc", flexShrink: 0 }}/>
          <select value={selectedProject} onChange={e => { setSelectedProject(e.target.value); setError(""); }}>
            <option value="all">Semua Proyek</option>
            {projects.map(p => {
              const name = p.project_name || p.name;
              return <option key={name} value={name}>{name}</option>;
            })}
          </select>
        </div>

        {isLocked ? (
          <div className="seoCountdownWrap">
            <Clock size={13}/>
            <span>Refresh dalam <b>{msToCountdown(remaining)}</b></span>
          </div>
        ) : (
          <button className="seoRunBtn" onClick={() => runAudit(false)} disabled={loading}>
            <Zap size={15}/> {loading ? "Menganalisis..." : "Jalankan Audit SEO"}
          </button>
        )}

        {data && isLocked && (
          <button className="seoRefreshBtn" onClick={() => runAudit(true)} disabled={loading} title="Paksa refresh — menggunakan token OpenAI baru">
            <RefreshCw size={14} style={loading ? { animation: "spin .8s linear infinite" } : {}}/> Muat Ulang
          </button>
        )}

        {data && (
          <button className="seoPdfBtn" onClick={downloadPdf} disabled={pdfLoading} title="Unduh laporan PDF">
            <FileDown size={14}/> {pdfLoading ? "Membuat PDF..." : "Unduh PDF"}
          </button>
        )}

        {data && (
          <span className="seoCacheBadge">
            {data.cached
              ? `Cache · ${new Date(data.cached_at || data.generated_at).toLocaleTimeString("id-ID")}`
              : "Baru · baru saja"}
          </span>
        )}
      </div>

      {!loading && !data && !error && (
        <div className="seoEmptyState">
          <div className="seoEmptyIcon"><Activity size={36} style={{ color: "#00e96b" }}/></div>
          <h3>Mesin Audit SEO</h3>
          <p>Pilih proyek di atas lalu klik <b>Jalankan Audit SEO</b> untuk analisis mendalam tentang:</p>
          <div className="seoEmptyGrid">
            <div><TrendingUp size={16}/> Kata Kunci &amp; Niat</div>
            <div><Shield size={16}/> E-E-A-T &amp; Kepercayaan</div>
            <div><BarChart3 size={16}/> Kesenjangan SERP</div>
            <div><Zap size={16}/> SEO Teknikal</div>
            <div><Globe2 size={16}/> Cakupan Entitas</div>
            <div><AlertTriangle size={16}/> Audit Risiko Spam</div>
          </div>
          <p className="seoEmptyNote">AI akan menilai proyek Anda menggunakan framework SEO 10 dimensi dan memberikan rekomendasi spesifik per domain. Hasil disimpan selama 24 jam.</p>
        </div>
      )}

      {loading && (
        <div className="seoLoadingState">
          <div className="seoSpinner"/>
          <p>Menganalisis ekosistem SEO <b>{projectName}</b>…</p>
          <small>GPT-4o-mini sedang menilai 10 dimensi SEO. Mungkin butuh 10–20 detik.</small>
        </div>
      )}

      {!loading && error && (
        <div className="seoErrorState">
          <AlertTriangle size={20}/>
          <p>{error}</p>
          <button onClick={() => runAudit(false)}>Coba Lagi</button>
        </div>
      )}

      {!loading && !error && data && (
        <div className="seoAuditBody">
          <div className="seoOverviewRow">
            <div className="seoScoreRingWrap">
              <ScoreRing score={data.seo_score} size={140} thickness={11}/>
              {scoreDelta !== null && (
                <span className={`seoScoreDelta ${scoreDelta > 0 ? "seoScoreDeltaUp" : scoreDelta < 0 ? "seoScoreDeltaDown" : "seoScoreDeltaFlat"}`}>
                  {scoreDelta > 0 ? "▲" : scoreDelta < 0 ? "▼" : "–"}{scoreDelta !== 0 ? Math.abs(scoreDelta) : ""} vs audit sebelumnya
                </span>
              )}
            </div>
            <div className="seoOverviewInfo">
              <div className="seoOverviewTop">
                <span className="seoProjectLabel">{projectName}</span>
                {data.serp_threat_level && (
                  <span className="seoThreatBadge" style={threatInfo}>
                    <Shield size={12}/> {threatInfo.label}
                  </span>
                )}
              </div>
              <p className="seoAssessment">{data.overall_assessment}</p>
              {data.serp_strategy && (
                <div className="seoSerpStrategy">
                  <Shield size={13} style={{ color: "#00e96b", flexShrink: 0 }}/>
                  <span>{data.serp_strategy}</span>
                </div>
              )}
            </div>
          </div>

          {scoreHistory.length > 0 && (
            <div className="seoHistorySection">
              <h3 className="seoSectionTitle"><History size={16}/> Riwayat Skor (5 Audit Terakhir)</h3>
              <ScoreSparkline history={scoreHistory}/>
              <div className="seoHistoryList">
                {scoreHistory.map((entry, i) => {
                  const prev = scoreHistory[i - 1];
                  const delta = prev ? entry.seo_score - prev.seo_score : null;
                  const isLatest = i === scoreHistory.length - 1;
                  const color = entry.seo_score >= 70 ? "#00d45a" : entry.seo_score >= 45 ? "#ffb020" : "#ef4444";
                  return (
                    <div key={entry.id} className={`seoHistoryRow${isLatest ? " seoHistoryRowLatest" : ""}`}>
                      <span className="seoHistoryDate">
                        {new Date(entry.generated_at).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })}
                        <small>{new Date(entry.generated_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</small>
                      </span>
                      <div className="seoHistoryBar">
                        <div className="seoHistoryBarFill" style={{ width: `${entry.seo_score}%`, background: color }}/>
                      </div>
                      <span className="seoHistoryScore" style={{ color }}><b>{entry.seo_score}</b><small>/100</small></span>
                      {delta !== null && (
                        <span className={`seoHistoryDelta ${delta > 0 ? "up" : delta < 0 ? "down" : "flat"}`}>
                          {delta > 0 ? "▲" : delta < 0 ? "▼" : "–"}{delta !== 0 ? Math.abs(delta) : ""}
                        </span>
                      )}
                      {isLatest && <span className="seoHistoryLatestBadge">Terkini</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="seoBreakdownSection">
            <h3 className="seoSectionTitle">
              <BarChart3 size={16}/> Rincian Skor 10 Dimensi
              <small>Total maks: {totalPossible} · Klik info untuk penjelasan &amp; tips</small>
            </h3>
            <div className="seoBreakdownGrid">
              {SCORE_DIMS.map(dim => (
                <ScoreDimBar key={dim.key} dim={dim} value={breakdown[dim.key]} onInfo={setActivePopup}/>
              ))}
            </div>
          </div>

          {data.domain_audits?.length > 0 && (
            <div className="seoDomainAudits">
              <h3 className="seoSectionTitle"><Globe2 size={16}/> Audit Per Domain ({data.domain_audits.length} domain)</h3>
              <div className="seoDomainList">
                {data.domain_audits.map((audit, i) => (
                  <DomainAuditCard key={audit.domain || i} audit={audit} projectName={selectedProject}/>
                ))}
              </div>
            </div>
          )}

          <div className="seoStrategyGrid">
            {data.quick_wins?.length > 0 && (
              <div className="seoStrategyCard seoQuickWins">
                <h3><Zap size={16}/> Langkah Cepat (Quick Wins)</h3>
                <ul>{data.quick_wins.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            {data.topical_cluster_advice && (
              <div className="seoStrategyCard">
                <h3><TrendingUp size={16}/> Otoritas Topikal</h3>
                <p>{data.topical_cluster_advice}</p>
              </div>
            )}
            {data.brand_entity_advice && (
              <div className="seoStrategyCard">
                <h3><Shield size={16}/> Entitas Brand</h3>
                <p>{data.brand_entity_advice}</p>
              </div>
            )}
            {data.keyword_recommendations?.length > 0 && (
              <div className="seoStrategyCard">
                <h3><Globe2 size={16}/> Kluster Kata Kunci</h3>
                <ul>{data.keyword_recommendations.map((k, i) => <li key={i}>{k}</li>)}</ul>
              </div>
            )}
          </div>

          <div className="seoAuditFooter">
            <small>
              Dibuat oleh GPT-4o-mini · {data.generated_at ? new Date(data.generated_at).toLocaleString("id-ID") : "—"} · Cache: 24 jam · {data.context?.domains?.length || 0} domain dianalisis
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
