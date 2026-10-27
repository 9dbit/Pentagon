#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {Pool}=require("pg");
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const express=require("express");
const {inventory,validateEvidence,importEvidence,router,SOURCE_URL}=
  require("../server/trustpositifEvidenceBridge");
if(process.env.CI!=="true"||
   !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(process.env.DATABASE_URL||"")){
  console.error("LOCAL_CI_POSTGRES_REQUIRED: never run against production");
  process.exit(3);
}
const testdb=new Pool({connectionString:process.env.DATABASE_URL,ssl:false,
  options:"-c search_path=bridge_fixture"});
const now=new Date();
let passed=0;
async function test(name,fn){await fn();passed++;console.log("PASS "+name);}
function payload(domains,at=now.toISOString()){
  return {source_url:SOURCE_URL,source_http:200,source_sha256:"b".repeat(64),
    source_bytes:222980547,source_entries:9952119,verified_at_utc:at,
    matches:domains.map(x=>({...x,listed:true}))};
}
async function main(){
  try{
    await testdb.query("CREATE SCHEMA IF NOT EXISTS bridge_fixture");
    await testdb.query("CREATE TABLE bridge_fixture.domains ("+
      "id SERIAL PRIMARY KEY,domain TEXT UNIQUE NOT NULL,tenant TEXT NOT NULL,"+
      "is_active BOOLEAN NOT NULL DEFAULT TRUE,global_status TEXT DEFAULT 'warning')");
    await testdb.query("CREATE TABLE bridge_fixture.rank_keyword_groups ("+
      "id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE)");
    await testdb.query("CREATE TABLE bridge_fixture.rank_keyword_domains ("+
      "id SERIAL PRIMARY KEY,group_id INTEGER REFERENCES bridge_fixture.rank_keyword_groups(id),"+
      "domain TEXT NOT NULL,is_whitelisted BOOLEAN NOT NULL DEFAULT FALSE)");
    await testdb.query("CREATE TABLE bridge_fixture.trustpositif_registry_bridge_audit("+
      "id BIGSERIAL PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_bytes BIGINT,"+
      "source_entries BIGINT,source_checked_at TIMESTAMPTZ,inventory_count INT,"+
      "accepted_count INT,listed_count INT,imported_at TIMESTAMPTZ DEFAULT NOW())");
    const merchant=(await testdb.query(
      "INSERT INTO rank_keyword_groups(tenant) VALUES('merchant_a') RETURNING id")).rows[0].id;
    const demo=(await testdb.query(
      "INSERT INTO rank_keyword_groups(tenant) VALUES('demo') RETURNING id")).rows[0].id;
    await testdb.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) "+
      "VALUES($1,'www.example.com',true),($1,'alpha.example',true),"+
      "($2,'demo.example',true)",[merchant,demo]);
    await testdb.query("INSERT INTO domains(domain,tenant,is_active,global_status) VALUES "+
      "('www.example.com','merchant_a',TRUE,'warning'),"+
      "('alpha.example','merchant_a',TRUE,'warning'),"+
      "('demo.example','demo',TRUE,'warning'),"+
      "('unlisted.example','merchant_a',TRUE,'warning')");
    const monitored=await inventory(testdb);
    await test("inventory includes only active production whitelists",async()=>{
      assert.deepEqual(monitored.map(x=>x.domain),["alpha.example","www.example.com"]);
      assert.equal(monitored[1].lookup_key,"example.com");
    });
    await test("full source integrity metadata required",async()=>{
      assert.equal(validateEvidence({...payload(monitored),source_http:404},monitored).ok,false);
      assert.equal(validateEvidence({...payload(monitored),source_bytes:150},monitored).ok,false);
      assert.equal(validateEvidence({...payload(monitored),source_bytes:99999999},monitored).ok,false);
      assert.equal(validateEvidence({...payload(monitored),source_entries:4999999},monitored).ok,false);
      assert.equal(validateEvidence({...payload(monitored),source_sha256:"invalid"},monitored).ok,false);
      assert.equal(validateEvidence({...payload(monitored),source_entries:50},monitored).ok,false);
    });
    await test("expired, partial, alias-spoofed or cross-tenant evidence rejected",async()=>{
      assert.equal(validateEvidence(payload(monitored,new Date(now-3*3600000).toISOString()),monitored).ok,false);
      assert.equal(validateEvidence({...payload(monitored),matches:[monitored[0]]},monitored).ok,false);
      const duplicate={...payload(monitored),matches:[{...monitored[0],listed:true},{...monitored[0],listed:true}]};
      assert.equal(validateEvidence(duplicate,monitored).ok,false);
      const alias={...payload(monitored),matches:[{...monitored[0],listed:true},
        {...monitored[1],lookup_key:"www.example.com",listed:true}]};
      assert.equal(validateEvidence(alias,monitored).ok,false);
      const tenant={...payload(monitored),matches:[{...monitored[0],tenant:"another",listed:true},
        {...monitored[1],listed:true}]};
      assert.equal(validateEvidence(tenant,monitored).ok,false);
    });
    await test("signed source evidence writes registry fields, not BLOCKED",async()=>{
      const out=await importEvidence(payload(monitored),testdb);
      assert.equal(out.ok,true);assert.equal(out.accepted,2);assert.equal(out.listed,2);
      const {rows}=await testdb.query(
        "SELECT d.domain,d.global_status,m.registry_listed,m.registry_checked_at,"+
        "m.registry_lookup_domain,m.listed,m.detected_at,m.registry_source,"+
        "m.registry_snapshot_sha256,m.registry_snapshot_bytes,m.registry_snapshot_entries,"+
        "m.registry_collector,m.registry_match_kind "+
        "FROM domains d LEFT JOIN trustpositif_domain_monitor m ON m.domain=d.domain "+
        "AND m.tenant=d.tenant ORDER BY d.domain");
      assert.equal(rows.find(x=>x.domain==="www.example.com").registry_lookup_domain,"example.com");
      assert.equal(rows.find(x=>x.domain==="www.example.com").registry_match_kind,"parent_apex");
      assert.equal(rows.find(x=>x.domain==="alpha.example").registry_match_kind,"exact");
      assert.equal(rows.find(x=>x.domain==="alpha.example").registry_collector,"TRADEVICEPC");
      assert.equal(rows.find(x=>x.domain==="alpha.example").registry_snapshot_sha256,"b".repeat(64));
      assert.equal(Number(rows.find(x=>x.domain==="alpha.example").registry_snapshot_bytes),222980547);
      assert.equal(Number(rows.find(x=>x.domain==="alpha.example").registry_snapshot_entries),9952119);
      assert.equal(rows.find(x=>x.domain==="alpha.example").registry_listed,true);
      assert.equal(rows.find(x=>x.domain==="alpha.example").listed,null);
      assert.equal(rows.find(x=>x.domain==="alpha.example").detected_at,null);
      assert.ok(rows.every(x=>x.global_status==="warning"));
      assert.equal(rows.find(x=>x.domain==="demo.example").registry_listed,null);
      assert.equal(rows.find(x=>x.domain==="unlisted.example").registry_listed,null);
      assert.match(rows.find(x=>x.domain==="alpha.example").registry_source,/sha256:/);
      assert.equal((await testdb.query(
        "SELECT COUNT(*)::int AS n FROM trustpositif_registry_bridge_audit")).rows[0].n,1);
    });
    await test("older contradictory snapshot cannot clear more recent evidence",async()=>{
      const earlier=payload(monitored,new Date(now.getTime()-60000).toISOString());
      earlier.matches.forEach(x=>x.listed=false);
      const out=await importEvidence(earlier,testdb);
      assert.equal(out.accepted,0);
      assert.ok((await testdb.query("SELECT registry_listed,registry_snapshot_sha256 FROM trustpositif_domain_monitor"))
        .rows.every(x=>x.registry_listed===true && x.registry_snapshot_sha256==="b".repeat(64)));
    });
    await test("HTTP route rejects missing or invalid secrets",async()=>{
      const app=express();app.use("/api/internal/trustpositif/bridge",router);
      const server=await new Promise(resolve=>{
        const s=app.listen(0,"127.0.0.1",()=>resolve(s));
      });
      const url="http://127.0.0.1:"+server.address().port+
        "/api/internal/trustpositif/bridge/inventory";
      try{
        delete process.env.TRUSTPOSITIF_SOURCE_BRIDGE_KEY;
        assert.equal((await fetch(url)).status,503);
        process.env.TRUSTPOSITIF_SOURCE_BRIDGE_KEY=crypto.randomBytes(48).toString("base64url");
        assert.equal((await fetch(url)).status,401);
        assert.equal((await fetch(url,{headers:{Authorization:"Bearer incorrect"}})).status,401);
      }finally{server.close();delete process.env.TRUSTPOSITIF_SOURCE_BRIDGE_KEY;}
    });
    const source=fs.readFileSync(path.join(__dirname,"../server/trustpositifEvidenceBridge.js"),"utf8");
    await test("bridge never sends Telegram or changes domain global status",async()=>{
      assert.doesNotMatch(source,/UPDATE\s+domains\s+SET/i);
      assert.doesNotMatch(source,/INSERT\s+INTO\s+(?:alerts|trustpositif_notification_outbox)/i);
      assert.doesNotMatch(source,/sendTelegram\s*\(/);
      assert.match(source,/timingSafeEqual/);
    });
    console.log("PENTAGON_TRUSTPOSITIF_SOURCE_BRIDGE_PG_PASS="+passed);
  }finally{await testdb.end();}
}
main().catch(e=>{console.error("BRIDGE_PG_FAIL="+e.stack);process.exitCode=1;});
