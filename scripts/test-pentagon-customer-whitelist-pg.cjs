#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {Pool}=require("pg");
const sync=require("../server/customerWhitelistSync");
const watch=require("../server/trustpositifWatch");
const outbox=require("../server/trustpositifAlertOutbox");

if(process.env.CI!=="true" ||
 !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(process.env.DATABASE_URL||"")) {
 console.error("ISOLATED_POSTGRES_REQUIRED");process.exit(3);
}
const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:false,
 options:"-c search_path=pentagon_customer_whitelist_ci,public"});
let passed=0;
async function test(name,fn){await fn();passed++;console.log("PASS "+name);}
async function group(tenant,project,active=true) {
 return (await db.query(
 "INSERT INTO rank_keyword_groups(tenant,project_name,is_active) VALUES($1,$2,$3) RETURNING id",
 [tenant,project,active])).rows[0].id;
}
async function whitelist(g,domains) {
 for(const domain of domains)await db.query(
 "INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES ($1,$2,TRUE)",[g,domain]);
}
async function domain(name,tenant,active=true,status="unknown") {
 return (await db.query(
 "INSERT INTO domains(domain,tenant,is_active,global_status,project_name) VALUES($1,$2,$3,$4,'Direct Monitor') RETURNING *",
 [name,tenant,active,status])).rows[0];
}
async function main(){
try{
 await db.query("CREATE SCHEMA IF NOT EXISTS pentagon_customer_whitelist_ci");
 await db.query("CREATE TABLE domains (id SERIAL PRIMARY KEY,domain TEXT NOT NULL UNIQUE,tenant TEXT NOT NULL,is_active BOOLEAN,project_name TEXT DEFAULT '',global_status TEXT DEFAULT 'unknown',last_status TEXT DEFAULT 'unknown',last_checked_at TIMESTAMPTZ)");
 await db.query("CREATE TABLE rank_keyword_groups(id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,project_name TEXT,is_active BOOLEAN)");
 await db.query("CREATE TABLE rank_keyword_domains(id SERIAL PRIMARY KEY,group_id INTEGER REFERENCES rank_keyword_groups(id),domain TEXT NOT NULL,is_whitelisted BOOLEAN)");
 await db.query("CREATE TABLE alerts(id SERIAL PRIMARY KEY,domain_id INTEGER REFERENCES domains(id),old_status TEXT,new_status TEXT,message TEXT,sent_to_telegram BOOLEAN DEFAULT FALSE)");
 const demo=await group("demo","Fixture Demo");
 const admin=await group("admin","Owner Websites");
 const client=await group("customer_one","Retail Website");
 const client2=await group("customer_two","Other Retail");
 const closed=await group("customer_one","Inactive Group",false);
 const sandbox=await group("sandbox","Sandbox");
 await whitelist(demo,["demo.example","demo-clash.example"]);
 await whitelist(admin,["admin.example","disabled.example"]);
 await whitelist(client,["retail.example","SHARED.EXAMPLE","demo-clash.example","taken.example","retail.example"]);
 await whitelist(client2,["shared.example","https://invalid.example/path"]);
 await whitelist(closed,["closed.example"]);
 await whitelist(sandbox,["sandbox.example"]);
 await domain("disabled.example","admin",false);
 await domain("taken.example","customer_two",true);
 await domain("demo-clash.example","demo",true);
 await domain("manual.example","customer_one",true);
 await test("exclude demo, sandbox, and fixture tenant names",async()=>{
  assert.equal(sync.isProductionTenant("demo"),false);
  assert.equal(sync.isProductionTenant("demo_a"),false);
  assert.equal(sync.isProductionTenant("test-data"),false);
  assert.equal(sync.isProductionTenant("sandbox"),false);
  assert.equal(sync.isProductionTenant("customer_one"),true);
  assert.equal(sync.isProductionTenant("admin"),true);
 });
 await test("preview all production tenant sources without database writes",async()=>{
  const a=await sync.customerWhitelistCoverage(db);
  assert.ok(a.whitelisted_source_rows>=7);
  assert.ok(a.excluded_nonproduction_rows>=3);
  assert.ok(a.quarantined_cross_tenant_sources>=2);
  assert.ok(a.invalid_hostnames>=1);
  assert.ok(a.deliberately_disabled>=1);
  assert.ok(a.occupied_by_other_tenant>=1);
  assert.equal(a.awaiting_import,2);
 });
 await test("sync only unambiguous current customer/admin whitelists",async()=>{
  const imported=await sync.syncEligibleCustomerWhitelist(db);
  assert.equal(imported,2);
  const r=(await db.query("SELECT tenant,domain,is_active FROM domains ORDER BY domain")).rows;
  assert.ok(r.some(x=>x.domain==="retail.example"&&x.tenant==="customer_one"&&x.is_active));
  assert.ok(r.some(x=>x.domain==="admin.example"&&x.tenant==="admin"&&x.is_active));
  assert.ok(r.some(x=>x.domain==="disabled.example"&&x.is_active===false));
  assert.ok(r.some(x=>x.domain==="demo-clash.example"&&x.tenant==="demo"));
  assert.ok(!r.some(x=>x.domain==="shared.example"));
  assert.ok(!r.some(x=>x.domain==="sandbox.example"));
  assert.ok(!r.some(x=>x.domain==="closed.example"));
 });
 await test("repeated cron sync is idempotent",async()=>{
  assert.equal(await sync.syncEligibleCustomerWhitelist(db),0);
  assert.equal((await sync.customerWhitelistCoverage(db)).awaiting_import,0);
 });
 await test("central report contains only production tenants, each with its own identity",async()=>{
  const all=await watch.listWatchlist("admin",db);
  assert.ok(all.some(x=>x.tenant==="customer_one"&&x.domain==="retail.example"&&x.monitored));
  assert.ok(all.some(x=>x.tenant==="admin"&&x.domain==="admin.example"&&x.monitored));
  assert.ok(all.some(x=>x.domain==="disabled.example"&&!x.monitored));
  assert.ok(!all.some(x=>x.tenant==="demo"||x.tenant==="sandbox"));
  const fixture=await watch.listWatchlist("demo",db);
  assert.ok(fixture.some(x=>x.tenant==="demo"&&x.domain==="demo.example"));
  assert.ok(!fixture.some(x=>x.tenant==="customer_one"));
 });
 const nodes=[
 {id:11,name:"ISP A",provider_name:"ISP A",is_active:true},
 {id:12,name:"ISP B",provider_name:"ISP B",is_active:true}
 ];
 const find=(id)=>({node_id:id,checker_type:"node:cellular",status:"blocked",reason:"HTTP 451 blocked",http_status:451});
 const retailer=(await db.query("SELECT * FROM domains WHERE domain='retail.example'")).rows[0];
 let officialCalls=0;
 await test("one customer node does not request official registry or change status",async()=>{
  const outcome=await watch.checkAfterNodeConsensus(retailer,[find(11)],nodes,{
   db,lookup:async()=>{officialCalls++;return{listed:true}}});
  assert.equal(outcome.confirmedBlocked,false);
  assert.equal(officialCalls,0);
 });
 await test("two customer ISP votes + exact official match, with tenant-scoped evidence",async()=>{
  const answer=await watch.checkAfterNodeConsensus(retailer,[find(11),find(12)],nodes,{
   db,lookup:async()=>{officialCalls++;return{listed:true,source:"synthetic-exact",verifiedAt:new Date()}}});
  assert.equal(answer.confirmedBlocked,true);
  assert.equal(answer.nodes.length,2);
  assert.equal(officialCalls,1);
  const row=(await db.query("SELECT * FROM trustpositif_domain_monitor WHERE tenant='customer_one' AND domain='retail.example'")).rows[0];
  assert.equal(row.listed,true);
 });
 await test("demo source never enters official verification",async()=>{
  const answer=await watch.checkAfterNodeConsensus({domain:"demo.example",tenant:"demo"},[find(11),find(12)],nodes,{
   db,lookup:async()=>{throw Error("DEMO_REGISTRY_FORBIDDEN")}});
  assert.equal(answer.confirmedBlocked,false);
  assert.equal(answer.triggered,false);
 });
 await test("customer alert and Telegram outbox use same tenant CAS",async()=>{
  const event=await outbox.enqueueTransition({
   domain:retailer,oldStatus:"unknown",newStatus:"blocked",eventType:"BLOCKED",
   message:"Synthetic customer example only",db});
  assert.equal(event.queued,true);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM trustpositif_notification_outbox")).rows[0].n,1);
  assert.equal((await outbox.deliverySummary("admin",db)).queued,1);
  assert.equal((await outbox.deliverySummary("customer_one",db)).queued,1);
  const activity=await outbox.recentNotificationLog("admin",db);
  assert.equal(activity[0].tenant,"customer_one");
  let sent=0;
  const delivery=await outbox.drainOutbox({db,sender:async()=>{sent++;return{outcome:"sent",messageId:"synthetic"}}});
  assert.equal(delivery.claimed,1);
  assert.equal(sent,1);
  assert.equal((await outbox.drainOutbox({db,sender:async()=>{throw Error("DUPLICATE")}})).claimed,0);
 });
 await test("monitor table is RLS protected in exposed public-compatible schemas",async()=>{
  const result=await db.query(
   "SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "+
   "WHERE c.relname='trustpositif_domain_monitor' AND n.nspname=current_schema()"
  );
  assert.equal(result.rows[0]?.relrowsecurity,true);
 });
 await test("demo and cross-tenant transition attempts cannot generate notifications",async()=>{
  const demoDomain=(await db.query("SELECT * FROM domains WHERE domain='demo-clash.example'")).rows[0];
  await assert.rejects(()=>outbox.enqueueTransition({
   domain:demoDomain,oldStatus:"unknown",newStatus:"blocked",eventType:"BLOCKED",message:"DO_NOT_SEND",db
  }),/INVALID_TRUSTPOSITIF_EVENT/);
  const mismatched={...retailer,tenant:"customer_two"};
  const refused=await outbox.enqueueTransition({
   domain:mismatched,oldStatus:"unknown",newStatus:"blocked",eventType:"BLOCKED",message:"DO_NOT_SEND",db
  });
  assert.equal(refused.queued,false);
 });
 await test("scoped worker and UI integration contract",async()=>{
  const fs=require("node:fs"),path=require("node:path");
  const scheduler=fs.readFileSync(path.join(__dirname,"../server/scheduler.js"),"utf8");
  const route=fs.readFileSync(path.join(__dirname,"../server/trustpositifRoutes.js"),"utf8");
  assert.match(scheduler,/syncEligibleCustomerWhitelist\(\)/);
  assert.match(scheduler,/NON_PRODUCTION_SQL/);
  assert.match(route,/customer_coverage/);
 });
 console.log("PENTAGON_CUSTOMER_WHITELIST_PG_PASS="+passed);
}finally{await db.end();}
}
main().catch(e=>{console.error("CUSTOMER_WHITELIST_TEST_FAILED="+e.stack);process.exitCode=1;});
