#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const m=require("../server/migrationSafety");
let n=0;
function t(name,fn){try{fn();n++;}catch(e){throw Error(name+": "+e.message);}}
const good={PENTAGON_FLEET_SAFE_SCHEMA_READY:"true",PENTAGON_ACTIVE_FLEET:"domain-radar"};
const req={session:{isAdmin:true,tenant:"admin"},body:{tenant:"demo",fleet:"pentagon"},query:{fleet:"pentagon"}};
t("server scope not client scope",()=>assert.deepEqual(m.resolveAuthenticatedScope(req,good),{tenant:"admin",fleet:"domain-radar"}));
for(const cfg of [{...good,PENTAGON_FLEET_SAFE_SCHEMA_READY:"false"},{...good,PENTAGON_ACTIVE_FLEET:""},{...good,PENTAGON_ACTIVE_FLEET:"unsafe"}])
t("reject disabled or unknown fleet",()=>assert.throws(()=>m.resolveAuthenticatedScope(req,cfg)));
for(const session of [null,{}, {tenant:"admin"}, {tenant:"admin",isAdmin:false},{tenant:"unknown",isAdmin:true}])
t("reject unauthenticated session",()=>assert.throws(()=>m.resolveAuthenticatedScope({session},good)));
t("demo scope preserved",()=>assert.equal(m.resolveAuthenticatedScope({session:{isAdmin:true,tenant:"demo"}},good).tenant,"demo"));
for(const name of ["domainCreate","domainBulk"]){
t(name+" composite conflict",()=>assert.match(m.SQL[name],/ON CONFLICT \(tenant, fleet, \(lower\(btrim\(domain\)\)\)\)/));
t(name+" scoped update",()=>assert.match(m.SQL[name],/domains\.tenant=EXCLUDED\.tenant AND domains\.fleet=EXCLUDED\.fleet/));
}
for(const name of ["domainPatch","domainDelete","domainCheckLookup"]){
t(name+" scoped by tenant and fleet",()=>{assert.match(m.SQL[name],/tenant=\$\d/);assert.match(m.SQL[name],/fleet=\$\d/);});
}
t("task claim skips legacy",()=>{assert.match(m.SQL.taskClaim,/execution_allowed IS TRUE AND dispatch_token IS NOT NULL/);assert.match(m.SQL.taskClaim,/FOR UPDATE SKIP LOCKED/);});
t("task completion requires claimed",()=>assert.match(m.SQL.taskComplete,/status='claimed'/));
t("domain status uses scoped id",()=>assert.match(m.SQL.domainStatusFromTask,/WHERE id=\$3 AND tenant=\$4 AND fleet=\$5/));
const node={id:1,tenant:"admin",fleet:"domain-radar"};
t("validate scoped node",()=>assert.equal(m.validNodeScope(node),true));
t("refuse unscoped node",()=>assert.equal(m.validNodeScope({...node,fleet:undefined}),false));
t("valid new task",()=>assert.equal(m.authorizeNewTask(node,"domain_check",{tenant:"admin",fleet:"domain-radar",domain_id:10}),10));
t("refuse new task missing id",()=>assert.throws(()=>m.authorizeNewTask(node,"domain_check",{tenant:"admin",fleet:"domain-radar"})));
t("refuse forged tenant",()=>assert.throws(()=>m.authorizeNewTask(node,"domain_check",{tenant:"demo",fleet:"domain-radar",domain_id:1})));
t("refuse forged fleet",()=>assert.throws(()=>m.authorizeNewTask(node,"domain_check",{tenant:"admin",fleet:"pentagon",domain_id:1})));
const task={status:"claimed",execution_allowed:true,dispatch_token:"d73c1f2a-382b-43e7-8ce9-bf506b31f80a",tenant:"admin",fleet:"domain-radar"};
t("allow checked task",()=>assert.equal(m.canCompleteTask(task,node),true));
for(const bad of [{...task,status:"queued"},{...task,execution_allowed:false},{...task,dispatch_token:null},{...task,tenant:"demo"},{...task,fleet:"pentagon"}])
t("reject unsafe completion",()=>assert.equal(m.canCompleteTask(bad,node),false));
console.log("PENTAGON_MIGRATION_SAFETY_TESTS_PASS="+n);
