#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {Pool}=require("pg");
const {auditWhitelistReadiness}=require("../server/trustpositifReadiness");

if (process.env.CI !== "true" ||
  !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(process.env.DATABASE_URL||"")) {
  console.error("LOCAL_ISOLATED_POSTGRES_ONLY");
  process.exit(3);
}
const db=new Pool({
  connectionString:process.env.DATABASE_URL,ssl:false,
  options:"-c search_path=trustpositif_readiness_ci,public"
});
let passed=0;
async function test(name,fn){await fn();passed++;console.log("PASS "+name);}
async function addDomain(domain,tenant,active){
  return db.query("INSERT INTO domains(domain,tenant,is_active) VALUES($1,$2,$3)",[domain,tenant,active]);
}
async function run() {
try {
  await db.query("CREATE SCHEMA IF NOT EXISTS trustpositif_readiness_ci");
  await db.query("CREATE TABLE domains (id SERIAL PRIMARY KEY,domain TEXT UNIQUE NOT NULL,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE)");
  await db.query("CREATE TABLE rank_keyword_groups (id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE)");
  await db.query("CREATE TABLE rank_keyword_domains (id SERIAL PRIMARY KEY,group_id INTEGER REFERENCES rank_keyword_groups(id),domain TEXT NOT NULL,is_whitelisted BOOLEAN DEFAULT TRUE)");
  await db.query("CREATE TABLE provider_nodes (id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,provider_name TEXT,is_active BOOLEAN DEFAULT TRUE,last_health_status TEXT,last_ping_at TIMESTAMPTZ)");

  await addDomain("demo.example","demo",true);
  await test("demo sandbox is never assumed to be active admin monitoring",async()=>{
    const r=await auditWhitelistReadiness(db);
    assert.equal(r.domains.active,0);
    assert.equal(r.whitelist.valid_distinct,0);
    assert.equal(r.reason,"no_approved_admin_domain");
    assert.equal(r.read_only,true);
  });
  const group=(await db.query("INSERT INTO rank_keyword_groups(tenant,is_active) VALUES('admin',TRUE) RETURNING id")).rows[0].id;
  await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES($1,'alpha.example',TRUE)",[group]);
  await addDomain("alpha.example","demo",true);
  await test("cross-tenant occupied host is review-only, never reassigned",async()=>{
    const r=await auditWhitelistReadiness(db);
    assert.equal(r.whitelist.cross_tenant_conflicts,1);
    assert.equal(r.whitelist.valid_distinct,1);
    assert.equal(r.whitelist.unimported,0);
    assert.equal(r.reason,"review_cross_tenant_conflicts");
    assert.equal((await db.query("SELECT tenant FROM domains WHERE domain='alpha.example'")).rows[0].tenant,"demo");
  });
  await db.query("UPDATE rank_keyword_domains SET is_whitelisted=FALSE WHERE domain='alpha.example'");
  await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES($1,'beta.example',TRUE)",[group]);
  await test("eligible rank whitelist without domain master import is visible as pending",async()=>{
    const r=await auditWhitelistReadiness(db);
    assert.equal(r.whitelist.whitelisted_rows,1);
    assert.equal(r.whitelist.valid_distinct,1);
    assert.equal(r.whitelist.unimported,1);
    assert.equal(r.reason,"eligible_rank_whitelist_pending_sync");
  });
  await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES($1,'https://bad.example/path',TRUE)",[group]);
  await test("invalid URL-style whitelist entries are not silently imported",async()=>{
    const r=await auditWhitelistReadiness(db);
    assert.equal(r.whitelist.invalid_names,1);
    assert.equal(r.whitelist.valid_distinct,1);
  });
  await addDomain("beta.example","admin",false);
  await test("explicitly disabled admin domain stays disabled",async()=>{
    const r=await auditWhitelistReadiness(db);
    assert.equal(r.domains.inactive,1);
    assert.equal(r.whitelist.admin_inactive,1);
    assert.equal(r.reason,"admin_domains_disabled");
    assert.equal((await db.query("SELECT is_active FROM domains WHERE domain='beta.example'")).rows[0].is_active,false);
  });
  await db.query("UPDATE domains SET is_active=TRUE WHERE domain='beta.example'");
  await db.query("INSERT INTO provider_nodes(tenant,provider_name,is_active,last_health_status,last_ping_at) VALUES('admin','ISP A',TRUE,'online',NOW()),('admin',' isp a ',TRUE,'online',NOW())");
  await test("two online node IDs from the same ISP are not independent",async()=>{
    const r=await auditWhitelistReadiness(db);
    assert.equal(r.nodes.online_recent,2);
    assert.equal(r.nodes.online_independent_providers,1);
    assert.equal(r.reason,"waiting_two_healthy_independent_providers");
  });
  await db.query("UPDATE provider_nodes SET provider_name='ISP B' WHERE id=2");
  await test("two independent healthy provider identities meet preflight",async()=>{
    const r=await auditWhitelistReadiness(db);
    assert.equal(r.nodes.online_independent_providers,2);
    assert.equal(r.domains.active,1);
    assert.equal(r.reason,"ready_to_scan");
  });
  await test("preflight SELECTs cannot create domains, remove demo data or activate rows",async()=>{
    const before=(await db.query("SELECT COUNT(*)::int n FROM domains")).rows[0].n;
    await auditWhitelistReadiness(db);await auditWhitelistReadiness(db);
    const after=(await db.query("SELECT COUNT(*)::int n FROM domains")).rows[0].n;
    assert.equal(before,after);
    assert.equal((await db.query("SELECT COUNT(*)::int n FROM domains WHERE tenant='demo'")).rows[0].n,2);
  });
  await test("non-admin tenant is explicitly rejected",async()=>{
    await assert.rejects(()=>auditWhitelistReadiness(db,"demo"),/ADMIN_TENANT_REQUIRED/);
  });
  console.log("PENTAGON_TRUSTPOSITIF_READINESS_PG_PASS="+passed);
}finally{await db.end();}
}
run().catch(e=>{console.error("READINESS_TEST_FAIL="+e.stack);process.exitCode=1;});
