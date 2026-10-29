import React,{useCallback,useEffect,useState} from "react";
import {QRCodeSVG} from "qrcode.react";
import {ArrowDown,ArrowUp,Copy,ExternalLink,Link2,Plus,RefreshCw,Trash2} from "lucide-react";
import "./ShieldLinkPage.css";

const messages={NO_READY_DESTINATION:"Belum ada tujuan yang siap. Simpan sebagai draf atau tambahkan fallback yang siap sebelum mengaktifkan link.",OWN_ACTIVE_PROJECT_DOMAIN_REQUIRED:"Pilih domain aktif milik project ini.",INVALID_DESTINATION:"Gunakan URL HTTP/HTTPS dari domain terdaftar.",DUPLICATE_DESTINATION:"URL fallback sudah ditambahkan.",PRIMARY_ALREADY_SELECTED:"URL ini sudah menjadi tujuan utama.",FALLBACK_CHANGED:"Daftar berubah. Refresh lalu coba kembali.",SHIELDLINK_LIMIT:"Batas 50 link per merchant telah tercapai.",FALLBACK_LIMIT:"Batas 30 fallback per link telah tercapai."};
const date=value=>value?new Date(value).toLocaleString("id-ID",{timeZone:"Asia/Jakarta",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})+" WIB":"Belum ada redirect";
const checkedDate=value=>value?date(value):"Belum diperiksa";
function matchingDomain(url,domains){try{const hostname=new URL(url.includes("://")?url:"https://"+url).hostname.replace(/^www\./,"").toLowerCase();return domains.find(d=>d.domain.replace(/^www\./,"").toLowerCase()===hostname);}catch(_){return null;}}
function DestinationPreview({url,domains}){
  if(!url)return null;
  const domain=matchingDomain(url,domains);
  return <p className={"shieldLinkPreflight "+(domain?.eligible?"shieldLinkReady":"shieldLinkWarning")} role="status">
    <strong>{domain?.readiness?.text||"Pilih domain aktif dari project ini."}</strong>
    {domain&&<span>Jaringan: {checkedDate(domain.last_checked_at)} · Registry: {checkedDate(domain.registry_checked_at)}</span>}
    {!domain?.eligible&&<span>URL ini belum dapat menjadi tujuan redirect. Gunakan domain yang siap atau simpan link sebagai draf.</span>}
  </p>;
}
async function request(path,options={}){
  const r=await fetch(path,{credentials:"include",cache:"no-store",...options,headers:{"Content-Type":"application/json"}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error((messages[data.error]||"Shieldlink belum dapat diproses. Coba refresh.")+(data.destinations?.[0]?.text?" Tujuan utama: "+data.destinations[0].text+".":""));
  return data;
}
function LinkCard({link,domains,mutate,busy,notice}) {
  const [label,setLabel]=useState(link.label),[primary,setPrimary]=useState(link.primary_url),[fallback,setFallback]=useState("");
  const choices=domains.filter(d=>d.is_active&&String(d.project_name||"")===link.project_name);
  async function copy(){try{await navigator.clipboard.writeText(link.shortlink);notice("Shortlink disalin.");}catch(_){notice("Salin alamat shortlink yang ditampilkan.");}}
  async function move(index,step){const ids=link.domains.map(d=>d.id);[ids[index],ids[index+step]]=[ids[index+step],ids[index]];await mutate("/"+link.id+"/order","PUT",{ids});}
  const checks=link.destinations||[],ready=checks.filter(d=>d.eligible).length;
  const available=choices.filter(d=>d.eligible).length;
  const targetText=link.target.reason==="paused"?"Draf / dijeda":link.target.reason==="primary"?"Siap · tujuan utama":link.target.reason==="fallback"?"Siap · fallback aktif":"Belum siap · tidak ada tujuan yang lolos";
  return <article className="shieldLinkCard">
    <header><div><h2>{link.label||link.project_name||"Shieldlink"}</h2><p>{link.project_name||"Tanpa project"} · {targetText}</p></div>
      <span className="shieldLinkCount">{Number(link.redirect_count).toLocaleString("id-ID")} redirect</span></header>
    <div className="shieldLinkShare"><QRCodeSVG value={link.shortlink} size={112} level="M" bgColor="#ffffff" fgColor="#121212" marginSize={2}/>
      <div><a href={link.shortlink} target="_blank" rel="noopener noreferrer">{link.shortlink}<ExternalLink size={14}/></a>
        <button type="button" onClick={copy}><Copy size={14}/> Salin link</button><small>{date(link.last_redirect_at)}</small></div></div>
    <div className="shieldLinkTarget"><span>Tujuan saat ini</span><strong>{link.target.url||(link.is_active?"Redirect belum tersedia":"Link belum aktif")}</strong></div>
    {!link.target.url&&<div className="shieldLinkWarning" role="status">
      <strong>{link.is_active?"Link belum siap dibagikan.":"Link tersimpan sebagai draf / dijeda."}</strong>
      <p>{!ready?`Tujuan utama: ${checks[0]?.text||"belum terverifikasi"}. ${link.domains.length?"Belum ada fallback yang siap.":"Belum ada fallback."}`:"Tujuan sudah siap. Aktifkan link melalui Kelola link dan fallback."}</p>
      {!ready&&<p>{available?`${available} domain project siap digunakan. Ganti URL utama atau tambahkan fallback dari daftar di bawah.`:"Belum ada domain project yang siap. Tambahkan domain pengganti di menu Domain pada project yang sama, lalu periksa hasil jaringan dan Trust Positif sebelum memilihnya."}</p>}
    </div>}
    <div className="shieldLinkScroll shieldLinkDiagnostics"><table><caption>Hasil pemeriksaan tujuan · {ready}/{checks.length} siap</caption><thead><tr><th>Tujuan</th><th>URL</th><th>Hasil</th><th>Pemeriksaan terakhir</th></tr></thead>
      <tbody>{checks.map((d,i)=><tr key={d.id||"primary"}><td>{d.role==="primary"?"Utama":"Fallback "+i}</td><td>{d.url}</td><td className={d.eligible?"shieldLinkReady":"shieldLinkBlocked"}>{d.text}</td><td><span>Jaringan: {checkedDate(d.last_checked_at)}</span><small>Registry: {checkedDate(d.registry_checked_at)}</small></td></tr>)}</tbody></table></div>
    <details><summary>Kelola link dan fallback ({link.domains.length})</summary>
      <form className="shieldLinkEdit" onSubmit={async e=>{e.preventDefault();await mutate("/"+link.id,"PATCH",{label,...(primary!==link.primary_url?{primary_url:primary}:{})});}}>
        <label>Label<input maxLength={80} value={label} onChange={e=>setLabel(e.target.value)}/></label>
        <label>URL utama<input required value={primary} onChange={e=>setPrimary(e.target.value)} maxLength={2048}/></label>
        <button disabled={busy}>Simpan</button>
        <DestinationPreview url={primary} domains={choices}/>
      </form>
      <div className="shieldLinkScroll"><table><thead><tr><th>Prioritas</th><th>URL fallback</th><th>Urutan</th><th>Aksi</th></tr></thead>
        <tbody>{link.domains.map((d,i)=><tr key={d.id}><td>{i+1}</td><td>{d.domain_url}</td><td><div className="shieldLinkActions">
          <button type="button" disabled={busy||i===0} aria-label="Naikkan prioritas" onClick={()=>move(i,-1)}><ArrowUp size={14}/></button>
          <button type="button" disabled={busy||i===link.domains.length-1} aria-label="Turunkan prioritas" onClick={()=>move(i,1)}><ArrowDown size={14}/></button></div></td>
          <td><button type="button" disabled={busy} aria-label="Hapus fallback" onClick={()=>{if(window.confirm("Hapus URL ini dari daftar fallback?"))mutate("/"+link.id+"/domains/"+d.id,"DELETE");}}><Trash2 size={14}/></button></td></tr>)}
          {!link.domains.length&&<tr><td colSpan={4}>Belum ada fallback. Tambahkan domain dari project yang sama.</td></tr>}</tbody></table></div>
      <form className="shieldLinkAddFallback" onSubmit={async e=>{e.preventDefault();if(await mutate("/"+link.id+"/domains","POST",{domain_url:fallback}))setFallback("");}}>
        <label>Tambahkan fallback<select value="" onChange={e=>setFallback("https://"+e.target.value)}><option value="" disabled>Pilih domain project</option>{choices.map(d=><option key={d.domain} value={d.domain}>{d.domain} · {d.readiness?.text||"Belum terverifikasi"}</option>)}</select></label>
        <label>URL fallback<input required value={fallback} onChange={e=>setFallback(e.target.value)} placeholder="https://domain.com/halaman" maxLength={2048}/></label>
        <button disabled={busy||!fallback}><Plus size={14}/> Tambah</button>
        <DestinationPreview url={fallback} domains={choices}/>
      </form>
      <div className="shieldLinkActions"><button type="button" disabled={busy||(!link.is_active&&!ready)} onClick={()=>mutate("/"+link.id,"PATCH",{is_active:!link.is_active})}>{link.is_active?"Jeda link":"Aktifkan link"}</button>
        <button type="button" className="shieldLinkDelete" disabled={busy} onClick={()=>{if(window.confirm("Hapus Shieldlink ini beserta fallback? Shortlink akan berhenti berfungsi."))mutate("/"+link.id,"DELETE");}}><Trash2 size={14}/> Hapus link</button></div>
    </details>
  </article>;
}
export default function ShieldLinkPage({audience="admin"}) {
  const base=audience==="merchant"?"/api/merchant/shield-link":"/api/shield-link";
  const [data,setData]=useState({links:[],project_domains:[]}),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
  const [showForm,setShowForm]=useState(false),[form,setForm]=useState({label:"",project_name:"",primary_url:"",is_active:true});
  const reload=useCallback(async()=>{try{setData(await request(base));setError("");}catch(e){setError(e.message);}finally{setLoading(false);}},[base]);
  useEffect(()=>{reload();const t=setInterval(reload,60000);return()=>clearInterval(t);},[reload]);
  async function mutate(path,method,body){
    setBusy(true);setError("");setNotice("");
    try{await request(base+path,{method,...(body?{body:JSON.stringify(body)}:{})});setNotice("Perubahan tersimpan.");await reload();return true;}
    catch(e){setError(e.message);return false;}finally{setBusy(false);}
  }
  const projects=[...new Set(data.project_domains.filter(d=>d.is_active).map(d=>d.project_name||""))];
  const choices=data.project_domains.filter(d=>d.is_active&&String(d.project_name||"")===form.project_name);
  return <section className="shieldLinkPage">
    <header className="shieldLinkHeader"><div><span>PENTAGON / LINK CONTINUITY</span><h1><Link2 size={26}/> Shieldlink</h1>
      <p>Satu shortlink tetap, dengan tujuan utama dan fallback berurutan dari project Anda.</p></div>
      <div className="shieldLinkActions"><button type="button" onClick={reload}><RefreshCw size={15}/> Refresh</button><button type="button" className="shieldLinkPrimary" onClick={()=>setShowForm(x=>!x)}><Plus size={15}/> Buat link</button></div></header>
    {error&&<p className="shieldLinkError" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {showForm&&<form className="shieldLinkComposer" onSubmit={async e=>{e.preventDefault();if(await mutate("","POST",form)){setShowForm(false);setForm({label:"",project_name:"",primary_url:"",is_active:true});}}}>
      <label>Project<select value={form.project_name} onChange={e=>setForm({...form,project_name:e.target.value,primary_url:""})}><option value="">Tanpa project</option>{projects.filter(Boolean).map(p=><option key={p}>{p}</option>)}</select></label>
      <label>Label<input maxLength={80} value={form.label} onChange={e=>setForm({...form,label:e.target.value})} placeholder="Nama campaign / brand"/></label>
      <label>Domain utama<select value="" onChange={e=>setForm({...form,primary_url:"https://"+e.target.value})}><option value="" disabled>Pilih domain</option>{choices.map(d=><option key={d.domain} value={d.domain}>{d.domain} · {d.readiness?.text||"Belum terverifikasi"}</option>)}</select></label>
      <label>URL tujuan<input required maxLength={2048} value={form.primary_url} onChange={e=>setForm({...form,primary_url:e.target.value})} placeholder="https://domain.com/halaman"/></label>
      <DestinationPreview url={form.primary_url} domains={choices}/>
      <label className="shieldLinkDraft"><input type="checkbox" checked={!form.is_active} onChange={e=>setForm({...form,is_active:!e.target.checked})}/> Simpan sebagai draf (belum mengalihkan pengunjung)</label>
      <button className="shieldLinkPrimary" disabled={busy||!form.primary_url||(form.is_active&&!matchingDomain(form.primary_url,choices)?.eligible)}>{form.is_active?"Buat dan aktifkan":"Simpan draf"}</button>
    </form>}
    <p className="shieldLinkNote">Tujuan dipilih dari domain aktif dengan hasil jaringan terjangkau dalam 24 jam dan tidak tercatat blocked/registry.
      Jika tujuan utama tidak memenuhi syarat, fallback dipilih sesuai prioritas. Jika semua gagal, pengunjung mendapat halaman status. Shieldlink tidak mengubah status blokir domain tujuan.</p>
    {loading?<p>Memuat Shieldlink…</p>:!data.links.length?<div className="shieldLinkEmpty"><Link2 size={30}/><h2>Belum ada Shieldlink</h2><p>Buat link untuk domain project yang sudah terdaftar, lalu tambahkan fallback.</p></div>:
      data.links.map(link=><LinkCard key={link.id} link={link} domains={data.project_domains} mutate={mutate} busy={busy} notice={setNotice}/>)}
  </section>;
}
