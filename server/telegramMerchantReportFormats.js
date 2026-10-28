"use strict";

// Pure, Telegram HTML-safe merchant report templates. Source data comes only
// from tenant-scoped stored scans; missing or stale observations are never
// invented. Each output is < 4096 characters after Telegram entities parsing.
const PAGE_MAX=3250;
function esc(value) {
  return String(value==null?"":value).replace(/&/g,"&amp;")
    .replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function clip(value,limit=100){const s=String(value==null?"":value);return s.length>limit?s.slice(0,limit-1)+"…":s;}
function wib(value) {
  if(!value)return "Not available";
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return "Not available";
  return date.toLocaleString("id-ID",{timeZone:"Asia/Jakarta",day:"2-digit",
    month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})+" WIB";
}
function validAge(value,now,maxHours) {
  const checked=value?new Date(value).getTime():NaN;
  return Number.isFinite(checked) && checked<=now.getTime()+300000 &&
    checked>=now.getTime()-maxHours*3600000;
}
function pages(header,lines,footer) {
  const head=header.join("\n"),tail=footer.join("\n"),parts=[];
  let current="";
  for(const line of (lines.length?lines:["<i>No records available.</i>"])){
    if(head.length+current.length+line.length+tail.length+4>PAGE_MAX && current){
      parts.push(current);current="";
    }
    current+=(current?"\n":"")+line;
  }
  parts.push(current);
  return parts.map((body,i)=>{
    const mark=parts.length>1?"<b>Part "+(i+1)+"/"+parts.length+"</b>\n":"";
    return mark+head+"\n\n"+body+"\n\n"+tail;
  });
}
function statusOf(row,now) {
  const current=String(row.global_status||"unknown").toLowerCase();
  if(current==="blocked" && row.latest_registry_event==="BLOCKED")return "CONFIRMED BLOCKED";
  if(current==="blocked")return "BLOCKED / REVIEW";
  if(row.registry_listed===true && validAge(row.registry_checked_at,now,24))
    return "REGISTRY LISTED / ISP PENDING";
  if(!row.last_checked_at)return "UNKNOWN";
  if(!validAge(row.last_checked_at,now,24))return "STALE";
  if(current==="working")return "WORKING";
  if(current==="warning")return "WARNING";
  return "UNKNOWN";
}
function providerTag(provider) {
  const name=String(provider||"").trim();
  if(/telkomsel/i.test(name))return "TSEL";
  if(/\bxl\b|xl axiata/i.test(name))return "XL";
  if(/indosat|isat|im3/i.test(name))return "ISAT";
  return clip(name.toUpperCase().replace(/[^A-Z0-9 ]/g,""),8)||"NODE";
}
function trustPositifReportPages(tenant,domainRows,providerRows=[],observationRows=[],now=new Date()) {
  const statuses=domainRows.map(row=>({...row,report_status:statusOf(row,now)}));
  const count=key=>statuses.filter(r=>r.report_status===key).length;
  const healthyProviders=new Set(providerRows.filter(row=>
    String(row.last_health_status||"").toLowerCase()==="online" &&
    validAge(row.last_ping_at,now,1/3)
  ).map(row=>String(row.provider_name||"").toLowerCase()).filter(Boolean));
  const totalProviders=new Set(providerRows.map(row=>String(row.provider_name||"").toLowerCase())
    .filter(Boolean)).size;
  const header=[
    "🛡️ <b>TRUST POSITIF REPORT</b>",
    "<b>Merchant:</b> "+esc(clip(tenant.toUpperCase(),65)),
    "🕐 "+esc(wib(now)),
    "<b>Monitored:</b> "+statuses.length+
      " | <b>Warning:</b> "+count("WARNING")+
      " | <b>Confirmed blocked:</b> "+count("CONFIRMED BLOCKED")+
      " | <b>Registry listed:</b> "+count("REGISTRY LISTED / ISP PENDING"),
    "<b>Working:</b> "+count("WORKING")+
      " | <b>Stale:</b> "+count("STALE")+
      " | <b>Unknown:</b> "+count("UNKNOWN")+
      " | <b>Review:</b> "+count("BLOCKED / REVIEW"),
    "<b>CHECKER COVERAGE:</b> "+healthyProviders.size+"/"+totalProviders+" recent healthy providers",
    "<b>DOMAIN MONITORING</b>"
  ];
  const observations=new Map();
  for(const r of observationRows) {
    const k=Number(r.domain_id);
    if(!observations.has(k))observations.set(k,[]);
    const list=observations.get(k);
    if(list.length<3)list.push(providerTag(r.provider_name)+": "+clip(r.status||"unknown",25));
  }
  const icon={"CONFIRMED BLOCKED":"🚨","BLOCKED / REVIEW":"🔴",
    WARNING:"⚠️",STALE:"⌛",UNKNOWN:"❔",WORKING:"✅",
    "REGISTRY LISTED / ISP PENDING":"🛡️"};
  const lines=statuses.map((r,i)=>{
    const flag=r.report_status;
    let line=(i+1)+". "+icon[flag]+" <code>"+esc(clip(r.domain,150))+"</code> "+
      "<b>"+esc(flag)+"</b>\n   Last checked: "+
      esc(wib(flag==="REGISTRY LISTED / ISP PENDING"?r.registry_checked_at:r.last_checked_at));
    if(flag==="REGISTRY LISTED / ISP PENDING")
      line+="\n   TRADEVICEPC registry: exact match · waiting for 2 valid WARNING triggers";
    if(["WARNING","BLOCKED / REVIEW","CONFIRMED BLOCKED"].includes(flag)){
      const checks=observations.get(Number(r.domain_id))||[];
      if(checks.length)line+="\n   Network evidence: "+esc(checks.join(" • "));
      if(flag==="CONFIRMED BLOCKED" && r.latest_registry_event_at)
        line+="\n   Registry confirmation: "+esc(wib(r.latest_registry_event_at));
      if(flag!=="CONFIRMED BLOCKED")line+="\n   Registry: not confirmed";
    }
    return line;
  });
  const footer=[
    "<i>WORKING describes network reachability, not an official registry clearance.",
    "REGISTRY LISTED means official source membership, not an automatic block without a warning trigger.",
    "BLOCKED requires 2 valid independent WARNING triggers followed by a TRADEVICEPC official registry match.",
    "Unknown/stale does not mean safe. Review evidence in Pentagon Defence Center.</i>"
  ];
  return pages(header,lines,footer);
}
function rankState(row,now) {
  if(!row.last_checked_at)return {text:"NOT CHECKED",position:null,delta:null,stale:false};
  if(!validAge(row.last_checked_at,now,24))
    return {text:"STALE",position:null,delta:null,stale:true};
  const p=Number(row.last_position);
  if(String(row.last_status||"").toLowerCase()==="not_found")
    return {text:"NOT FOUND",position:null,delta:null,stale:false};
  if(!Number.isInteger(p)||p<1||p>100)
    return {text:"NOT FOUND",position:null,delta:null,stale:false};
  const prior=Number(row.previous_position);
  const validPrevious=row.previous_position!=null&&Number.isInteger(prior)&&prior>=1&&prior<=100;
  const d=validPrevious?prior-p:null;
  return {text:"#"+p,position:p,delta:d,stale:false};
}
function rankReportPages(tenant,rows=[],nodes=[],snapshotRows=[],now=new Date()) {
  const groups=new Map();
  for(const row of rows){
    const key=String(row.group_id);
    if(!groups.has(key))groups.set(key,{keyword:row.keyword,project:row.project_name,
      candidates:[]});
    groups.get(key).candidates.push(row);
  }
  const items=[...groups.entries()].map(([id,g])=>{
    const candidates=g.candidates.map(row=>({row,state:rankState(row,now)}));
    candidates.sort((a,b)=>{
      const ap=a.state.position,bp=b.state.position;
      if(ap!=null&&bp!=null)return ap-bp;
      if(ap!=null)return -1;if(bp!=null)return 1;
      return String(a.row.domain).localeCompare(String(b.row.domain));
    });
    return {id,...g,best:candidates[0]||null};
  });
  const positioned=items.filter(x=>x.best?.state.position!=null);
  const top10=positioned.filter(x=>x.best.state.position<=10).length;
  const top3=positioned.filter(x=>x.best.state.position<=3).length;
  const rising=positioned.filter(x=>x.best.state.delta>0).length;
  const falling=positioned.filter(x=>x.best.state.delta<0).length;
  const header=[
    "📊 <b>GOOGLE RANK REPORT</b>",
    "<b>Merchant:</b> "+esc(clip(tenant.toUpperCase(),65)),
    "🕐 "+esc(wib(now)),
    "<b>Keywords:</b> "+items.length+" | <b>Ranked:</b> "+positioned.length+
      " | <b>Top 10:</b> "+top10+" | <b>Top 3:</b> "+top3,
    "<b>Movement:</b> ↑ "+rising+" | ↓ "+falling+
      " | <b>Not ranked / unavailable:</b> "+(items.length-positioned.length),
    "<b>KEYWORD PERFORMANCE</b>"
  ];
  const lines=items.map((g,i)=>{
    const best=g.best;
    if(!best)return (i+1)+". "+esc(clip(g.keyword,80))+" • NO WHITELIST DOMAIN";
    const row=best.row,s=best.state;
    const prior=s.delta==null?"":s.delta>0?" ↑"+s.delta:s.delta<0?" ↓"+Math.abs(s.delta):" =0";
    const label=row.domain_label==="landing_page"?"LP":row.domain_label==="ms"?"MS":"SITE";
    return (i+1)+". <b>"+esc(clip(g.keyword,105))+"</b>\n   <code>"+
      esc(clip(row.domain,120))+"</code> • "+label+" | <b>"+s.text+"</b>"+prior+
      "\n   Checked: "+esc(wib(row.last_checked_at));
  });
  const candidates=items.filter(item=>item.best?.state.position!=null);
  const selected=candidates[0]||items[0];
  if(selected?.best){
    const key=String(selected.id)+"|"+String(selected.best.row.domain).toLowerCase();
    const nodeTags=new Map(nodes.map(n=>[String(n.id),providerTag(n.provider_name)]));
    const positions=new Map();
    for(const r of snapshotRows){
      if(String(r.group_id)+"|"+String(r.domain).toLowerCase()!==key)continue;
      if(!validAge(r.checked_at,now,0.5))continue;
      const label=r.node_id==null?"VPS":nodeTags.get(String(r.node_id));
      if(label&&!positions.has(label))positions.set(label,"#"+r.position);
    }
    if(selected.best.state.position!=null&&!positions.has("VPS"))
      positions.set("VPS","#"+selected.best.state.position);
    const keys=["VPS",...new Set(nodes.map(n=>providerTag(n.provider_name)))];
    const snapshot=keys.map(tag=>tag+": "+(positions.get(tag)||"—")).join(" • ");
    lines.push("<b>CHECKER SNAPSHOT</b>\n"+esc(clip(selected.keyword,80))+"\n"+
      esc(clip(snapshot,600)));
  }
  const footer=[
    "<i>Positions are saved scan snapshots, not a live Google query.",
    "Changes compare with an older VPS scan only when available.",
    "STALE/NOT CHECKED mean no fresh verified ranking. Open Pentagon Google Rank for details.</i>"
  ];
  return pages(header,lines,footer);
}
module.exports={esc,wib,validAge,statusOf,rankState,trustPositifReportPages,rankReportPages};
