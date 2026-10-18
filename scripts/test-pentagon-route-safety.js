#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const read=n=>fs.readFileSync(path.join(__dirname,"..","server",n),"utf8");
const app=read("index.js"),agent=read("agentPollRoutes.js"),nodes=read("nodeRoutes.js");
let passed=0;const t=(name,fn)=>{try{fn();passed++;}catch(e){throw Error(name+": "+e.message);}};
const api=[
['get','overview'],['get','alerts'],['get','domains'],['post','domains'],
['post','domains/bulk'],['patch','domains/:id'],['delete','domains/:id'],
['get','results'],['get','export/domains.csv'],['get','export/results.csv']
];
for(const [method,route] of api)t("scoped route "+method+" "+route,()=>
 assert.ok(app.includes('app.'+method+'("/api/'+route+'", requireAdmin, requireAuthenticatedScope,')));
t("no domain-wide upsert",()=>assert.doesNotMatch(app,/ON CONFLICT\s*\(domain\)/));
t("all-domain manual scanner disabled",()=>assert.match(app,/Manual all-domain scan disabled pending fleet-safe scheduler validation/));
t("single domain scanner disabled",()=>assert.match(app,/Single-domain scan disabled until checker and provider scheduling are fleet-safe/));
t("domain lookups, writes and deletes call scoped SQL",()=>{for(const name of ["domainsList","domainCreate","domainBulk","domainPatch","domainDelete"])
 assert.ok(app.includes("migrationSQL."+name));});
t("domain result updates are not matched by name",()=>assert.doesNotMatch(agent,/WHERE domain=\$3/));
t("poll uses explicit dispatch token filter",()=>assert.ok(agent.includes("migrationSQL.taskClaim")));
t("enqueue uses verified scope",()=>assert.ok(agent.includes("authorizeNewTask(node, taskType, options)")));
t("only explicitly authorized result accepted",()=>assert.ok(agent.includes("canCompleteTask(taskRows[0], node)")));
t("legacy defaults not executable",()=>assert.match(agent,/execution_allowed BOOLEAN NOT NULL DEFAULT false/));
t("new task has generated nonce",()=>assert.ok(agent.includes("const id = randomUUID(), token = randomUUID()")));
t("task completion uses guarded query",()=>assert.ok(agent.includes("migrationSQL.taskComplete")));
t("node routes gated by authorized server scope",()=>assert.match(nodes,/router\.use\(requireAuthenticatedScope\)/));
t("node upsert never overwrites credentials",()=>{assert.doesNotMatch(nodes,/ON CONFLICT \(name\) DO UPDATE/);assert.doesNotMatch(nodes,/secret_key=EXCLUDED\.secret_key/);});
t("node mutation filters tenant and fleet",()=>assert.match(nodes,/DELETE FROM provider_nodes WHERE id=\$1 AND tenant=\$2 AND fleet=\$3/));
console.log("PENTAGON_ROUTE_SAFETY_TESTS_PASS="+passed);
