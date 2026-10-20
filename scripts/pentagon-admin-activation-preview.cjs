#!/usr/bin/env node
"use strict";
/*
 * Local-only SOURCE ADMIN domain activation preview.
 * This script reads TWO offline restored PostgreSQL databases on loopback.
 * It NEVER connects to Supabase, imports a row, edits a tenant, starts a
 * production scheduler, emits executable SQL or sends Telegram messages.
 */
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const crypto=require("node:crypto");
const {spawnSync}=require("node:child_process");

const EXPECTED_SOURCE_ARCHIVE_SHA="47f0c597e7dbd1836379c8244ef06ece46b81eeaeb42b5584888cffc36db0937";
const SOURCE_DB="pentagon_restore_test";
const TARGET_DB="pentagon_target_restore_20261018_045027";
const HOST_RE=/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
class Stop extends Error {constructor(code){super(code);this.code=code;}}
const guard=(p,k)=>{if(!p)throw new Stop(k);};
const canonical=x=>String(x||"").trim().toLowerCase();

function buildAdminPreview(sourceRows,targetRows){
  guard(Array.isArray(sourceRows)&&Array.isArray(targetRows),"MISSING_LOCAL_ROWS");
  const allSource=new Map(), allTargets=new Map(), adminGroups=new Map();
  for(const r of sourceRows){
    const host=canonical(r.domain);
    if(!host)continue;
    if(!allSource.has(host))allSource.set(host,[]);
    allSource.get(host).push(r);
    if(canonical(r.tenant)==="admin"){
      if(!adminGroups.has(host))adminGroups.set(host,[]);
      adminGroups.get(host).push(r);
    }
  }
  for(const r of targetRows){
    const host=canonical(r.domain);
    if(!host)continue;
    if(!allTargets.has(host))allTargets.set(host,[]);
    allTargets.get(host).push(r);
  }
  const rows=[];
  for(const [host,group] of [...adminGroups.entries()].sort(([a],[b])=>a.localeCompare(b))){
    const other=allSource.get(host)||[],target=allTargets.get(host)||[];
    const fleets=[...new Set(group.map(r=>String(r.fleet||"").trim()))];
    const names=[...new Set(group.map(r=>String(r.project_name||"").trim()).filter(Boolean))];
    let reason;
    if(!HOST_RE.test(host)||host.length>253||host.includes("..")||
       host.startsWith("-")||host.endsWith("-"))reason="INVALID_HOSTNAME";
    else if(group.some(r=>r.is_active!==true))reason="SOURCE_HAS_DISABLED_RECORD";
    else if(fleets.some(x=>!x))reason="MISSING_SOURCE_FLEET";
    else if(other.some(r=>canonical(r.tenant)!=="admin"))reason="SOURCE_CROSS_TENANT_HOST_CONFLICT";
    else if(new Set(group.map(r=>String(r.fleet||"").trim())).size!==group.length)
      reason="SOURCE_DUPLICATE_WITHIN_FLEET";
    else if(target.length)reason="TARGET_HOST_ALREADY_OCCUPIED";
    else reason="MONITOR_ONLY_CANDIDATE_NEEDS_OWNER_ATTESTATION";
    rows.push({
      domain:host,tenant:"admin",
      source_ids:group.map(r=>String(r.id)),origin_fleets:fleets,
      project_names:names,source_records:group.length,source_all_host_records:other.length,
      target_same_host_records:target.length,
      all_source_admin_active:group.every(r=>r.is_active===true),
      monitor_only_candidate:reason==="MONITOR_ONLY_CANDIDATE_NEEDS_OWNER_ATTESTATION",
      history_requires_fleet_mapping:group.length>1,
      // Neither source history nor node IDs are imported in this stage.
      reason,activation_allowed:false
    });
  }
  const previewable=rows.filter(x=>x.monitor_only_candidate).length;
  return {
    type:"pentagon_offline_admin_candidate_preview_v1",
    counts:{
      source_total:sourceRows.length,source_admin:sourceRows.filter(x=>canonical(x.tenant)==="admin").length,
      source_demo:sourceRows.filter(x=>canonical(x.tenant)==="demo").length,
      source_admin_unique_hosts:rows.length,
      target_total:targetRows.length,target_admin:targetRows.filter(x=>canonical(x.tenant)==="admin").length,
      target_demo:targetRows.filter(x=>canonical(x.tenant)==="demo").length,
      monitor_only_candidate_hosts:previewable,
      monitor_only_blocked_hosts:rows.length-previewable,
      historical_multi_fleet_admin_hosts:rows.filter(x=>x.history_requires_fleet_mapping).length,
      source_admin_active:sourceRows.filter(x=>canonical(x.tenant)==="admin"&&x.is_active===true).length
    },
    source_admin_reviews:rows,
    gates:{data_from_historical_backup:true,fresh_target_check_required:true,
      fleet_identity_preserved:true,ownership_attestation_required:true,
      monitor_only_no_historical_merge:true,
      task_history_not_migrated:true,activate_only_after_approved_release:true,
      activation_allowed:false,generated_sql:false,production_connections:0,production_writes:0}
  };
}

function command(ctl,args,env) {
 const p=spawnSync(ctl,args,{env,stdio:"ignore",windowsHide:true,timeout:30000});
 guard(p.status===0,"LOCAL_PG_CTL_FAILED");
}
async function sha256File(filename){
 const h=crypto.createHash("sha256");
 for await(const part of fs.createReadStream(filename))h.update(part);
 return h.digest("hex");
}
async function collectOffline({home=os.homedir(),Client}={}){
 const root=path.join(home,"Pentagon-Migration-Audit");
 const cluster=path.join(root,"restore-cluster-18");
 const ctl=path.join(root,"pg-portable-18","pgsql","bin","pg_ctl.exe");
 const archive=path.join(home,"Pentagon-Secure-Backups","pentagon-heliumdb-20261012.dump");
 guard(fs.existsSync(archive),"VERIFIED_SOURCE_BACKUP_MISSING");
 guard(await sha256File(archive)===EXPECTED_SOURCE_ARCHIVE_SHA,"SOURCE_BACKUP_HASH_MISMATCH");
 guard(fs.existsSync(ctl)&&fs.existsSync(cluster),"RESTORED_LOCAL_CLUSTER_MISSING");
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG/i.test(k)));
 const state=spawnSync(ctl,["-D",cluster,"status"],{env,stdio:"ignore",windowsHide:true,timeout:10000});
 guard(state.status===3,"LOCAL_CLUSTER_MUST_START_STOPPED");
 guard(typeof Client==="function","POSTGRES_CLIENT_MISSING");
 let started=false;const clients=[];
 try{
  command(ctl,["-D",cluster,"-l",path.join(root,"target-restore-postgres-20261018.log"),
    "-o","-p 55432 -h 127.0.0.1","-w","-t","15","start"],env);
  started=true;
  for(const name of [SOURCE_DB,TARGET_DB]){
   const client=new Client({host:"127.0.0.1",port:55432,user:"pentagon_restore",
     password:"",database:name,ssl:false,connectionTimeoutMillis:7000,query_timeout:45000,
     options:"-c timezone=UTC"});
   clients.push(client);await client.connect();
   await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
   await client.query("SET LOCAL statement_timeout='30s'");
   const r=(await client.query(
     "SELECT current_database() AS db,current_user AS role,host(inet_server_addr()) AS addr,"+
     "inet_server_port() AS port,current_setting('transaction_read_only') AS ro,"
     +"current_setting('data_directory') AS dir")).rows[0];
   guard(r&&r.db===name&&r.role==="pentagon_restore"&&r.addr==="127.0.0.1"&&
     Number(r.port)===55432&&r.ro==="on"&&
     path.resolve(r.dir).toLowerCase()===path.resolve(cluster).toLowerCase(),
     "LOCAL_READ_ONLY_IDENTITY_MISMATCH");
  }
  const source=(await clients[0].query(
    "SELECT id,domain,tenant,fleet,is_active,project_name FROM public.domains ORDER BY id"
  )).rows;
  const target=(await clients[1].query(
    "SELECT id,domain,tenant,is_active FROM public.domains ORDER BY id"
  )).rows;
  const report=buildAdminPreview(source,target);
  return {...report,
    provenance:{source_db:SOURCE_DB,target_db:TARGET_DB,
      source_backup_sha256:EXPECTED_SOURCE_ARCHIVE_SHA,
      historical_snapshot_date:"2026-10-18",
      local_db_read_only:true}
  };
 }finally{
   for(const c of clients){await c.query("ROLLBACK").catch(()=>{});await c.end().catch(()=>{});}
   if(started)command(ctl,["-D",cluster,"-m","fast","-w","-t","15","stop"],env);
 }
}

async function main(argv=process.argv.slice(2)) {
 process.umask(0o077);
 guard(argv.length===2 && argv[0]==="--out"&&argv[1]&&!argv[1].startsWith("--"),
   "USAGE_LOCAL_OUT_ONLY");
 const dest=path.resolve(argv[1]);
 guard(!fs.existsSync(dest),"OUTPUT_EXISTS");
 const {Client}=require("pg"); // Load only after explicit local-only CLI invocation.
 const plan=await collectOffline({Client});
 fs.writeFileSync(dest,JSON.stringify(plan,null,2)+"\n",{flag:"wx",mode:0o600});
 console.log("PENTAGON_OFFLINE_ADMIN_CANDIDATES_READY");
 for(const [k,v] of Object.entries(plan.counts))console.log(k.toUpperCase()+"="+v);
 console.log("ACTIVATION_ALLOWED=false");
 console.log("NO_PRODUCTION_CONNECTION_OR_WRITE");
 console.log("REVIEW_PATH="+dest);
 return plan;
}
if(require.main===module)main().catch(e=>{
 console.error("ADMIN_CANDIDATE_PREVIEW_STOPPED:"+
   (e instanceof Stop?e.code:"LOCAL_READ_FAILURE"));process.exitCode=2;
});
module.exports={buildAdminPreview,collectOffline,main};
