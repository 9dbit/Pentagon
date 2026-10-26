import React, { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Bell, Camera, CheckCircle2, CircleAlert, Copy, ExternalLink,
  LockKeyhole, Pause, Play, RefreshCw, Send, ShieldCheck, Smartphone,
  SlidersHorizontal, Unplug, X } from "lucide-react";
import "./MerchantTelegramHub.css";

async function api(path,method="GET",body) {
  const result=await fetch("/api/merchant/telegram-hub"+path,{
    method,credentials:"include",cache:"no-store",
    headers:body===undefined?{}:{"Content-Type":"application/json"},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const data=await result.json().catch(()=>({}));
  if(!result.ok)throw new Error(data.error||"Telegram Hub unavailable");
  return data;
}
const dateWib = value => value
  ? new Date(value).toLocaleString("id-ID",{timeZone:"Asia/Jakarta",
      dateStyle:"medium",timeStyle:"short"})+" WIB" : "Not available";
const options=[
  ["immediate_alert","Immediate blocked alert","After independent provider + official registry confirmation"],
  ["recovery_alert","Registry delisted / recovery","Do not imply all providers are healthy"],
  ["digest_enabled","Whitelist summary","Every active whitelisted domain belonging to your merchant"],
  ["node_warning","Monitoring coverage","Notify when independent node coverage is degraded"],
  ["rank_report","Google Rank report","Optional keyword position report"]
];
const usernameFromQR = raw => {
  const str=String(raw||"").trim();
  const match=str.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,32})(?:\/|\?|$)/i);
  if(match)return match[1];
  const handle=str.replace(/^@/,"");
  return /^[A-Za-z0-9_]{5,32}$/.test(handle)?handle:"";
};
export default function MerchantTelegramHub(){
  const [state,setState]=useState(null);
  const [link,setLink]=useState(null);
  const [claim,setClaim]=useState(null);
  const [mode,setMode]=useState("private");
  const [username,setUsername]=useState("");
  const [working,setWorking]=useState(false);
  const [busyType,setBusyType]=useState("");
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const [camera,setCamera]=useState(false);
  const [scanError,setScanError]=useState("");
  const cameraRef=useRef(null);
  const streamRef=useRef(null);
  const intervalRef=useRef(null);
  const lockRef=useRef(false);
  const stopCamera=useCallback(()=>{
    if(intervalRef.current)clearInterval(intervalRef.current);
    intervalRef.current=null;
    if(streamRef.current)streamRef.current.getTracks().forEach(track=>track.stop());
    streamRef.current=null;
    if(cameraRef.current)cameraRef.current.srcObject=null;
    setCamera(false);
  },[]);
  const reload=useCallback(async()=>{
    try{
      const status=await api("/status");
      setState(status);
      setError("");
      return status;
    }catch(e){setError(e.message);return null;}
  },[]);
  useEffect(()=>{
    reload();
    const timer=setInterval(reload,30000);
    return ()=>clearInterval(timer);
  },[reload]);
  useEffect(()=>{
    if(!link?.request_id)return;
    let live=true;
    const check=async()=>{
      try{
        const data=await api("/activate/"+encodeURIComponent(link.request_id));
        if(live)setClaim(data);
      }catch(e){if(live&&e.message==="ACTIVATION_EXPIRED"){setLink(null);setClaim(null);setError("QR expired. Activate again.");}}
    };
    check();
    const timer=setInterval(check,3000);
    return ()=>{live=false;clearInterval(timer);};
  },[link?.request_id]);
  useEffect(()=>()=>stopCamera(),[stopCamera]);
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
  async function activate(){
    setWorking(true);setError("");setMessage("");setClaim(null);
    try{
      const data=await api("/activate","POST",{mode});
      setLink(data);
    }catch(e){setError(e.message);}
    finally{setWorking(false);}
  }
  async function confirm(){
    if(!link?.request_id)return;
    const result=await action("/confirm","POST",{request_id:link.request_id},
      "Telegram identity verified. Merchant reports connected.");
    if(result?.connected){setLink(null);setClaim(null);stopCamera();}
  }
  async function startCamera(){
    setScanError("");
    if(!navigator.mediaDevices?.getUserMedia){setScanError("Camera is not supported by this browser.");return;}
    if(!("BarcodeDetector" in window)){setScanError("QR scanner unsupported. Use Open Telegram or enter @username.");return;}
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
      streamRef.current=stream;
      setCamera(true);
      setTimeout(async()=>{
        if(!cameraRef.current||!streamRef.current)return;
        cameraRef.current.srcObject=stream;
        await cameraRef.current.play().catch(()=>{});
        const detector=new window.BarcodeDetector({formats:["qr_code"]});
        intervalRef.current=setInterval(async()=>{
          if(lockRef.current||!cameraRef.current)return;
          lockRef.current=true;
          try{
            const codes=await detector.detect(cameraRef.current);
            const scanned=codes[0]?.rawValue;
            if(scanned){
              const handle=usernameFromQR(scanned);
              if(handle){setUsername("@"+handle);setMessage("Telegram profile scanned. Press Save Username; connect via bot to verify.");}
              else setScanError("Not a Telegram profile QR. Scan a t.me username QR.");
              stopCamera();
            }
          }catch(_){/* Retry next frame. */}
          finally{lockRef.current=false;}
        },550);
      },160);
    }catch(e){stopCamera();setScanError("Camera permission denied or device unavailable.");}
  }
  const connected=state?.connected&&state?.status==="connected";
  const paused=state?.status==="paused";
  const prefs=state?.preferences||{};
  const updatePref=async(key,value)=>action("/preferences","PATCH",{[key]:value},"Preferences updated.");
  return <div className="maTgHub">
    <div className="maTgHeader">
      <div><div className="maTgEyebrow">PENTAGON / TELEGRAM HUB</div>
        <h2>Telegram Reports</h2>
        <p>Private status reports for your own whitelisted domains, powered by independently validated provider nodes.</p>
      </div>
      <span className={"maTgStatus "+(connected?"online":paused?"paused":"offline")}>
        <span className="maTgDot"/> {connected?"Connected":paused?"Paused":"Not connected"}
      </span>
    </div>
    {error&&<div className="maTgFeedback error" role="alert"><CircleAlert size={15}/>{error}</div>}
    {message&&<div className="maTgFeedback" role="status"><CheckCircle2 size={15}/>{message}</div>}
    <div className="maTgStats">
      <div><span>Whitelisted domains</span><strong>{state?.whitelist_count??"—"}</strong></div>
      <div><span>Destination</span><strong>{state?.chat_type==="private"?"Private DM":state?.chat_type?"Merchant group":"Not linked"}</strong></div>
      <div><span>Last report</span><strong>{dateWib(state?.last_report_at)}</strong></div>
      <div><span>Delivery</span><strong>{state?.last_delivery_status||"Not tested"}</strong></div>
    </div>
    {!connected&&!paused&&<>
      <div className="maTgSection">
        <h3>Connect your Telegram</h3>
        <p>Choose your own DM or a merchant-owned group. Only an authenticated confirmation here can activate delivery.</p>
        <div className="maTgChoices" role="group" aria-label="Telegram report destination">
          <button type="button" className={mode==="private"?"selected":""}
            onClick={()=>{setMode("private");setLink(null);setClaim(null);}}><Smartphone size={17}/> Private DM</button>
          <button type="button" className={mode==="group"?"selected":""}
            onClick={()=>{setMode("group");setLink(null);setClaim(null);}}><Bell size={17}/> Merchant Group</button>
        </div>
        {!link?<button type="button" className="maTgPrimary" disabled={working||!state?.bot_configured}
          onClick={activate}><ShieldCheck size={17}/> Activate Telegram Report</button>:<>
          <div className="maTgActivate">
            <div className="maTgQr" aria-label="One-time Telegram activation QR">
              <QRCodeSVG value={link.url} size={190} marginSize={0} level="M" />
            </div>
            <div className="maTgActivateText">
              <strong>Scan the code, then press Start in Telegram</strong>
              <p>One-time link, expires after 10 minutes. {mode==="group"?"Add the bot to your group as an administrator.":"Use your own Telegram account."}</p>
              <div className="maTgControls">
                <a className="maTgPrimary" href={link.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/> Open Telegram</a>
                <button type="button" onClick={()=>navigator.clipboard?.writeText(link.url)} className="maTgPill"><Copy size={15}/> Copy link</button>
              </div>
            </div>
          </div>
          <div className="maTgClaim">
            {claim?.claimed?<><CheckCircle2 size={19}/>
              <span>Telegram {claim.claimed_username?"@"+claim.claimed_username:"account/group"} received. Verify it is yours, then confirm here.</span>
              <button className="maTgPrimary" type="button" disabled={working} onClick={confirm}>Confirm &amp; Connect</button></>
              :<><RefreshCw size={16}/><span>Waiting for Telegram /start. This page checks the link every few seconds.</span></>}
          </div>
          <button type="button" className="maTgLink" onClick={()=>{setLink(null);setClaim(null);}}>Generate new link</button>
        </>}
      </div>
    </>}
    {(connected||paused)&&<div className="maTgSection">
      <div className="maTgIdentity">
        <div className="maTgAvatar"><ShieldCheck size={24}/></div>
        <div><strong>{state?.telegram_username?"@"+state.telegram_username:"Verified Telegram"}</strong>
          <span>{state.chat_type==="private"?"Private DM":"Merchant-managed group"} · {state.chat_masked}</span>
          <small>Connected {dateWib(state.connected_at)}</small></div>
      </div>
      <div className="maTgControls">
        {paused?<button type="button" className="maTgPrimary" disabled={working}
          onClick={()=>action("/resume","POST",{},"Telegram reports resumed.")}><Play size={16}/> Resume</button>
          :<button type="button" className="maTgPill" disabled={working}
            onClick={()=>action("/pause","POST",{},"Telegram reports paused.")}><Pause size={16}/> Pause</button>}
        <button type="button" className="maTgPill" disabled={working||!connected}
          onClick={()=>action("/test","POST",{},"Test delivered to verified Telegram destination.")}><Send size={16}/> Send Test</button>
        <button type="button" className="maTgPill" disabled={working||!connected}
          onClick={()=>action("/report/send-now","POST",{},"Whitelist report queued for delivery.")}><Bell size={16}/> Send report now</button>
        <button type="button" className="maTgPill danger" disabled={working}
          onClick={()=>{if(window.confirm("Disconnect Telegram reports for this merchant?"))action("/disconnect","POST",{},"Telegram disconnected.");}}>
          <Unplug size={16}/> Disconnect</button>
      </div>
    </div>}
    <div className="maTgSection">
      <h3><Camera size={18}/> Telegram identity helper</h3>
      <p>You may enter @username or scan a Telegram profile QR to label the intended account. Username alone does not authorize delivery.</p>
      <div className="maTgControls">
        <input aria-label="Telegram username" placeholder="@telegram_username"
          value={username} onChange={e=>setUsername(e.target.value)} maxLength={33}/>
        <button type="button" className="maTgPill" onClick={camera?stopCamera:startCamera}>
          {camera?<X size={15}/>:<Camera size={15}/>} {camera?"Stop camera":"Scan profile QR"}
        </button>
        <button type="button" className="maTgPill" disabled={working} onClick={async()=>{
          const handle=username.replace(/^@/,"");
          if(!/^[A-Za-z0-9_]{5,32}$/.test(handle)){setError("Invalid Telegram username");return;}
          await action("/identity-hint","PATCH",{username:handle},"Username saved as a label, not as a verified destination.");
        }}>Save username</button>
      </div>
      {camera&&<video className="maTgVideo" ref={cameraRef} muted playsInline autoPlay/>}
      {scanError&&<div className="maTgFeedback error">{scanError}</div>}
    </div>
    {(connected||paused)&&<div className="maTgSection">
      <h3><SlidersHorizontal size={18}/> Report Preferences</h3>
      <div className="maTgOptions">
        {options.map(([key,title,caption])=><label key={key} className="maTgOption">
          <span><strong>{title}</strong><small>{caption}</small></span>
          <input type="checkbox" disabled={working} checked={Boolean(prefs[key])}
            onChange={e=>updatePref(key,e.target.checked)}/>
        </label>)}
      </div>
      <label className="maTgInterval">Digest frequency
        <select disabled={working} value={prefs.interval_minutes||60}
          onChange={e=>updatePref("interval_minutes",Number(e.target.value))}>
          {[10,30,60,180,1440].map(x=><option key={x} value={x}>
            {x<60?x+" minutes":x===1440?"Daily":x/60+" hour"+(x>60?"s":"")}
          </option>)}
        </select>
      </label>
    </div>}
    <div className="maTgPrivacy"><LockKeyhole size={16}/>
      Reports use verified Telegram chats and tenant-scoped whitelist data. Telegram profile QR is only a convenience; it never activates notifications by itself.
      Official blocking evidence requires two independent providers plus exact registry verification.</div>
  </div>;
}
