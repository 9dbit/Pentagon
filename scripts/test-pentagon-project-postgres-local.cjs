#!/usr/bin/env node
"use strict";
// Private PostgreSQL target restore only. All DDL/DML inside ROLLBACK.
const path=require("node:path"),os=require("node:os"),net=require("node:net");
const {spawnSync}=require("node:child_process"),{Client}=require("pg");
const ROOT=path.join(os.homedir(),"Pentagon-Migration-Audit");
const DATA=path.join(ROOT,"restore-cluster-18");
const PGCTL=path.join(ROOT,"pg-portable-18","pgsql","bin","pg_ctl.exe");
const DB="pentagon_target_restore_20261018_045027";
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(PG|DATABASE_URL|SUPABASE)/i.test(k)));
const check=(v,code)=>{if(!v)throw new Error(code);};
const pgctl=a=>{const r=spawnSync(PGCTL,a,{env,stdio:"ignore",windowsHide:true,timeout:25000});check(r.status===0,"PG_CTL_FAILED");};
const busy=()=>new Promise(resolve=>{const s=net.createConnection({host:"127.0.0.1",port:55432});s.once("connect",()=>{s.destroy();resolve(true)});s.once("error",e=>{s.destroy();resolve(e.code!=="ECONNREFUSED")});s.setTimeout(1500,()=>{s.destroy();resolve(true)});});
async function main(){
  check(process.argv.length===3&&process.argv[2]==="--run-local","LOCAL_ONLY_FLAG_REQUIRED");
  check(process.platform==="win32"&&path.basename(os.homedir()).toUpperCase()==="MARKSTUDIOS","WRONG_DEVICE");
  check(!(await busy()),"PORT_55432_BUSY");
  const st=spawnSync(PGCTL,["-D",DATA,"status"],{env,stdio:"ignore",windowsHide:true,timeout:6000});
  check(st.status===3,"LOCAL_CLUSTER_ALREADY_ACTIVE");
  let started=false,c,tx=false,count=0;
  const ok=(v,k)=>{check(v,k);count++};
  try{
    started=true;
    pgctl(["-D",DATA,"-l",path.join(ROOT,"project-rehearsal.log"),"-o","-p 55432 -h 127.0.0.1","-w","-t","15","start"]);
    c=new Client({host:"127.0.0.1",port:55432,user:"pentagon_restore",password:"",database:DB,ssl:false,connectionTimeoutMillis:5000,query_timeout:15000});
    await c.connect();
    const d=(await c.query("SELECT current_database() db,current_user role,host(inet_server_addr()) ip,inet_server_port() port,current_setting('data_directory') dir")).rows[0];
    ok(d.db===DB&&d.role==="pentagon_restore"&&d.ip==="127.0.0.1"&&d.port===55432&&path.resolve(d.dir).toLowerCase()===path.resolve(DATA).toLowerCase(),"WRONG_LOCAL_DATABASE");
    const before={projects:(await c.query("SELECT count(*)::int n FROM public.projects")).rows[0].n,domains:(await c.query("SELECT count(*)::int n FROM public.domains")).rows[0].n};
    ok(before.domains===8&&before.projects===2,"TARGET_SNAPSHOT_CHANGED");
    await c.query("BEGIN");tx=true; await c.query("SET LOCAL statement_timeout='10s'");
    await c.query("ALTER TABLE public.projects ADD COLUMN fleet TEXT");
    await c.query("ALTER TABLE public.domains ADD COLUMN fleet TEXT");
    await c.query("UPDATE public.projects SET fleet='pentagon'");
    await c.query("UPDATE public.domains SET fleet='pentagon'");
    await c.query("ALTER TABLE public.projects ALTER COLUMN fleet SET NOT NULL");
    await c.query("ALTER TABLE public.domains ALTER COLUMN fleet SET NOT NULL");
    const a="pentagon-local-scope-audit-20261018-admin",b="pentagon-local-scope-audit-20261018-demo";
    await c.query("INSERT INTO public.projects(name,notes,tenant,fleet) VALUES($1,'', 'admin','pentagon'),($2,'','demo','domain-radar')",[a,b]);
    await c.query("INSERT INTO public.domains(domain,project_name,tenant,fleet) VALUES('pentagon-local-audit-admin.invalid',$1,'admin','pentagon'),('pentagon-local-audit-demo.invalid',$2,'demo','domain-radar')",[a,b]);
    const select=(tenant,fleet)=>c.query("SELECT COALESCE(p.name,d.project_name,'No Project') AS project_name, COUNT(d.id)::int total FROM (SELECT * FROM public.projects WHERE tenant=$1 AND fleet=$2) p FULL OUTER JOIN (SELECT * FROM public.domains WHERE tenant=$1 AND fleet=$2) d ON d.project_name=p.name GROUP BY COALESCE(p.name,d.project_name,'No Project') ORDER BY total DESC",[tenant,fleet]);
    const admin=(await select("admin","pentagon")).rows,demo=(await select("demo","domain-radar")).rows;
    ok(admin.some(r=>r.project_name===a&&r.total===1),"ADMIN_PROJECT_NOT_VISIBLE");
    ok(!admin.some(r=>r.project_name===b),"DEMO_PROJECT_LEAK_IN_ADMIN");
    ok(demo.some(r=>r.project_name===b&&r.total===1),"DEMO_PROJECT_NOT_VISIBLE");
    ok(!demo.some(r=>r.project_name===a),"ADMIN_PROJECT_LEAK_IN_DEMO");
    const mismatch=(await c.query("SELECT name FROM public.projects WHERE LOWER(name)=LOWER($1) AND tenant=$2 AND fleet=$3",[a,"demo","domain-radar"])).rowCount;
    ok(mismatch===0,"WRONG_SCOPE_PROJECT_DUPLICATE");
    const match=(await c.query("SELECT name FROM public.projects WHERE LOWER(name)=LOWER($1) AND tenant=$2 AND fleet=$3",[a,"admin","pentagon"])).rowCount;
    ok(match===1,"MATCHING_SCOPE_PROJECT_NOT_FOUND");
    await c.query("ROLLBACK");tx=false;
    const after={projects:(await c.query("SELECT count(*)::int n FROM public.projects")).rows[0].n,domains:(await c.query("SELECT count(*)::int n FROM public.domains")).rows[0].n};
    ok(after.projects===before.projects&&after.domains===before.domains,"ROLLBACK_COUNTS_CHANGED");
    ok((await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='projects' AND column_name='fleet'")).rowCount===0,"ROLLBACK_LEFT_PROJECT_FLEET");
    console.log("PENTAGON_PROJECT_SQL_SCOPE_PASS="+count);
  }finally{
    if(tx&&c)await c.query("ROLLBACK").catch(()=>{});
    if(c)await c.end().catch(()=>{});
    if(started){pgctl(["-D",DATA,"-m","fast","-w","-t","15","stop"]);console.log("LOCAL_POSTGRES_STOPPED=true");}
  }
}
main().catch(e=>{console.error("PROJECT_SQL_SMOKE_STOPPED="+(/^[A-Z_]+$/.test(e.message)?e.message:"LOCAL_QUERY_FAILED"));process.exitCode=1});
