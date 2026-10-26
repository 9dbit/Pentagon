import React,{useCallback,useEffect,useState} from "react";
import {Bell,CheckCircle2,Clock3,ExternalLink,RefreshCw,
  Send,Settings2,ShieldCheck,ShieldAlert,Activity} from "lucide-react";
import "./MerchantTelegramHub.css";

const endpoint="/api/merchant/telegram-onboarding";
async function request(url){
  const response=await fetch(url,{credentials:"include",cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"TELEGRAM_REPORT_UNAVAILABLE");
  return data;
}
const dateWib=value=>value&&Number.isFinite(new Date(value).getTime())
  ?new Date(value).toLocaleString("id-ID",{timeZone:"Asia/Jakarta",
    dateStyle:"medium",timeStyle:"short"})+" WIB":"Not available";
const kindName={
  google_rank:"Google Rank Report",
  trustpositif_summary:"Trust Positif Summary",
  tp_BLOCKED:"Confirmed BLOCKED",
  tp_REGISTRY_DELISTED:"Registry Delisted",
  digest:"Whitelist Report"
};
const statusName={
  sent:"Delivered to Telegram",
  pending:"Queued",retry:"Retry scheduled",sending:"Sending",
  failed:"Failed",uncertain:"Delivery unconfirmed",
  cancelled:"Cancelled"
};
export default function MerchantTelegramHub({onOpenGroupSettings}){
  const [hub,setHub]=useState(null);
  const [status,setStatus]=useState(null);
  const [history,setHistory]=useState([]);
  const [error,setError]=useState("");
  const reload=useCallback(async()=>{
    try{
      const [h,s,d]=await Promise.all([
        request("/api/merchant/telegram-hub/status"),
        request(endpoint+"/status"),
        request(endpoint+"/deliveries")
      ]);
      setHub(h);setStatus(s);setHistory(d.deliveries||[]);setError("");
    }catch(e){setError(e.message);}
  },[]);
  useEffect(()=>{
    reload();const interval=setInterval(reload,20000);
    return ()=>clearInterval(interval);
  },[reload]);
  const connected=Boolean(hub?.connected&&status?.identity_verified&&status?.group_ready);
  const sent=history.filter(r=>r.status==="sent").length;
  const latest=history.find(r=>r.status==="sent");
  return <div className="maTgHub">
    <header className="maTgHeader">
      <div>
        <div className="maTgEyebrow">PENTAGON / MERCHANT DELIVERY MONITOR</div>
        <h2>Telegram Reports</h2>
        <p>Read-only delivery timeline for {String(hub?.tenant||"your merchant").toUpperCase()}.
          Google Rank, Trust Positif and confirmed registry alerts are sent only to your assigned private report group.</p>
      </div>
      <span className={"maTgStatus "+(connected?"online":"offline")}>
        <span className="maTgDot"/> {connected?"Telegram active":"Activation pending"}
      </span>
    </header>
    {error&&<p className="maTgFeedback error" role="alert">{error}</p>}
    <div className="maTgStats">
      <div><span>Merchant</span><strong>{String(hub?.tenant||"—").toUpperCase()}</strong></div>
      <div><span>Assigned group</span><strong>{status?.group_title||"Not assigned"}</strong></div>
      <div><span>Messages delivered</span><strong>{sent}</strong></div>
      <div><span>Last successful delivery</span><strong>{dateWib(latest?.sent_at)}</strong></div>
    </div>
    {!connected&&<section className="maTgSection">
      <h3><ShieldCheck size={18}/> Activate your Telegram reports</h3>
      <p>Activate your Telegram identity via QR, Telegram ID or camera in Telegram Settings.
        Pentagon creates your merchant's private group automatically when its Telegram service account is configured.
        You will not be asked to select another group.</p>
      <div className="maTgControls">
        <button type="button" className="maTgPrimary" onClick={onOpenGroupSettings}>
          <Settings2 size={16}/> Activate Telegram Report
        </button>
        <button type="button" className="maTgPill" onClick={reload}>
          <RefreshCw size={15}/> Refresh status
        </button>
      </div>
    </section>}
    <section className="maTgSection">
      <div className="maTgDeliveryHeader">
        <div><h3><Activity size={18}/> Report Delivery History</h3>
          <p>Last 30 delivery events. Each status comes from the tenant-scoped Telegram outbox, not a simulated message.</p></div>
        <button className="maTgPill" type="button" onClick={reload}>
          <RefreshCw size={15}/> Refresh
        </button>
      </div>
      <div className="maTgDeliveryList">
        {history.map((item,i)=><div className="maTgDeliveryRow" key={i}>
          <div className="maTgDeliveryType">
            {item.kind==="google_rank"?<Activity size={17}/>:item.kind==="tp_BLOCKED"?<ShieldAlert size={17}/>:<Bell size={17}/>}
            <div><strong>{kindName[item.kind]||item.kind}</strong>
              <small>{dateWib(item.created_at)}</small></div>
          </div>
          <div className="maTgDeliveryState">
            {item.status==="sent"?<CheckCircle2 size={15}/>:<Clock3 size={15}/>}
            <span>{statusName[item.status]||item.status}</span>
            {item.status==="sent"&&<small>{dateWib(item.sent_at)}</small>}
          </div>
        </div>)}
        {!history.length&&<div className="maTgDeliveryEmpty">
          <Send size={22}/>
          <strong>No reports sent yet</strong>
          <span>{connected?"The next scheduled report will appear here after delivery.":
            "Delivery history will appear after Telegram activation and the first report."}</span>
        </div>}
      </div>
      <div className="maTgControls">
        <button type="button" className="maTgPill" onClick={onOpenGroupSettings}>
          <Settings2 size={15}/> Report preferences
        </button>
        <a className="maTgPill" href="https://pentagon.quest" target="_blank" rel="noopener noreferrer">
          <ExternalLink size={15}/> Open Pentagon Dashboard
        </a>
      </div>
    </section>
  </div>;
}
