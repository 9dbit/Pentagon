#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const { Pool }=require("pg");
const fs=require("node:fs"),path=require("node:path");
const watch=require("../server/trustpositifWatch");
const registry=require("../server/trustpositifRegistrySync");

if(process.env.CI!=="true" || !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(process.env.DATABASE_URL||"")){
  console.error("LOCAL_CI_POSTGRES_REQUIRED: never run this drill against production");
  process.exit(3);
}
const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const nodes=[
{id:10,name:"Checker East",provider_name:"Sample ISP A",is_active:true},
{id:20,name:"Checker West",provider_name:"Sample ISP B",is_active:true},
{id:30,name:"Checker C",provider_name:"Sample ISP C",is_active:false}
];
const node=(id,status,reason="HTTP 451 blocked")=>({node_id:id,checker_type:"node:cellular",status,reason,http_status:451});
const negative=(id)=>({node_id:id,checker_type:"node:cellular",status:"working",reason:"OK",http_status:200});
const two=[node(10,"blocked"),node(20,"warning","HTTP 451 from regional ISP")];
let checks=0;
async function test(name,fn){await fn();checks++;console.log("PASS "+name);}
async function run(){
 try{
  await db.query("CREATE TABLE domains (id SERIAL PRIMARY KEY,domain TEXT NOT NULL UNIQUE,project_name TEXT DEFAULT '',is_active BOOLEAN DEFAULT TRUE,global_status TEXT DEFAULT 'unknown',last_status TEXT DEFAULT 'unknown',last_checked_at TIMESTAMPTZ,tenant TEXT DEFAULT 'admin')");
  await db.query("CREATE TABLE rank_keyword_groups (id SERIAL PRIMARY KEY,project_name TEXT DEFAULT '',tenant TEXT NOT NULL DEFAULT 'admin',is_active BOOLEAN DEFAULT TRUE)");
  await db.query("CREATE TABLE rank_keyword_domains (id SERIAL PRIMARY KEY,group_id INTEGER NOT NULL REFERENCES rank_keyword_groups(id),domain TEXT NOT NULL,is_whitelisted BOOLEAN DEFAULT TRUE)");
  await watch.ensureMonitorTable(db);

  const g1=(await db.query("INSERT INTO rank_keyword_groups(project_name,tenant) VALUES('Sample Campaign','admin') RETURNING id")).rows[0].id;
  const g2=(await db.query("INSERT INTO rank_keyword_groups(project_name,tenant) VALUES('Private Demo','demo') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES($1,'alpha.example',true),($1,'beta.example',true),($1,'ghost.example',false)",[g1]);
  await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES($1,'private.example',true)",[g2]);
  await db.query("INSERT INTO domains(domain,tenant,is_active) VALUES('beta.example','admin',false)");
  await test("rank whitelist synced without exposing demo",async()=>{
    const imported=await watch.syncAdminWhitelist(db);
    assert.equal(imported,1);
    const r=(await db.query("SELECT domain,is_active FROM domains ORDER BY domain")).rows;
    assert.deepEqual(r.map(x=>x.domain),["alpha.example","beta.example"]);
    assert.equal(r.find(x=>x.domain==="beta.example").is_active,false);
    assert.equal(await watch.syncAdminWhitelist(db),0);
  });
  await test("one node cannot trigger official endpoint",async()=>{
    const result=await watch.checkAfterNodeConsensus({domain:"alpha.example",tenant:"admin"},[node(10,"blocked")],nodes,
      {db,lookup:async()=>{throw Error("SHOULD_NOT_CALL")}});
    assert.equal(result.triggered,false);
  });
  await test("one node persisted as suspected without official call",async()=>{
    const r=(await db.query("SELECT listed,first_anomaly_at,last_anomaly_at,anomaly_nodes FROM trustpositif_domain_monitor WHERE domain='alpha.example'")).rows[0];
    assert.equal(r.listed,null);assert.ok(r.last_anomaly_at);assert.ok(r.first_anomaly_at);
    assert.equal(r.anomaly_nodes.length,1);
  });
  await test("repeated samples from one node do not qualify",async()=>{
    assert.equal(watch.reliableNodeAnomalies([node(10,"blocked"),node(10,"blocked")],nodes).length,1);
  });
  await test("same-provider distinct node IDs do not form independent quorum",async()=>{
    const shared=[...nodes,{id:40,name:"Backup",provider_name:"Sample ISP A",is_active:true}];
    assert.equal(watch.reliableNodeAnomalies([node(10,"blocked"),node(40,"blocked")],shared).length,1);
  });
  await test("agent error and disabled node excluded",async()=>{
    assert.equal(watch.reliableNodeAnomalies([node(10,"warning","Node polling timeout"),node(20,"blocked")],nodes).length,1);
    assert.equal(watch.reliableNodeAnomalies([node(10,"blocked"),node(30,"blocked")],nodes).length,1);
    assert.equal(watch.reliableNodeAnomalies([node(10,"blocked"),{checker_type:"direct",status:"blocked"}],nodes).length,1);
  });
  const alpha={domain:"alpha.example",tenant:"admin",global_status:"warning"};
  const firstResults=[...two];
  await test("two independent nodes plus exact listed registry confirm blocked",async()=>{
    const answer=await watch.checkAfterNodeConsensus(alpha,firstResults,nodes,{db,lookup:async(d)=>{
      checks++;assert.equal(d,"alpha.example");return{listed:true,source:"mock-official-snapshot",verifiedAt:new Date()};
    }});
    assert.equal(answer.confirmedBlocked,true,JSON.stringify({source:answer.source,error:answer.lastError,nodes:answer.nodes}));assert.equal(answer.nodes.length,2);
    assert.equal(firstResults.at(-1).checker_type,"provider_registry");
    const r=(await db.query("SELECT listed,detected_at,verified_at,anomaly_nodes FROM trustpositif_domain_monitor WHERE domain='alpha.example'")).rows[0];
    assert.equal(r.listed,true);assert.ok(r.detected_at);assert.ok(r.verified_at);assert.equal(r.anomaly_nodes.length,2);
    assert.ok(new Date(r.detected_at).getTime() <= new Date(r.verified_at).getTime());
  });
  await test("cached positive result does not request official endpoint again",async()=>{
    const samples=[...two];
    const answer=await watch.checkAfterNodeConsensus(alpha,samples,nodes,{db,lookup:async()=>{throw Error("CACHE_FAILED")}});
    assert.equal(answer.confirmedBlocked,true);assert.equal(answer.cached,true);
  });
  await test("cached positive refreshes node evidence without official fetch",async()=>{
    const swapped=[node(10,"warning","HTTP 451 from regional ISP"),node(20,"blocked")];
    const current=new Date();
    const r=await watch.checkAfterNodeConsensus(alpha,[...swapped],nodes,
      {db,now:current,lookup:async()=>{throw Error("CACHED_NO_ENDPOINT")}});
    assert.equal(r.confirmedBlocked,true);
    const row=(await db.query("SELECT anomaly_nodes,last_anomaly_at FROM trustpositif_domain_monitor WHERE domain='alpha.example'")).rows[0];
    assert.equal(row.anomaly_nodes[0].status,"warning");
    assert.equal(row.anomaly_nodes[1].status,"blocked");
    assert.ok(Math.abs(new Date(row.last_anomaly_at).getTime()-current.getTime())<1000);
  });
  await test("verified blocked status survives temporary loss of node consensus",async()=>{
    const r=await watch.checkAfterNodeConsensus({...alpha,global_status:"blocked"},[node(10,"blocked"),negative(20)],nodes,
      {db,lookup:async()=>{throw Error("NO_REMOTE_LOOKUP_WITH_SINGLE_NODE")}});
    assert.equal(r.confirmedBlocked,false);assert.equal(r.holdBlocked,true);
    assert.equal(r.source,"previous_verified_listing");
  });
  await test("official source failure is pending, not blocked",async()=>{
    const response=await watch.checkAfterNodeConsensus({domain:"unavailable.example",tenant:"admin",global_status:"warning"},[...two],nodes,
      {db,lookup:async()=>{throw Error("SOURCE_OFFLINE")}});
    assert.equal(response.checked,false);assert.equal(response.confirmedBlocked,false);
    assert.equal((await db.query("SELECT last_error FROM trustpositif_domain_monitor WHERE domain='unavailable.example'")).rows[0].last_error,"SOURCE_OFFLINE");
  });
  await test("failure backoff avoids repeated source calls",async()=>{
    const response=await watch.checkAfterNodeConsensus({domain:"unavailable.example",tenant:"admin",global_status:"warning"},[...two],nodes,
      {db,lookup:async()=>{throw Error("RETRY_SHOULD_BE_SUPPRESSED")}});
    assert.equal(response.source,"retry_backoff");
  });
  await test("source unavailable cannot clear earlier confirmed blocked",async()=>{
    const later=new Date(Date.now()+watch.TTL_MS+1500);
    const r=await watch.checkAfterNodeConsensus({...alpha,global_status:"blocked"},[...two],nodes,
      {db,now:later,lookup:async()=>{throw Error("UPSTREAM_TIMEOUT")}});
    assert.equal(r.holdBlocked,true);assert.equal(r.confirmedBlocked,false);
  });
  await test("registry exact negative does not set blocked",async()=>{
    const answer=await watch.checkAfterNodeConsensus({domain:"beta.example",tenant:"admin"},[...two],nodes,
      {db,lookup:async()=>({listed:false,source:"mock-official-snapshot",verifiedAt:new Date()})});
    assert.equal(answer.confirmedBlocked,false);
  });
  await test("demo tenant can never run administrator registry scan",async()=>{
    const answer=await watch.checkAfterNodeConsensus({domain:"private.example",tenant:"demo"},[...two],nodes,
      {db,lookup:async()=>{throw Error("ISOLATION_FAILURE")}});
    assert.equal(answer.triggered,false);
  });
  await test("watchlist shows all whitelisted, including inactive monitoring entries",async()=>{
    await db.query("UPDATE domains SET global_status='blocked',last_checked_at=NOW() WHERE domain='alpha.example'");
    const r=await watch.listWatchlist("admin",db);
    assert.deepEqual(r.map(x=>x.domain),["alpha.example","beta.example"]);
    assert.equal(r[0].listed,true);assert.equal(r[0].global_status,"blocked");
    assert.ok(r[0].detected_at);assert.equal(r[0].anomaly_nodes.length,2);
    assert.equal(r[1].monitored,false);
    const demo=await watch.listWatchlist("demo",db);
    assert.deepEqual(demo.map(x=>x.domain),["private.example"]);
  });
  await test("a delisted domain resets its original detection timestamp",async()=>{
    const later=new Date(Date.now()+watch.TTL_MS+watch.RETRY_MS+120000);
    const negative=await watch.checkAfterNodeConsensus({...alpha,global_status:"blocked"},[...two],nodes,
      {db,now:later,lookup:async()=>({listed:false,verifiedAt:later,source:"test-official"})});
    assert.equal(negative.confirmedBlocked,false);
    assert.equal(negative.confirmedRecovered,true);
    const state=(await db.query("SELECT listed,detected_at FROM trustpositif_domain_monitor WHERE domain='alpha.example'")).rows[0];
    assert.equal(state.listed,false);
    assert.equal(state.detected_at,null);
    const recovery=(await db.query("SELECT recovered_at FROM trustpositif_domain_monitor WHERE domain='alpha.example'")).rows[0];
    assert.ok(recovery.recovered_at);
    const again=new Date(later.getTime()+watch.TTL_MS+120000);
    const positive=await watch.checkAfterNodeConsensus({...alpha,global_status:"warning"},[...two],nodes,
      {db,now:again,lookup:async()=>({listed:true,verifiedAt:again,source:"test-official"})});
    assert.equal(positive.confirmedBlocked,true);
    const fresh=(await db.query("SELECT detected_at FROM trustpositif_domain_monitor WHERE domain='alpha.example'")).rows[0];
    assert.ok(Math.abs(new Date(fresh.detected_at).getTime()-again.getTime())<1000);
    const reset=(await db.query("SELECT recovered_at FROM trustpositif_domain_monitor WHERE domain='alpha.example'")).rows[0];
    assert.equal(reset.recovered_at,null);
  });
  await test("ordinary DNS and HTTP timeout do not count as ISP block quorum",async()=>{
    const warnings=[
      {node_id:10,checker_type:"node:cellular",status:"warning",reason:"HTTP timeout",http_status:null},
      {node_id:20,checker_type:"node:cellular",status:"warning",reason:"DNS not found",http_status:null}
    ];
    assert.equal(watch.reliableNodeAnomalies(warnings,nodes).length,0);
    assert.equal(watch.reliableNodeAnomalies(two,nodes).length,2);
  });
  await test("canonical registry domain lookup strips only www and protocol",async()=>{
    assert.equal(registry.canonicalRegistryDomain("https://www.Wisnu123.NET/path"),"wisnu123.net");
    assert.equal(registry.canonicalRegistryDomain("wisnu123.net"),"wisnu123.net");
    assert.equal(registry.canonicalRegistryDomain("invalid@.net"),"");
  });
  await test("independent official registry sync persists listing, not global BLOCKED",async()=>{
    const gid=(await db.query(
      "INSERT INTO rank_keyword_groups(project_name,tenant) VALUES('WISNU','wisnu123') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) "+
      "VALUES($1,'www.wisnu123.net',TRUE)",[gid]);
    await db.query("INSERT INTO domains(domain,tenant,is_active,global_status) "+
      "VALUES('www.wisnu123.net','wisnu123',TRUE,'warning')");
    const outcome=await registry.syncOfficialRegistryBatch(db,{now:new Date(),
      lookup:async domains=>{
        assert.ok(domains.includes("wisnu123.net"));
        assert.ok(!domains.includes("www.wisnu123.net"));
        return {entryCount:9952119,source:"fixture-exact-index",
          matches:Object.fromEntries(domains.map(x=>[x,true]))};
      }});
    assert.equal(outcome.status,"complete");
    assert.equal(outcome.listed,2);
    const row=(await db.query("SELECT registry_listed,registry_checked_at,registry_lookup_domain,listed,detected_at "+
      "FROM trustpositif_domain_monitor WHERE tenant='wisnu123'")).rows[0];
    assert.equal(row.registry_listed,true);
    assert.equal(row.registry_lookup_domain,"wisnu123.net");
    assert.ok(row.registry_checked_at);
    assert.equal(row.listed,null);
    assert.equal(row.detected_at,null);
    assert.equal((await db.query("SELECT global_status FROM domains WHERE tenant='wisnu123'")).rows[0].global_status,"warning");
  });
  await test("valid independent node quorum reuses a fresh www registry listing",async()=>{
    const result=await watch.checkAfterNodeConsensus(
      {domain:"www.wisnu123.net",tenant:"wisnu123",global_status:"warning"},[...two],nodes,
      {db,lookup:async()=>{throw Error("SHOULD_REUSE_FRESH_REGISTRY_EVIDENCE")}});
    assert.equal(result.confirmedBlocked,true);
    assert.equal(result.nodes.length,2);
  });
  await test("official source timeout never erases exact registry evidence",async()=>{
    await db.query("UPDATE trustpositif_domain_monitor SET registry_checked_at=NOW()-INTERVAL '7 hours' "+
      "WHERE tenant='wisnu123'");
    const result=await registry.syncOfficialRegistryBatch(db,{
      lookup:async()=>{throw Object.assign(Error("Network error"),{code:"ETIMEDOUT"})}});
    assert.equal(result.status,"source_unavailable");
    const row=(await db.query("SELECT registry_listed,registry_last_error,registry_retry_after "+
      "FROM trustpositif_domain_monitor WHERE tenant='wisnu123'")).rows[0];
    assert.equal(row.registry_listed,true);
    assert.equal(row.registry_last_error,"ETIMEDOUT");
    assert.ok(row.registry_retry_after);
    const backoff=await registry.syncOfficialRegistryBatch(db,{
      lookup:async()=>{throw Error("RETRY_NOT_DUE")}});
    assert.equal(backoff.status,"not_due");
  });
  await test("scheduler sends alerts and Telegram on verified status transition",async()=>{
    const scheduler=fs.readFileSync(path.resolve(__dirname,"../server/scheduler.js"),"utf8");
    assert.match(scheduler,/syncAdminWhitelist\(\)/);
    assert.match(scheduler,/registryCheck\.confirmedBlocked/);
    assert.ok(scheduler.includes("registryCheck.confirmedRecovered"));
    assert.match(scheduler,/INSERT INTO alerts/);
    assert.match(scheduler,/sendTelegram\(message, telegramExtra\)/);
    assert.match(scheduler,/buildEmergencyBlockedMessage/);
    assert.doesNotMatch(scheduler,/verifyProviderBlock\(/);
    assert.match(scheduler,/registryCheck\.nodes\?\.map/);
  });
  const source=fs.readFileSync(path.resolve(__dirname,"../src/TrustPositifWatchlist.jsx"),"utf8");
  await test("watch page includes evidence timestamp and search",async()=>{
    assert.match(source,/detected_at/);assert.match(source,/min_nodes/);
    assert.match(source,/type="search"/);assert.match(source,/trustpositif\/watchlist/);
  });
  console.log("PENTAGON_TRUSTPOSITIF_WATCH_PG_PASS="+checks);
 }finally{await db.end();}
}
run().catch(e=>{console.error("WATCH_PG_FAIL="+e.stack);process.exitCode=1;});
