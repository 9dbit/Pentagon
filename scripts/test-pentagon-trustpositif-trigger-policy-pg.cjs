#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {Pool}=require("pg");
const policy=require("../server/trustpositifTriggerPolicy");
const watch=require("../server/trustpositifWatch");
const {scanRequired}=require("../server/trustpositifEvidenceBridge");
if(process.env.CI!=="true" ||
   !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(process.env.DATABASE_URL||"")){
  console.error("LOCAL_CI_POSTGRES_REQUIRED: never run against production");
  process.exit(3);
}
process.env.TRUSTPOSITIF_STATUS_POLICY="tradevicepc_triggered";
const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:false,
  options:"-c search_path=tradevicepc_trigger_policy_ci"});
const sha="a".repeat(64);
const source="komdigi-domains_isp-tradevicepc-sha256:"+sha.slice(0,32);
const nodes=[
  {id:1,name:"TSEL",provider_name:"Telkomsel",is_active:true},
  {id:2,name:"XL",provider_name:"XL",is_active:true},
  {id:3,name:"TSEL-Backup",provider_name:"Telkomsel",is_active:true},
  {id:4,name:"Inactive",provider_name:"Indosat",is_active:false}
];
const node=(id,status,reason,http_status=null)=>({
  node_id:id,checker_type:"node:cellular",status,reason,http_status
});
const warnings=[
  node(1,"warning","HTTP error: SSLHandshakeException: connection closed"),
  node(2,"warning","HTTP timeout / connection took too long")
];
const working=[node(1,"working","OK",200),node(2,"working","OK",200)];
const domain={domain:"www.example.com",tenant:"merchant_a",global_status:"warning"};
let count=0;
async function check(name,fn){await fn();count++;console.log("PASS "+name);}
async function sourceEvidence(listed,at,collector="TRADEVICEPC"){
 await db.query(
  "UPDATE trustpositif_domain_monitor SET registry_listed=$1,registry_checked_at=$2,"+
  "registry_collector=$3,registry_source=$4,registry_lookup_domain='example.com',"+
  "registry_snapshot_sha256=$5,registry_snapshot_bytes=222980547,"+
  "registry_snapshot_entries=9952119,registry_match_kind='parent_apex' "+
  "WHERE tenant='merchant_a' AND domain='www.example.com'",
  [listed,at,collector,source,sha]
 );
}
async function main(){
 try{
  await db.query("CREATE SCHEMA IF NOT EXISTS tradevicepc_trigger_policy_ci");
  await db.query("CREATE TABLE domains (id SERIAL PRIMARY KEY,domain TEXT UNIQUE NOT NULL,"+
    "tenant TEXT NOT NULL,global_status TEXT DEFAULT 'unknown',is_active BOOLEAN DEFAULT TRUE)");
  await db.query("CREATE TABLE rank_keyword_groups ("+
    "id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE)");
  await db.query("CREATE TABLE rank_keyword_domains ("+
    "id SERIAL PRIMARY KEY,group_id INTEGER REFERENCES rank_keyword_groups(id),"+
    "domain TEXT NOT NULL,is_whitelisted BOOLEAN DEFAULT FALSE)");
  const group=(await db.query(
    "INSERT INTO rank_keyword_groups(tenant) VALUES('merchant_a') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) "+
    "VALUES($1,'www.example.com',TRUE)",[group]);
  await db.query("INSERT INTO domains(domain,tenant,global_status) "+
    "VALUES('www.example.com','merchant_a','warning')");
  await watch.ensureMonitorTable(db);
  const t0=new Date();
  await check("only genuine responses from different provider nodes count",async()=>{
    assert.equal(policy.distinctSignals(warnings,nodes,"warning").length,2);
    assert.equal(policy.distinctSignals([
      node(1,"warning","SSL handshake"),node(3,"warning","HTTPS 503")],nodes,"warning").length,1);
    assert.equal(policy.distinctSignals([
      node(1,"warning","Node polling timeout / no response from device"),
      node(2,"warning","Polling node error: ENETDOWN")],nodes,"warning").length,0);
    assert.equal(policy.distinctSignals([
      node(1,"working","OK",null),node(2,"working","OK",200)],nodes,"working").length,1);
    assert.equal(policy.distinctSignals(working,nodes,"working").length,2);
  });
  await check("one warning never triggers registry or BLOCKED",async()=>{
    const r=await policy.evaluateTriggeredPolicy(domain,[warnings[0]],nodes,{db,now:t0});
    assert.equal(r.triggered,false);
    assert.equal(r.confirmedBlocked,false);
    assert.equal(await scanRequired(db),false);
  });
  await check("two independent warnings create trigger, never automatic BLOCKED",async()=>{
    const r=await policy.evaluateTriggeredPolicy(domain,warnings,nodes,{
      db,now:new Date(t0.getTime()+1000)});
    assert.equal(r.triggered,true);
    assert.equal(r.awaitingCollector,true);
    assert.equal(r.confirmedBlocked,false);
    assert.equal(await scanRequired(db),true);
    const row=(await db.query(
      "SELECT registry_triggered_at,anomaly_nodes,listed FROM trustpositif_domain_monitor "+
      "WHERE tenant='merchant_a'")).rows[0];
    assert.ok(row.registry_triggered_at);
    assert.equal(row.anomaly_nodes.length,2);
    assert.equal(row.listed,null);
  });
  await check("Railway registry match cannot impersonate trusted TRADEVICEPC",async()=>{
    await sourceEvidence(true,new Date(t0.getTime()+3000),"RAILWAY");
    const r=await policy.evaluateTriggeredPolicy(domain,warnings,nodes,{
      db,now:new Date(t0.getTime()+4000)});
    assert.equal(r.confirmedBlocked,false);
    assert.equal(r.awaitingCollector,true,"Railway snapshot cannot satisfy TRADEVICEPC authority");
    assert.equal(r.checked,false);
  });
  await check("post-trigger TRADEVICEPC exact membership becomes BLOCKED without node.blocked",async()=>{
    await sourceEvidence(true,new Date(t0.getTime()+5000));
    const r=await policy.evaluateTriggeredPolicy(domain,warnings,nodes,{
      db,now:new Date(t0.getTime()+7000)});
    assert.equal(r.confirmedBlocked,true);
    assert.equal(r.checked,true);
    assert.equal(r.nodes.length,2);
    assert.equal(r.nodes.every(n=>n.status==="warning"),true);
    const row=(await db.query(
      "SELECT listed,verified_at,detected_at FROM trustpositif_domain_monitor "+
      "WHERE tenant='merchant_a'")).rows[0];
    assert.equal(row.listed,true);
    assert.ok(row.verified_at);
    assert.ok(row.detected_at);
    assert.equal((await db.query("SELECT global_status FROM domains WHERE tenant='merchant_a'"))
      .rows[0].global_status,"warning","policy never bypasses atomic transition/outbox");
    assert.equal(await scanRequired(db),false);
  });
  await check("agent timeout cannot clear a previous verified BLOCKED",async()=>{
    const r=await policy.evaluateTriggeredPolicy({...domain,global_status:"blocked"},[
      node(1,"warning","Node polling timeout / no response from device")],nodes,{
      db,now:new Date(t0.getTime()+12000)});
    assert.equal(r.holdBlocked,true);
    assert.equal(r.confirmedNormalized,false);
  });
  await check("trusted registry delisting downgrades BLOCKED but not NORMAL on broken links",async()=>{
    await sourceEvidence(false,new Date(t0.getTime()+16000));
    const r=await policy.evaluateTriggeredPolicy({...domain,global_status:"blocked"},warnings,nodes,{
      db,now:new Date(t0.getTime()+17000)});
    assert.equal(r.confirmedBlocked,false);
    assert.equal(r.confirmedRecovered,true);
    assert.equal(r.confirmedNormalized,false);
    assert.equal(r.holdBlocked,false);
    const row=(await db.query(
      "SELECT listed,recovered_at,detected_at FROM trustpositif_domain_monitor WHERE tenant='merchant_a'"
    )).rows[0];
    assert.equal(row.listed,false);
    assert.ok(row.recovered_at);
    assert.equal(row.detected_at,null);
  });
  await check("network recovery requires TWO independent working cycles",async()=>{
    const cycle1=await policy.evaluateTriggeredPolicy(domain,working,nodes,{
      db,now:new Date(t0.getTime()+5*60000)});
    assert.equal(cycle1.confirmedNormalized,false);
    assert.equal(cycle1.recoveryStreak,1);
    const cycle2=await policy.evaluateTriggeredPolicy(domain,working,nodes,{
      db,now:new Date(t0.getTime()+10*60000)});
    assert.equal(cycle2.confirmedNormalized,true);
    assert.equal(cycle2.recoveryStreak,2);
  });
  await check("a subsequent node failure resets normal recovery streak",async()=>{
    await policy.evaluateTriggeredPolicy(domain,[warnings[0]],nodes,{
      db,now:new Date(t0.getTime()+15*60000)});
    const row=(await db.query(
      "SELECT recovery_streak FROM trustpositif_domain_monitor WHERE tenant='merchant_a'"
    )).rows[0];
    assert.equal(row.recovery_streak,0);
  });
  await check("blocked domain gets official delisting recheck after six hours",async()=>{
    await db.query(
      "UPDATE domains SET global_status='blocked' WHERE tenant='merchant_a'");
    await db.query(
      "UPDATE trustpositif_domain_monitor SET registry_checked_at=NOW()-INTERVAL '7 hours' "+
      "WHERE tenant='merchant_a'");
    assert.equal(await scanRequired(db),true);
  });
  console.log("PENTAGON_TWO_WARNING_TRADEVICEPC_POLICY_PASS="+count);
 }finally{await db.end();}
}
main().catch(e=>{console.error("TRIGGER_POLICY_PG_FAIL="+e.stack);process.exitCode=1;});
