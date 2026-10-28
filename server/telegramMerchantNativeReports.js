"use strict";

// Telegram Bot API 10.1+ native tables, HTML-rich messages. No database or
// network access here. Every rich page has a strictly equivalent legacy HTML
// fallback built from the SAME tenant-scoped snapshot and SAME page of rows.
const {esc,wib,validAge,statusOf,rankState}=require("./telegramMerchantReportFormats");
const ROWS_PER_PAGE=8;
const RICH_MAX=24000;          // Telegram allows 32,768 UTF-8 characters.
const FALLBACK_MAX=3800;      // Legacy sendMessage caps parsed text at 4,096.

const clip=(v,n=70)=>{
  const t=String(v==null?"":v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g," ").trim();
  return t.length>n?t.slice(0,n-1)+"…":t;
};
const cell=(v)=>esc(clip(v,95));
const int=(v)=>Number.isFinite(Number(v))?Number(v):0;
function minsSince(date,now){
  if(!date)return "—";
  const at=new Date(date).getTime(),diff=now.getTime()-at;
  if(!Number.isFinite(at)||diff< -300000)return "—";
  if(diff<60000)return "<1m";
  if(diff<3600000)return Math.floor(diff/60000)+"m";
  if(diff<86400000)return Math.floor(diff/3600000)+"h";
  return Math.floor(diff/86400000)+"d";
}
function period(minutes){
  const n=Math.max(1,Math.min(1440,int(minutes)||60));
  return n===1440?"24 jam":n%60===0?(n/60)+" jam":n+" menit";
}
function groupsOf(items){
  if(!items.length)return [[]];
  const groups=[];
  for(let i=0;i<items.length;i+=ROWS_PER_PAGE)
    groups.push(items.slice(i,i+ROWS_PER_PAGE));
  return groups;
}
function assertLengths(rich,fallback){
  if(rich.length>RICH_MAX||fallback.length>FALLBACK_MAX)
    throw new Error("TELEGRAM_NATIVE_REPORT_EXCEEDS_PAGE_LIMIT");
  return {rich_message:{html:rich,skip_entity_detection:true},message:fallback};
}
function renderPages(items,render){
  const groups=groupsOf(items);
  return groups.map((batch,i)=>render(batch,i+1,groups.length));
}
function statusStyle(status){
  if(status==="CONFIRMED BLOCKED")return {rich:"🚨 Blocked",fallback:"🚨 CONFIRMED BLOCKED"};
  if(status==="BLOCKED / REVIEW")return {rich:"🔴 Review",fallback:"🔴 BLOCKED / REVIEW"};
  if(status==="REGISTRY LISTED / ISP PENDING")
    return {rich:"🛡️ Listed · trigger pending",fallback:"🛡️ REGISTRY LISTED / ISP PENDING"};
  if(status==="WARNING")return {rich:"⚠️ Warning",fallback:"⚠️ WARNING"};
  if(status==="STALE")return {rich:"⌛ Stale",fallback:"⌛ STALE"};
  if(status==="WORKING")return {rich:"✅ Working",fallback:"✅ WORKING"};
  return {rich:"❔ Unknown",fallback:"❔ UNKNOWN"};
}
function providerHealth(providers,now){
  const names=new Set(),healthy=new Set();
  for(const p of providers){
    const name=String(p.provider_name||"").trim().toLowerCase();
    if(!name)continue;
    names.add(name);
    if(String(p.last_health_status||"").toLowerCase()==="online" &&
      validAge(p.last_ping_at,now,1/3))healthy.add(name);
  }
  return {healthy:healthy.size,total:names.size};
}
function trustPositifNativePages(tenant,domainRows=[],providers=[],observations=[],now=new Date(),intervalMinutes=60){
  const observationsByDomain=new Map();
  for(const obs of observations){
    const id=Number(obs.domain_id);
    const seen=observationsByDomain.get(id)||[];
    if(seen.length<3)seen.push(clip(obs.provider_name,14)+": "+clip(obs.status,15));
    observationsByDomain.set(id,seen);
  }
  const rows=domainRows.map(r=>{
    const status=statusOf(r,now);
    return {id:r.domain_id,domain:clip(r.domain,85),status,
      age:minsSince(status==="REGISTRY LISTED / ISP PENDING"?r.registry_checked_at:r.last_checked_at,now),
      checks:observationsByDomain.get(Number(r.domain_id))||[]};
  });
  const flagged=rows.filter(r=>r.status==="CONFIRMED BLOCKED").length;
  const listedPending=rows.filter(r=>r.status==="REGISTRY LISTED / ISP PENDING").length;
  const warning=rows.filter(r=>r.status==="WARNING"||r.status==="BLOCKED / REVIEW").length;
  const unknown=rows.filter(r=>r.status==="STALE"||r.status==="UNKNOWN").length;
  const health=providerHealth(providers,now);
  const name=esc(clip(String(tenant).toUpperCase(),65));
  const stamp=esc(wib(now));
  const schedule=esc(period(intervalMinutes));
  const protection="Status Working adalah keterjangkauan jaringan, bukan bukti bebas blokir. " +
    "Dua provider dengan hasil WARNING memicu pemeriksaan. " +
    "TRADEVICEPC memutuskan BLOCKED dari registry resmi; NORMAL memerlukan recovery jaringan independen. " +
    "Unknown/Stale bukan berarti aman.";
  return renderPages(rows,(batch,part,total)=>{
    const countInfo=total>1?"<p><b>Bagian "+part+"/"+total+"</b></p>":"";
    const head="<h3>🛡️ TRUST POSITIF REPORT</h3><p><b>"+name+
      "</b> · "+stamp+"</p>"+countInfo+
      "<p><b>"+rows.length+"</b> Domains · <b>"+flagged+
      "</b> Confirmed Blocked · <b>"+listedPending+
      "</b> Registry Listed (warning trigger pending) · <b>"+health.healthy+"/"+health.total+
      "</b> Healthy Providers</p>"+
      "<p>⚠️ Review/Warning: <b>"+warning+"</b> · Unknown/Stale: <b>"+unknown+"</b></p>"+
      "<h4>DOMAIN MONITORING</h4>";
    const trs=batch.length?batch.map(r=>
      "<tr><td>"+cell(r.domain)+"</td><td align=\"center\">"+
      esc(statusStyle(r.status).rich)+"</td><td align=\"right\">"+
      esc(r.age)+"</td></tr>").join("")
      :"<tr><td colspan=\"3\">Belum ada domain whitelist aktif</td></tr>";
    const table="<table bordered striped><tr><th>Domain</th><th>Status</th><th>Age</th></tr>"+trs+"</table>";
    const issues=batch.filter(r=>r.checks.length &&
      ["WARNING","BLOCKED / REVIEW","CONFIRMED BLOCKED"].includes(r.status)).slice(0,3);
    const evidence=issues.length?
      "<p><b>Network evidence:</b> "+issues.map(r=>
        cell(r.domain)+": "+esc(r.checks.join(" • "))).join("; ")+"</p>":"";
    const foot="<p>⚠️ "+esc(protection)+"</p>"+
      "<footer>Source: Pentagon Network Monitoring · Setiap "+schedule+
      " · Detail di Defence Center</footer>";
    const rich=head+table+evidence+foot;
    const fallback=[
      "<b>🛡️ TRUST POSITIF REPORT</b>",
      "<b>Merchant:</b> "+name+" · "+stamp,
      total>1?"<b>Bagian "+part+"/"+total+"</b>":null,
      "<b>Domains:</b> "+rows.length+" | <b>Confirmed blocked:</b> "+flagged+
       " | <b>Registry listed:</b> "+listedPending+
       " | <b>Healthy providers:</b> "+health.healthy+"/"+health.total,
      "<b>Review/Warning:</b> "+warning+" | <b>Unknown/Stale:</b> "+unknown,
      "",
      "<b>DOMAIN MONITORING</b>",
      ...(batch.length?batch.map(r=>"<code>"+esc(r.domain)+"</code> · "+
        esc(statusStyle(r.status).fallback)+" · "+esc(r.age)):
        ["Belum ada domain whitelist aktif"]),
      "",
      "<i>"+esc(protection)+"</i>",
      "Source: Pentagon Network Monitoring · Setiap "+schedule
    ].filter(x=>x!==null).join("\n");
    return assertLengths(rich,fallback);
  });
}
function rankedGroups(rows,now){
  const groups=new Map();
  for(const r of rows){
    const key=String(r.group_id);
    if(!groups.has(key))groups.set(key,{id:key,keyword:clip(r.keyword,115),candidates:[]});
    groups.get(key).candidates.push({row:r,state:rankState(r,now)});
  }
  return [...groups.values()].map(g=>{
    g.candidates.sort((a,b)=>{
      const ap=a.state.position,bp=b.state.position;
      if(ap!=null&&bp!=null)return ap-bp;
      if(ap!=null)return -1;
      if(bp!=null)return 1;
      return String(a.row.domain).localeCompare(String(b.row.domain));
    });
    return {...g,best:g.candidates[0]||null};
  });
}
function deltaText(state){
  if(state.delta==null)return "—";
  if(state.delta>0)return "▲ +"+state.delta;
  if(state.delta<0)return "▼ −"+Math.abs(state.delta);
  return "● 0";
}
function recentSnapshots(selected,nodes,snapshots,now){
  if(!selected?.best)return null;
  const target=String(selected.id)+"|"+String(selected.best.row.domain).toLowerCase();
  const labels=new Map(nodes.map(n=>[String(n.id),
    clip(n.provider_name||"NODE",16).toUpperCase()]));
  const positions=new Map();
  for(const r of snapshots){
    if(String(r.group_id)+"|"+String(r.domain).toLowerCase()!==target)continue;
    if(!validAge(r.checked_at,now,0.5))continue;
    const label=r.node_id==null?"VPS":labels.get(String(r.node_id));
    const position=Number(r.position);
    if(label&&Number.isInteger(position)&&position>=1&&position<=100&&!positions.has(label))
      positions.set(label,"#"+position);
  }
  if(!positions.size)return null;
  return clip(selected.keyword,70)+": "+
    [...positions.entries()].slice(0,4).map(([k,v])=>k+" "+v).join(" · ");
}
function googleRankNativePages(tenant,rankingRows=[],nodes=[],snapshots=[],now=new Date(),intervalMinutes=60){
  const groups=rankedGroups(rankingRows,now);
  const positioned=groups.filter(g=>g.best?.state.position!=null);
  const top3=positioned.filter(g=>g.best.state.position<=3).length;
  const top10=positioned.filter(g=>g.best.state.position<=10).length;
  const rising=positioned.filter(g=>g.best.state.delta>0).length;
  const falling=positioned.filter(g=>g.best.state.delta<0).length;
  const name=esc(clip(String(tenant).toUpperCase(),65));
  const stamp=esc(wib(now)),schedule=esc(period(intervalMinutes));
  const snapshot=recentSnapshots(positioned[0]||groups[0],nodes,snapshots,now);
  const note="N/D berarti posisi terbaru belum tersedia atau scan stale. "+
    "Pergerakan hanya dihitung dari snapshot historis valid; tidak ada angka estimasi.";
  return renderPages(groups,(batch,part,total)=>{
    const partLine=total>1?"<p><b>Bagian "+part+"/"+total+"</b></p>":"";
    const head="<h3>📊 GOOGLE RANK REPORT</h3><p><b>"+name+
      "</b> · "+stamp+"</p>"+partLine+
      "<p><b>"+groups.length+"</b> Keywords · <b>"+rankingRows.length+
      "</b> Domain Links · <b>"+positioned.length+"</b> Valid Positions</p>"+
      "<p>Top 3: <b>"+top3+"</b> · Top 10: <b>"+top10+
      "</b> · ▲ "+rising+" · ▼ "+falling+"</p>"+
      "<h4>KEYWORD POSITION TABLE</h4>";
    const trs=batch.length?batch.map(g=>{
      const st=g.best?.state;
      const position=st?.position==null?"N/D":"#"+st.position;
      const diff=st?deltaText(st):"—";
      return "<tr><td>"+cell(g.keyword)+"</td><td align=\"center\">"+
        esc(position)+"</td><td align=\"center\">"+esc(diff)+"</td></tr>";
    }).join(""):"<tr><td colspan=\"3\">Belum ada keyword/domain yang memenuhi syarat</td></tr>";
    const table="<table bordered striped><tr><th>Keyword</th><th>Position</th><th>Δ Rank</th></tr>"+trs+"</table>";
    const snapshotNote=snapshot&&part===1?
      "<p><b>Checker snapshot:</b> "+esc(snapshot)+"</p>":"";
    const foot="<p>ℹ️ "+esc(note)+"</p>"+
      "<footer>Source: Google SERP snapshots · Setiap "+schedule+
      " · Detail di Pentagon Google Rank</footer>";
    const rich=head+table+snapshotNote+foot;
    const fallback=[
      "<b>📊 GOOGLE RANK REPORT</b>",
      "<b>Merchant:</b> "+name+" · "+stamp,
      total>1?"<b>Bagian "+part+"/"+total+"</b>":null,
      "<b>Keywords:</b> "+groups.length+" | <b>Domain links:</b> "+rankingRows.length+
        " | <b>Valid:</b> "+positioned.length,
      "<b>Top 3:</b> "+top3+" | <b>Top 10:</b> "+top10+" | ▲ "+rising+" ▼ "+falling,
      "",
      "<b>KEYWORD POSITION TABLE</b>",
      ...(batch.length?batch.map(g=>{
        const st=g.best?.state;
        return "<b>"+cell(g.keyword)+"</b> · "+
          (st?.position==null?"N/D":"#"+st.position)+" · "+
          esc(st?deltaText(st):"—");
      }):["Belum ada keyword/domain yang memenuhi syarat"]),
      snapshot&&part===1?"<b>Checker snapshot:</b> "+esc(snapshot):null,
      "",
      "<i>"+esc(note)+"</i>",
      "Source: Google SERP snapshots · Setiap "+schedule
    ].filter(x=>x!==null).join("\n");
    return assertLengths(rich,fallback);
  });
}
module.exports={
  ROWS_PER_PAGE,minsSince,providerHealth,statusStyle,deltaText,
  trustPositifNativePages,googleRankNativePages
};
