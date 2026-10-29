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
    "AI Checker memverifikasi registry resmi untuk BLOCKED; NORMAL memerlukan recovery jaringan independen. " +
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
function deltaText(state){
  if(state.delta==null)return "—";
  if(state.delta>0)return "▲ +"+state.delta;
  if(state.delta<0)return "▼ −"+Math.abs(state.delta);
  return "● 0";
}
function googleRankNativePages(tenant,rankingRows=[],nodes=[],snapshots=[],now=new Date(),intervalMinutes=60,evidence={}){
  // Each whitelist relationship is a row. Never replace it with a keyword's
  // best domain. Network and registry evidence are NOT SIM-sourced SERP ranks.
  const byDomain=new Map((evidence.domains||[]).map(d=>[d.domain.toLowerCase(),d]));
  const checkerNodes=evidence.nodes||nodes.map((n,i)=>({key:"unavailable-"+i,label:n.provider_name||"Node",is_active:n.is_active!==false}));
  const checkerColumns=[...checkerNodes,{key:"ai",label:"AI Checker",is_active:true}];
  const columnGroups=[];
  for(let i=0;i<checkerColumns.length;i+=4)columnGroups.push(checkerColumns.slice(i,i+4));
  const name=esc(clip(String(tenant).toUpperCase(),65)),stamp=esc(wib(now));
  const schedule=esc(period(intervalMinutes));
  const keywords=new Set(rankingRows.map(r=>String(r.group_id))).size;
  const note="Node: akses jaringan. AI Checker: registry TrustPositif. Bukan rank Google dari SIM. "+
    "Lama/Belum diperiksa bukan berarti aman; tidak ditemukan hanya berlaku pada hasil scan.";
  function cellsFor(row,columns){
    const d=byDomain.get(String(row.domain).toLowerCase());
    return columns.map(col=>{
      const r=col.key==="ai"?d?.ai:d?.node_results?.[col.key];
      return {label:col.label+(col.is_active?"":" (nonaktif)"),text:r?.text||"Belum diperiksa",
        time:r?.checked_at?wib(r.checked_at):"—",historical:r?.attribution==="provider_history"};
    });
  }
  function render(batch,columns,part,total){
    const mark=total>1?"Bagian "+part+"/"+total:"";
    const head="<h3>📊 GOOGLE RANK REPORT</h3><p><b>"+name+"</b> · "+stamp+"</p>"+
      (mark?"<p><b>"+mark+"</b></p>":"")+"<p><b>"+keywords+"</b> Keywords · <b>"+rankingRows.length+"</b> Domain Links</p>";
    const trs=batch.map(row=>{
      const state=rankState(row,now);
      const page=state.position!=null&&Number.isInteger(Number(row.last_page))&&Number(row.last_page)>0?String(row.last_page):"—";
      const rank=state.position==null?state.text:"#"+state.position+(state.delta!=null?" "+deltaText(state):"");
      const checks=cellsFor(row,columns);
      return {rich:"<tr><td>"+cell(row.keyword)+"<br>"+cell(row.domain)+"</td><td>"+esc(page)+
        "</td><td>"+esc(rank)+"<br>"+esc(wib(row.last_checked_at))+"</td>"+
        checks.map(c=>"<td>"+esc(c.text)+"<br>"+esc(c.time)+(c.historical?"<br>Riwayat provider":"")+"</td>").join("")+"</tr>",
        plain:"<b>"+cell(row.keyword)+"</b> · <code>"+cell(row.domain)+"</code>\nGoogle: halaman "+esc(page)+" · "+esc(rank)+
        " · "+esc(wib(row.last_checked_at))+"\n"+checks.map(c=>esc(c.label)+": "+esc(c.text)+" · "+esc(c.time)+(c.historical?" (riwayat provider)":"")).join("\n")};
    });
    const header="<tr><th>Keyword / Domain</th><th>Halaman SERP</th><th>Rank Google / waktu</th>"+
      columns.map(c=>"<th>"+cell(c.label)+(c.key==="ai"?"<br>Registry":"<br>Jaringan")+"</th>").join("")+"</tr>";
    const rich=head+"<table bordered striped>"+header+(trs.length?trs.map(t=>t.rich).join(""):
      '<tr><td colspan="'+(3+columns.length)+'">Belum ada domain whitelist aktif</td></tr>')+"</table><p>"+esc(note)+
      "</p><footer>Source: saved Google SERP + node checks + registry · Setiap "+schedule+"</footer>";
    const fallback=["<b>📊 GOOGLE RANK REPORT</b>",name+" · "+stamp,mark,
      keywords+" Keywords · "+rankingRows.length+" Domain Links",...trs.map(t=>t.plain),
      trs.length?"":"Belum ada domain whitelist aktif","<i>"+esc(note)+"</i>","Setiap "+schedule].filter(Boolean).join("\n\n");
    return {rich_message:{html:rich,skip_entity_detection:true},message:fallback};
  }
  const batches=[];
  for(const columns of columnGroups){
    let batch=[];
    for(const row of rankingRows){
      const candidate=render([...batch,row],columns,99999,99999);
      if(batch.length&&(batch.length>=ROWS_PER_PAGE||candidate.message.length>3500||candidate.rich_message.html.length>22000)){
        batches.push({batch,columns});batch=[];
      }
      batch.push(row);
    }
    if(batch.length||!rankingRows.length)batches.push({batch,columns});
  }
  return batches.map(({batch,columns},i)=>{
    const page=render(batch,columns,i+1,batches.length);
    return assertLengths(page.rich_message.html,page.message);
  });
}

module.exports={
  ROWS_PER_PAGE,minsSince,providerHealth,statusStyle,deltaText,
  trustPositifNativePages,googleRankNativePages
};
