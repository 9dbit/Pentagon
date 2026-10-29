#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const express=require("express");
const {Pool}=require("pg");
const {createCustomerViewerRouter}=require("../server/customerViewerRoutes");
const {customerViewerFirewall}=require("../server/customerViewerAuth");

const url=process.env.DATABASE_URL||"";
if(process.env.CI!=="true" || !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(url)){
  console.error("LOCAL_CI_POSTGRES_ONLY");process.exit(3);
}
const db=new Pool({connectionString:url,ssl:false,options:"-c search_path=pentagon_customer_viewer_ci,public"});
const prior=process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
const fixtureEmail="viewer.fixture@example.test";
const tenant="fixture_wisnu";
process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([{email:fixtureEmail,tenant,role:"customer_viewer"}]);
let server,passed=0;
function test(name,fn){return Promise.resolve().then(fn).then(()=>{passed++;console.log("PASS "+name);});}
async function main(){
 try {
  await db.query("CREATE SCHEMA IF NOT EXISTS pentagon_customer_viewer_ci");
  await db.query("CREATE TABLE domains (id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,domain TEXT UNIQUE NOT NULL,project_name TEXT,label TEXT,is_active BOOLEAN DEFAULT TRUE,global_status TEXT DEFAULT 'unknown',last_checked_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW())");
  await db.query("CREATE TABLE rank_keyword_groups (id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,project_name TEXT,keyword TEXT,is_active BOOLEAN DEFAULT TRUE,last_checked_at TIMESTAMPTZ)");
  await db.query("CREATE TABLE rank_keyword_domains (id SERIAL PRIMARY KEY,group_id INTEGER REFERENCES rank_keyword_groups(id),domain TEXT,is_whitelisted BOOLEAN DEFAULT TRUE,last_position INT,last_page INT,last_status TEXT DEFAULT 'pending',last_checked_at TIMESTAMP)");
  await db.query("CREATE TABLE alerts (id SERIAL PRIMARY KEY,domain_id INTEGER REFERENCES domains(id),created_at TIMESTAMPTZ DEFAULT NOW(),old_status TEXT,new_status TEXT,message TEXT)");

  const ids=[];
  for(let i=0;i<5;i++){
    const r=(await db.query("INSERT INTO domains(tenant,domain,project_name,label,is_active,global_status) VALUES($1,$2,'WISNU FIXTURE',$3,TRUE,'unknown') RETURNING id",
      [tenant,"client-"+i+".example",i===0?"ms":"landing_page"])).rows[0];
    ids.push(r.id);
  }
  await db.query("INSERT INTO domains(tenant,domain,project_name,label) VALUES('demo','demo.example','Demo','ms'),('other_client','other.example','Other','ms')");
  for(const keyword of ["BRAND","BRAND LOGIN","BRAND REGISTER","BRAND BONUS","BRAND INFO"]){
    const g=(await db.query("INSERT INTO rank_keyword_groups(tenant,project_name,keyword) VALUES($1,'WISNU FIXTURE',$2) RETURNING id",[tenant,keyword])).rows[0];
    for(let i=0;i<5;i++)await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES($1,$2,TRUE)",[g.id,"client-"+i+".example"]);
  }
  for(const [owner,host] of [["demo","demo.example"],["other_client","other.example"]]){
    const g=(await db.query("INSERT INTO rank_keyword_groups(tenant,project_name,keyword) VALUES($1,'Not client','SECRET KEYWORD') RETURNING id",[owner])).rows[0];
    await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES($1,$2,TRUE)",[g.id,host]);
  }
  const demoDomain=(await db.query("SELECT id FROM domains WHERE tenant='demo'")).rows[0].id;
  await db.query("INSERT INTO alerts(domain_id,old_status,new_status,message) VALUES($1,'unknown','warning','own client alert')",[ids[0]]);
  await db.query("INSERT INTO alerts(domain_id,old_status,new_status,message) VALUES($1,'unknown','blocked','other tenant secret')",[demoDomain]);

  const viewer={isCustomerViewer:true,isAdmin:false,isDemo:false,adminEmail:fixtureEmail,tenant};
  const app=express();
  // Synthetic test-only injection. Production uses signed express-session.
  app.use((req,res,next)=>{
    const sample=req.headers["x-synthetic-auth"];
    req.session=sample==="viewer"?{...viewer}:sample==="spoof"?{...viewer,tenant:"demo"}:
      sample==="admin"?{isAdmin:true,tenant:"admin"}:null;
    next();
  });
  app.use("/api",customerViewerFirewall);
  app.use("/api/customer",createCustomerViewerRouter(db));
  app.get("/api/overview",(req,res)=>res.json({sensitive:true}));
  server=app.listen(0,"127.0.0.1");
  await new Promise((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
  const base="http://127.0.0.1:"+server.address().port;
  async function request(path,auth="viewer",method="GET"){
    const r=await fetch(base+path,{method,headers:{"x-synthetic-auth":auth}});
    const data=await r.json().catch(()=>({}));
    return {status:r.status,data,cache:r.headers.get("cache-control")};
  }
  await test("customer summary matches five domains and 25 whitelist links",async()=>{
    const r=await request("/api/customer/overview");
    assert.equal(r.status,200);
    assert.equal(r.data.total,5);
    assert.equal(r.data.active,5);
    assert.equal(r.data.unknown,5);
    assert.equal(r.data.keywords,5);
    assert.equal(r.data.whitelist_links,25);
    assert.equal(r.data.blocked,0);
    assert.equal(r.data.tenant,tenant);
    assert.match(r.cache,/no-store/);
  });
  await test("query tenant override is ignored for domains",async()=>{
    const r=await request("/api/customer/domains?tenant=demo");
    assert.equal(r.status,200);
    assert.equal(r.data.length,5);
    assert.equal(r.data[0].label,"ms");
    assert.ok(r.data.every(x=>x.domain.endsWith(".example")&&!x.domain.includes("demo")));
    assert.ok(!r.data.some(x=>"secret_key" in x));
  });
  await test("five keyword groups each show only five matching customer domains",async()=>{
    const r=await request("/api/customer/keywords?tenant=other_client");
    assert.equal(r.status,200);
    assert.equal(r.data.length,5);
    assert.ok(r.data.every(x=>x.whitelisted_domains===5));
    assert.ok(!r.data.some(x=>x.keyword==="SECRET KEYWORD"));
  });
  await test("viewer SERP rows preserve all owned domains and reject cross-tenant links",async()=>{
    const group=(await db.query("SELECT id FROM rank_keyword_groups WHERE tenant=$1 ORDER BY id LIMIT 1",[tenant])).rows[0].id;
    await db.query("UPDATE rank_keyword_domains SET last_position=23,last_page=3,last_status='found',last_checked_at=TIMESTAMP '2026-10-29 09:38:46' WHERE group_id=$1 AND domain='client-0.example'",[group]);
    await db.query("UPDATE rank_keyword_domains SET last_status='not_found',last_checked_at=NOW() WHERE group_id=$1 AND domain='client-1.example'",[group]);
    await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted,last_position,last_page,last_status,last_checked_at) VALUES($1,'other.example',TRUE,1,1,'found',NOW())",[group]);
    const r=await request("/api/customer/keywords?tenant=other_client");
    const rows=r.data.find(x=>x.keyword==='BRAND').whitelist;
    assert.equal(rows.length,5);
    assert.equal(rows.find(x=>x.domain==='client-0.example').last_position,23);
    assert.equal(rows.find(x=>x.domain==='client-0.example').last_page,3);
    const checkedAt=rows.find(x=>x.domain==='client-0.example').last_checked_at;
    assert.match(checkedAt,/(?:Z|[+]00:00)$/);
    assert.equal(new Date(checkedAt).toISOString(),'2026-10-29T09:38:46.000Z');
    assert.equal(rows.find(x=>x.domain==='client-1.example').last_status,'not_found');
    assert.equal(rows.find(x=>x.domain==='client-2.example').last_checked_at,null);
    assert.ok(!JSON.stringify(rows).includes('other.example'));
  });
  await test("alerts do not expose another tenant or freeform sensitive message",async()=>{
    const r=await request("/api/customer/alerts");
    assert.equal(r.status,200);
    assert.equal(r.data.length,1);
    assert.equal(r.data[0].domain,"client-0.example");
    assert.ok(!JSON.stringify(r.data).includes("other tenant secret"));
    assert.ok(!("message" in r.data[0]));
  });
  await test("unauthenticated customer endpoints deny without disclosing rows",async()=>{
    for(const path of ["/api/customer/overview","/api/customer/domains","/api/customer/keywords","/api/customer/alerts"]){
      const r=await request(path,"unauthenticated");
      assert.equal(r.status,401,path);
    }
  });
  await test("spoofed tenant and admin sessions cannot become customer viewers",async()=>{
    assert.equal((await request("/api/customer/domains","spoof")).status,403);
    assert.equal((await request("/api/customer/domains","admin")).status,401);
  });
  await test("mutations, admin API, and unrecognized customer paths blocked",async()=>{
    for(const [method,path] of [
      ["POST","/api/customer/domains"],["DELETE","/api/customer/domains"],
      ["POST","/api/check/manual"],["POST","/api/telegram/test"],
      ["GET","/api/overview"],["GET","/api/customer/export"]
    ])assert.equal((await request(path,"viewer",method)).status,403);
  });
  await test("mapping revoke takes effect for existing customer session",async()=>{
    process.env.PENTAGON_CUSTOMER_VIEWERS_JSON="[]";
    assert.equal((await request("/api/customer/overview")).status,403);
    process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([{email:fixtureEmail,tenant,role:"customer_viewer"}]);
    assert.equal((await request("/api/customer/overview")).status,200);
  });
  console.log("PENTAGON_CUSTOMER_VIEWER_POSTGRES_PASS="+passed);
 } finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  await db.end();
  if(prior===undefined)delete process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
  else process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=prior;
 }
}
main().catch(e=>{console.error("VIEWER_CI_FAILED="+e.stack);process.exitCode=1;});
