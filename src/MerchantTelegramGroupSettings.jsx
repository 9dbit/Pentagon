import React,{useCallback,useEffect,useRef,useState} from "react";
import {QRCodeSVG} from "qrcode.react";
import {ArrowLeft,Bell,Camera,CheckCircle2,CircleAlert,Copy,ExternalLink,
  LockKeyhole,RefreshCw,Settings2,ShieldCheck,Users,X} from "lucide-react";
import "./MerchantTelegramGroupSettings.css";

async function api(path,method="GET",payload){
  const response=await fetch(path,{
    method,credentials:"include",cache:"no-store",
    headers:payload===undefined?{}:{"Content-Type":"application/json"},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"TELEGRAM_SETTINGS_UNAVAILABLE");
  return data;
}
const onboarding="/api/merchant/telegram-onboarding";
const hub="/api/merchant/telegram-hub";
const friendly={
  INVALID_TELEGRAM_IDENTITY:"Enter a Telegram @username, numeric user ID or valid profile QR.",
  TELEGRAM_IDENTITY_ALREADY_VERIFIED:"Your Telegram account is already verified.",
  ACTIVATION_UNAVAILABLE:"Telegram activation service is temporarily unavailable.",
  TELEGRAM_BOT_NOT_READY:"The Pentagon Telegram bot is unavailable."
};
const preferences=[
  ["immediate_alert","Blocked alert","Only after confirmed independent evidence and the official registry"],
  ["recovery_alert","Registry delisted","Only official registry delisting, not a blanket network guarantee"],
  ["digest_enabled","Trust Positif summary","Whitelist monitoring and verified anomalies"],
  ["node_warning","Node coverage alert","Preference stored; dedicated alert integration is pending"],
  ["rank_report","Google Rank report","Stored keyword positions and changes"]
];
function validProfileQr(raw){
  const value=String(raw||"").trim();
  if(/^@[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value)||
    /^[0-9]{5,20}$/.test(value))return value;
  const profile=value.match(/^https:\/\/t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,31})\/?$/i);
  if(profile&&!/^joinchat$/i.test(profile[1]))return "@"+profile[1];
  const user=value.match(/^tg:\/\/user\?id=([0-9]{5,20})$/i);
  return user?.[1]||"";
}
export default function MerchantTelegramGroupSettings({onBackToReports}){
  const [status,setStatus]=useState(null);
  const [hubState,setHubState]=useState(null);
  const [activation,setActivation]=useState(null);
  const [identity,setIdentity]=useState("");
  const [hintSaved,setHintSaved]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [cameraOpen,setCameraOpen]=useState(false);
  const [groupInvite,setGroupInvite]=useState(null);
  const videoRef=useRef(null),streamRef=useRef(null),frameRef=useRef(null),alive=useRef(false);
  const refresh=useCallback(async()=>{
    try{
      const [onboard,settings]=await Promise.all([
        api(onboarding+"/status"),api(hub+"/status")
      ]);
      setStatus(onboard);setHubState(settings);
      if(onboard.identity_verified)setActivation(null);
      return onboard;
    }catch(e){setError(friendly[e.message]||e.message);return null;}
  },[]);
  useEffect(()=>{
    refresh();
    const tick=setInterval(refresh,15000);
    return ()=>clearInterval(tick);
  },[refresh]);
  function stopCamera(){
    alive.current=false;
    if(frameRef.current!==null){cancelAnimationFrame(frameRef.current);frameRef.current=null;}
    streamRef.current?.getTracks().forEach(track=>track.stop());
    streamRef.current=null;
    setCameraOpen(false);
  }
  useEffect(()=>()=>stopCamera(),[]);
  async function scanCamera(){
    setError("");
    if(typeof BarcodeDetector==="undefined"||!navigator.mediaDevices?.getUserMedia){
      setError("QR camera decoding is unavailable in this browser. Enter the Telegram username or user ID instead.");
      return;
    }
    setCameraOpen(true);alive.current=true;
    try{
      const stream=await navigator.mediaDevices.getUserMedia({
        audio:false,video:{facingMode:{ideal:"environment"}}
      });
      if(!alive.current){stream.getTracks().forEach(t=>t.stop());return;}
      streamRef.current=stream;
      // Let React mount the video before assigning the media stream.
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const video=videoRef.current;
      if(!video)throw new Error("Camera view not ready");
      video.srcObject=stream;
      await video.play();
      const detector=new BarcodeDetector({formats:["qr_code"]});
      const check=async()=>{
        if(!alive.current)return;
        try{
          const codes=await detector.detect(video);
          if(codes.length){
            const found=validProfileQr(codes[0]?.rawValue);
            if(!found){
              setError("That QR is not a Telegram user profile. Scan the merchant's Telegram profile QR.");
              stopCamera();return;
            }
            setIdentity(found);
            setNotice("Telegram profile QR recognized. Save the identity, then confirm using Activate Telegram Report.");
            stopCamera();return;
          }
        }catch(_){}
        if(alive.current)frameRef.current=requestAnimationFrame(check);
      };
      frameRef.current=requestAnimationFrame(check);
    }catch(_){stopCamera();setError("Camera permission denied or unavailable. Use Telegram ID or @username.");}
  }
  async function activate(){
    setBusy(true);setError("");setNotice("");
    try{
      const next=await api(onboarding+"/activate","POST",{});
      setActivation(next);
      setNotice("Scan this QR using the merchant's Telegram account and tap Start to verify.");
    }catch(e){setError(friendly[e.message]||e.message);}
    finally{setBusy(false);}
  }
  async function saveIdentity(){
    if(!identity.trim())return;
    setBusy(true);setError("");setNotice("");
    try{
      const data=await api(onboarding+"/identity-hint","POST",{identity:identity.trim()});
      setHintSaved(data.identity_hint);
      setNotice("Telegram identity saved as a hint. Verification requires opening the activation link in Telegram.");
    }catch(e){setError(friendly[e.message]||e.message);}
    finally{setBusy(false);}
  }
  async function openGroup(){
    setBusy(true);setError("");
    try{setGroupInvite(await api("/api/merchant/telegram-groups/invite","POST",{}));}
    catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  async function updatePref(key,value){
    setBusy(true);setError("");setNotice("");
    try{await api(hub+"/preferences","PATCH",{[key]:value});await refresh();setNotice("Report preference saved.");}
    catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  async function copy(value){
    try{await navigator.clipboard.writeText(value);setNotice("Copied to clipboard.");}
    catch(_){setError("Select and copy the link manually.");}
  }
  const tenant=String(status?.tenant||"").toUpperCase();
  const title=status?.group_title||"PENTAGON | MERCHANT | REPORTS";
  const verified=Boolean(status?.identity_verified);
  const groupReady=Boolean(status?.group_ready);
  const ready=verified&&groupReady&&hubState?.connected;
  const prefs=hubState?.preferences||{};
  return <div className="maGroupSettings">
    <header className="maGroupSettingsHead">
      <div>
        <span className="maGroupEyebrow">PENTAGON / MERCHANT TELEGRAM</span>
        <h2><Settings2 size={22}/> Telegram Settings</h2>
        <p>Activate once. Pentagon assigns one private report group to your merchant automatically, without selecting or creating a group in Telegram.</p>
      </div>
      <span className={"maGroupBadge "+(ready?"ready":verified?"paused":"pending")}>
        {ready?"Active":verified?"Waiting for group":"Not activated"}
      </span>
    </header>
    {error&&<p className="maGroupFeedback error" role="alert"><CircleAlert size={16}/>{error}</p>}
    {notice&&<p className="maGroupFeedback" role="status"><CheckCircle2 size={16}/>{notice}</p>}
    <div className="maGroupIdentity">
      <div><small>Merchant</small><strong>{tenant||"Loading..."}</strong></div>
      <div><small>Assigned report group</small><strong>{title}</strong></div>
      <div><small>Group creation</small><strong>{groupReady?"Created":status?.group_state||"Pending"}</strong></div>
    </div>
    {!status?.provisioner_configured&&<div className="maGroupSetupWarning">
      <CircleAlert size={17}/>
      <span>Automatic Telegram group provisioning is waiting for a dedicated Telegram service account. Your identity can be verified now, but delivery will stay disabled until the group exists.</span>
    </div>}
    <section className="maGroupSetupArea">
      <div className="maGroupSectionTitle">
        <h3><ShieldCheck size={18}/> Activate Telegram Report</h3>
        <p>Your Telegram account is verified through the Pentagon bot. A typed ID or scanned profile alone cannot activate another person's account.</p>
      </div>
      {verified?<div className="maGroupSuccess">
        <CheckCircle2 size={23}/><div><strong>Telegram identity verified</strong>
          <p>{status?.telegram_username?"@"+status.telegram_username:status?.telegram_user_id_masked} is linked to {tenant}. {groupReady?"Your group has been provisioned.":"The private report group is being provisioned."}</p>
        </div>
      </div>:<>
        <div className="maGroupControls">
          <button type="button" className="maGroupPrimary" onClick={activate} disabled={busy||!tenant}>
            <ShieldCheck size={16}/> Activate Telegram Report
          </button>
          <button type="button" className="maGroupPill" onClick={scanCamera} disabled={busy}>
            <Camera size={16}/> Scan Merchant QR
          </button>
        </div>
        {activation&&<div className="maGroupActivation">
          <div className="maGroupQr"><QRCodeSVG value={activation.url} size={185} level="M"/></div>
          <div><strong>Scan to verify Telegram account</strong>
            <p>On the merchant's phone, scan this QR and tap Start in the Pentagon bot. Valid for 10 minutes. This does not open a group picker.</p>
            <a href={activation.url} target="_blank" rel="noopener noreferrer" className="maGroupPrimary">
              <ExternalLink size={15}/> Open Telegram
            </a>
          </div>
        </div>}
        <div className="maGroupIdentityInput">
          <label htmlFor="maTelegramIdentity">Telegram username or numeric user ID (optional)</label>
          <div className="maGroupControls">
            <input id="maTelegramIdentity" value={identity}
              onChange={e=>setIdentity(e.target.value)}
              placeholder="@username or numeric Telegram user ID" autoComplete="off"/>
            <button type="button" className="maGroupPill" disabled={busy||!identity.trim()}
              onClick={saveIdentity}><CheckCircle2 size={15}/> Save identity</button>
          </div>
          <small>{hintSaved?"Saved identity: "+hintSaved+". ":""}An ID is not proof of ownership. The merchant must confirm using the bot QR/link.</small>
        </div>
      </>}
      {groupReady&&verified&&<div className="maGroupInvitation">
        <h3><Users size={18}/> {title}</h3>
        <p>Assigned exclusively to {tenant}. A private invitation is sent to your verified Telegram account. No group selection is required.</p>
        <button className="maGroupPrimary" type="button" disabled={busy} onClick={openGroup}>
          <Users size={16}/> Open My Report Group
        </button>
        {groupInvite&&<a href={groupInvite.url} target="_blank" rel="noreferrer" className="maGroupPill">
          <ExternalLink size={16}/> Join {groupInvite.group_title}
        </a>}
      </div>}
      {cameraOpen&&<div className="maGroupCam" role="dialog" aria-modal="true" aria-label="Scan Telegram profile QR">
        <div className="maGroupCamContent">
          <button type="button" aria-label="Close camera" className="maGroupCamClose" onClick={stopCamera}><X size={18}/></button>
          <h3><Camera size={18}/> Scan Merchant Telegram Profile</h3>
          <p>Point the camera at the Telegram QR on the merchant's phone.</p>
          <video ref={videoRef} autoPlay muted playsInline/>
        </div>
      </div>}
    </section>
    <section className="maGroupSetupArea">
      <div className="maGroupSectionTitle"><h3><Bell size={18}/> Report Preferences</h3>
        <p>These preferences apply only to {tenant||"your merchant"}. Report delivery starts only after the Telegram identity and group are both verified.</p>
      </div>
      <div className="maGroupPrefs">{preferences.map(([key,label,description])=>
        <label key={key} className="maGroupPref">
          <span><strong>{label}</strong><small>{description}</small></span>
          <input type="checkbox" checked={Boolean(prefs[key])}
            disabled={busy||!hubState} onChange={e=>updatePref(key,e.target.checked)}/>
        </label>)}</div>
      <label className="maGroupFrequency">Digest frequency
        <select disabled={busy||!hubState} value={prefs.interval_minutes||60}
          onChange={e=>updatePref("interval_minutes",Number(e.target.value))}>
          {[10,30,60,180,1440].map(n=><option key={n} value={n}>
            {n<60?n+" min":n===1440?"Daily":n/60+" hour"+(n>60?"s":"")}
          </option>)}
        </select>
      </label>
    </section>
    <footer className="maGroupFoot">
      <p><LockKeyhole size={15}/> One merchant, one group. No manual group selection, no shared forum, no cross-merchant report forwarding.</p>
      <button className="maGroupPill" type="button" onClick={onBackToReports}>
        <ArrowLeft size={15}/> Back to Telegram Reports
      </button>
      <button className="maGroupPill" type="button" onClick={refresh}>
        <RefreshCw size={15}/> Refresh status
      </button>
    </footer>
  </div>;
}
