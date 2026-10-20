import React, { useEffect, useMemo, useState } from "react";
import { BellRing, CheckCircle2, ChevronDown, Clock3, RefreshCw, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import "./TrustPositifWatchlist.css";

const displayTime = value => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "Belum tersedia";
  return new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta",
    day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) + " WIB";
};
const since = value => value && Number.isFinite(new Date(value).getTime())
  ? Date.now() - new Date(value).getTime() : Infinity;
const providerNames = row => [...new Set((Array.isArray(row.anomaly_nodes) ? row.anomaly_nodes : [])
  .map(node => String(node.provider || node.name || "").trim()).filter(Boolean))];

function classify(row) {
  const votes = Array.isArray(row.anomaly_nodes) ? row.anomaly_nodes.length : 0;
  const recent = since(row.last_anomaly_at) < 20 * 60 * 1000;
  if (!row.monitored) return {key:"off",text:"Monitor nonaktif"};
  if (row.listed === true && row.global_status === "blocked") return {key:"blocked",text:"BLOCKED"};
  if (row.recovered_at && row.listed === false) return {key:"recovered",text:"Delisted / recovery registry"};
  if (recent && votes >= 2 && (row.last_error || row.listed == null))
    return {key:"verifying",text:"Verifying / menunggu registry"};
  if (recent && votes > 0 && row.listed !== true) return {key:"suspected",text:"Suspected / sinyal jaringan"};
  if (row.listed === true) return {key:"verifying",text:"Registry listed, status menunggu"};
  if (row.listed === false) return {key:"healthy",text:"Tidak terdaftar di registry"};
  return {key:"unknown",text:"Unknown / belum diverifikasi"};
}
const workerLabel = worker => {
  if (!worker?.enabled) return "Nonaktif";
  if (worker.lastResult === "complete") return "Aktif, siklus selesai";
  if (worker.lastResult === "waiting_two_active_nodes") return "Menunggu dua node aktif";
  if (worker.lastResult === "waiting_database_schema") return "Menunggu kesiapan database";
  if (worker.lastResult === "no_active_domains") return "Aktif, tidak ada domain";
  if (worker.lastResult === "error") return "Terjadi kesalahan pemeriksaan";
  return "Aktif, menunggu siklus";
};
const chooseText = node => [node.name || ("Node "+node.id),node.provider || "",node.status || "",node.reason || ""].filter(Boolean).join(" · ");

export default function TrustPositifWatchlist() {
  const [data,setData] = useState(null);
  const [filter,setFilter] = useState("");
  const [statusFilter,setStatusFilter] = useState("all");
  const [projectFilter,setProjectFilter] = useState("all");
  const [providerFilter,setProviderFilter] = useState("all");
  const [visibleCount,setVisibleCount] = useState(100);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState("");

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/trustpositif/watchlist", {credentials:"include",cache:"no-store"});
      if (!response.ok) throw Error("Watchlist HTTP "+response.status);
      const json = await response.json();
      setData(json);
      setError("");
    } catch (err) { setError("Watchlist belum tersedia: "+err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    let busy = false;
    async function refresh() {
      if (busy || !active) return;
      busy=true;
      try {
        const response=await fetch("/api/trustpositif/watchlist", {credentials:"include",cache:"no-store"});
        if (!response.ok) throw Error("Watchlist HTTP "+response.status);
        const json=await response.json();
        if (active) {setData(json);setError("");}
      } catch(err) {if(active)setError("Watchlist belum tersedia: "+err.message);}
      finally {busy=false;}
    }
    refresh();
    const timer=setInterval(refresh,30000); // DB-only; refresh never calls Komdigi
    return()=>{active=false;clearInterval(timer);};
  },[]);

  const all = Array.isArray(data?.domains) ? data.domains : [];
  const projects = useMemo(() => [...new Set(all.flatMap(row => String(row.project_name || "")
    .split(",").map(x=>x.trim()).filter(Boolean)))].sort(),[all]);
  const providers = useMemo(() => [...new Set(all.flatMap(providerNames))].sort(),[all]);
  const rows = useMemo(() => {
    const q=filter.trim().toLowerCase();
    return all.filter(row => {
      if (statusFilter !== "all" && classify(row).key !== statusFilter) return false;
      if (projectFilter !== "all" && !String(row.project_name || "").split(",").map(x=>x.trim()).includes(projectFilter)) return false;
      if (providerFilter !== "all" && !providerNames(row).includes(providerFilter)) return false;
      return !q || [row.domain,row.project_name,classify(row).text,...providerNames(row)]
        .some(value => String(value || "").toLowerCase().includes(q));
    });
  },[all,filter,statusFilter,projectFilter,providerFilter]);
  const counts = all.reduce((obj,row)=>{const key=classify(row).key;obj[key]=(obj[key]||0)+1;return obj;},{});
  const nodeHealth=data?.node_health || {};
  const delivery=data?.notification_delivery || {};
  function resetFilters(setter,value) {setter(value);setVisibleCount(100);}

  return <section className="tpWatchReport" aria-label="Whitelisted domain TrustPositif monitoring">
    <div className="tpWatchHead">
      <div>
        <span className="tpWatchEyebrow">AUTOMATIC DOMAIN DEFENCE</span>
        <h2>Whitelist monitoring</h2>
        <p>Domain monitor aktif dan seluruh domain whitelist Google Rank. Status BLOCKED hanya setelah
          minimal {data?.min_nodes || 2} node dari provider independen serta pencocokan exact registry Komdigi.</p>
      </div>
      <button type="button" className="tpWatchRefreshButton" disabled={loading} onClick={load}>
        <RefreshCw size={14}/>{loading ? "Memuat..." : "Refresh"}
      </button>
    </div>
    <p className="tpWatchWorkerState" role="status">
      <b>Worker:</b> {workerLabel(data?.worker)} · Node aktif: {nodeHealth.active ?? data?.worker?.activeNodes ?? "—"} ·
      Node sehat 20 menit: {nodeHealth.recently_healthy ?? "—"} ·
      Siklus terakhir: {displayTime(data?.worker?.lastFinishedAt)}
    </p>
    <div className="tpWatchMetrics">
      <div><span>Domain whitelist</span><strong>{data?.summary?.total ?? "—"}</strong></div>
      <div><span>Aktif dimonitor</span><strong>{data?.summary?.monitored ?? "—"}</strong></div>
      <div><span>Suspected / verifying</span><strong>{(counts.suspected || 0)+(counts.verifying || 0)}</strong></div>
      <div><span>Blocked</span><strong className="tpWatchBadNumber">{counts.blocked || 0}</strong></div>
      <div><span>Registry delisted</span><strong>{counts.recovered || 0}</strong></div>
    </div>
    <p className="tpWatchOperationalMeta">
      <span>Telegram queued: <b>{delivery.queued ?? "—"}</b></span>
      <span>Delivered: <b>{delivery.sent ?? "—"}</b></span>
      <span>Needs review: <b>{delivery.attention ?? "—"}</b></span>
      <span>Last sync: {displayTime(data?.generated_at)}</span>
    </p>
    {error && <p className="tpWatchError" role="status">{error}</p>}
    <div className="tpWatchTableHead">
      <div><h3>Monitored domain list</h3>
        <small>Hasil dibaca dari database. Perubahan status menyimpan evidence, timestamp, dan riwayat alert.</small>
      </div>
    </div>
    <div className="tpWatchFilters">
      <label className="tpWatchSearch"><Search size={15}/>
        <input type="search" aria-label="Cari domain atau project" placeholder="Domain / project / provider"
          value={filter} onChange={e=>resetFilters(setFilter,e.target.value)}/>
      </label>
      <label><span>Status</span><select aria-label="Filter status" value={statusFilter}
        onChange={e=>resetFilters(setStatusFilter,e.target.value)}>
        <option value="all">Semua status</option>
        <option value="blocked">Blocked</option><option value="suspected">Suspected</option>
        <option value="verifying">Verifying</option><option value="recovered">Registry delisted</option>
        <option value="healthy">Tidak terdaftar</option><option value="unknown">Unknown</option>
        <option value="off">Monitor nonaktif</option>
      </select></label>
      <label><span>Project</span><select aria-label="Filter project" value={projectFilter}
        onChange={e=>resetFilters(setProjectFilter,e.target.value)}>
        <option value="all">Semua project</option>{projects.map(p=><option key={p} value={p}>{p}</option>)}
      </select></label>
      <label><span>Provider</span><select aria-label="Filter provider" value={providerFilter}
        onChange={e=>resetFilters(setProviderFilter,e.target.value)}>
        <option value="all">Semua provider</option>{providers.map(p=><option key={p} value={p}>{p}</option>)}
      </select></label>
    </div>
    <p className="tpWatchResultCount">{rows.length} dari {all.length} domain sesuai filter</p>
    <div className="tpWatchRows">
      {rows.slice(0,visibleCount).map(row => {
        const status=classify(row),nodes=Array.isArray(row.anomaly_nodes)?row.anomaly_nodes:[];
        return <article className="tpWatchRow" key={row.domain}>
          <div className="tpWatchDomain"><b>{row.domain}</b><span>{row.project_name || "No project"}
            {row.rank_whitelisted ? " · Google Rank whitelist" : " · Domain monitor"}</span></div>
          <div className="tpWatchEvidence"><span className={"tpWatchPill "+status.key}>
            {status.key==="blocked" ? <ShieldAlert size={13}/> :
              status.key==="healthy" || status.key==="recovered" ? <CheckCircle2 size={13}/> : <ShieldCheck size={13}/>}
            {status.text}</span>
            <small>{nodes.length} node evidence · TrustPositif: {displayTime(row.verified_at)}</small>
          </div>
          <div className="tpWatchWhen">
            {status.key==="blocked" ? <span className="tpWatchTimestamp"><BellRing size={13}/> First detected: {displayTime(row.detected_at)}</span> :
              status.key==="recovered" ? <span><CheckCircle2 size={13}/> Registry delisted: {displayTime(row.recovered_at)}</span> :
              <span><Clock3 size={13}/> Node: {displayTime(row.last_node_check_at || row.last_anomaly_at)}</span>}
            {row.last_error && <small>Source pending: {String(row.last_error).slice(0,90)} · Retry {displayTime(row.next_check_at)}</small>}
          </div>
          {(nodes.length>0 || row.last_error || row.source) && <details className="tpWatchDetails">
            <summary>Evidence &amp; history <ChevronDown size={13}/></summary>
            <div className="tpWatchDetailBody">
              <div><b>Official source:</b> {row.source || "Not verified"}</div>
              <div><b>Verified at:</b> {displayTime(row.verified_at)}</div>
              <div><b>First blocked:</b> {displayTime(row.detected_at)}</div>
              <div><b>Registry delisted:</b> {displayTime(row.recovered_at)}</div>
              <div><b>Last anomaly:</b> {displayTime(row.last_anomaly_at)}</div>
              {nodes.map(n=><div key={n.id}><b>Node #{n.id}:</b> {chooseText(n)}</div>)}
            </div>
          </details>}
        </article>;
      })}
      {!rows.length && <div className="tpWatchEmpty">{loading ? "Memuat whitelist..." :
        "Tidak ada domain yang sesuai dengan filter."}</div>}
    </div>
    {rows.length>visibleCount && <button className="tpWatchMoreButton" type="button"
      onClick={()=>setVisibleCount(v=>v+100)}>Tampilkan 100 lagi ({rows.length-visibleCount} tersisa)</button>}
    <section className="tpWatchDeliveryLog" aria-label="Telegram delivery audit">
      <div className="tpWatchTableHead">
        <div><h3>Alert delivery log</h3>
          <small>Riwayat notifikasi resmi yang persisten. Retry hanya untuk kegagalan pasti; timeout ambigu memerlukan review.</small>
        </div>
      </div>
      {(Array.isArray(data?.notification_log) ? data.notification_log : []).slice(0,20).map(evt=>
        <article className="tpWatchDeliveryRow" key={evt.id}>
          <div><b>{evt.domain}</b><span>{evt.event_type === "BLOCKED" ? "Blocked" : "Registry delisted"} · {displayTime(evt.created_at)}</span></div>
          <div className="tpWatchDeliveryStatus"><span className={"tpWatchPill "+(evt.status==="sent"?"healthy":evt.status==="retry"?"verifying":evt.status==="uncertain"?"suspected":"unknown")}>{evt.status}</span>
            <small>Attempt {evt.attempts} · {evt.last_error_code || "No delivery error"}</small></div>
          <details className="tpWatchDetails"><summary>Audit trail <ChevronDown size={13}/></summary>
            <div className="tpWatchDetailBody">
              {(Array.isArray(evt.history)?evt.history:[]).length ?
                evt.history.map((attempt,i)=><div key={i}>{displayTime(attempt.at)} · {attempt.outcome} · {attempt.code || "OK"}</div>) :
                <div>Belum ada pengiriman. Event tersimpan di database.</div>}
            </div>
          </details>
        </article>
      )}
      {!data?.notification_log?.length && <p className="tpWatchEmpty">Belum ada event TrustPositif yang menghasilkan notifikasi.</p>}
    </section>
    <div className="tpWatchFoot"><ShieldCheck size={14}/> Registry cache {Math.round((data?.cache_ttl_minutes || 360)/60)}
      jam. Endpoint gagal atau timeout tidak mengubah domain menjadi blocked atau healthy.
      Status delisted hanya mengonfirmasi hasil registry, bukan pemulihan seluruh jaringan.</div>
  </section>;
}
