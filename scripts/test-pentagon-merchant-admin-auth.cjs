#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const security = require("../server/customerViewerAuth");
const email = "merchant-fixture@example.test";
const tenant = "fixture_merchant";
const prior = process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
const config = JSON.stringify([{ email, tenant, role: "merchant_admin" }]);
process.env.PENTAGON_CUSTOMER_VIEWERS_JSON = config;
let count = 0;
const session = { isCustomerViewer: true, isAdmin: false, isDemo: false, adminEmail: email, tenant };
function run(name, fn) { fn(); count++; console.log("PASS " + name); }
function firewall(sess, method, path, origin) {
  let code = 200, next = false, error;
  const req = { session: sess, method, path, baseUrl: "/api", headers: origin ? { origin } : {} };
  const res = { status(c) { code=c; return this; }, json(body) { error=body.error; return this; } };
  security.customerViewerFirewall(req,res,()=>{next=true;});
  return { code: next ? 200 : code, error };
}
function merchantGuard(sess) {
  let status=200, next=false, tenantFound=null;
  const req={session:sess};
  const res={status(c){status=c;return this;},json(){return this;}};
  security.requireMerchantAdmin(req,res,()=>{next=true;tenantFound=req.merchantTenant;});
  return {status:next?200:status,tenant:tenantFound};
}
try {
  run("explicit merchant role accepted, unknown role rejected", ()=>{
    assert.deepEqual(security.customerGrantForEmail(email),{email,tenant,role:"merchant_admin"});
    assert.equal(security.currentMerchantTenant(session),tenant);
    for (const role of ["admin","super_admin","editor","demo"]) {
      assert.equal(security.readCustomerViewers(JSON.stringify([{email,tenant,role}])).length,0);
    }
  });
  run("merchant privilege granted by live server-side mapping only", ()=>{
    assert.deepEqual(merchantGuard(session),{status:200,tenant});
    assert.equal(merchantGuard({...session,tenant:"other_merchant"}).status,403);
    assert.equal(merchantGuard({...session,isAdmin:true}).status,403);
    assert.equal(merchantGuard({...session,isDemo:true}).status,403);
    assert.equal(merchantGuard(null).status,403);
    assert.equal(merchantGuard({...session,adminEmail:"someone@example.test"}).status,403);
  });
  run("merchant route allowed; legacy platform administration still blocked", ()=>{
    for(const [method,path] of [
      ["GET","/merchant/domains"],["POST","/merchant/domains"],
      ["PATCH","/merchant/domains/12"],["GET","/merchant/nodes"],
      ["POST","/merchant/keywords/12/whitelist"],["DELETE","/merchant/keywords/12/whitelist/example.test"],
      ["GET","/customer/overview"],["GET","/auth/me"]
    ]) assert.equal(firewall(session,method,path).code,200,method+" "+path);
    for(const [method,path] of [
      ["GET","/domains"],["GET","/nodes"],["GET","/settings"],["GET","/api/rank/keywords"],
      ["GET","/auth/users"],["POST","/check/manual"],["POST","/telegram/test"],
      ["POST","/nodes"],["PATCH","/projects/demo"],["POST","/project-telegram"],
      ["GET","/activity/sessions"]
    ]) assert.equal(firewall(session,method,path).code,403,method+" "+path);
  });
  run("viewer cannot enter merchant routes", ()=>{
    process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([{email,tenant,role:"customer_viewer"}]);
    assert.equal(security.currentMerchantTenant(session),null);
    assert.equal(firewall(session,"GET","/merchant/domains").code,403);
    assert.equal(merchantGuard(session).status,403);
    assert.equal(firewall(session,"GET","/customer/domains").code,200);
    process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=config;
  });
  run("merchant session immediately loses admin rights if grant revoked", ()=>{
    process.env.PENTAGON_CUSTOMER_VIEWERS_JSON="[]";
    assert.equal(firewall(session,"GET","/merchant/nodes").code,403);
    assert.equal(firewall(session,"GET","/customer/overview").code,403);
    assert.equal(merchantGuard(session).status,403);
    process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=config;
  });
  run("strict browser-origin restrictions include exact standby hostname", ()=>{
    assert.equal(firewall(session,"GET","/merchant/domains","https://pentagon-hot-standby.onrender.com").code,200);
    assert.equal(firewall(session,"POST","/merchant/domains","https://pentagon.quest").code,200);
    for(const origin of ["https://evil.example.test","https://pentagon-hot-standby.onrender.com.evil.test","null","http://pentagon.quest"])
      assert.equal(firewall(session,"POST","/merchant/domains",origin).code,403);
  });
  run("no plaintext, cross-tenant or external role claims in code", ()=>{
    const fs=require("node:fs"),path=require("node:path");
    const routes=fs.readFileSync(path.join(__dirname,"../server/merchantAdminRoutes.js"),"utf8");
    const ui=fs.readFileSync(path.join(__dirname,"../src/MerchantAdminPage.jsx"),"utf8");
    assert.match(routes,/requireMerchantAdmin/);
    assert.match(routes,/tenant=\$1/);
    assert.match(routes,/ownTenant\(req\)/);
    assert.ok(!ui.includes('"/api/nodes"')&&!ui.includes('"/api/settings"'));
    assert.match(ui,/Node Health/);
  });
  console.log("PENTAGON_MERCHANT_ADMIN_AUTH_PASS="+count);
} finally {
  if (prior === undefined) delete process.env.PENTAGON_CUSTOMER_VIEWERS_JSON;
  else process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=prior;
}
