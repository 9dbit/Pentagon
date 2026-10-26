import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert, Copy, LockKeyhole,
  RefreshCw, Settings2, ShieldCheck, Users } from "lucide-react";
import "./MerchantTelegramGroupSettings.css";

async function api(path,method="GET",body){
  const response=await fetch(path,{
    method,credentials:"include",cache:"no-store",
    headers:body===undefined?{}:{"Content-Type":"application/json"},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error(data.error||"TELEGRAM_SETTINGS_UNAVAILABLE");
    error.status=response.status;throw error;
  }
  return data;
}
const dateWib=value=>value&&Number.isFinite(new Date(value).getTime())
  ?new Date(value).toLocaleString("id-ID",{timeZone:"Asia/Jakarta",dateStyle:"medium",timeStyle:"short"})+" WIB"
  :"Not available";

export default function MerchantTelegramGroupSettings({onBackToReports}){
  const [state,setState]=useState(null);
  const [setup,setSetup]=useState(null);
  const [working,setWorking]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const reload=useCallback(async()=>{
    try{
      const data=await api("/api/merchant/telegram-hub/status");
      setState(data);
      if(data.permanent_group_ready===true)setSetup(null);
      return data;
    }catch(e){setError(e.message);return null;}
  },[]);
  useEffect(()=>{
    reload();
    const handle=setInterval(reload,30000);
    return ()=>clearInterval(handle);
  },[reload]);
  const tenant=String(state?.tenant||"").toLowerCase();
  const title="PENTAGON | "+(tenant||"MERCHANT").toUpperCase()+" | REPORTS";
  const ready=state?.permanent_group_ready===true;
  const groupTitle=state?.permanent_group_title||title;
  const connected=ready&&state?.status==="connected";
  async function setupGroup(){
    setWorking(true);setError("");setNotice("");setSetup(null);
    try{
      // Never accept a tenant ID from the browser. Server resolves session.
      const value=await api("/api/merchant/telegram-groups/setup","POST",{});
      if(value.tenant!==tenant||value.title!==title||!value.command)
        throw new Error("TENANT_GROUP_MISMATCH");
      setSetup(value);
      setNotice("One-time setup code created for "+tenant.toUpperCase()+".");
    }catch(e){
      if(e.message==="MERCHANT_GROUP_PERMANENTLY_BOUND")await reload();
      else setError(e.message);
    }finally{setWorking(false);}
  }
  async function copy(value){
    try{
      if(!navigator.clipboard?.writeText)throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setNotice("Copied to clipboard.");setError("");
    }catch(_){setError("Cannot copy automatically. Select and copy the displayed text.");}
  }
  return <div className="maGroupSettings">
    <header className="maGroupSettingsHead">
      <div>
        <span className="maGroupEyebrow">PENTAGON / MERCHANT TELEGRAM</span>
        <h2><Settings2 size={22}/> Telegram Group Settings</h2>
        <p>One merchant, one verified private group. You configure the group only once. Every future report QR opens this same group directly.</p>
      </div>
      <span className={"maGroupBadge "+(connected?"ready":ready?"paused":"pending")}>
        {connected?"Connected":ready?"Group verified":"Setup pending"}
      </span>
    </header>
    {error&&<p className="maGroupFeedback error" role="alert"><CircleAlert size={16}/>{error}</p>}
    {notice&&<p className="maGroupFeedback" role="status"><CheckCircle2 size={16}/>{notice}</p>}
    <div className="maGroupIdentity">
      <div><small>Merchant account</small><strong>{tenant?tenant.toUpperCase():"Loading..."}</strong></div>
      <div><small>Permanent report group</small><strong>{groupTitle}</strong></div>
      <div><small>Verified at</small><strong>{dateWib(state?.permanent_group_verified_at)}</strong></div>
    </div>
    {!ready?<section className="maGroupSetupArea">
      <div className="maGroupSectionTitle">
        <h3><Users size={18}/> Connect your permanent Telegram group</h3>
        <p>Initial setup requires creating a private group in Telegram. Once registered, merchant users never need to choose a group when scanning the report QR.</p>
      </div>
      <div className="maGroupSteps">
        <div className="maGroupStep"><span className="maGroupNumber">01</span><div>
          <strong>Create one private Telegram group</strong>
          <p>Use this exact group name, then keep the group private. It must not be the shared Domain Radar operations forum.</p>
          <div className="maGroupCopyRow"><code>{title}</code>
            <button type="button" disabled={!tenant} onClick={()=>copy(title)}><Copy size={15}/> Copy name</button></div>
        </div></div>
        <div className="maGroupStep"><span className="maGroupNumber">02</span><div>
          <strong>Add the Pentagon reporting bot</strong>
          <p>Add <b>@DomainRadarAi_Bot</b> as a group administrator with permission to invite users. Do this inside the group you created, not in a private chat with the bot.</p>
        </div></div>
        <div className="maGroupStep"><span className="maGroupNumber">03</span><div>
          <strong>Generate one-time verification code</strong>
          <p>The code is valid for 10 minutes, tied only to your signed-in merchant, and cannot be used to connect another merchant’s group.</p>
          <button type="button" className="maGroupPrimary" disabled={!tenant||working}
            onClick={setupGroup}><LockKeyhole size={16}/> {setup?"Regenerate setup code":"Generate setup code"}</button>
          {setup&&<div className="maGroupCommand">
            <span>Send this command once inside <b>{setup.title}</b>:</span>
            <div className="maGroupCopyRow"><code>{setup.command}</code>
              <button type="button" onClick={()=>copy(setup.command)}><Copy size={15}/> Copy command</button></div>
            <small>Regenerating immediately invalidates the previous code. Never post it outside your group.</small>
          </div>}
        </div></div>
        <div className="maGroupStep"><span className="maGroupNumber">04</span><div>
          <strong>Verify and activate</strong>
          <p>After the bot replies that the group is secured, refresh this page. The report destination is fixed permanently by Telegram chat ID.</p>
          <button type="button" className="maGroupPill" disabled={working}
            onClick={reload}><RefreshCw size={15}/> Refresh group status</button>
        </div></div>
      </div>
    </section>:<section className="maGroupSuccess">
      <ShieldCheck size={23}/>
      <div><strong>Permanent report group verified</strong>
        <p><b>{groupTitle}</b> is bound to {tenant.toUpperCase()}. The destination cannot be reassigned by this merchant or redirected to a shared group.</p>
      </div>
    </section>}
    <footer className="maGroupFoot">
      <p><LockKeyhole size={15}/> Cross-tenant group linking is rejected. Delivery stays disabled until the binding is verified.</p>
      <button type="button" className="maGroupPill" onClick={onBackToReports}>
        <ArrowLeft size={15}/> Back to Telegram Reports
      </button>
    </footer>
  </div>;
}
