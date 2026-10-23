#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const express=require("express");
const {publicIpv4}=require("../server/merchantDirectChecker");
const {createMerchantOperationsRouter}=require("../server/merchantOperationsRoutes");
const previous=process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([{email:"merchant-fixture@example.test",tenant:"fixture",role:"merchant_admin"}]);
let calls=[];
let setting=null;
const db={async query(sql,args=[]){
  calls.push({sql,args});
  if(sql.startsWith("SELECT value FROM app_settings"))return {rows:setting?[{value:setting}]:[]};
  if(sql.startsWith("INSERT INTO app_settings")){setting=args[1];return {rows:[]};}
  if(sql.includes("COUNT(DISTINCT r.provider_name)"))return {rows:[{id:1,domain:"own.example",global_status:"unknown",recent_node_providers:0}]};
  if(sql.includes("FROM trustpositif_checks"))return {rows:[]};
  if(sql.includes("COUNT(*)::int AS total"))return {rows:[{total:1,active:1}]};
  if(sql.includes("FROM domains d LEFT JOIN LATERAL"))return {rows:[{domain:"own.example",status:null,is_active:true,checked_at:null}]};
  if(sql.includes("FROM domains WHERE tenant="))return {rows:[]};
  return {rows:[]};
}};
let passed=0;
function test(name,fn){return Promise.resolve().then(fn).then(()=>{passed++;console.log("PASS "+name);});}
async function main(){
  await test("Private IPv4 and DNS targets are refused",()=>{
    for(const x of ["127.0.0.1","10.0.1.1","172.16.10.10","192.168.1.1","169.254.1.1","100.100.1.1","192.0.2.2","198.18.0.2","198.51.100.4","203.0.113.8","224.0.0.1","not-ip","999.999.2.1"])
      assert.equal(publicIpv4(x),false,x);
    assert.equal(publicIpv4("8.8.8.8"),true);
  });
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{
    const p=req.headers["x-persona"];
    req.session=p==="viewer"?{isCustomerViewer:true,isAdmin:false,adminEmail:"viewer-fixture@example.test",tenant:"fixture"}:
      p==="merchant"?{isCustomerViewer:true,isAdmin:false,isDemo:false,adminEmail:"merchant-fixture@example.test",tenant:"fixture"}:
      {isAdmin:false};next();
  });
  app.use("/api/merchant",createMerchantOperationsRouter(db));
  const server=app.listen(0,"127.0.0.1");
  try{
    await new Promise(r=>server.once("listening",r));
    const base="http://127.0.0.1:"+server.address().port;
    async function request(url,{method="GET",body,persona="merchant"}={}){
      const res=await fetch(base+url,{method,headers:{"x-persona":persona,...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
      return {status:res.status,data:await res.json().catch(()=>({}))};
    }
    await test("Unauthorized viewer cannot manage merchant operations",async()=>{
      for(const path of ["/api/merchant/telegram","/api/merchant/trust-positif","/api/merchant/direct-checker"])
        assert.equal((await request(path,{persona:"viewer"})).status,403);
    });
    await test("Trust Positif summary is tenant-scoped and conservative",async()=>{
      const r=await request("/api/merchant/trust-positif?tenant=admin");
      assert.equal(r.status,200);
      assert.equal(r.data.domains[0].domain,"own.example");
      assert.equal(r.data.domains[0].sufficient_independent_nodes,false);
      assert.ok(calls.some(c=>c.sql.includes("d.tenant=$1")&&c.args[0]==="fixture"));
    });
    await test("Direct Checker is own-domain read-only until an authorized check",async()=>{
      const g=await request("/api/merchant/direct-checker");
      assert.equal(g.status,200);
      assert.equal(g.data.domains[0].status,"not_checked");
      assert.equal((await request("/api/merchant/direct-checker/run",{method:"POST",body:{domain:"other.example",tenant:"fixture"}})).status,404);
    });
    await test("Telegram settings default off; tenant-keyed and test requires opt-in",async()=>{
      const read=await request("/api/merchant/telegram");
      assert.equal(read.status,200);assert.equal(read.data.enabled,false);
      assert.equal((await request("/api/merchant/telegram/test",{method:"POST",body:{}})).status,409);
      assert.equal((await request("/api/merchant/telegram",{method:"PATCH",body:{enabled:true,chat_id:"bad"}})).status,400);
      assert.equal((await request("/api/merchant/telegram",{method:"PATCH",body:{enabled:true,chat_id:"-100123456789"}})).status,200);
      assert.equal((await request("/api/merchant/telegram")).data.chat_id,"-100123456789");
      assert.ok(calls.some(c=>c.sql.startsWith("INSERT INTO app_settings")&&c.args[0]==="merchant_telegram_fixture"));
    });
    await test("Read-only trust/checker and malformed methods reject",async()=>{
      assert.equal((await request("/api/merchant/trust-positif",{method:"POST",body:{}})).status,405);
      assert.equal((await request("/api/merchant/direct-checker",{method:"POST",body:{}})).status,405);
    });
    console.log("PENTAGON_MERCHANT_OPS_PASS="+passed);
  }finally{
    await new Promise(r=>server.close(r));
    if(previous===undefined)delete process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
    else process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=previous;
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
