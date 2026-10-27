import React,{useCallback,useEffect,useMemo,useState} from "react";
import {Activity,Bell,CheckCircle2,CircleAlert,Copy,LockKeyhole,RefreshCw,ShieldCheck,Users} from "lucide-react";
import "./TelegramPermanentGroupsAdmin.css";

async function request(path,method="GET",payload){
  const response=await fetch("/api/admin/telegram-groups"+path,{
    method,credentials:"include",cache:"no-store",
    headers:payload===undefined?{}:{"Content-Type":"application/json"},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"Telegram provisioning unavailable");
  return data;
}

function labelFor(row){
  if(row.verified_at&&row.identity_verified)return {text:"Group active",kind:"ready"};
  if(row.verified_at)return {text:"Group created • identity pending",kind:"waiting"};
  if(row.group_state==="retry")return {text:"Retry scheduled",kind:"waiting"};
  if(row.group_state==="creating"||row.group_state==="securing")
    return {text:"Creating group",kind:"waiting"};
  if(row.group_state==="ready")return {text:"Group created",kind:"waiting"};
  return {text:"Provisioning queued",kind:"waiting"};
}
export default function TelegramPermanentGroupsAdmin(){
  const [groups,setGroups]=useState([]);
  const [tenant,setTenant]=useState("");
  const [setup,setSetup]=useState(null);
  const [configured,setConfigured]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const reload=useCallback(async()=>{
    try{
      const data=await request("/list");
      setGroups(Array.isArray(data.groups)?data.groups:[]);
      setConfigured(Boolean(data.provisioner_configured));
      setTenant(previous=>previous&&data.groups?.some(x=>x.tenant===previous)
        ?previous:(data.groups?.find(x=>!x.verified_at)?.tenant||""));
      setError("");
    }catch(e){setError(e.message);}
  },[]);
  useEffect(()=>{reload();},[reload]);
  const selected=groups.find(g=>g.tenant===tenant);
  const summary=useMemo(()=>({
    total:groups.length,
    groups:groups.filter(g=>Boolean(g.verified_at)).length,
    verified:groups.filter(g=>Boolean(g.identity_verified)).length
  }),[groups]);
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
        <div className="tgPermEyebrow">PENTAGON / AUTOMATIC TELEGRAM GROUPS</div>
        <h3>Merchant Report Provisioning</h3>
        <p>Each verified merchant receives one permanently assigned private report group. Pentagon creates and secures groups automatically; merchants verify their own Telegram identity using QR or Telegram ID.</p>
      </div>
      <button type="button" className="tgPermButton ghost" onClick={reload}>
        <RefreshCw size={15}/> Refresh
      </button>
    </div>
    {error&&<p role="alert" className="tgPermError">{error}</p>}
    <div className="tgPermAutoStats">
      <div><span>Eligible merchants</span><strong>{summary.total}</strong></div>
      <div><span>Groups provisioned</span><strong>{summary.groups}</strong></div>
      <div><span>Telegram identities verified</span><strong>{summary.verified}</strong></div>
    </div>
    {!configured&&<div className="tgPermProvisionerWarning">
      <CircleAlert size={19}/>
      <span>Automatic group creation is on hold until the dedicated Telegram MTProto service account is configured. Existing merchant data and report destinations remain unchanged.</span>
    </div>}
    <div className="tgPermTable" aria-label="Merchant Telegram automatic group provisioning">
      {groups.map(group=>{
        const status=labelFor(group);
        return <div key={group.tenant} className="tgPermRow tgPermAutoRow">
          <span><Users size={15}/> <strong>{group.tenant.toUpperCase()}</strong></span>
          <span>{group.chat_title||("PENTAGON | "+group.tenant.toUpperCase()+" | REPORTS")}</span>
          <span className={status.kind==="ready"?"tgPermReady":"tgPermWaiting"}>
            {status.kind==="ready"?<CheckCircle2 size={14}/>:<Activity size={14}/>}
            {status.text}
          </span>
          {group.group_state==="retry"&&group.group_error&&<small>Last attempt: {group.group_error}</small>}
        </div>;
      })}
      {!groups.length&&<p className="tgPermMuted">No eligible production merchants were found.</p>}
    </div>
    <details className="tgPermRecovery">
      <summary><LockKeyhole size={16}/> Super Admin recovery only</summary>
      <div className="tgPermSetup">
        <h4><ShieldCheck size={18}/> Manual binding for exceptional recovery</h4>
        <p>Automated provisioning is the default. Only use this fallback if the Telegram service account cannot create a group and a private group has been created under authorized supervision. Never select a shared Domain Radar forum.</p>
        <div className="tgPermControls">
          <select aria-label="Merchant to recover" value={tenant}
            onChange={e=>{setTenant(e.target.value);setSetup(null);}}>
            <option value="">Select merchant</option>
            {groups.map(group=><option key={group.tenant} value={group.tenant}>
              {group.tenant}{group.verified_at?" (permanently bound)":""}
            </option>)}
          </select>
          <button className="tgPermButton" type="button"
            disabled={busy||!tenant||Boolean(selected?.verified_at)} onClick={provision}>
            <Bell size={15}/> Generate recovery setup code
          </button>
        </div>
        {setup&&<div className="tgPermCommand">
          <div><span>Exact private group name</span><strong>{setup.title}</strong>
            <button type="button" className="tgPermButton ghost"
              onClick={()=>navigator.clipboard?.writeText(setup.title)}><Copy size={14}/> Copy name</button></div>
          <div><span>One-time bot command, valid for 10 minutes</span>
            <code>{setup.command}</code>
            <button type="button" className="tgPermButton ghost"
              onClick={()=>navigator.clipboard?.writeText(setup.command)}><Copy size={14}/> Copy command</button></div>
          <p>Send the command inside the private merchant group. The bot verifies title, group identity, administrator and invite rights before permanent binding.</p>
        </div>}
      </div>
    </details>
  </section>;
}
