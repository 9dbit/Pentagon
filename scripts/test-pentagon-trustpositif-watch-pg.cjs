#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const { Pool }=require("pg");
const fs=require("node:fs"),path=require("node:path");
const watch=require("../server/trustpositifWatch");

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
  await test("repeated samples from one node do not qualify",async()=>{
    assert.equal(watch.reliableNodeAnomalies([node(10,"blocked"),node(10,"blocked")],nodes).length,1);
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
    assert.equal(answer.confirmedBlocked,true);assert.equal(answer.nodes.length,2);
    assert.equal(firstResults.at(-1).checker_type,"provider_registry");
    const r=(await db.query("SELECT listed,detected_at,verified_at,anomaly_nodes FROM trustpositif_domain_monitor WHERE domain='alpha.example'")).rows[0];
    assert.equal(r.listed,true);assert.ok(r.detected_at);assert.ok(r.verified_at);assert.equal(r.anomaly_nodes.length,2);
  });
  await test("cached positive result does not request official endpoint again",async()=>{
    const samples=[...two];
    const answer=await watch.checkAfterNodeConsensus(alpha,samples,nodes,{db,lookup:async()=>{throw Error("CACHE_FAILED")}});
    assert.equal(answer.confirmedBlocked,true);assert.equal(answer.cached,true);
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
  await test("scheduler sends alerts and Telegram on verified status transition",async()=>{
    const scheduler=fs.readFileSync(path.resolve(__dirname,"../server/scheduler.js"),"utf8");
    assert.match(scheduler,/syncAdminWhitelist\(\)/);
    assert.match(scheduler,/registryCheck\.confirmedBlocked/);
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
