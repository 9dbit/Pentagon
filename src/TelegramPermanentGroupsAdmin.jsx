import React, {useCallback,useEffect,useState} from "react";
import {Bell,CheckCircle2,Copy,RefreshCw,ShieldCheck,Users} from "lucide-react";
import "./TelegramPermanentGroupsAdmin.css";

async function request(path,method="GET",payload){
  const r=await fetch("/api/admin/telegram-groups"+path,{
    method,credentials:"include",cache:"no-store",
    headers:payload===undefined?{}:{"Content-Type":"application/json"},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data.error||"Telegram group setup unavailable");
  return data;
}

export default function TelegramPermanentGroupsAdmin(){
  const [groups,setGroups]=useState([]);
  const [tenant,setTenant]=useState("");
  const [setup,setSetup]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const reload=useCallback(async()=>{
    try{
      const data=await request("/list");
      setGroups(Array.isArray(data.groups)?data.groups:[]);
      setTenant(previous=>previous&&data.groups?.some(x=>x.tenant===previous)
        ?previous:(data.groups?.find(x=>!x.verified_at)?.tenant||""));
      setError("");
    }catch(e){setError(e.message);}
  },[]);
  useEffect(()=>{reload();},[reload]);
  const selected=groups.find(g=>g.tenant===tenant);
  async function provision(){
    if(!tenant)return;
    setBusy(true);setError("");setSetup(null);
    try{setSetup(await request("/setup","POST",{tenant}));}
    catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  return <section className="tgPerm">
    <div className="tgPermHeading">
      <div>
        <div className="tgPermEyebrow">MERCHANT TELEGRAM ROUTING</div>
        <h3>Permanent Report Groups</h3>
        <p>One merchant, one private group. Only the Super Admin performs group setup, once. Merchant QR will open the assigned group directly.</p>
      </div>
      <button type="button" className="tgPermButton ghost" onClick={reload}>
        <RefreshCw size={15}/> Refresh
      </button>
    </div>
    {error&&<p role="alert" className="tgPermError">{error}</p>}
    <div className="tgPermTable">
      {groups.map(group=><div key={group.tenant} className="tgPermRow">
        <span><Users size={15}/> <strong>{group.tenant}</strong></span>
        <span>{group.chat_title||"Waiting for private report group"}</span>
        <span className={group.verified_at?"tgPermReady":"tgPermWaiting"}>
          {group.verified_at?<><CheckCircle2 size={14}/> Bound permanently</>:"Not provisioned"}
        </span>
      </div>)}
      {!groups.length&&<p className="tgPermMuted">No eligible production tenants were found.</p>}
    </div>
    <div className="tgPermSetup">
      <h4><ShieldCheck size={18}/> One-time Super Admin setup</h4>
      <p>Create a private Telegram group with the exact name shown below, add <b>@DomainRadarAi_Bot</b> as administrator with invite-user rights, then paste the setup command in that group. The bot validates group identity before binding.</p>
      <div className="tgPermControls">
        <select aria-label="Merchant to provision" value={tenant}
          onChange={e=>{setTenant(e.target.value);setSetup(null);}}>
          <option value="">Select merchant</option>
          {groups.map(group=><option key={group.tenant} value={group.tenant}>
            {group.tenant}{group.verified_at?" (permanently bound)":""}
          </option>)}
        </select>
        <button className="tgPermButton" type="button"
          disabled={busy||!tenant||Boolean(selected?.verified_at)} onClick={provision}>
          <Bell size={15}/> Generate group setup code
        </button>
      </div>
      {setup&&<div className="tgPermCommand">
        <div><span>Required group name</span><strong>{setup.title}</strong>
          <button type="button" className="tgPermButton ghost"
            onClick={()=>navigator.clipboard?.writeText(setup.title)}><Copy size={14}/> Copy name</button></div>
        <div><span>One-time bot command, valid for 10 minutes</span>
          <code>{setup.command}</code>
          <button type="button" className="tgPermButton ghost"
            onClick={()=>navigator.clipboard?.writeText(setup.command)}><Copy size={14}/> Copy command</button></div>
        <p>Send this command inside the newly created merchant group. Refresh the table after the bot confirms successful binding. Never paste this command in the shared Domain Radar operations forum.</p>
      </div>}
    </div>
  </section>;
}
