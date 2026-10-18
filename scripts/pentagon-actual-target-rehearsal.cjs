#!/usr/bin/env node
'use strict';
// OFFLINE ONLY. Copy every source table to a private typed archive inside the
// already-restored target, verify twice, then ROLLBACK. Never publish to public.
// Legacy sensitive fields stay on TRADEVICEPC; logs/reports contain hashes only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),net=require('node:net');
const {spawnSync}=require('node:child_process');
const ROOT=path.join(os.homedir(),'Pentagon-Migration-Audit');
const SECURE=path.join(os.homedir(),'Pentagon-Secure-Backups');
const CLUSTER=path.join(ROOT,'restore-cluster-18');
const BIN=path.join(ROOT,'pg-portable-18','pgsql','bin');
const SOURCE_DB='pentagon_restore_test';
const TARGET_DB='pentagon_target_restore_20261018_045027';
const STAGE='pentagon_rehearsal_20261018';
const PROBE_ROLE='pentagon_rehearsal_deny_probe';
const SOURCE_SHA='47f0c597e7dbd1836379c8244ef06ece46b81eeaeb42b5584888cffc36db0937';
const TARGET_SHA='03ae4c636bdf0f0555dbf62dd8a52540a6577db9828b5dd6781d0285cca9b51d';
const ENCRYPTED_SHA='0cec8fa6b75970bcc6a65903ad68295c6dc0244a498c8899ad2058c00327e85e';
const TARGET_FILE='pentagon-target-public-20261018T045027Z-019824.dump';
const TYPES=new Set(['bigint','boolean','bytea','character varying','date','integer','json','jsonb','numeric','numeric(10,2)','numeric(14,0)','text','timestamp with time zone','timestamp without time zone','timestamp(6) without time zone','uuid']);
const BATCH=500;
class Stop extends Error{constructor(code){super(code);this.safeCode=code;}}
const check=(ok,code)=>{if(!ok)throw new Stop(code);};
const qi=s=>'"'+String(s).replace(/"/g,'""')+'"';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const fileHash=p=>sha(fs.readFileSync(p));
const typeSql=s=>{check(TYPES.has(s),'UNREVIEWED_COLUMN_TYPE');return s;};
const stageTable=name=>{check(/^[a-z][a-z0-9_]{0,50}$/.test(name),'UNSAFE_TABLE_NAME');return qi(STAGE)+'.'+qi('legacy_'+name);};
function config(database){check([SOURCE_DB,TARGET_DB].includes(database),'DATABASE_NOT_ALLOWLISTED');return {host:'127.0.0.1',port:55432,database,user:'pentagon_restore',password:'',ssl:false,connectionTimeoutMillis:5000,query_timeout:90000,application_name:'pentagon-offline-private-rehearsal',options:'-c timezone=UTC'};}
function createTableSql(table){
 check(table.columns.length>0&&table.pk.length>0,'MISSING_COLUMNS_OR_PRIMARY_KEY');
 return `CREATE TABLE ${stageTable(table.name)} (${table.columns.map(c=>qi(c.name)+' '+typeSql(c.type)+(c.nullable?'':' NOT NULL')).join(',')},PRIMARY KEY (${table.pk.map(qi).join(',')}))`;
}
function insertSql(table){
 return `INSERT INTO ${stageTable(table.name)} (${table.columns.map(c=>qi(c.name)).join(',')}) SELECT ${table.columns.map(c=>'x.'+qi(c.name)+'::'+typeSql(c.type)).join(',')} FROM json_to_recordset($1::json) AS x (${table.columns.map(c=>qi(c.name)+' text').join(',')}) ON CONFLICT (${table.pk.map(qi).join(',')}) DO NOTHING`;
}
function selectSql(table,schema='public',limit=false){
 const rel=schema==='public'?'public.'+qi(table.name):stageTable(table.name);
 return `SELECT row_to_json(r)::text AS encoded FROM (SELECT ${table.columns.map(c=>qi(c.name)+'::text AS '+qi(c.name)).join(',')} FROM ${rel} v ORDER BY ${table.pk.map(k=>'v.'+qi(k)).join(',')}${limit?' LIMIT $1 OFFSET $2':''}) r`;
}
function addRows(hash,rows){for(const r of rows){const b=Buffer.from(r.encoded,'utf8');hash.update(String(b.length)+':');hash.update(b);}return hash;}
function domainState(candidateCount,sourceScopeCount){return candidateCount===0?'NEW_REQUIRES_REVIEW':candidateCount>1||sourceScopeCount>1?'AMBIGUOUS_FLEET':'IDENTITY_REVIEW_REQUIRED';}
function nativeEnv(){return Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(PG|DATABASE_URL|SUPABASE)/i.test(k)));}
function ctl(args){const r=spawnSync(path.join(BIN,'pg_ctl.exe'),args,{env:nativeEnv(),stdio:'ignore',windowsHide:true,timeout:20000});check(!r.error&&r.status===0,'LOCAL_PG_CTL_FAILED');}
async function portBusy(){return await new Promise(resolve=>{const s=net.createConnection({host:'127.0.0.1',port:55432});let done=false;const end=x=>{if(!done){done=true;s.destroy();resolve(x);}};s.once('connect',()=>end(true));s.once('error',e=>end(e.code!=='ECONNREFUSED'));s.setTimeout(1500,()=>end(true));});}
async function guard(c,db){
 const g=(await c.query("SELECT current_database() db,current_user AS role,host(inet_server_addr()) host,inet_server_port() port,current_setting('data_directory') dir,current_setting('listen_addresses') listen")).rows[0];
 check(g.db===db&&g.role==='pentagon_restore'&&g.host==='127.0.0.1'&&g.port===55432&&g.listen==='127.0.0.1'&&path.resolve(g.dir).toLowerCase()===path.resolve(CLUSTER).toLowerCase(),'LOCAL_IDENTITY_FAILED');
}
async function catalog(c){
 const tables=(await c.query("SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname")).rows;
 for(const t of tables){
  t.columns=(await c.query("SELECT a.attname name,format_type(a.atttypid,a.atttypmod) type,NOT a.attnotnull nullable FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",['public.'+qi(t.name)])).rows;
  t.pk=(await c.query("SELECT a.attname name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY v(attnum,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=v.attnum WHERE k.conrelid=$1::regclass AND k.contype='p' ORDER BY v.ord",['public.'+qi(t.name)])).rows.map(r=>r.name);
  check(t.pk.length>0,'SOURCE_OR_TARGET_MISSING_PRIMARY_KEY');
  t.rows=Number((await c.query(`SELECT count(*)::text n FROM public.${qi(t.name)}`)).rows[0].n);
 }
 return tables;
}
async function tableHash(c,t,schema='public'){
 const h=crypto.createHash('sha256');let count=0;
 while(true){const rows=(await c.query(selectSql(t,schema,true),[BATCH,count])).rows;if(!rows.length)break;addRows(h,rows);count+=rows.length;}
 return {rows:count,sha256:h.digest('hex')};
}
async function fingerprint(c,tables){
 const data=[];for(const t of tables)data.push({table:t.name,...await tableHash(c,t)});
 const metadata=(await c.query(`SELECT 'column' kind,c.relname rel,a.attname name,concat(format_type(a.atttypid,a.atttypmod),'|',a.attnotnull,'|',coalesce(pg_get_expr(d.adbin,d.adrelid),'')) detail
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'constraint',c.relname,k.conname,pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 UNION ALL SELECT 'index',tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'
 UNION ALL SELECT 'security',c.relname,'rls',concat(c.relrowsecurity,'|',c.relforcerowsecurity,'|',c.relacl::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
 UNION ALL SELECT 'policy',tablename,policyname,concat(cmd,'|',roles::text,'|',qual,'|',with_check) FROM pg_policies WHERE schemaname='public'
 ORDER BY 1,2,3,4`)).rows;
 const sequences=[];for(const r of (await c.query("SELECT relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY relname")).rows)sequences.push({name:r.name,...(await c.query(`SELECT last_value::text,is_called FROM public.${qi(r.name)}`)).rows[0]});
 return {data,metadata_sha256:sha(JSON.stringify(metadata)),sequences,aggregate_sha256:sha(JSON.stringify({data,metadata,sequences}))};
}
async function secureTable(c,name){await c.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);await c.query(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`);await c.query(`REVOKE ALL ON ${name} FROM PUBLIC`);}
async function expectedFailure(c,sql,state){
 await c.query('SAVEPOINT expected_failure');let rejected=false;
 try{await c.query(sql);}catch(e){check(e.code===state,'UNEXPECTED_NEGATIVE_TEST_SQLSTATE');rejected=true;}
 finally{await c.query('ROLLBACK TO SAVEPOINT expected_failure');await c.query('RELEASE SAVEPOINT expected_failure');}
 check(rejected,'NEGATIVE_TEST_WAS_NOT_REJECTED');return true;
}
async function copyPass(source,target,t,number){
 let offset=0,inserted=0;const h=crypto.createHash('sha256');
 while(true){
  const rows=(await source.query(selectSql(t,'public',true),[BATCH,offset])).rows;if(!rows.length)break;
  addRows(h,rows);const payload='['+rows.map(r=>r.encoded).join(',')+']';
  inserted+=(await target.query(insertSql(t),[payload])).rowCount;offset+=rows.length;
 }
 const sourceHash=h.digest('hex'),after=await tableHash(target,t,STAGE);
 check(offset===t.rows&&after.rows===offset&&after.sha256===sourceHash,'FULL_FIELD_PARITY_FAILED');
 check(inserted===(number===1?offset:0),'IDEMPOTENT_INSERT_COUNT_FAILED');
 return {table:t.name,rows:offset,inserted,full_field_sha256:sourceHash,parity:true};
}
async function foreignKeys(source,target){
 const fks=(await source.query(`SELECT c.relname child,p.relname parent,k.conname name,
 ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.n ORDER BY ord) child_columns,
 ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n,ord) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.n ORDER BY ord) parent_columns
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_namespace pn ON pn.oid=p.relnamespace WHERE n.nspname='public' AND pn.nspname='public' AND k.contype='f' ORDER BY c.relname,k.conname`)).rows;
 for(const f of fks){check(Array.isArray(f.child_columns)&&Array.isArray(f.parent_columns),'FK_COLUMN_ARRAY_INVALID');} for(const f of fks)await target.query(`ALTER TABLE ${stageTable(f.child)} ADD CONSTRAINT ${qi(f.name)} FOREIGN KEY (${f.child_columns.map(qi).join(',')}) REFERENCES ${stageTable(f.parent)} (${f.parent_columns.map(qi).join(',')})`);
 return fks.length;
}
async function mappingAndQuarantine(c){
 const p=qi(STAGE),d=stageTable('domains'),n=stageTable('provider_nodes'),tasks=stageTable('provider_node_tasks');
 await c.query(`CREATE TABLE ${p}.domain_map(legacy_id integer PRIMARY KEY REFERENCES ${d}(id),tenant text NOT NULL,fleet text NOT NULL,target_id integer CHECK(target_id IS NULL),candidate_ids jsonb NOT NULL,resolution text NOT NULL CHECK(resolution IN ('NEW_REQUIRES_REVIEW','AMBIGUOUS_FLEET','IDENTITY_REVIEW_REQUIRED')))`);
 await secureTable(c,p+'.domain_map');
 await c.query(`INSERT INTO ${p}.domain_map SELECT s.id,s.tenant,s.fleet,NULL,coalesce((SELECT jsonb_agg(t.id ORDER BY t.id) FROM public.domains t WHERE t.tenant=s.tenant AND lower(btrim(t.domain))=lower(btrim(s.domain))),'[]'::jsonb),CASE WHEN NOT EXISTS(SELECT 1 FROM public.domains t WHERE t.tenant=s.tenant AND lower(btrim(t.domain))=lower(btrim(s.domain))) THEN 'NEW_REQUIRES_REVIEW' WHEN (SELECT count(*) FROM ${d} d2 WHERE d2.tenant=s.tenant AND lower(btrim(d2.domain))=lower(btrim(s.domain)))>1 THEN 'AMBIGUOUS_FLEET' ELSE 'IDENTITY_REVIEW_REQUIRED' END FROM ${d} s`);
 await c.query(`CREATE TABLE ${p}.node_map(legacy_id integer PRIMARY KEY REFERENCES ${n}(id),tenant text NOT NULL,fleet text NOT NULL,target_id integer CHECK(target_id IS NULL),resolution text NOT NULL DEFAULT 'DEVICE_IDENTITY_REVIEW_REQUIRED')`);
 await secureTable(c,p+'.node_map');await c.query(`INSERT INTO ${p}.node_map(legacy_id,tenant,fleet) SELECT id,tenant,fleet FROM ${n}`);
 const idType=(await c.query("SELECT format_type(atttypid,atttypmod) t FROM pg_attribute WHERE attrelid=$1::regclass AND attname='id'",[tasks])).rows[0].t;
 await c.query(`CREATE TABLE ${p}.task_quarantine(task_id ${typeSql(idType)} PRIMARY KEY REFERENCES ${tasks}(id),source_status text,execution_allowed boolean NOT NULL DEFAULT false CHECK(execution_allowed=false))`);
 await secureTable(c,p+'.task_quarantine');
 const first=(await c.query(`INSERT INTO ${p}.task_quarantine(task_id,source_status) SELECT id,status FROM ${tasks}`)).rowCount;
 const second=(await c.query(`INSERT INTO ${p}.task_quarantine(task_id,source_status) SELECT id,status FROM ${tasks} ON CONFLICT(task_id) DO NOTHING`)).rowCount;
 const result=(await c.query(`SELECT count(*)::text total,count(*) FILTER(WHERE source_status IN ('queued','claimed'))::text pending,count(*) FILTER(WHERE execution_allowed)::text executable FROM ${p}.task_quarantine`)).rows[0];
 check(first===61483&&second===0&&result.total==='61483'&&result.pending==='1164'&&result.executable==='0','QUARANTINE_BASELINE_FAILED');
 result.execution_enable_rejected=await expectedFailure(c,`UPDATE ${p}.task_quarantine SET execution_allowed=true WHERE task_id=(SELECT task_id FROM ${p}.task_quarantine LIMIT 1)`,'23514');
 result.unreviewed_domain_mapping_rejected=await expectedFailure(c,`UPDATE ${p}.domain_map SET target_id=1 WHERE legacy_id=(SELECT legacy_id FROM ${p}.domain_map LIMIT 1)`,'23514');
 result.unreviewed_node_mapping_rejected=await expectedFailure(c,`UPDATE ${p}.node_map SET target_id=1 WHERE legacy_id=(SELECT legacy_id FROM ${p}.node_map LIMIT 1)`,'23514');
 result.domain_resolution_counts=(await c.query(`SELECT resolution,count(*)::text count FROM ${p}.domain_map GROUP BY resolution ORDER BY resolution`)).rows;
 result.nodes_pending_identity_review=Number((await c.query(`SELECT count(*)::text count FROM ${p}.node_map WHERE target_id IS NULL`)).rows[0].count);
 result.cross_tenant_legacy_tasks=Number((await c.query(`SELECT count(*)::text count FROM ${tasks} t JOIN ${n} n ON n.id=t.node_id WHERE t.tenant IS DISTINCT FROM n.tenant`)).rows[0].count);
 check(result.cross_tenant_legacy_tasks===35392,'CROSS_TENANT_PROVENANCE_CHANGED');
 const links=[['check_results','domain_id','domains','id'],['alerts','domain_id','domains','id'],['provider_node_tasks','node_id','provider_nodes','id'],['provider_node_task_events','task_id','provider_node_tasks','id'],['provider_node_task_events','node_id','provider_nodes','id'],['rank_scan_results','group_id','rank_keyword_groups','id'],['rank_scan_results','node_id','provider_nodes','id']];
 result.relations=[];for(const [ch,fk,pa,pk] of links){const count=Number((await c.query(`SELECT count(*)::text n FROM ${stageTable(ch)} c LEFT JOIN ${stageTable(pa)} p ON p.${qi(pk)}=c.${qi(fk)} WHERE c.${qi(fk)} IS NOT NULL AND p.${qi(pk)} IS NULL`)).rows[0].n);check(count===0,'ARCHIVE_ORPHAN_FOUND');result.relations.push({child:ch,parent:pa,orphans:count});}
 return result;
}
async function precisionFixture(c){
 const t={name:'precision_fixture',pk:['id'],columns:[{name:'id',type:'bigint',nullable:false},{name:'stamp',type:'timestamp with time zone',nullable:false},{name:'amount',type:'numeric',nullable:false},{name:'raw_json',type:'json',nullable:false},{name:'bytes',type:'bytea',nullable:false}]};
 await c.query(createTableSql(t));await secureTable(c,stageTable(t.name));
 const fixture={id:'9007199254740993',stamp:'2026-10-12 17:10:46.580491+00',amount:'12345678901234567890.123456789',raw_json:'{ "a":1, "a":2, "precise":9007199254740993 }',bytes:'\\x00deadbeef'};
 const payload=JSON.stringify([fixture]);check((await c.query(insertSql(t),[payload])).rowCount===1,'PRECISION_FIXTURE_INSERT_FAILED');
 const row=(await c.query(selectSql(t,STAGE))).rows[0];check(row.encoded===JSON.stringify(fixture),'PRECISION_ROUNDTRIP_FAILED');
 check((await c.query(insertSql(t),[payload])).rowCount===0,'PRECISION_FIXTURE_NOT_IDEMPOTENT');return true;
}
async function securityProbe(c){
 check((await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[PROBE_ROLE])).rowCount===0,'PROBE_ROLE_ALREADY_EXISTS');
 await c.query(`CREATE ROLE ${qi(PROBE_ROLE)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
 await c.query('SAVEPOINT access_probe');
 await c.query(`SET LOCAL ROLE ${qi(PROBE_ROLE)}`);
 let denied=false;try{await c.query(`SELECT count(*) FROM ${stageTable('domains')}`);}catch(e){check(e.code==='42501','UNEXPECTED_SCHEMA_ACCESS_ERROR');denied=true;}
 await c.query('ROLLBACK TO SAVEPOINT access_probe');await c.query('RELEASE SAVEPOINT access_probe');check(denied,'PRIVATE_SCHEMA_ACCESS_NOT_DENIED');
 await c.query(`GRANT USAGE ON SCHEMA ${qi(STAGE)} TO ${qi(PROBE_ROLE)}`);
 await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${qi(STAGE)} TO ${qi(PROBE_ROLE)}`);
 const names=(await c.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[STAGE])).rows;
 await c.query(`SET LOCAL ROLE ${qi(PROBE_ROLE)}`);
 for(const r of names)check((await c.query(`SELECT count(*)::text n FROM ${qi(STAGE)}.${qi(r.tablename)}`)).rows[0].n==='0','RLS_DENY_DEFAULT_FAILED');
 await c.query('RESET ROLE');
 return {schema_access_denied:denied,rls_default_deny_tables:names.length,probe_role_nologin:true};
}
async function main(){
 check(process.argv.slice(2).join(' ')==='--run-local','EXPLICIT_RUN_LOCAL_REQUIRED');
 check(process.platform==='win32'&&path.basename(os.homedir()).toUpperCase()==='MARKSTUDIOS','AUTHORIZED_MACHINE_REQUIRED');
 for(const [name,expected] of [['pentagon-heliumdb-20261012.dump',SOURCE_SHA],[TARGET_FILE,TARGET_SHA],[TARGET_FILE+'.age',ENCRYPTED_SHA]])check(fileHash(path.join(SECURE,name))===expected,'PINNED_BACKUP_HASH_FAILED');
 const {Client}=require('pg');const clients=[];let started=false,source,target,sourceTx=false,targetTx=false;
 const report={report_type:'pentagon_actual_target_private_rehearsal',version:1,started_at_utc:new Date().toISOString(),source_sha256:SOURCE_SHA,target_sha256:TARGET_SHA,source_snapshot:'2026-10-12',target_snapshot:'2026-10-18T04:50:27Z',scope:'private_typed_archive_only',production_sql_connections:0,public_rows_written:0,live_queue_rows_inserted:0,legacy_sensitive_fields:'copied locally, never printed',private_keys_used:false,source_credentials_requested:false,import_allowed:false,uat_ready:false};
 const out=path.join(ROOT,'reconciliation-reports','actual-target-rehearsal-'+Date.now()+'.json');
 let phase='preflight';
 try{
  check(!await portBusy(),'LOCAL_PORT_ALREADY_BUSY');
  const status=spawnSync(path.join(BIN,'pg_ctl.exe'),['-D',CLUSTER,'status'],{env:nativeEnv(),stdio:'ignore',windowsHide:true,timeout:5000});check(status.status===3,'LOCAL_CLUSTER_NOT_STOPPED');
  started=true;ctl(['-D',CLUSTER,'-l',path.join(ROOT,'private-rehearsal-postgres.log'),'-o','-p 55432 -h 127.0.0.1','-w','-t','15','start']);
  for(const db of [SOURCE_DB,TARGET_DB]){const c=new Client(config(db));clients.push(c);await c.connect();await guard(c,db);}
  [source,target]=clients;
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');sourceTx=true;
  await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ');targetTx=true;
  for(const c of clients){await c.query("SET LOCAL statement_timeout='90s'");await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL TIME ZONE 'UTC'");await c.query("SET LOCAL DateStyle='ISO, YMD'");await c.query("SET LOCAL bytea_output='hex'");await c.query("SET LOCAL extra_float_digits=3");await c.query("SET LOCAL log_statement='none'");await c.query("SET LOCAL log_min_error_statement='panic'");}
  const tables=await catalog(source),targetTables=await catalog(target);
  check(tables.length===50&&tables.reduce((a,t)=>a+t.rows,0)===209730&&targetTables.length===23,'SOURCE_TARGET_BASELINES_CHANGED');
  check(!(await target.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[STAGE])).rowCount,'PRIVATE_STAGE_ALREADY_EXISTS');
  report.target_before=await fingerprint(target,targetTables);
  await target.query(`CREATE SCHEMA ${qi(STAGE)}`);await target.query(`REVOKE ALL ON SCHEMA ${qi(STAGE)} FROM PUBLIC`);
  phase='create_typed_tables';for(const t of tables){await target.query(createTableSql(t));await secureTable(target,stageTable(t.name));}
  console.log('PRIVATE_TYPED_TABLES_READY='+tables.length); phase='precision_fixture';report.precision_roundtrip_pass=await precisionFixture(target);
  report.first_pass=[];report.second_pass=[];
  phase='first_pass';for(const t of tables){report.first_pass.push(await copyPass(source,target,t,1));if(t.rows>10000)console.log('FIRST_PASS_TABLE='+t.name+' ROWS='+t.rows);}
  console.log('FIRST_PASS_ROWS='+report.first_pass.reduce((a,t)=>a+t.inserted,0));
  phase='foreign_keys';report.validated_archive_foreign_keys=await foreignKeys(source,target);
  phase='second_pass';for(const t of tables){report.second_pass.push(await copyPass(source,target,t,2));if(t.rows>10000)console.log('SECOND_PASS_TABLE='+t.name+' INSERTS=0');}
  console.log('SECOND_PASS_INSERTS='+report.second_pass.reduce((a,t)=>a+t.inserted,0));
  phase='mapping_quarantine';report.quarantine=await mappingAndQuarantine(target);
  phase='permission_tests';report.security=await securityProbe(target);
  phase='target_preservation';report.target_during=await fingerprint(target,targetTables);check(report.target_during.aggregate_sha256===report.target_before.aggregate_sha256,'PUBLIC_TARGET_CHANGED_DURING_REHEARSAL');
  await target.query('ROLLBACK');targetTx=false;await source.query('ROLLBACK');sourceTx=false;
  phase='post_rollback';report.target_after=await fingerprint(target,targetTables);check(report.target_after.aggregate_sha256===report.target_before.aggregate_sha256,'PUBLIC_TARGET_CHANGED_AFTER_ROLLBACK');
  report.stage_removed=!(await target.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[STAGE])).rowCount;
  report.probe_role_removed=!(await target.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[PROBE_ROLE])).rowCount;
  check(report.stage_removed&&report.probe_role_removed,'ROLLBACK_OBJECTS_REMAIN');
  report.status='PASS';report.source_tables=50;report.source_rows=209730;report.source_columns=tables.reduce((a,t)=>a+t.columns.length,0);
  console.log('ACTUAL_TARGET_PRIVATE_REHEARSAL_PASS');
 }catch(e){report.status='FAILED';report.failure_phase=phase;report.exception_name=e.name;report.error=e.safeCode||'LOCAL_OPERATION_FAILED';report.sqlstate=/^[0-9A-Z]{5}$/.test(e.code||'')?e.code:null;console.error('REHEARSAL_STOPPED='+report.error+' PHASE='+phase+' SQLSTATE='+(report.sqlstate||'none'));process.exitCode=1;}
 finally{
  if(targetTx)await target.query('ROLLBACK').catch(()=>{});if(sourceTx)await source.query('ROLLBACK').catch(()=>{});
  for(const c of clients)await c.end().catch(()=>{});
  if(started){try{ctl(['-D',CLUSTER,'-m','fast','-w','-t','15','stop']);report.local_cluster_stopped=true;}catch{report.local_cluster_stopped=false;report.status='FAILED_CLEANUP';process.exitCode=1;}}
  report.completed_at_utc=new Date().toISOString();fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('REPORT='+out);console.log('LOCAL_CLUSTER_STOPPED='+Boolean(report.local_cluster_stopped));
 }
}
if(require.main===module)main().catch(e=>{console.error('REHEARSAL_BLOCKED='+(e.safeCode||'LOCAL_OPERATION_FAILED'));process.exitCode=1;});
else module.exports={qi,typeSql,stageTable,config,createTableSql,insertSql,selectSql,domainState,addRows,TYPES,SOURCE_DB,TARGET_DB,STAGE};
