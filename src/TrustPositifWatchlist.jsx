import React, { useEffect, useMemo, useState } from "react";
import { BellRing, CheckCircle2, Clock3, RefreshCw, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import "./TrustPositifWatchlist.css";

const displayTime = value => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "Belum diperiksa";
  return new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day:"2-digit",
    month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) + " WIB";
};
function classify(row) {
  if (!row.monitored) return {key:"off",text:"Perlu sinkronisasi"};
  if (row.listed === true && row.global_status === "blocked") return {key:"blocked",text:"BLOCKED"};
  if (row.last_anomaly_at && row.last_error) return {key:"pending",text:"Verifikasi tertunda"};
  if (row.listed === true) return {key:"pending",text:"Terdaftar, evaluasi node"};
  if (row.listed === false) return {key:"clear",text:"Tidak terdaftar"};
  return {key:"monitor",text:"Monitoring"};
}

export default function TrustPositifWatchlist() {
  const [data,setData] = useState(null);
  const [filter,setFilter] = useState("");
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState("");
  useEffect(() => {
    let mounted = true;
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      if (mounted) setLoading(true);
      try {
        const response = await fetch("/api/trustpositif/watchlist", {credentials:"include", cache:"no-store"});
        if (!response.ok) throw Error("Watchlist HTTP " + response.status);
        const json = await response.json();
        if (mounted) { setData(json); setError(""); }
      } catch (err) { if (mounted) setError("Watchlist belum tersedia: " + err.message); }
      finally { busy = false; if (mounted) setLoading(false); }
    }
    load();
    const timer = setInterval(load,30000); // local database only, never the official endpoint
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  const all = Array.isArray(data?.domains) ? data.domains : [];
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return !q ? all : all.filter(row => [row.domain,row.project_name,classify(row).text]
      .some(x => String(x || "").toLowerCase().includes(q)));
  },[all,filter]);
  const blocked = all.filter(r => classify(r).key === "blocked").length;
  const pending = all.filter(r => classify(r).key === "pending" || classify(r).key === "off").length;
  return <section className="tpWatchReport" aria-label="Whitelisted domain TrustPositif monitoring">
    <div className="tpWatchHead">
      <div>
        <span className="tpWatchEyebrow">AUTOMATIC DOMAIN DEFENCE</span>
        <h2>Whitelist monitoring</h2>
        <p>Semua domain aktif dan whitelist Google Rank masuk dalam daftar ini. Minimal {data?.min_nodes || 2} node berbeda harus menemukan anomali sebelum pencocokan exact registry dilakukan.</p>
      </div>
      <span className="tpWatchRefreshState"><RefreshCw size={14} aria-hidden="true"/>{loading ? "Sinkronisasi…" : (data?.worker?.enabled ? "Pemeriksaan otomatis aktif" : "Pemeriksaan otomatis belum aktif")}</span>
    </div>
    {data?.worker && <p className="tpWatchWorkerState" role="status">
      Worker: {data.worker.enabled ? data.worker.lastResult === "complete" ? "Aktif, menjalankan pemeriksaan berkala" : data.worker.lastResult === "waiting_two_active_nodes" ? "Menunggu 2 node checker aktif" : data.worker.lastResult === "waiting_database_schema" ? "Menunggu kesiapan database" : data.worker.lastResult === "error" ? "Pemeriksaan tertunda, lihat sistem" : "Aktif, menunggu siklus berikutnya" : "Belum diaktifkan oleh administrator"}.
      {data.worker.lastFinishedAt ? " Siklus terakhir: " + displayTime(data.worker.lastFinishedAt) : ""}
    </p>}
    <div className="tpWatchMetrics">
      <div><span>Domain terdaftar</span><strong>{data?.summary?.total ?? "—"}</strong></div>
      <div><span>Aktif di monitor</span><strong>{data?.summary?.monitored ?? "—"}</strong></div>
      <div><span>Confirmed blocked</span><strong className="tpWatchBadNumber">{blocked}</strong></div>
      <div><span>Perlu perhatian</span><strong>{pending}</strong></div>
    </div>
    {error && <p className="tpWatchError" role="status">{error}</p>}
    <div className="tpWatchTableHead">
      <div><h3>Domain list</h3><small>Status berasal dari hasil node dan pencocokan exact data Komdigi. Endpoint tidak diperiksa tiap refresh halaman.</small></div>
      <label className="tpWatchSearch"><Search size={15}/><input type="search" aria-label="Cari domain atau project" placeholder="Cari domain / project" value={filter} onChange={e=>setFilter(e.target.value)}/></label>
    </div>
    <div className="tpWatchRows">
      {rows.slice(0,100).map(row => {
        const status = classify(row);
        const nodes = Array.isArray(row.anomaly_nodes) ? row.anomaly_nodes : [];
        return <article className="tpWatchRow" key={row.domain}>
          <div className="tpWatchDomain"><b>{row.domain}</b><span>{row.project_name || "No project"}{row.rank_whitelisted ? " · Google Rank whitelist" : " · Domain monitor"}</span></div>
          <div className="tpWatchEvidence"><span className={"tpWatchPill "+status.key}>
            {status.key==="blocked" ? <ShieldAlert size={13}/> : status.key==="clear" ? <CheckCircle2 size={13}/> : <ShieldCheck size={13}/>}
            {status.text}</span>
            <small>{nodes.length} node anomali · Terakhir cek: {displayTime(row.verified_at)}</small>
          </div>
          <div className="tpWatchWhen">
            {status.key==="blocked" ? <span className="tpWatchTimestamp"><BellRing size={13}/> Detected {displayTime(row.detected_at)}</span>
              : <span><Clock3 size={13}/> Node: {displayTime(row.last_node_check_at)}</span>}
            {row.last_error && <small title={row.last_error}>Koneksi registry gagal, retry terjadwal</small>}
          </div>
        </article>;
      })}
      {!rows.length && <div className="tpWatchEmpty">{loading ? "Memuat daftar whitelist…" : "Tidak ada domain yang sesuai."}</div>}
    </div>
    {rows.length>100 && <p className="tpWatchMore">Menampilkan 100 dari {rows.length} domain. Gunakan pencarian untuk domain tertentu.</p>}
    <div className="tpWatchFoot"><ShieldCheck size={14}/> Cache registry sekitar {Math.round((data?.cache_ttl_minutes || 360)/60)} jam. Gangguan endpoint tidak dihitung sebagai bukti domain normal ataupun blocked.</div>
  </section>;
}
