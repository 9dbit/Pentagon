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
  if (row.recovered_at && row.listed === false && row.global_status === "working")
    return {key:"healthy",text:"NORMAL · koneksi dua provider pulih"};
  if (row.recovered_at && row.listed === false)
    return {key:"recovered",text:"Delisted · menunggu koneksi normal"};
  if (row.registry_listed === true && row.listed !== true)
    return {key:"registry",text:"Terdaftar registry · menunggu pemicu 2 WARNING"};
  if (recent && votes >= 2 && (row.last_error || row.listed == null))
    return {key:"verifying",text:"Verifying / menunggu registry"};
  if (recent && votes > 0 && row.listed !== true) return {key:"suspected",text:"Suspected / sinyal jaringan"};
  if (row.listed === true) return {key:"verifying",text:"Registry listed, status menunggu"};
  if (row.registry_listed === false && row.global_status === "working" &&
      since(row.last_node_check_at) < 20 * 60 * 1000 && !recent)
    return {key:"healthy",text:"Network healthy · registry clear"};
  if (row.registry_listed === false) return {key:"unknown",text:"Tidak terdaftar registry · jaringan belum terkonfirmasi"};
  return {key:"unknown",text:"Unknown / belum diverifikasi"};
}
const readinessLabels = {
  ready_to_scan:"Siap memeriksa domain admin dari dua provider sehat",
  no_approved_admin_domain:"Belum ada domain produksi yang disetujui",
  eligible_rank_whitelist_pending_sync:"Whitelist Google Rank menunggu sinkronisasi",
  admin_domains_disabled:"Domain administrator belum diaktifkan",
  review_cross_tenant_conflicts:"Konflik kepemilikan domain antar-tenant harus ditinjau",
  review_invalid_whitelist_names:"Nama domain pada whitelist perlu diperbaiki",
  waiting_two_healthy_independent_providers:"Menunggu dua provider checker yang sehat dan independen",
  inventory_unavailable:"Inventarisasi database belum tersedia"
};
const workerLabel = worker => {
  if (!worker?.enabled) return "Nonaktif";
  if (worker.lastResult === "complete") return "Aktif, siklus selesai";
  if (worker.lastResult === "waiting_two_active_nodes") return "Menunggu dua node aktif";
  if (worker.lastResult === "waiting_database_schema") return "Menunggu kesiapan database";
  if (worker.lastResult === "no_active_domains" || worker.lastResult === "no_customer_domains")
    return "Aktif, belum ada domain pelanggan production";
  if (worker.lastResult === "waiting_two_healthy_independent_providers")
    return "Menunggu dua ISP berbeda dengan heartbeat terbaru";
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
  const [tenantFilter,setTenantFilter] = useState("all");
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
  const tenants = useMemo(() => [...new Set(all.map(row => String(row.tenant || "admin")))].sort(),[all]);
  const rows = useMemo(() => {
    const q=filter.trim().toLowerCase();
    return all.filter(row => {
      if (statusFilter !== "all" && classify(row).key !== statusFilter) return false;
      if (projectFilter !== "all" && !String(row.project_name || "").split(",").map(x=>x.trim()).includes(projectFilter)) return false;
      if (providerFilter !== "all" && !providerNames(row).includes(providerFilter)) return false;
      if (tenantFilter !== "all" && String(row.tenant||"admin") !== tenantFilter) return false;
      return !q || [row.domain,row.tenant,row.project_name,classify(row).text,...providerNames(row)]
        .some(value => String(value || "").toLowerCase().includes(q));
    });
  },[all,filter,statusFilter,projectFilter,providerFilter,tenantFilter]);
  const counts = all.reduce((obj,row)=>{const key=classify(row).key;obj[key]=(obj[key]||0)+1;return obj;},{});
  const recentPcEvidence=all.filter(row=>row.registry_collector==="TRADEVICEPC" &&
    row.registry_checked_at && since(row.registry_checked_at)<12*3600000).length;
  const nodeHealth=data?.node_health || {};
  const delivery=data?.notification_delivery || {};
  const readiness=data?.readiness || null;
  const customerCoverage=data?.customer_coverage || null;
  function resetFilters(setter,value) {setter(value);setVisibleCount(100);}

  return <section className="tpWatchReport" aria-label="Whitelisted domain TrustPositif monitoring">
    <div className="tpWatchHead">
      <div>
        <span className="tpWatchEyebrow">AUTOMATIC DOMAIN DEFENCE</span>
        <h2>Whitelist monitoring</h2>
        <p>Minimal {data?.min_nodes || 2} node provider berbeda yang melaporkan WARNING menjadi pemicu. TRADEVICEPC menentukan
          BLOCKED lewat exact-match registry resmi. NORMAL hanya setelah registry tidak terdaftar
          dan dua provider membuktikan koneksi pulih dalam dua siklus.</p>
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
    {readiness && readiness.reason !== "ready_to_scan" && <section className="tpWatchReadiness"
      aria-label="Whitelist reconciliation readiness" role="status">
      <div><b>Whitelist preflight</b>
        <p>{readinessLabels[readiness.reason] || "Status whitelist belum dapat dipastikan"}. Pemeriksaan ini hanya membaca database, tanpa impor, aktivasi domain, atau alarm Telegram.</p>
      </div>
      {readiness.domains && readiness.whitelist && readiness.nodes && <div className="tpWatchReadinessCounts">
        <span>Admin aktif <b>{readiness.domains.active}</b></span>
        <span>Admin nonaktif <b>{readiness.domains.inactive}</b></span>
        <span>Rank whitelist valid <b>{readiness.whitelist.valid_distinct}</b></span>
        <span>Belum tersinkron <b>{readiness.whitelist.unimported}</b></span>
        <span>Konflik tenant <b>{readiness.whitelist.cross_tenant_conflicts}</b></span>
        <span>Nama tidak valid <b>{readiness.whitelist.invalid_names}</b></span>
        <span>Provider sehat independen <b>{readiness.nodes.online_independent_providers}</b></span>
      </div>}
      <small>Status admin perlu validasi kepemilikan. Data tenant demo dan impor migrasi yang belum disetujui tidak diaktifkan otomatis.</small>
    </section>}
    {customerCoverage && <section className="tpWatchCustomerCoverage" aria-label="Customer whitelist production coverage">
      <div><b>Seluruh whitelist pelanggan production</b>
        <p>Sinkronisasi otomatis mempertahankan tenant masing-masing. Data demo, benturan kepemilikan domain, dan monitor yang sengaja dinonaktifkan tidak diaktifkan.</p>
      </div>
      <div className="tpWatchCoverageCounts">
        <span>Whitelist sumber valid <b>{customerCoverage.valid_tenant_domains ?? "—"}</b></span>
        <span>Monitor aktif <b>{customerCoverage.active_production_domains ?? "—"}</b></span>
        <span>Menunggu sinkronisasi <b>{customerCoverage.awaiting_import ?? "—"}</b></span>
        <span>Konflik / karantina <b>{(Number(customerCoverage.quarantined_cross_tenant_sources||0)+Number(customerCoverage.occupied_by_other_tenant||0))}</b></span>
        <span>Data demo dikecualikan <b>{customerCoverage.excluded_nonproduction_rows ?? "—"}</b></span>
      </div>
    </section>}
    <div className="tpWatchMetrics">
      <div><span>Domain whitelist</span><strong>{data?.summary?.total ?? "—"}</strong></div>
      <div><span>Aktif dimonitor</span><strong>{data?.summary?.monitored ?? "—"}</strong></div>
      <div><span>Registry listed · menunggu trigger</span><strong>{data?.summary?.registry_pending_isp ?? (counts.registry||0)}</strong></div>
      <div><span>Suspected / verifying</span><strong>{(counts.suspected || 0)+(counts.verifying || 0)}</strong></div>
      <div><span>Blocked</span><strong className="tpWatchBadNumber">{counts.blocked || 0}</strong></div>
      <div><span>Registry delisted</span><strong>{counts.recovered || 0}</strong></div>
    </div>
    <p className="tpWatchOperationalMeta">
      <span>Telegram queued: <b>{delivery.queued ?? "—"}</b></span>
      <span>Delivered: <b>{delivery.sent ?? "—"}</b></span>
      <span>Needs review: <b>{delivery.attention ?? "—"}</b></span>
      <span>Registry belum diperiksa: <b>{data?.summary?.registry_unchecked ?? "—"}</b></span>
      <span>TRADEVICEPC verified registry: <b>{recentPcEvidence}</b></span>
      <span>Railway direct source: <b>{data?.worker?.registry_sync?.lastResult || "—"}</b></span>
      <span>Dashboard refreshed: {displayTime(data?.generated_at)}</span>
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
        <option value="blocked">Blocked</option><option value="registry">Registry listed · 2 warning pending</option><option value="suspected">Suspected</option>
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
      <label><span>Pelanggan</span><select aria-label="Filter pelanggan" value={tenantFilter}
        onChange={e=>resetFilters(setTenantFilter,e.target.value)}>
        <option value="all">Semua pelanggan</option>{tenants.map(t=><option key={t} value={t}>{t}</option>)}
      </select></label>
    </div>
    <p className="tpWatchResultCount">{rows.length} dari {all.length} domain sesuai filter</p>
    <div className="tpWatchRows">
      {rows.slice(0,visibleCount).map(row => {
        const status=classify(row),nodes=Array.isArray(row.anomaly_nodes)?row.anomaly_nodes:[];
        return <article className="tpWatchRow" key={(row.tenant||"admin")+":"+row.domain}>
          <div className="tpWatchDomain"><b>{row.domain}</b><span>{row.project_name || "No project"} · Tenant {row.tenant||"admin"}
            {row.rank_whitelisted ? " · Google Rank whitelist" : " · Domain monitor"}</span></div>
          <div className="tpWatchEvidence"><span className={"tpWatchPill "+status.key}>
            {status.key==="blocked" ? <ShieldAlert size={13}/> :
              status.key==="healthy" || status.key==="recovered" ? <CheckCircle2 size={13}/> : <ShieldCheck size={13}/>}
            {status.text}</span>
            <small>{nodes.length} node evidence · Registry check: {displayTime(row.registry_checked_at)}
              {row.registry_listed===true ? (row.registry_lookup_domain!==row.domain ? " · APEX MATCH" : " · EXACT MATCH") :
                row.registry_listed===false ? " · NOT LISTED" : " · UNKNOWN"}</small>
          </div>
          <div className="tpWatchWhen">
            {status.key==="blocked" ? <span className="tpWatchTimestamp"><BellRing size={13}/> First detected: {displayTime(row.detected_at)}</span> :
              status.key==="recovered" ? <span><CheckCircle2 size={13}/> Registry delisted: {displayTime(row.recovered_at)}</span> :
              <span><Clock3 size={13}/> Node: {displayTime(row.last_node_check_at || row.last_anomaly_at)}</span>}
            {row.last_error && <small>Source pending: {String(row.last_error).slice(0,90)} · Retry {displayTime(row.next_check_at)}</small>}
          </div>
          {(nodes.length>0 || row.last_error || row.source || row.registry_checked_at || row.registry_last_error) && <details className="tpWatchDetails">
            <summary>Evidence &amp; history <ChevronDown size={13}/></summary>
            <div className="tpWatchDetailBody">
              <div><b>Official registry:</b> {row.registry_listed===true ? "LISTED · exact source match" :
                row.registry_listed===false ? "NOT LISTED (snapshot)" : "NOT CHECKED"}</div>
              <div><b>Registry source:</b> {row.registry_source || "Not checked"}</div>
              <div><b>Collector:</b> {row.registry_collector || "Not available"}</div>
              <div><b>Warning trigger:</b> {displayTime(row.registry_triggered_at)}</div>
              <div><b>Recovery checks:</b> {row.recovery_streak || 0}/2 consecutive provider cycles</div>
              <div><b>Registry checked:</b> {displayTime(row.registry_checked_at)}</div>
              <div><b>Registry collector:</b> {row.registry_collector || "Not recorded"} · {row.registry_match_kind || "—"}</div>
              {row.registry_snapshot_sha256 && <div><b>Snapshot SHA-256:</b> <code>{row.registry_snapshot_sha256.slice(0,16)}…</code></div>}
              {row.registry_snapshot_bytes && <div><b>Snapshot:</b> {Number(row.registry_snapshot_bytes).toLocaleString("id-ID")} bytes · {Number(row.registry_snapshot_entries||0).toLocaleString("id-ID")} entries</div>}
              <div><b>Registry lookup key:</b> {row.registry_lookup_domain || "Not checked"}{row.registry_lookup_domain && row.registry_lookup_domain!==row.domain ? " (www alias uses parent lookup)" : ""}</div>
              {row.registry_last_error && <div><b>Registry sync:</b> {row.registry_last_error}</div>}
              <div><b>BLOCKED confirmation source:</b> {row.source || "Awaiting 2 provider signals"}</div>
              <div><b>Verified at:</b> {displayTime(row.verified_at)}</div>
              <div><b>First node anomaly:</b> {displayTime(row.first_anomaly_at)}</div>
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
          <div><b>{evt.domain}</b><span>{evt.tenant || "admin"} · {evt.event_type === "BLOCKED" ? "Blocked" : "Registry delisted"} · {displayTime(evt.created_at)}</span></div>
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
