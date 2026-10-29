"use strict";
const assert=require("node:assert/strict");
const {normalizedUrl,selectTarget,destinationStatus,destinationChecks}=require("../server/shieldLinkRoutes");
const {networkReading,registryReading}=require("../server/rankCheckerEvidence");
const {googleRankNativePages}=require("../server/telegramMerchantNativeReports");
const now=Date.parse("2026-10-29T10:00:00Z"),stamp=new Date(now).toISOString();
let passed=0;function test(name,fn){fn();passed++;console.log("PASS "+name);}
test("Shieldlink rejects unsafe schemes, credentials, internal hosts, port tricks and redirect loops",()=>{
  for(const url of ["javascript:alert(1)","https://a:b@example.com","https://127.0.0.1","http://localhost","https://example.com:444","https://pentagon.quest/s/abcd1234","https://example.com\\@evil.com","https://example.com/\nLocation:evil"])
    assert.throws(()=>normalizedUrl(url),url);
  assert.equal(normalizedUrl("example.com/path?campaign=1"),"https://example.com/path?campaign=1");
});
test("Shieldlink fails over in order, excludes stale/blocked/foreign project, and recovers primary",()=>{
  const link={is_active:true,project_name:"Project",primary_url:"https://primary.example/a"};
  const stock=[{domain_url:"https://foreign.example"},{domain_url:"https://stale.example"},{domain_url:"https://fallback.example/b"}];
  const row=(domain,extra={})=>({domain,project_name:"Project",is_active:true,global_status:"working",last_checked_at:stamp,...extra});
  const domains=[row("primary.example",{global_status:"blocked"}),row("foreign.example",{project_name:"Other"}),row("stale.example",{last_checked_at:"2020-01-01"}),row("fallback.example")];
  assert.equal(selectTarget(link,stock,domains,now).url,"https://fallback.example/b");
  domains[0].global_status="working";assert.equal(selectTarget(link,stock,domains,now).reason,"primary");
  domains[0].registry_listed=true;domains[3].registry_listed=true;
  assert.equal(selectTarget(link,stock,domains,now).reason,"no_verified_destination");
  assert.equal(selectTarget({...link,is_active:false},stock,domains,now).reason,"paused");
});
test("Missing, future, warning, and old checker data cannot become safe or a rank",()=>{
  assert.equal(networkReading(null,now).state,"unknown");
  assert.equal(networkReading({status:"working",checked_at:new Date(now+1)},now).state,"unknown");
  assert.equal(networkReading({status:"warning",checked_at:stamp},now).state,"warning");
  assert.equal(networkReading({status:"working",checked_at:new Date(now-21*60000)},now).state,"stale");
  assert.equal(registryReading({registry_listed:false,registry_checked_at:stamp},now).text,"Tidak tercatat registry");
  assert.equal(registryReading({registry_listed:true,registry_checked_at:new Date(now-13*3600000)},now).state,"stale");
});
test("Destination diagnostics distinguish registry blocking, missing evidence, stale data and readiness",()=>{
  const ready={domain:"primary.example",project_name:"Project",is_active:true,global_status:"working",last_checked_at:stamp,registry_checked_at:stamp};
  for(const [extra,code] of [[{},"ready"],[{is_active:false},"inactive"],[{registry_listed:true},"registry_listed"],[{global_status:"blocked"},"network_blocked"],[{last_checked_at:null},"unchecked"],[{last_checked_at:new Date(now+1)},"invalid_timestamp"],[{last_checked_at:new Date(now-86400001)},"stale"],[{global_status:"warning"},"network_unverified"]]){
    const status=destinationStatus({...ready,...extra},now);assert.equal(status.code,code);assert.equal(status.eligible,code==="ready");
  }
  assert.equal(destinationStatus(null,now).code,"not_owned");
  const checks=destinationChecks({project_name:"Project",primary_url:"https://primary.example/path"},[{id:"fallback",domain_url:"https://foreign.example"},{domain_url:"javascript:bad"}],[ready],now);
  assert.equal(checks[0].code,"ready");assert.equal(checks[0].registry_checked_at,stamp);
  assert.equal(checks[1].code,"not_owned");assert.equal(checks[1].id,"fallback");assert.equal(checks[2].code,"invalid_url");
});
test("Telegram includes every whitelist relation and checker, preserving distinct evidence and escaping",()=>{
  const nodes=Array.from({length:9},(_,i)=>({key:"n"+i,label:"Provider "+i,is_active:i!==8}));
  const rows=Array.from({length:25},(_,i)=>({group_id:Math.floor(i/5),keyword:"Keyword "+Math.floor(i/5),
    domain:"domain"+i+".example",last_position:i===0?13:null,last_page:i===0?2:null,
    last_status:i===0?"found":i===1?"pending":"not_found",last_checked_at:i===1?null:stamp}));
  const evidence={nodes,domains:rows.map(row=>({domain:row.domain,
    node_results:Object.fromEntries(nodes.map(n=>[n.key,{text:"Warning jaringan <script>",checked_at:stamp}])),
    ai:{text:"Tercatat registry",checked_at:stamp}}))};
  const pages=googleRankNativePages("merchant",rows,[],[],new Date(now),60,evidence);
  for(const p of pages){assert.ok(p.message.length<3800);assert.ok(p.rich_message.html.length<24000);assert.doesNotMatch(p.rich_message.html,/<script>/);}
  const all=pages.map(p=>p.rich_message.html).join("\n");
  for(const r of rows)assert.ok(all.includes(r.domain));
  for(const n of nodes)assert.ok(all.includes(n.label));
  assert.match(all,/<td>2<\/td><td>#13/);assert.match(all,/NOT CHECKED/);assert.match(all,/NOT FOUND/);
  assert.match(all,/AI Checker/);assert.match(all,/Tercatat registry/);assert.match(all,/Bukan rank Google dari SIM/);
});
console.log("SHIELD_RANK_UNIT_PASS="+passed);
