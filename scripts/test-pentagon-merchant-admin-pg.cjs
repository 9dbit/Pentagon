#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const express=require("express");
const {Pool}=require("pg");
const {createMerchantAdminRouter}=require("../server/merchantAdminRoutes");
const {customerViewerFirewall}=require("../server/customerViewerAuth");

const url=process.env.DATABASE_URL||"";
if(process.env.CI!=="true" || !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(url)){
  console.error("LOCAL_CI_POSTGRES_ONLY");process.exit(3);
}
const prior=process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
const tenant="merchant_fixture", email="merchant-fixture@example.test";
const grant=JSON.stringify([{email,tenant,role:"merchant_admin"}]);
process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=grant;
const db=new Pool({connectionString:url,ssl:false,options:"-c search_path=pentagon_merchant_ci,public"});
let server,passed=0;
function test(name,fn){return Promise.resolve().then(fn).then(()=>{passed++;console.log("PASS "+name);});}
async function main(){
  try{
    await db.query("CREATE SCHEMA IF NOT EXISTS pentagon_merchant_ci");
    await db.query("CREATE TABLE domains (id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,domain TEXT UNIQUE NOT NULL,project_name TEXT,label TEXT,is_active BOOLEAN DEFAULT TRUE,global_status TEXT DEFAULT 'unknown',last_checked_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW())");
    await db.query("CREATE TABLE rank_keyword_groups (id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,project_name TEXT,keyword TEXT,keyword_lc TEXT,is_active BOOLEAN DEFAULT TRUE,last_checked_at TIMESTAMPTZ,UNIQUE(keyword_lc,tenant))");
    await db.query("CREATE TABLE rank_keyword_domains (id SERIAL PRIMARY KEY,group_id INT REFERENCES rank_keyword_groups(id),domain TEXT,is_whitelisted BOOLEAN DEFAULT TRUE,last_position INT,last_page INT,last_status TEXT DEFAULT 'pending',last_checked_at TIMESTAMPTZ,UNIQUE(group_id,domain))");
    await db.query("CREATE TABLE provider_nodes (id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,provider_name TEXT,endpoint_url TEXT,secret_key TEXT,is_active BOOLEAN,last_health_status TEXT,last_ping_at TIMESTAMPTZ,network_type TEXT)");
    await db.query("CREATE TABLE node_telemetry (node_id INT PRIMARY KEY REFERENCES provider_nodes(id),last_seen_at TIMESTAMPTZ,ip TEXT,subscription_id INT,signal_level INT,signal_percent INT,signal_dbm INT,battery_percent INT,is_charging BOOLEAN,network_type_label TEXT)");
    await db.query("CREATE TABLE check_results (id SERIAL PRIMARY KEY,domain_id INT REFERENCES domains(id),provider_name TEXT,checker_type TEXT,status TEXT,checked_at TIMESTAMPTZ DEFAULT NOW(),latency_ms INT)");

    const own=(await db.query("INSERT INTO domains(tenant,domain,project_name,label) VALUES($1,'own.example','OWN','ms') RETURNING id",[tenant])).rows[0].id;
    const other=(await db.query("INSERT INTO domains(tenant,domain,project_name,label) VALUES('other_merchant','other.example','SECRET OTHER','ms') RETURNING id")).rows[0].id;
    const group=(await db.query("INSERT INTO rank_keyword_groups(tenant,keyword,keyword_lc,project_name) VALUES($1,'OWN KEYWORD','own keyword','OWN') RETURNING id",[tenant])).rows[0].id;
    const alienGroup=(await db.query("INSERT INTO rank_keyword_groups(tenant,keyword,keyword_lc,project_name) VALUES('other_merchant','OTHER SECRET','other secret','OTHER') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES($1,'own.example',TRUE),($2,'other.example',TRUE)",[group,alienGroup]);
    await db.query("INSERT INTO provider_nodes(tenant,provider_name,endpoint_url,secret_key,is_active,last_health_status,last_ping_at) VALUES('admin','ProviderPublic','https://private.example','SECRET_ADMIN_KEY',TRUE,'online',NOW()),('other_merchant','OtherOnly','https://other.example','SECRET_OTHER_KEY',TRUE,'online',NOW())");
    await db.query("INSERT INTO check_results(domain_id,provider_name,checker_type,status) VALUES($1,'ISP-ONE','node:isp','working'),($2,'OTHER SECRET','node:other','blocked')",[own,other]);
    const provider=(await db.query("SELECT id FROM provider_nodes WHERE provider_name='ProviderPublic'")).rows[0].id;
    await db.query(
      "INSERT INTO node_telemetry(node_id,last_seen_at,signal_level,signal_percent,signal_dbm,battery_percent,is_charging,network_type_label,ip,subscription_id) " +
      "VALUES($1,NOW()-INTERVAL '45 seconds',4,88,-75,84,TRUE,'LTE','10.0.0.44',777)",
      [provider]
    );


    const app=express();app.use(express.json());
    app.use((req,res,next)=>{
      const persona=req.headers["x-synthetic-role"];
      req.session=persona==="merchant"?{isCustomerViewer:true,isAdmin:false,isDemo:false,tenant,adminEmail:email}:
        persona==="viewer"?{isCustomerViewer:true,isAdmin:false,isDemo:false,tenant,adminEmail:email}:
        persona==="spoof"?{isCustomerViewer:true,isAdmin:false,isDemo:false,tenant:"other_merchant",adminEmail:email}:
        persona==="admin"?{isAdmin:true,tenant:"admin"}:null;
      next();
    });
    app.use("/api",customerViewerFirewall);
    app.use("/api/merchant",createMerchantAdminRouter(db));
    app.all("/api/overview",(req,res)=>res.json({secret:"platform"}));
    app.all("/api/nodes",(req,res)=>res.json({secret:"provider"}));
    server=app.listen(0,"127.0.0.1");
    await new Promise((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
    const base="http://127.0.0.1:"+server.address().port;
    async function request(path,{persona="merchant",method="GET",body,origin}={}){
      const headers={"x-synthetic-role":persona};
      if(body!==undefined) headers["content-type"]="application/json";
      if(origin) headers["origin"]=origin;
      const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      return {status:r.status,data:await r.json().catch(()=>({})),cache:r.headers.get("cache-control")};
    }
    await test("merchant reads only its own domain IDs",async()=>{
      const r=await request("/api/merchant/domains?tenant=other_merchant");
      assert.equal(r.status,200);
      assert.equal(r.data.length,1);
      assert.equal(r.data[0].domain,"own.example");
      assert.ok(!JSON.stringify(r.data).includes("SECRET OTHER"));
      assert.match(r.cache,/no-store/);
    });
    await test("foreign domain update never changes data",async()=>{
      const r=await request("/api/merchant/domains/"+other,{method:"PATCH",body:{project_name:"OWNED NOW",is_active:false}});
      assert.equal(r.status,404);
      const row=(await db.query("SELECT tenant,project_name,is_active FROM domains WHERE id=$1",[other])).rows[0];
      assert.equal(row.tenant,"other_merchant");
      assert.equal(row.project_name,"SECRET OTHER");
      assert.equal(row.is_active,true);
    });
    await test("merchant can edit and pause its own domain",async()=>{
      const r=await request("/api/merchant/domains/"+own,{method:"PATCH",body:{label:"landing_page",is_active:false}});
      assert.equal(r.status,200);
      assert.equal(r.data.is_active,false);
      assert.equal(r.data.label,"landing_page");
    });
    await test("cannot claim a domain owned by another merchant",async()=>{
      const r=await request("/api/merchant/domains",{method:"POST",body:{domain:"other.example",project_name:"Hijack",label:"ms"}});
      assert.equal(r.status,409);
      const row=(await db.query("SELECT tenant FROM domains WHERE domain='other.example'")).rows[0];
      assert.equal(row.tenant,"other_merchant");
    });
    await test("new domain receives server-side merchant tenant",async()=>{
      const r=await request("/api/merchant/domains",{method:"POST",body:{domain:"another.example",project_name:"OWN",label:"landing_page",tenant:"other_merchant"}});
      assert.equal(r.status,201);
      assert.equal(r.data.domain,"another.example");
      const row=(await db.query("SELECT tenant FROM domains WHERE domain='another.example'")).rows[0];
      assert.equal(row.tenant,tenant);
    });
    await test("keyword lists and mutations are scoped",async()=>{
      const r=await request("/api/merchant/keywords?tenant=other_merchant");
      assert.equal(r.status,200);
      assert.equal(r.data.length,1);
      assert.equal(r.data[0].keyword,"OWN KEYWORD");
      assert.deepEqual(r.data[0].whitelist,[{domain:"own.example",last_position:null,last_page:null,last_status:"pending",last_checked_at:null}]);
      assert.equal((await request("/api/merchant/keywords/"+alienGroup,{method:"PATCH",body:{keyword:"TAKEN"}})).status,404);
      assert.equal((await request("/api/merchant/keywords/"+group,{method:"PATCH",body:{is_active:false}})).status,200);
      const created=await request("/api/merchant/keywords",{method:"POST",body:{keyword:"New own keyword",tenant:"other_merchant"}});
      assert.equal(created.status,201);
      assert.equal((await db.query("SELECT tenant FROM rank_keyword_groups WHERE id=$1",[created.data.id])).rows[0].tenant,tenant);
    });
    await test("SERP report exposes each owned whitelist result without foreign results",async()=>{
      await db.query("INSERT INTO domains(tenant,domain) VALUES($1,'unranked.example'),($1,'pending.example')",[tenant]);
      await db.query("UPDATE rank_keyword_domains SET last_position=13,last_page=2,last_status='found',last_checked_at=NOW() WHERE group_id=$1",[group]);
      await db.query("INSERT INTO rank_keyword_domains(group_id,domain,last_status,last_checked_at) VALUES($1,'unranked.example','not_found',NOW()),($1,'pending.example','pending',NULL),($1,'other.example','found',NOW())",[group]);
      const r=await request("/api/merchant/keywords?tenant=other_merchant");
      const rows=r.data.find(x=>x.id===group).whitelist;
      assert.equal(rows.length,3);
      assert.equal(rows.find(x=>x.domain==='own.example').last_position,13);
      assert.equal(rows.find(x=>x.domain==='own.example').last_page,2);
      assert.ok(rows.find(x=>x.domain==='own.example').last_checked_at);
      assert.equal(rows.find(x=>x.domain==='unranked.example').last_status,'not_found');
      assert.equal(rows.find(x=>x.domain==='pending.example').last_checked_at,null);
      assert.ok(!JSON.stringify(rows).includes('other.example'));
    });
    await test("whitelist linking checks both group ownership and domain ownership",async()=>{
      assert.equal((await request("/api/merchant/keywords/"+group+"/whitelist",{method:"POST",body:{domain:"other.example"}})).status,404);
      assert.equal((await request("/api/merchant/keywords/"+alienGroup+"/whitelist",{method:"POST",body:{domain:"another.example"}})).status,404);
      const ok=await request("/api/merchant/keywords/"+group+"/whitelist",{method:"POST",body:{domain:"another.example"}});
      assert.equal(ok.status,201);
      assert.equal((await request("/api/merchant/keywords/"+alienGroup+"/whitelist/other.example",{method:"DELETE"})).status,404);
      assert.equal((await request("/api/merchant/keywords/"+group+"/whitelist/another.example",{method:"DELETE"})).status,200);
      const check=(await db.query("SELECT is_whitelisted FROM rank_keyword_domains WHERE group_id=$1 AND domain='other.example'",[alienGroup])).rows[0];
      assert.equal(check.is_whitelisted,true);
    });
    await test("nodes show aggregate health only and never secrets",async()=>{
      const r=await request("/api/merchant/nodes");
      assert.equal(r.status,200);
      assert.equal(r.data.length,1);
      assert.equal(r.data[0].provider_name,"ProviderPublic");
      assert.ok(!JSON.stringify(r.data).includes("SECRET"));
      assert.ok(!JSON.stringify(r.data).includes("endpoint_url"));
      assert.ok(!JSON.stringify(r.data).includes("subscription"));
      assert.ok(!JSON.stringify(r.data).includes("OtherOnly"));
    });
    await test("domain history is tenant-scoped and sanitised",async()=>{
      const r=await request("/api/merchant/history");
      assert.equal(r.status,200);
      assert.equal(r.data.length,1);
      assert.equal(r.data[0].domain,"own.example");
      assert.ok(!JSON.stringify(r.data).includes("OTHER SECRET"));
    });
    await test("legacy global admin routes remain inaccessible",async()=>{
      for(const [method,path] of [["GET","/api/overview"],["GET","/api/nodes"],["POST","/api/nodes"],["POST","/api/check/manual"]]){
        const r=await request(path,{method,body:method==="POST"?{}:undefined});
        assert.equal(r.status,403,method+" "+path);
      }
    });
    await test("viewer, spoof and anonymous rejected on merchant routes",async()=>{
      process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([{email,tenant,role:"customer_viewer"}]);
      assert.equal((await request("/api/merchant/domains",{persona:"viewer"})).status,403);
      process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=grant;
      assert.equal((await request("/api/merchant/domains",{persona:"spoof"})).status,403);
      assert.equal((await request("/api/merchant/domains",{persona:"admin"})).status,403);
      assert.equal((await request("/api/merchant/domains",{persona:"anonymous"})).status,403);
    });
    await test("foreign browser origin denied for writes",async()=>{
      const r=await request("/api/merchant/domains",{method:"POST",body:{domain:"evil.example"},origin:"https://evil.example"});
      assert.equal(r.status,403);
    });
    await test("per-node merchant telemetry returns sanitized public data",async()=>{
      const r=await request("/api/merchant/node-health");
      assert.equal(r.status,200);
      assert.match(r.cache,/no-store/);
      assert.equal(typeof r.data.as_of,"string");
      assert.ok(Array.isArray(r.data.nodes));
      assert.equal(r.data.nodes.length,1);
      const row=r.data.nodes[0];
      assert.equal(row.provider_name,"ProviderPublic");
      assert.equal(row.public_alias,"PROVIDERPUBLIC NODE 01");
      assert.equal(row.network_type,"4G LTE");
      assert.equal(row.is_active,true);
      assert.equal(row.connectivity,"online");
      assert.equal(row.signal_bars,5);
      assert.equal(row.signal_label,"Strong");
      assert.equal(row.battery_percent,84);
      assert.equal(row.is_charging,true);
      assert.equal(row.telemetry_fresh,true);
      const payload=JSON.stringify(r.data);
      for(const secret of ["SECRET_ADMIN_KEY","SECRET_OTHER_KEY","10.0.0.44","private.example","OtherOnly","node_id","subscription_id","endpoint_url","secret_key","\"id\"","\"name\"","\"tenant\""])
        assert.equal(payload.includes(secret),false,secret);
    });
    await test("node telemetry merchant scope cannot be forged",async()=>{
      assert.equal((await request("/api/merchant/node-health?tenant=other_merchant")).data.nodes.length,1);
      assert.equal((await request("/api/merchant/node-health",{persona:"spoof"})).status,403);
      assert.equal((await request("/api/merchant/node-health",{persona:"anonymous"})).status,403);
      process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([{email,tenant,role:"customer_viewer"}]);
      assert.equal((await request("/api/merchant/node-health",{persona:"viewer"})).status,403);
      process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=grant;
      assert.equal((await request("/api/merchant/node-health",{method:"POST",body:{is_active:false}})).status,405);
      assert.equal((await request("/api/nodes",{method:"POST",body:{is_active:false}})).status,403);
      assert.equal((await request("/api/merchant/node-health",{origin:"https://forged.example"})).status,403);
    });
    await test("stale heartbeat and inactive status not mislabeled online",async()=>{
      await db.query("UPDATE node_telemetry SET last_seen_at=NOW()-INTERVAL '20 minutes' WHERE node_id=$1",[provider]);
      const stale=(await request("/api/merchant/node-health")).data.nodes[0];
      assert.equal(stale.connectivity,"offline");
      assert.equal(stale.telemetry_fresh,false);
      assert.equal(stale.battery_percent,84);
      await db.query("UPDATE provider_nodes SET is_active=FALSE WHERE id=$1",[provider]);
      const inactive=(await request("/api/merchant/node-health")).data.nodes[0];
      assert.equal(inactive.connectivity,"inactive");
      assert.equal(inactive.is_active,false);
      await db.query("UPDATE provider_nodes SET is_active=TRUE WHERE id=$1",[provider]);
      await db.query("UPDATE node_telemetry SET last_seen_at=NOW()+INTERVAL '5 minutes' WHERE node_id=$1",[provider]);
      const future=(await request("/api/merchant/node-health")).data.nodes[0];
      assert.equal(future.connectivity,"unknown");
      assert.equal(future.telemetry_fresh,false);
      assert.equal(future.last_seen_at,null);
    });
    await test("missing signal and battery fields remain unknown, never fake data",async()=>{
      await db.query("UPDATE node_telemetry SET signal_level=NULL,signal_percent=NULL,signal_dbm=NULL,battery_percent=NULL,is_charging=NULL,last_seen_at=NOW()-INTERVAL '40 seconds' WHERE node_id=$1",[provider]);
      const row=(await request("/api/merchant/node-health")).data.nodes[0];
      assert.equal(row.signal_bars,null);
      assert.equal(row.signal_label,"Unknown");
      assert.equal(row.battery_percent,null);
      assert.equal(row.is_charging,null);
    });
    console.log("PENTAGON_MERCHANT_ADMIN_POSTGRES_PASS="+passed);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    await db.end();
    if(prior===undefined)delete process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
    else process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=prior;
  }
}
main().catch(error=>{console.error("MERCHANT_CI_FAILED="+error.stack);process.exitCode=1;});
