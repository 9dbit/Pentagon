#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {scryptSync}=require("node:crypto");
const {verifyTestUser}=require("../server/testAccountAuth");
const security=require("../server/customerViewerAuth");
let total=0;
function test(name,fn){fn();total++;console.log("PASS "+name);}
const email="viewer.fixture@example.test";
const tenant="customer_fixture";
const config=JSON.stringify([{email,tenant,role:"customer_viewer"}]);
const old=process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=config;
const viewer={isCustomerViewer:true,isAdmin:false,isDemo:false,adminEmail:email,tenant};
function checkFirewall(session,method,path,origin){
  let result="allowed",next=false;
  const req={session,method,path,baseUrl:"/api",headers:origin?{origin}:{}};
  const res={status(code){result=code;return this;},json(body){return body;}};
  security.customerViewerFirewall(req,res,()=>{next=true;});
  return next?200:result;
}
function checkViewer(session,method){
 let code=200,allowed=false;
 const req={session,method};
 const res={status(value){code=value;return this;},json(body){return body;}};
 security.requireCustomerViewer(req,res,()=>{allowed=true;});
 return {code,allowed,tenant:req.viewerTenant};
}
try{
test("explicit scoped binding works",()=>{
 assert.equal(security.readCustomerViewers(config).length,1);
 assert.equal(security.customerTenantForEmail(email.toUpperCase()),tenant);
 assert.equal(security.currentViewerTenant(viewer),tenant);
});
test("fail closed absent, malformed and oversized binding",()=>{
 for(const value of ["","{"," ".repeat(12000),JSON.stringify({email,tenant})])
  assert.equal(security.readCustomerViewers(value).length,0);
});
test("reject demo or unauthorized tenant roles",()=>{
 for(const value of ["demo","demo_foo","test","staging-blue","sandbox_2","admin/other","Customer Upper"])
  assert.equal(security.readCustomerViewers(JSON.stringify([{email,tenant:value,role:"customer_viewer"}])).length,0);
 for(const role of ["admin","demo","editor",null])
  assert.equal(security.readCustomerViewers(JSON.stringify([{email,tenant,role}])).length,0);
});
test("reject plaintext, hashes and duplicate accounts in role bindings",()=>{
 for(const extra of [{password:"secret"},{hash:"secret"},{salt:"secret"}])
  assert.equal(security.readCustomerViewers(JSON.stringify([{email,tenant,role:"customer_viewer",...extra}])).length,0);
 assert.equal(security.readCustomerViewers(JSON.stringify([{email,tenant,role:"customer_viewer"},{email:email.toUpperCase(),tenant,role:"customer_viewer"}])).length,0);
});
test("session with isAdmin or isDemo cannot become viewer",()=>{
 assert.equal(security.currentViewerTenant({...viewer,isAdmin:true}),null);
 assert.equal(security.currentViewerTenant({...viewer,isDemo:true}),null);
 assert.equal(security.currentViewerTenant({...viewer,tenant:"other_customer"}),null);
 assert.equal(security.currentViewerTenant({...viewer,adminEmail:"wrong@example.test"}),null);
});
test("GET allowlist permits only protected customer reads",()=>{
 for(const path of ["/customer/overview","/customer/domains","/customer/keywords","/customer/alerts"])
  assert.equal(checkFirewall(viewer,"GET",path),200,path);
 assert.equal(checkFirewall(viewer,"GET","/auth/me"),200);
 assert.equal(checkFirewall(viewer,"POST","/auth/logout"),200);
});
test("all admin, checker, export and mutation APIs blocked",()=>{
 for(const [method,path] of [
  ["GET","/overview"],["GET","/domains"],["GET","/alerts"],["GET","/settings"],
  ["GET","/project-telegram"],["GET","/rank/keywords"],["GET","/nodes"],
  ["GET","/rank/sync-lp-ms"],["GET","/export/domains.csv"],["GET","/auth/users"],
  ["POST","/check/manual"],["POST","/check/domain/1"],["POST","/telegram/test"],
  ["POST","/activity/heartbeat"],["PATCH","/domains/1"],["POST","/customer/domains"],
  ["DELETE","/domains/1"],["GET","/customer/unknown"]])
   assert.equal(checkFirewall(viewer,method,path),403,method+" "+path);
});
test("untrusted browser origins cannot read viewer session data",()=>{
 assert.equal(checkFirewall(viewer,"GET","/customer/domains","https://attacker.example"),403);
 assert.equal(checkFirewall(viewer,"GET","/customer/domains","null"),403);
 assert.equal(checkFirewall(viewer,"GET","/customer/domains","https://pentagon.quest"),200);
 assert.equal(checkFirewall(viewer,"GET","/customer/domains","https://www.pentagon.quest"),200);
});
test("revoking server mapping invalidates existing viewer session without logout",()=>{
 process.env.PENTAGON_CUSTOMER_VIEWERS_JSON="[]";
 assert.equal(checkFirewall(viewer,"GET","/customer/domains"),403);
 assert.equal(checkFirewall(viewer,"GET","/auth/me"),200);
 assert.equal(checkFirewall(viewer,"POST","/auth/logout"),200);
 assert.equal(security.currentViewerTenant(viewer),null);
 process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=config;
});
test("unauthenticated, nonviewer and stale tenant claims are refused",()=>{
 assert.equal(checkViewer(null,"GET").code,401);
 assert.equal(checkViewer({isAdmin:true,tenant}, "GET").code,401);
 assert.equal(checkViewer({...viewer,tenant:"demo"},"GET").code,403);
 assert.equal(checkViewer(viewer,"POST").code,405);
 assert.deepEqual(checkViewer(viewer,"GET"),{code:200,allowed:true,tenant});
});
test("customer roles require existing strong salted test-account credentials",()=>{
 const password="Synthetic-Secure-Only-Password-For-CI";
 const salt=Buffer.alloc(16,0x3d);
 const hash=scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
 const entry={email,role:"demo",saltHex:salt.toString("hex"),hashHex:hash.toString("hex")};
 assert.ok(verifyTestUser(email,password,JSON.stringify([entry])));
 assert.equal(verifyTestUser(email,"wrong",JSON.stringify([entry])),null);
 assert.equal(security.customerTenantForEmail(email),tenant);
});
test("frontend and server use separate read-only viewer route",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const source=fs.readFileSync(path.join(__dirname,"../server/index.js"),"utf8");
 const app=fs.readFileSync(path.join(__dirname,"../src/App.jsx"),"utf8");
 const ui=fs.readFileSync(path.join(__dirname,"../src/CustomerViewerPage.jsx"),"utf8");
 const style=fs.readFileSync(path.join(__dirname,"../src/CustomerViewerPage.css"),"utf8");
 assert.match(source,/app\.use\("\/api", customerViewerFirewall\)/);
 assert.match(source,/app\.use\("\/api\/customer", createCustomerViewerRouter\(\)\)/);
 assert.match(source,/req\.session\.regenerate/);
 assert.match(source,/req\.session\.isAdmin = false/);
 assert.match(app,/if\(isCustomerViewer\) return <CustomerViewerPage/);
 assert.ok(!ui.includes("/api/settings")&&!ui.includes("/api/nodes")&&!ui.includes("/api/rank/"));
 assert.match(style,/@media\(max-width:620px\)/);
 assert.match(style,/@media\(max-width:340px\)/);
});
console.log("PENTAGON_CUSTOMER_VIEWER_AUTH_PASS="+total);
}finally {
 if(old===undefined)delete process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
 else process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=old;
}
