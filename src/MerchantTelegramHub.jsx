import React, { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Bell, CheckCircle2, CircleAlert, Copy, ExternalLink, LockKeyhole,
  Pause, Play, RefreshCw, Send, ShieldCheck, Users } from "lucide-react";
import "./MerchantTelegramHub.css";

async function request(url,method="GET",body){
  const result=await fetch(url,{
    method,credentials:"include",cache:"no-store",
    headers:body===undefined?{}:{"Content-Type":"application/json"},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const data=await result.json().catch(()=>({}));
  if(!result.ok)throw new Error(data.error||"Telegram report unavailable");
  return data;
}
const api=(path,method="GET",body)=>
  request("/api/merchant/telegram-hub"+path,method,body);
const dateWib=value=>value
  ?new Date(value).toLocaleString("id-ID",{timeZone:"Asia/Jakarta",
      dateStyle:"medium",timeStyle:"short"})+" WIB":"Not available";
const options=[
  ["immediate_alert","Blocked alert","Only after independent provider and registry confirmation"],
  ["recovery_alert","Registry delisted","Official delisting, not a blanket guarantee of connectivity"],
  ["digest_enabled","Whitelist report","Only active domains belonging to this merchant"],
  ["node_warning","Node coverage alert","Preference saved; dedicated delivery integration is pending"],
  ["rank_report","Google Rank report","Preference saved; dedicated delivery integration is pending"]
];

export default function MerchantTelegramHub(){
  const [state,setState]=useState(null);
  const [invite,setInvite]=useState(null);
  const [working,setWorking]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const reload=useCallback(async()=>{
    try{const data=await api("/status");setState(data);return data;}
    catch(e){setError(e.message);return null;}
  },[]);
  useEffect(()=>{
    reload();
    const timer=setInterval(reload,30000);
    return ()=>clearInterval(timer);
  },[reload]);
  async function action(path,method,body,success){
    setWorking(true);setError("");setMessage("");
    try{
      const result=await api(path,method,body);
      setMessage(success||"Saved");
      await reload();
      return result;
    }catch(e){setError(e.message);return null;}
    finally{setWorking(false);}
  }
  async function openDirectInvite(){
    setWorking(true);setError("");setMessage("");setInvite(null);
    try{
      const result=await request("/api/merchant/telegram-groups/invite","POST",{});
      setInvite(result);
    }catch(e){setError(e.message);}
    finally{setWorking(false);}
  }
  const ready=state?.permanent_group_ready===true;
  const connected=ready&&state?.connected===true&&state?.status==="connected";
  const paused=ready&&state?.status==="paused";
  const title=state?.permanent_group_title||("PENTAGON | "+String(state?.tenant||"MERCHANT").toUpperCase()+" | REPORTS");
  const prefs=state?.preferences||{};
  const updatePref=(key,value)=>action("/preferences","PATCH",{[key]:value},"Report setting saved for this merchant.");
  return <div className="maTgHub">
    <div className="maTgHeader">
      <div>
        <div className="maTgEyebrow">PENTAGON / DEDICATED TELEGRAM REPORT</div>
        <h2>Telegram Reports</h2>
        <p>One merchant, one permanent private report group. QR always opens your own group directly, without selecting any Telegram group.</p>
      </div>
      <span className={"maTgStatus "+(connected?"online":paused?"paused":"offline")}>
        <span className="maTgDot"/> {connected?"Group connected":paused?"Reports paused":"Group setup pending"}
      </span>
    </div>
    {error&&<div className="maTgFeedback error" role="alert"><CircleAlert size={15}/>{error}</div>}
    {message&&<div className="maTgFeedback" role="status"><CheckCircle2 size={15}/>{message}</div>}
    <div className="maTgStats">
      <div><span>Whitelisted domains</span><strong>{state?.whitelist_count??"—"}</strong></div>
      <div><span>Report destination</span><strong>{ready?title:"Awaiting dedicated group"}</strong></div>
      <div><span>Last report</span><strong>{dateWib(state?.last_report_at)}</strong></div>
      <div><span>Delivery</span><strong>{state?.last_delivery_status||"Not tested"}</strong></div>
    </div>
    <div className="maTgSection maTgSettingsSection" aria-label="Telegram report settings">
      <div className="maTgSettingsHeading">
        <div>
          <h3><Bell size={18}/> Report Settings</h3>
          <p>Configure report types and delivery frequency for {String(state?.tenant||"your merchant").toUpperCase()}.</p>
        </div>
        <span className="maTgSettingsState">{state?.preferences_saved?"Preferences saved":"Default preferences"}</span>
      </div>
      {!ready&&<p className="maTgSettingsNotice">
        Settings can be saved now. Delivery remains disabled until Super Admin verifies your permanent report group.
      </p>}
      <div className="maTgOptions">{options.map(([key,name,description])=>
        <label key={key} className="maTgOption">
          <span><strong>{name}</strong><small>{description}</small></span>
          <input type="checkbox" disabled={working||!state}
            checked={Boolean(prefs[key])} onChange={e=>updatePref(key,e.target.checked)}/>
        </label>)}
      </div>
      <label className="maTgInterval">Digest frequency
        <select disabled={working||!state} value={prefs.interval_minutes||60}
          onChange={e=>updatePref("interval_minutes",Number(e.target.value))}>
          {[10,30,60,180,1440].map(n=><option value={n} key={n}>
            {n<60?n+" minutes":n===1440?"Daily":n/60+" hour"+(n>60?"s":"")}
          </option>)}
        </select>
      </label>
      <p className="maTgSettingsFooter">Changes are saved to this merchant account only. No Telegram message is sent while group setup is pending.</p>
    </div>
    {!ready?<div className="maTgSection">
      <h3><Users size={18}/> Preparing your permanent report group</h3>
      <p>Super Admin must provision your dedicated Telegram group once. Until verified, Pentagon will not generate a QR or send any merchant data to another group or Domain Radar.</p>
      <div className="maTgControls">
        <button type="button" className="maTgPill" disabled={working} onClick={reload}>
          <RefreshCw size={16}/> Refresh group status
        </button>
      </div>
    </div>:<div className="maTgSection">
      <h3><ShieldCheck size={19}/> {title}</h3>
      <p>This group is permanently assigned to your merchant. Scanning the invite QR goes straight to this exact private group; there is no Telegram group picker.</p>
      <div className="maTgControls">
        <button className="maTgPrimary" type="button" disabled={working} onClick={openDirectInvite}>
          <Users size={16}/> {invite?"Generate new invite QR":"Open my report group QR"}
        </button>
      </div>
      {invite&&<div className="maTgActivate">
        <div className="maTgQr" aria-label={"Direct private invite QR for "+invite.group_title}>
          <QRCodeSVG value={invite.url} size={190} marginSize={0} level="M"/>
        </div>
        <div className="maTgActivateText">
          <strong>Direct invite: {invite.group_title}</strong>
          <p>Scan and tap Join in Telegram. No group selection. This link expires after 10 minutes and admits one member.</p>
          <div className="maTgControls">
            <a href={invite.url} target="_blank" rel="noreferrer" className="maTgPrimary">
              <ExternalLink size={15}/> Open report group
            </a>
            <button type="button" className="maTgPill"
              onClick={()=>navigator.clipboard?.writeText(invite.url)}><Copy size={15}/> Copy invite</button>
          </div>
        </div>
      </div>}
      <div className="maTgIdentity">
        <div className="maTgAvatar"><Bell size={24}/></div>
        <div><strong>{title}</strong><span>Tenant: {state?.tenant||"—"}</span>
          <small>Group verified {dateWib(state?.permanent_group_verified_at)}</small></div>
      </div>
      <div className="maTgControls">
        {paused?<button type="button" className="maTgPrimary" disabled={working}
          onClick={()=>action("/resume","POST",{},"Merchant reports resumed.")}><Play size={16}/> Resume</button>
          :<button type="button" className="maTgPill" disabled={working||!connected}
          onClick={()=>action("/pause","POST",{},"Merchant reports paused.")}><Pause size={16}/> Pause</button>}
        <button type="button" className="maTgPill" disabled={working||!connected}
          onClick={()=>action("/test","POST",{},"Test sent to your permanent group.")}><Send size={16}/> Send Test</button>
        <button type="button" className="maTgPill" disabled={working||!connected}
          onClick={()=>action("/report/send-now","POST",{},"Whitelist report queued for your permanent group.")}>
          <Bell size={16}/> Send report now
        </button>
      </div>
    </div>}
    <div className="maTgPrivacy"><LockKeyhole size={16}/>
      Each report destination is registered once by Super Admin, verified with Telegram and unique per merchant.
      A shared operations forum is never a merchant destination. A pending setup never falls back to Domain Radar.
    </div>
  </div>;
}
