import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight, Bell, CheckCircle2, Clock3, Globe2, LockKeyhole,
  LogOut, RefreshCw, Search, ShieldCheck, ShieldAlert, Layers3
} from "lucide-react";
import "./CustomerViewerPage.css";

const timeWib = value => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "Belum diperiksa";
  return new Date(value).toLocaleString("id-ID", {
    timeZone:"Asia/Jakarta",day:"2-digit",month:"short",year:"numeric",
    hour:"2-digit",minute:"2-digit"
  }) + " WIB";
};
const labels = {
  working:"Normal (network)", blocked:"Blocked / perlu verifikasi",
  warning:"Warning", unknown:"Unknown / menunggu node"
};
const statusLabel = status => labels[status] || "Unknown / menunggu node";
async function requestCustomer(url) {
  const response = await fetch(url,{credentials:"include",cache:"no-store"});
  const data = await response.json().catch(()=>({}));
  if (!response.ok) {
    const err = new Error(data.error==="CUSTOMER_ACCESS_REVOKED" ?
      "Akses pelanggan telah dicabut. Silakan login ulang." : "Data pelanggan belum dapat diambil.");
    err.status=response.status;
    throw err;
  }
  return data;
}

export default function CustomerViewerPage({ onLogout, accountEmail = "" }) {
  const [page,setPage] = useState("domains");
  const [search,setSearch] = useState("");
  const [overview,setOverview] = useState({});
  const [domains,setDomains] = useState([]);
  const [keywords,setKeywords] = useState([]);
  const [alerts,setAlerts] = useState([]);
  const [error,setError] = useState("");
  const [loading,setLoading] = useState(true);
  const [refreshedAt,setRefreshedAt] = useState(null);

  useEffect(()=>{
    let active=true, busy=false;
    async function refresh(){
      if(busy || !active) return;
      busy=true;
      try{
        const [o,d,k,a]=await Promise.all([
          requestCustomer("/api/customer/overview"),
          requestCustomer("/api/customer/domains"),
          requestCustomer("/api/customer/keywords"),
          requestCustomer("/api/customer/alerts")
        ]);
        if(active){
          setOverview(o);
          setDomains(Array.isArray(d)?d:[]);
          setKeywords(Array.isArray(k)?k:[]);
          setAlerts(Array.isArray(a)?a:[]);
          setError("");
          setRefreshedAt(new Date().toISOString());
        }
      }catch(err){
        if(active){
          setError(err.message);
          if(err.status===401 || err.status===403) onLogout();
        }
      }finally{busy=false;if(active)setLoading(false);}
    }
    refresh();
    const interval=setInterval(refresh,30000);
    const changed=()=>{if(document.visibilityState==="visible")refresh();};
    document.addEventListener("visibilitychange",changed);
    return()=>{active=false;clearInterval(interval);document.removeEventListener("visibilitychange",changed);};
  },[onLogout]);

  async function logout(){
    try {await fetch("/api/auth/logout",{method:"POST",credentials:"include"});}
    finally {onLogout();}
  }

  const visibleDomains=useMemo(()=>domains.filter(row =>
    (row.domain+" "+(row.project_name||"")+" "+(row.label||""))
      .toLowerCase().includes(search.trim().toLowerCase())),[domains,search]);
  const nav=[
    {key:"domains",label:"Domain",icon:Globe2},
    {key:"keywords",label:"Google Rank",icon:Layers3},
    {key:"alerts",label:"Notifikasi",icon:Bell}
  ];

  return <div className="cvApp">
    <header className="cvHeader">
      <div className="cvBrand"><ShieldCheck size={23} strokeWidth={1.8}/>
        <div><b>PENTAGON</b><span>Customer Monitoring</span></div>
      </div>
      <div className="cvAccount">
        <span className="cvAccountEmail">{accountEmail}</span>
        <span className="cvReadOnly"><LockKeyhole size={12}/> Read only</span>
        <button className="cvSignOut" type="button" onClick={logout}><LogOut size={15}/> <span>Keluar</span></button>
      </div>
    </header>
    <main className="cvMain">
      <section className="cvTitleBar">
        <div>
          <span className="cvEyebrow">CLIENT OVERVIEW</span>
          <h1>{overview.tenant ? overview.tenant.toUpperCase() : "Customer Dashboard"}</h1>
          <p>Whitelist domain dan keyword brand. Status diperbarui dari pemeriksaan server, bukan simulasi.</p>
        </div>
        <div className="cvRefresh">
          <span><Clock3 size={13}/> Dashboard refresh: {refreshedAt?timeWib(refreshedAt):"Belum tersedia"}</span>
          <button onClick={()=>window.location.reload()} type="button"><RefreshCw size={14}/> Refresh</button>
        </div>
      </section>

      <section className="cvMetrics" aria-label="Ringkasan monitoring">
        {[
          ["Domain terdaftar",overview.total],
          ["Aktif dimonitor",overview.active],
          ["Keyword",overview.keywords],
          ["Relasi whitelist",overview.whitelist_links],
          ["Blocked / review",overview.blocked]
        ].map(([label,value])=><div className="cvMetric" key={label}>
          <span>{label}</span><strong>{Number.isFinite(Number(value))?Number(value):"—"}</strong>
        </div>)}
      </section>

      <section className="cvSafetyNote">
        <ShieldAlert size={17}/>
        <p>Domain dengan status <b>Unknown</b> belum memperoleh bukti pemeriksaan yang memadai.
          Status blocked belum dapat dianggap konfirmasi TrustPositif tanpa evidence resmi dan dua node independen.</p>
      </section>

      <nav className="cvNav" aria-label="Halaman pelanggan">
        {nav.map(item=>{const I=item.icon;return <button type="button" key={item.key}
          className={page===item.key?"cvActive":""} onClick={()=>setPage(item.key)}>
          <I size={15}/>{item.label}</button>;})}
      </nav>

      {error && <div className="cvError" role="alert">{error}</div>}
      {page==="domains" && <section className="cvContent">
        <div className="cvSectionHeading"><div><h2>Whitelist domain</h2>
          <p>Domain MS dan landing page terdaftar untuk monitoring.</p></div>
          <label className="cvSearch"><Search size={16}/>
            <input aria-label="Cari domain" type="search" placeholder="Cari domain..." value={search}
              onChange={e=>setSearch(e.target.value)}/></label>
        </div>
        <div className="cvDomainList">
          {visibleDomains.map(domain=><article className="cvDomainRow" key={domain.domain}>
            <div className="cvDomainName">
              <div><b>{domain.domain}</b>
                <a href={"https://"+domain.domain} target="_blank" rel="noreferrer noopener"
                  aria-label={"Buka "+domain.domain}><ArrowUpRight size={14}/></a></div>
              <span>{domain.label==="ms"?"Main Site":domain.label==="landing_page"?"Landing Page":domain.label||"Domain"}
                {" · "}{domain.project_name||"No project"}</span>
            </div>
            <div className={"cvStatus cvStatus-"+(domain.global_status||"unknown")}>
              {domain.global_status==="working"?<CheckCircle2 size={13}/>:<ShieldAlert size={13}/>}
              {statusLabel(domain.global_status)}
            </div>
            <div className="cvLastChecked">Last check: {timeWib(domain.last_checked_at)}</div>
          </article>)}
          {!visibleDomains.length && <p className="cvEmpty">{loading?"Memuat domain...":"Domain tidak ditemukan."}</p>}
        </div>
      </section>}

      {page==="keywords" && <section className="cvContent">
        <div className="cvSectionHeading"><div><h2>Keyword Brand</h2>
          <p>Jumlah domain whitelist untuk setiap keyword.</p></div></div>
        <div className="cvKeywordList">
          {keywords.map((item,i)=><article className="cvKeywordRow" key={item.keyword+"-"+i}>
            <div><b>{item.keyword}</b><span>{item.project_name||"Brand"}</span></div>
            <span>{item.whitelisted_domains} domain whitelist</span>
            <small>Last rank scan: {timeWib(item.last_checked_at)}</small>
          </article>)}
          {!keywords.length && <p className="cvEmpty">{loading?"Memuat keyword...":"Belum ada keyword."}</p>}
        </div>
      </section>}

      {page==="alerts" && <section className="cvContent">
        <div className="cvSectionHeading"><div><h2>Riwayat Notifikasi</h2>
          <p>Hanya alert yang terkait domain milik akun pelanggan ini.</p></div></div>
        {alerts.map(item=><article className="cvAlertRow" key={item.id}>
          <span className="cvStatus cvStatus-warning"><Bell size={13}/>{item.new_status||"Event"}</span>
          <b>{item.domain}</b><small>{timeWib(item.created_at)}</small>
        </article>)}
        {!alerts.length && <div className="cvEmpty">
          <ShieldCheck size={24}/><p>Belum ada alert tercatat. Ini bukan konfirmasi semua domain sehat.</p>
        </div>}
      </section>}
      <footer className="cvFooter"><LockKeyhole size={13}/> Akses baca saja · Data pelanggan terisolasi · Tidak ada kontrol trading, node, atau pengiriman Telegram</footer>
    </main>
  </div>;
}
