import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, Bell, CheckCircle2, CircleAlert, Clock3, ExternalLink,
  Globe2, LayoutDashboard, Layers3, LockKeyhole, LogOut, Plus,
  Radio, RefreshCw, Save, Search, Settings2, ShieldCheck, ShieldAlert,
  Trash2, Wifi, X
} from "lucide-react";
import "./MerchantAdminPage.css";
import MerchantNodeCardV2 from "./MerchantNodeCardV2";

const dateWib = value => value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta",
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " WIB"
  : "Belum tersedia";

async function request(url, options = {}) {
  const res = await fetch(url, {
    credentials: "include", cache: "no-store",
    ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || "Layanan belum tersedia.");
    err.status = res.status;
    throw err;
  }
  return json;
}

const NAV = [
  { key: "overview", text: "Overview", icon: LayoutDashboard },
  { key: "domains", text: "Domain", icon: Globe2 },
  { key: "keywords", text: "Google Rank", icon: Layers3 },
  { key: "nodes", text: "Node Health", icon: Wifi },
  { key: "trust", text: "Trust Positif", icon: ShieldCheck },
  { key: "direct", text: "Direct Checker", icon: Activity },
  { key: "alerts", text: "Notifikasi", icon: Bell },
  { key: "settings", text: "Merchant Settings", icon: Settings2 }
];
const statusText = value => ({
  working: "Normal", blocked: "Blocked / review", warning: "Warning",
  unknown: "Unknown", online: "Online", waiting: "Waiting"
})[value] || "Unknown";
const n = value => Number(value) || 0;

export default function MerchantAdminPage({ onLogout, accountEmail = "" }) {
  const [page, setPage] = useState("overview");
  const [data, setData] = useState({ overview: {}, domains: [], keywords: [], nodes: [], alerts: [], history: [], profile: {} });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [domainForm, setDomainForm] = useState({ domain: "", project_name: "", label: "landing_page" });
  const [keywordForm, setKeywordForm] = useState({ keyword: "", project_name: "" });
  const [editing, setEditing] = useState(null);
  const [linkFor, setLinkFor] = useState({});
  const [showDomainForm, setShowDomainForm] = useState(false);
  const [showKeywordForm, setShowKeywordForm] = useState(false);
  const [detail, setDetail] = useState(null);
  const [telegramForm, setTelegramForm] = useState({enabled:false,chat_id:""});

  const reload = useCallback(async () => {
    try {
      const [overview, domains, keywords, nodeHealth, alerts, history, profile] = await Promise.all([
        request("/api/customer/overview"), request("/api/merchant/domains"),
        request("/api/merchant/keywords"), request("/api/merchant/node-health"),
        request("/api/customer/alerts"), request("/api/merchant/history"),
        request("/api/merchant/profile")
      ]);
      const [trust,direct,telegram]=await Promise.all([
        request("/api/merchant/trust-positif").catch(()=>null),
        request("/api/merchant/direct-checker").catch(()=>null),
        request("/api/merchant/telegram").catch(()=>null)
      ]);
      setData({ overview, domains, keywords, nodes: nodeHealth.nodes || [], nodeAsOf: nodeHealth.as_of,
        alerts, history, profile, trust, direct, telegram });
      if (telegram) setTelegramForm({enabled:telegram.enabled,chat_id:telegram.chat_id || ""});
      setError("");
      setRefreshedAt(new Date().toISOString());
    } catch (err) {
      setError(err.message);
      if (err.status === 401 || err.status === 403) onLogout();
    } finally {
      setLoading(false);
    }
  }, [onLogout]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 60000);
    return () => clearInterval(id);
  }, [reload]);

  async function act(url, method, body, success) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      setNotice(success || "Perubahan tersimpan.");
      await reload();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try { await request("/api/auth/logout", { method: "POST" }); }
    catch (_) { /* Local logout still revokes rendered access. */ }
    finally { onLogout(); }
  }
  const ownDomains = useMemo(
    () => data.domains.filter(item => (item.domain + " " + (item.project_name || "")).toLowerCase().includes(search.toLowerCase())),
    [data.domains, search]
  );
  const healthyNodes = data.nodes.filter(node => node.is_active && node.connectivity === "online").length;
  const activeNodes = data.nodes.filter(node => node.is_active).length;
  const overview = data.overview || {};

  return <div className="maApp">
    <header className="maHeader">
      <div className="maBrand"><ShieldCheck size={25}/><div><strong>PENTAGON</strong><small>Merchant Control Center</small></div></div>
      <div className="maIdentity"><span>{(data.profile.tenant || overview.tenant || "MERCHANT").toUpperCase()}</span><button type="button" onClick={logout}><LogOut size={16}/> Keluar</button></div>
    </header>
    <div className="maShell">
      <aside className="maAside">
        <div className="maAsideTitle">MERCHANT ADMIN</div>
        {NAV.map(item => { const I = item.icon; return <button type="button" key={item.key}
          className={page === item.key ? "maNavActive" : ""} onClick={() => setPage(item.key)}><I size={17}/>{item.text}</button>; })}
        <div className="maAsideFoot"><LockKeyhole size={13}/> Isolasi data per merchant</div>
      </aside>
      <main className="maMain">
        <div className="maTopline">
          <div><span className="maOverline">PENTAGON / {page.toUpperCase()}</span>
            <h1>{data.profile.tenant ? data.profile.tenant.toUpperCase() : "Merchant"} <span>Administrator</span></h1>
            <p>Kelola aset merchant sendiri. Monitoring mengikuti data pemeriksaan jaringan yang tersedia.</p></div>
          <button className="maPill maRefresh" type="button" onClick={reload}><RefreshCw size={15}/> Refresh</button>
        </div>
        <nav className="maMobileNav">{NAV.map(item => { const I = item.icon; return <button key={item.key} type="button" onClick={() => setPage(item.key)} className={page === item.key ? "active" : ""}><I size={15}/>{item.text}</button>; })}</nav>
        <div className="maTimestamp"><Clock3 size={13}/> {loading ? "Memuat dashboard" : "Data terakhir: " + dateWib(refreshedAt)}</div>
        {error && <div className="maFeedback maError" role="alert"><CircleAlert size={17}/>{error}</div>}
        {notice && <div className="maFeedback" role="status"><CheckCircle2 size={17}/>{notice}</div>}

        {page === "overview" && <>
          <div className="maMetrics">
            {[
              ["Domain terdaftar", overview.total, Globe2],
              ["Monitoring aktif", overview.active, Activity],
              ["Keyword", overview.keywords, Layers3],
              ["Whitelist", overview.whitelist_links, ShieldCheck],
              ["Blocked / review", overview.blocked, ShieldAlert],
              ["Node responsif", healthyNodes + " / " + activeNodes, Radio]
            ].map(([label, value, I]) => <button type="button" className="maMetric maMetricButton"
              key={label} aria-label={"Detail " + label}
              onClick={() => setDetail({label, value, section:
                label.includes("Node") ? "nodes" : label.includes("Keyword") || label.includes("Whitelist")
                ? "keywords" : label.includes("Blocked") ? "trust" : "domains"})}>
              <span>{label}</span><I size={18}/><strong>{value ?? "—"}</strong><small>Klik untuk detail</small>
            </button>)}
          </div>
          <div className="maInfo"><ShieldAlert size={20}/><span>Status <b>Unknown</b> bukan konfirmasi aman. Bukti blokir memerlukan sumber resmi dan minimal dua node independen.</span></div>
          <section className="maPanel"><h2>Aktivitas pemeriksaan terakhir</h2><p>Hanya hasil untuk domain merchant ini.</p>
            <div className="maList">{data.history.slice(0, 15).map((item, i) => <div className="maListRow" key={i}>
              <div><strong>{item.domain}</strong><small>{item.provider_name || item.checker_type} · {dateWib(item.checked_at)}</small></div><span className={"maStatus status-" + item.status}>{statusText(item.status)}</span>
            </div>)}{!data.history.length && <div className="maEmpty">Belum ada pemeriksaan terverifikasi.</div>}</div>
          </section>
        </>}

        {page === "domains" && <section className="maPanel">
          <div className="maPanelHead"><div><h2>Domain Merchant</h2><p>Tambah, perbarui, atau jeda monitoring domain sendiri.</p></div>
            <button type="button" className="maPrimary" onClick={() => setShowDomainForm(v => !v)}><Plus size={16}/> Tambah Domain</button></div>
          {showDomainForm && <form className="maForm" onSubmit={async e => {
            e.preventDefault(); if (await act("/api/merchant/domains", "POST", domainForm, "Domain berhasil ditambahkan.")) {
              setDomainForm({ domain: "", project_name: "", label: "landing_page" }); setShowDomainForm(false);
            }
          }}>
            <label>Domain<input required value={domainForm.domain} onChange={e => setDomainForm({ ...domainForm, domain: e.target.value })} placeholder="merchant-domain.com"/></label>
            <label>Project<input value={domainForm.project_name} onChange={e => setDomainForm({ ...domainForm, project_name: e.target.value })} placeholder="Nama project"/></label>
            <label>Jenis<select value={domainForm.label} onChange={e => setDomainForm({ ...domainForm, label: e.target.value })}><option value="ms">Main Site</option><option value="landing_page">Landing Page</option></select></label>
            <button className="maPrimary" disabled={busy}><Save size={15}/> Simpan</button>
          </form>}
          <label className="maSearch"><Search size={16}/><input type="search" placeholder="Cari domain merchant..." value={search} onChange={e => setSearch(e.target.value)}/></label>
          <div className="maList">{ownDomains.map(item => <div className="maListRow maDomainRow" key={item.id}>
            {editing?.id === item.id ? <form className="maEditForm" onSubmit={async e => {
              e.preventDefault(); if (await act("/api/merchant/domains/" + item.id, "PATCH", { project_name: editing.project_name, label: editing.label }, "Domain diperbarui.")) setEditing(null);
            }}>
              <strong>{item.domain}</strong>
              <input value={editing.project_name} onChange={e => setEditing({ ...editing, project_name: e.target.value })}/>
              <select value={editing.label} onChange={e => setEditing({ ...editing, label: e.target.value })}><option value="ms">Main Site</option><option value="landing_page">Landing Page</option></select>
              <button className="maPrimary" disabled={busy}>Simpan</button><button type="button" className="maPill" onClick={() => setEditing(null)}><X size={14}/></button>
            </form> : <>
              <div><strong>{item.domain} <a href={"https://" + item.domain} target="_blank" rel="noreferrer noopener"><ExternalLink size={13}/></a></strong>
                <small>{item.project_name || "Tanpa project"} · {item.label === "ms" ? "Main Site" : "Landing Page"} · {dateWib(item.last_checked_at)}</small></div>
              <div className="maRowActions"><span className={"maStatus status-" + (item.global_status || "unknown")}>{statusText(item.global_status)}</span>
                <button type="button" className="maPill" onClick={() => setEditing({ id: item.id, project_name: item.project_name || "", label: item.label || "landing_page" })}>Edit</button>
                <button type="button" className="maPill" disabled={busy} onClick={() => act("/api/merchant/domains/" + item.id, "PATCH", { is_active: !item.is_active }, "Status monitoring diperbarui.")}>{item.is_active ? "Jeda" : "Aktifkan"}</button></div>
            </>}
          </div>)}{!ownDomains.length && <div className="maEmpty">Belum ada domain yang cocok.</div>}</div>
        </section>}

        {page === "keywords" && <section className="maPanel">
          <div className="maPanelHead"><div><h2>Google Rank & Whitelist</h2><p>Kelola keyword dan whitelist domain merchant.</p></div>
            <button className="maPrimary" type="button" onClick={() => setShowKeywordForm(v => !v)}><Plus size={16}/> Keyword</button></div>
          {showKeywordForm && <form className="maForm" onSubmit={async e => {
            e.preventDefault(); if (await act("/api/merchant/keywords", "POST", keywordForm, "Keyword berhasil ditambahkan.")) { setKeywordForm({ keyword: "", project_name: "" }); setShowKeywordForm(false); }
          }}>
            <label>Keyword<input required value={keywordForm.keyword} onChange={e => setKeywordForm({ ...keywordForm, keyword: e.target.value })} placeholder="LOGIN MERCHANT"/></label>
            <label>Project<input value={keywordForm.project_name} onChange={e => setKeywordForm({ ...keywordForm, project_name: e.target.value })} placeholder="Nama project"/></label>
            <button className="maPrimary" disabled={busy}>Simpan</button>
          </form>}
          <div className="maList">{data.keywords.map(item => <div className="maKeyword" key={item.id}>
            <div className="maKeywordTop"><div><h3>{item.keyword}</h3><small>{item.project_name || "Brand"} · Terakhir diperiksa {dateWib(item.last_checked_at)}</small></div>
              <button type="button" className="maPill" disabled={busy} onClick={() => act("/api/merchant/keywords/" + item.id, "PATCH", { is_active: !item.is_active }, "Status keyword diperbarui.")}>{item.is_active ? "Jeda" : "Aktifkan"}</button></div>
            <div className="maChips">{(item.whitelist || []).map(d => <span key={d.domain}>{d.domain}<button type="button" title="Hapus whitelist" disabled={busy}
              onClick={() => act("/api/merchant/keywords/" + item.id + "/whitelist/" + encodeURIComponent(d.domain), "DELETE", undefined, "Domain dikeluarkan dari whitelist.")}><X size={12}/></button></span>)}</div>
            <form className="maLinkForm" onSubmit={async e => {
              e.preventDefault(); const domain = linkFor[item.id]; if (!domain) return;
              if (await act("/api/merchant/keywords/" + item.id + "/whitelist", "POST", { domain }, "Whitelist ditambahkan.")) setLinkFor(prev => ({ ...prev, [item.id]: "" }));
            }}>
              <select aria-label={"Domain whitelist " + item.keyword} value={linkFor[item.id] || ""} onChange={e => setLinkFor(prev => ({ ...prev, [item.id]: e.target.value }))}>
                <option value="">Pilih domain milik merchant</option>
                {data.domains.filter(d => d.is_active).map(d => <option value={d.domain} key={d.id}>{d.domain}</option>)}
              </select><button className="maPill" disabled={busy || !linkFor[item.id]}><Plus size={14}/> Tambah Whitelist</button>
            </form>
          </div>)}{!data.keywords.length && <div className="maEmpty">Belum ada keyword untuk merchant ini.</div>}</div>
        </section>}

        {page === "nodes" && <section className="maNodePageV2">
          <div className="maNodePageHead">
            <div>
              <span className="maNodeEyebrow">PENTAGON NETWORK MONITORING</span>
              <h2>Provider Node Health</h2>
              <p>Live telemetry, signal strength, battery dan konektivitas checker. Read-only untuk Merchant Admin.</p>
            </div>
            <button className="maNodeRefreshBtn" type="button" onClick={reload} disabled={loading}>
              <RefreshCw size={16}/> Refresh Status
            </button>
          </div>
          <div className="maNodeStatsV2">
            <div><span>TOTAL NODES</span><strong>{data.nodes.length}</strong></div>
            <div><span>ACTIVE</span><strong>{activeNodes}</strong></div>
            <div><span>ONLINE</span><strong>{healthyNodes}</strong></div>
            <div><span>WAITING / OFFLINE</span><strong>{data.nodes.filter(node =>
              node.is_active && node.connectivity !== "online").length}</strong></div>
          </div>
          <div className="maNodeGridV2">
            <button type="button" className="maDirectNodeCard" onClick={()=>setPage("direct")}>
              <Activity size={29}/>
              <strong>Direct Checker</strong>
              <span>HTTP/HTTPS dari Railway, terpisah dari node SIM</span>
              <small>Riwayat untuk {data.direct?.domains?.length ?? 0} domain merchant</small>
              <b>Buka Direct Checker →</b>
            </button>
            {data.nodes.map(node =>
              <MerchantNodeCardV2 key={node.public_alias} node={node} asOf={data.nodeAsOf || refreshedAt}
                onSelect={()=>setDetail({label:node.public_alias,value:node.connectivity,node})}/>
            )}
            {!data.nodes.length && <div className="maNodeEmptyV2">
              <Radio size={28}/>
              <strong>Belum ada node</strong>
              <span>{loading ? "Memuat telemetry..." : "Tidak ada node pemeriksa yang tersedia untuk merchant ini."}</span>
            </div>}
          </div>
          <div className="maNodeInfoV2"><ShieldAlert size={18}/>
            <span>Indikator ACTIVE menunjukkan node diaktifkan. ONLINE memerlukan heartbeat terbaru.
              Sinyal dan battery bertanda Last Reading berasal dari pembacaan sebelumnya.
              Status domain tetap memerlukan bukti pemeriksaan resmi dan minimal dua node independen.</span>
          </div>
          <div className="maNodeFootV2">Terakhir diperbarui: {dateWib(data.nodeAsOf || refreshedAt)} · Network data read-only</div>
        </section>}

        {page === "trust" && <section className="maPanel">
          <div className="maPanelHead"><div><h2>Trust Positif Monitoring</h2>
            <p>Evidence domain merchant dan sumber pengecekan. Status Unknown bukan indikasi aman.</p></div>
            <button type="button" className="maPill" onClick={reload}><RefreshCw size={15}/> Refresh</button></div>
          {data.trust ? <>
            <div className="maMetrics">
              <div className="maMetric"><span>DOMAIN</span><strong>{data.trust.domain_summary?.total ?? 0}</strong></div>
              <div className="maMetric"><span>AKTIF</span><strong>{data.trust.domain_summary?.active ?? 0}</strong></div>
              <div className="maMetric"><span>SUMBER DIPERIKSA</span><strong>{data.trust.official_source_checks?.length ?? 0}</strong></div>
            </div>
            <div className="maInfo"><ShieldAlert size={19}/>
              <span>Konfirmasi blocked memerlukan evidence resmi dan minimum dua provider node independen. Tidak ada simulasi status.</span></div>
            <div className="maList">{data.trust.domains?.map(d=><button key={d.domain} className="maDataRowBtn"
              type="button" onClick={()=>setDetail({label:d.domain,value:d.global_status,domain:d})}>
              <strong>{d.domain}</strong><span>{statusText(d.global_status)}</span>
              <small>Checker independen 24 jam: {d.recent_node_providers} · Bukti: {dateWib(d.latest_evidence_at)}</small>
            </button>)}{!data.trust.domains?.length&&<div className="maEmpty">Belum ada domain.</div>}</div>
          </>:<div className="maEmpty">Evidence Trust Positif belum dapat dimuat. Periksa koneksi server.</div>}
        </section>}

        {page === "direct" && <section className="maPanel">
          <h2>Direct Checker</h2>
          <p>Riwayat hasil pemeriksaan koneksi langsung dari server, bukan node SIM atau daftar resmi Trust Positif.</p>
          <div className="maInfo"><Activity size={18}/><span>Belum ada hasil berarti belum diperiksa, bukan otomatis normal. Pemeriksaan ini hanya menampilkan hasil yang benar-benar tersimpan.</span></div>
          {data.direct ? <div className="maList">{data.direct.domains?.map(d=><div key={d.domain} className="maDirectRow">
            <button type="button" className="maDataRowBtn" onClick={()=>setDetail({label:d.domain,value:d.status,direct:d})}>
              <strong>{d.domain}</strong><span>{statusText(d.status)}</span>
              <small>HTTP {d.http_status ?? "N/A"} · {d.latency_ms ?? "N/A"} ms · {dateWib(d.checked_at)}</small>
            </button>
            <button type="button" className="maPrimary" disabled={busy||!d.is_active} onClick={()=>
              act("/api/merchant/direct-checker/run","POST",{domain:d.domain},"Direct Checker selesai.")}>
              <RefreshCw size={14}/> Periksa Langsung
            </button>
          </div>)}</div>:<div className="maEmpty">Data Direct Checker belum tersedia.</div>}
        </section>}

        {page === "alerts" && <section className="maPanel"><h2>Notifikasi Merchant</h2><p>Hanya kejadian domain merchant ini, tanpa notifikasi pelanggan lain.</p>
          <div className="maList">{data.alerts.map(item => <div className="maListRow" key={item.id}><div><strong>{item.domain}</strong><small>{dateWib(item.created_at)}</small></div>
            <span className={"maStatus status-" + item.new_status}>{statusText(item.new_status)}</span></div>)}
            {!data.alerts.length && <div className="maEmpty">Belum ada alert tercatat. Ini bukan konfirmasi semua domain sehat.</div>}</div>
        </section>}

        {page === "settings" && <section className="maPanel"><h2>Profil Merchant</h2><p>Hak akses yang berlaku untuk akun saat ini.</p>
          <div className="maAccountDetails"><div><small>Merchant</small><strong>{data.profile.tenant || "—"}</strong></div>
            <div><small>Role</small><strong>Merchant Administrator</strong></div>
            <div><small>Akun</small><strong>{accountEmail || "—"}</strong></div>
            <div><small>Ruang lingkup</small><strong>Domain, keyword, whitelist, laporan merchant</strong></div></div>
          <h2 className="maTelegramHeading">Telegram Merchant</h2>
          <p>Gunakan Telegram Chat ID grup merchant. Bot pusat tetap dikelola Super Admin.</p>
          <form className="maForm maTelegramForm" onSubmit={async e=>{
            e.preventDefault();
            await act("/api/merchant/telegram","PATCH",telegramForm,"Pengaturan Telegram tersimpan.");
          }}>
            <label>Telegram Chat ID<input value={telegramForm.chat_id}
              placeholder="-1001234567890" onChange={e=>setTelegramForm(p=>({...p,chat_id:e.target.value}))}/></label>
            <label className="maTelegramToggle">
              <input type="checkbox" checked={telegramForm.enabled}
                onChange={e=>setTelegramForm(p=>({...p,enabled:e.target.checked}))}/>
              Aktifkan notifikasi</label>
            <button className="maPrimary" disabled={busy}>Simpan</button>
            <button className="maPill" type="button" disabled={busy||!data.telegram?.enabled}
              onClick={()=>act("/api/merchant/telegram/test","POST",{},"Pesan uji Telegram terkirim.")}>
              <Bell size={14}/> Test Send
            </button>
          </form>
          <div className="maInfo"><LockKeyhole size={16}/>
            <span>Bot: {data.telegram?.bot_configured?"Tersedia":"Belum dikonfigurasi"}.
              Test Send hanya mengirim pesan ketika ditekan. Notifikasi otomatis harus dihubungkan ke jalur alert terverifikasi.</span></div>
          <div className="maInfo"><LockKeyhole size={18}/><span>Pengaturan Super Admin, node fisik, Telegram global, serta data merchant lain tetap dilindungi.</span></div>
        </section>}
        {detail && <div className="maDialogBackdrop" role="presentation"
          onMouseDown={e=>{if(e.target===e.currentTarget)setDetail(null);}}>
          <section role="dialog" aria-modal="true" aria-label={"Detail "+detail.label} className="maDetailDialog">
            <div className="maPanelHead"><div><span className="maNodeEyebrow">STATUS DETAIL</span>
              <h2>{detail.label}</h2></div><button type="button" className="maPill"
              onClick={()=>setDetail(null)} aria-label="Tutup"><X size={18}/></button></div>
            <div className="maDetailValue">{String(detail.value ?? "Belum tersedia")}</div>
            {detail.domain && <p>Node independen: {detail.domain.recent_node_providers}. Evidence terbaru: {dateWib(detail.domain.latest_evidence_at)}.
              Hanya domain merchant ini.</p>}
            {detail.direct && <p>HTTP: {detail.direct.http_status ?? "N/A"}, durasi: {detail.direct.latency_ms ?? "N/A"} ms,
              terakhir diperiksa: {dateWib(detail.direct.checked_at)}.</p>}
            {detail.node && <p>Provider: {detail.node.provider_name}. Sinyal: {detail.node.signal_label},
              {detail.node.signal_bars ?? "N/A"} / 5 bar. Battery: {detail.node.battery_percent ?? "N/A"}%.
              Active: {detail.node.is_active ? "Yes" : "No"}. Heartbeat: {dateWib(detail.node.last_seen_at)}.
              Status online memerlukan heartbeat terbaru, bukan hanya APK terbuka.</p>}
            {!detail.domain && !detail.direct && !detail.node && <div>
              <p>Rincian berasal dari data tenant merchant, bukan simulasi. Klik halaman terkait untuk hasil lengkap.</p>
              <div className="maDetailEntries">
                {(detail.section==="nodes" ? data.nodes.map(n=>({name:n.public_alias,description:n.connectivity+" · "+dateWib(n.last_seen_at)})):
                  detail.section==="keywords" ? data.keywords.map(k=>({name:k.keyword,description:(k.whitelist||[]).length+" relasi whitelist"})):
                  detail.section==="trust" ? (data.trust?.domains||[]).filter(d=>["blocked","warning"].includes(d.global_status))
                    .map(d=>({name:d.domain,description:statusText(d.global_status)})):
                  data.domains.map(d=>({name:d.domain,description:statusText(d.global_status)}))
                ).slice(0,12).map((item,i)=><div key={i}><strong>{item.name}</strong><small>{item.description}</small></div>)}
              </div>
            </div>}
            {detail.section && <button className="maPrimary" type="button"
              onClick={()=>{setPage(detail.section);setDetail(null);}}>Buka {detail.section}</button>}
          </section>
        </div>}
      </main>
    </div>
  </div>;
}
