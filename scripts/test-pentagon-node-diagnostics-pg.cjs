"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const express=require("express"),{Pool}=require("pg");
const url=process.env.DATABASE_URL||"";
if(process.env.CI!=="true" || !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(url))throw Error("LOCAL_CI_POSTGRES_ONLY");
const db=new Pool({connectionString:url,ssl:false,options:"-c search_path=node_diagnostics_fixture"});
let server;
function load(file,extra={}){
  const module={exports:{}};
  const deps={express,axios:{},crypto:require("crypto"),"./db":{pool:db},"./nodeDiagnostics":require("../server/nodeDiagnostics"),"./telegram":{sendTelegram(){throw Error("NO_SEND");}},...extra};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../server",file),"utf8"),{module,exports:module.exports,Date,console,process:{env:{}},setTimeout,require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name];}});
  return module.exports;
}
async function main(){try{
  await db.query("CREATE SCHEMA node_diagnostics_fixture");
  const nodes=load("nodeRoutes.js"),agent=load("agentPollRoutes.js",{"./nodeRoutes":nodes});
  await agent.ensureTaskTable();
  await db.query("ALTER TABLE provider_nodes ADD COLUMN IF NOT EXISTS tenant TEXT DEFAULT 'fixture'");
  const node=(await db.query("INSERT INTO provider_nodes(name,provider_name,endpoint_url,secret_key,tenant) VALUES('Fixture','Fixture ISP','poll://fixture','fixture-key','fixture') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO provider_node_tasks(id,node_id,domain,status) VALUES('fixture-task',$1,'reserved.example','queued')",[node]);
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.tenant="fixture";next();});
  app.use("/agent",agent.router);app.use("/nodes",nodes.router);
  app.use((error,req,res,next)=>{console.error(error.code||error.message);res.status(500).json({error:"FIXTURE_FAILURE"});});
  server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  async function post(route,body){const r=await fetch(base+route,{method:"POST",headers:{"content-type":"application/json","user-agent":"PentagonProviderNode/1.7.7"},body:JSON.stringify({node_name:"Fixture",secret_key:"fixture-key",...body})});return {status:r.status,data:await r.json()};}
  const telemetry={battery_percent:80,is_charging:true,diagnostics:{schema_version:1,task_busy:true,task_phase:"dns",secret_key:"DO_NOT_STORE",events:[{event:"TASK_START",at:"2026-10-29T00:00:00Z",raw:"DO_NOT_STORE"}]}};
  const busy=await post("/agent/poll",{busy:true,telemetry});assert.equal(busy.status,200);assert.equal(busy.data.task,null);
  let row=(await db.query("SELECT status FROM provider_node_tasks WHERE id='fixture-task'")).rows[0];assert.equal(row.status,"queued");
  row=(await db.query("SELECT diagnostics,diagnostics_received_at,is_charging FROM node_telemetry WHERE node_id=$1",[node])).rows[0];assert.equal(row.is_charging,true);assert.equal(row.diagnostics.task_phase,"dns");assert.ok(row.diagnostics_received_at);assert.equal(JSON.stringify(row).includes("DO_NOT_STORE"),false);
  console.log("PASS PostgreSQL busy heartbeat persists sanitized diagnostics without claiming");
  const auth=await post("/agent/poll",{secret_key:"wrong",busy:true,telemetry});assert.equal(auth.status,401);
  const view=await fetch(base+"/nodes/"+node+"/diagnostics?tenant=other");const data=await view.json();assert.equal(view.status,200);assert.match(view.headers.get("cache-control"),/no-store/);assert.equal(data.app_version,"1.7.7");assert.equal(data.diagnostics.task_phase,"dns");assert.equal(JSON.stringify(data).includes("secret_key"),false);
  await db.query("UPDATE provider_nodes SET tenant='other' WHERE id=$1",[node]);assert.equal((await fetch(base+"/nodes/"+node+"/diagnostics")).status,404);await db.query("UPDATE provider_nodes SET tenant='fixture' WHERE id=$1",[node]);
  console.log("PASS authentication and diagnostics tenant scope cannot be forged");
  const claimed=await post("/agent/poll",{telemetry:{battery_percent:80}});assert.equal(claimed.data.task.id,"fixture-task");
  const done=await post("/agent/result",{task_id:"fixture-task",result:{status:"warning",reason:"fixture"},telemetry});assert.equal(done.data.ok,true);
  const dup=await post("/agent/result",{task_id:"fixture-task",result:{status:"working"},telemetry});assert.equal(dup.data.ignored,true);
  row=(await db.query("SELECT status,result FROM provider_node_tasks WHERE id='fixture-task'")).rows[0];assert.equal(row.status,"done");assert.equal(row.result.status,"warning");
  console.log("PASS old-client poll protocol and monotonic result completion remain valid");
}finally{if(server)await new Promise(r=>server.close(r));await db.end();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
