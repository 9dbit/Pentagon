#!/usr/bin/env node
"use strict";
// Rehearsal against a previously restored, isolated local Pentagon TARGET copy.
// Never connect to Supabase/production. Every database change is rolled back.
const fs=require("node:fs"), path=require("node:path"), os=require("node:os");
const net=require("node:net"),{spawnSync}=require("node:child_process");
const {Client}=require("pg");
const {SQL}=require("../server/migrationSafety");
const ROOT=path.join(os.homedir(),"Pentagon-Migration-Audit");
const CLUSTER=path.join(ROOT,"restore-cluster-18");
const BIN=path.join(ROOT,"pg-portable-18","pgsql","bin");
const DB="pentagon_target_restore_20261018_045027";
const ENV=Object.fromEntries(Object.entries(process.env).filter(([k])=>!(/^(PG|DATABASE_URL|SUPABASE)/i.test(k))));
const check=(ok,code)=>{if(!ok)throw Error(code);};
const ctl=(args)=>{const x=spawnSync(path.join(BIN,"pg_ctl.exe"),args,{env:ENV,stdio:"ignore",windowsHide:true,timeout:20000});check(x.status===0,"LOCAL_PG_CTL_FAILED");};
async function busy(){return new Promise(resolve=>{const s=net.createConnection({host:"127.0.0.1",port:55432});s.once("connect",()=>{s.destroy();resolve(true)});s.once("error",e=>{s.destroy();resolve(e.code!=="ECONNREFUSED")});s.setTimeout(2000,()=>{s.destroy();resolve(true)});});}
async function main(){
  check(process.argv[2]==="--run-local"&&process.argv.length===3,"EXPLICIT_LOCAL_FLAG_REQUIRED");
  check(process.platform==="win32"&&path.basename(os.homedir()).toUpperCase()==="MARKSTUDIOS","WRONG_DEVICE");
  check(!(await busy()),"LOCAL_PORT_ALREADY_USED");
  const status=spawnSync(path.join(BIN,"pg_ctl.exe"),["-D",CLUSTER,"status"],{env:ENV,stdio:"ignore",windowsHide:true,timeout:5000});
  check(status.status===3,"LOCAL_POSTGRES_ALREADY_RUNNING");
  let started=false,client,tx=false,success=false,tests=0;
  const ok=(expr,code)=>{check(expr,code);tests++;};
  try{
    started=true;
    ctl(["-D",CLUSTER,"-l",path.join(ROOT,"scope-smoke-postgres.log"),"-o","-p 55432 -h 127.0.0.1","-w","-t","15","start"]);
    client=new Client({host:"127.0.0.1",port:55432,user:"pentagon_restore",password:"",database:DB,ssl:false,connectionTimeoutMillis:5000,query_timeout:15000});
    await client.connect();
    const identity=(await client.query("SELECT current_database() db, current_user role, host(inet_server_addr()) host, inet_server_port() port, current_setting('data_directory') data_dir")).rows[0];
    ok(identity.db===DB&&identity.role==="pentagon_restore"&&identity.host==="127.0.0.1"&&identity.port===55432&&path.resolve(identity.data_dir).toLowerCase()===path.resolve(CLUSTER).toLowerCase(),"DATABASE_GUARD_FAILED");
    const before=(await client.query("SELECT count(*)::int n FROM public.domains")).rows[0].n;
    const taskBefore=(await client.query("SELECT count(*)::int n FROM public.provider_node_tasks")).rows[0].n;
    ok(before===8&&taskBefore===3,"TARGET_BACKUP_BASELINE_CHANGED");
    await client.query("BEGIN");tx=true;
    await client.query("SET LOCAL statement_timeout='12s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("ALTER TABLE public.domains DROP CONSTRAINT domains_domain_key");
    await client.query("ALTER TABLE public.domains ADD COLUMN fleet TEXT");
    await client.query("UPDATE public.domains SET fleet='pentagon'");
    await client.query("ALTER TABLE public.domains ALTER COLUMN fleet SET NOT NULL");
    await client.query("CREATE UNIQUE INDEX pentagon_smoke_domain_scoped ON public.domains (tenant,fleet,(lower(btrim(domain))))");
    const original=(await client.query("SELECT domain FROM public.domains LIMIT 1")).rows[0].domain;
    const create=(await client.query(SQL.domainCreate,[original,"Migrated safe demo","demo","domain-radar"])).rows[0];
    ok(create.tenant==="demo"&&create.fleet==="domain-radar","CROSS_FLEET_INSERT_FAILED");
    ok((await client.query(SQL.domainCreate,[original,"Updated same scope","demo","domain-radar"])).rows[0].id===create.id,"UPSERT_DUPLICATED_SCOPE");
    ok((await client.query(SQL.domainBulk,[original,"Bulk updated","demo","domain-radar"])).rows[0].id===create.id,"BULK_UPSERT_DUPLICATED_SCOPE");
    ok((await client.query(SQL.domainCheckLookup,[create.id,"demo","pentagon"])).rowCount===0,"WRONG_FLEET_LOOKUP_ALLOWED");
    ok((await client.query(SQL.domainCheckLookup,[create.id,"admin","domain-radar"])).rowCount===0,"WRONG_TENANT_LOOKUP_ALLOWED");
    ok((await client.query(SQL.domainPatch,[null,true,"wrong tenant",create.id,null,"admin","domain-radar"])).rowCount===0,"CROSS_TENANT_PATCH_ALLOWED");
    ok((await client.query(SQL.domainPatch,[null,true,"right scope",create.id,null,"demo","domain-radar"])).rowCount===1,"SCOPED_PATCH_FAILED");
    ok((await client.query(SQL.domainStatusFromTask,["working","wrong fleet",create.id,"demo","pentagon"])).rowCount===0,"CROSS_FLEET_TASK_STATUS_ALLOWED");
    ok((await client.query(SQL.domainStatusFromTask,["working","right scope",create.id,"demo","domain-radar"])).rowCount===1,"SCOPED_TASK_STATUS_FAILED");
    ok((await client.query(SQL.domainDelete,[create.id,"demo","pentagon"])).rowCount===0,"CROSS_FLEET_DELETE_ALLOWED");
    ok((await client.query(SQL.domainDelete,[create.id,"demo","domain-radar"])).rowCount===1,"SCOPED_DELETE_FAILED");
    await client.query("ALTER TABLE public.provider_node_tasks ADD COLUMN IF NOT EXISTS execution_allowed BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE public.provider_node_tasks ADD COLUMN IF NOT EXISTS dispatch_token UUID");
    await client.query("ALTER TABLE public.provider_node_tasks ADD COLUMN IF NOT EXISTS domain_id INTEGER");
    await client.query("ALTER TABLE public.provider_node_tasks ADD COLUMN IF NOT EXISTS tenant TEXT");
    await client.query("ALTER TABLE public.provider_node_tasks ADD COLUMN IF NOT EXISTS fleet TEXT");
    const node=(await client.query("SELECT id FROM public.provider_nodes WHERE tenant='admin' ORDER BY id LIMIT 1")).rows[0].id;
    await client.query("INSERT INTO public.provider_node_tasks (id,node_id,domain,status,task_type,tenant,fleet) VALUES ($1,$2,$3,'queued','domain_check','admin','pentagon')",["legacy-replay-guard-test",node,"example.org"]);
    await client.query("INSERT INTO public.provider_node_tasks (id,node_id,domain,status,task_type,tenant,fleet,execution_allowed,dispatch_token) VALUES ($1,$2,$3,'queued','domain_check','admin','pentagon',true,$4)",["authorized-dispatch-test",node,"example.org","d73c1f2a-382b-43e7-8ce9-bf506b31f80a"]);
    const claim=await client.query(SQL.taskClaim,[node,"admin","pentagon"]);
    ok(claim.rowCount===1&&claim.rows[0].id==="authorized-dispatch-test","HISTORICAL_QUEUED_TASK_CLAIMED");
    const old=await client.query(SQL.taskLookup,["legacy-replay-guard-test",node]);
    ok(old.rows[0].execution_allowed===false&&old.rows[0].dispatch_token===null,"HISTORICAL_TASK_NOT_DISABLED");
    ok((await client.query(SQL.taskComplete,["{}",old.rows[0].id,node,"admin","pentagon"])).rowCount===0,"HISTORICAL_TASK_COMPLETION_ALLOWED");
    ok((await client.query(SQL.taskComplete,["{}",claim.rows[0].id,node,"admin","pentagon"])).rowCount===1,"VALID_TASK_COMPLETION_FAILED");
    ok((await client.query(SQL.taskComplete,["{}",claim.rows[0].id,node,"admin","pentagon"])).rowCount===0,"REPLAYED_TASK_COMPLETION_ALLOWED");
    await client.query("ROLLBACK");tx=false;
    const after=(await client.query("SELECT count(*)::int n FROM public.domains")).rows[0].n;
    const taskAfter=(await client.query("SELECT count(*)::int n FROM public.provider_node_tasks")).rows[0].n;
    ok(after===before&&taskAfter===taskBefore,"TARGET_COUNTS_CHANGED_AFTER_ROLLBACK");
    ok((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='domains' AND column_name='fleet'")).rowCount===0,"ROLLBACK_LEFT_FLEET_COLUMN");
    success=true;
    console.log("PENTAGON_LOCAL_PG_SCOPE_TESTS_PASS="+tests);
  } finally {
    if(tx&&client)await client.query("ROLLBACK").catch(()=>{});
    if(client)await client.end().catch(()=>{});
    if(started) {try{ctl(["-D",CLUSTER,"-m","fast","-w","-t","15","stop"]);console.log("LOCAL_CLUSTER_STOPPED=true");}catch(e){console.log("LOCAL_CLUSTER_STOPPED=false");throw e;}}
  }
  if(!success)throw Error("LOCAL_SQL_SMOKE_FAILED");
}
main().catch(e=>{console.error("PENTAGON_LOCAL_PG_SCOPE_TESTS_STOPPED="+(/^[A-Z_]+$/.test(e.message)?e.message:"OPERATION_FAILED"));process.exitCode=1;});
