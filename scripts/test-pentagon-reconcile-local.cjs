'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {config,qi,validCount,validateTarget,compareSchema,collect,BASELINE}=require('./pentagon-reconcile-local.cjs');
const names=[...Object.keys(BASELINE),'rank_keyword_groups','rank_scan_results'];
const columns=names.flatMap(table_name => ['id','tenant','fleet'].map(column_name => ({table_name,column_name,sql_type:'text',nullable:true})));
for(const [table_name,column_name] of [['domains','domain'],['check_results','domain_id'],['alerts','domain_id'],['provider_node_tasks','node_id'],['provider_node_tasks','status'],['provider_node_task_events','task_id'],['provider_node_task_events','node_id'],['rank_scan_results','group_id'],['rank_scan_results','node_id']]) columns.push({table_name,column_name,sql_type:'text',nullable:true});
function source(){return {tables:names.map(table_name=>({table_name,row_count:BASELINE[table_name]||'2',rls_enabled:false})),columns:structuredClone(columns),constraints:[]};}
function target(){const s=source();return {...s,report_type:'pentagon_target_preflight',version:1,expected_project_ref:'odjsifsxhdesvkyzsnbw',database:'postgres',inventory_complete:true,transaction_read_only:true,raw_rows_included:false,credentials_included:false,sequences:[],count_errors:[],captured_at_utc:'2026-10-09T14:52:45.825Z',tables:s.tables.map(r=>({...r,rls_enabled:true}))};}
function fake({identityPatch={},failCounts=false,orphan='0'}={}) {
 const calls=[];
 return {calls,async query(sql){calls.push(sql);const q=sql.trim();
   if (/^(BEGIN|SET|ROLLBACK)/.test(q))return {rows:[]};
   if(q.startsWith('SELECT current_database')) return {rows:[{database:'pentagon_restore_test',role:'pentagon_restore',address:'127.0.0.1',port:55432,read_only:'on',isolation:'repeatable read',captured_at:'2026-10-13T00:00:00Z',...identityPatch}]};
   if(q.includes('pg_attribute'))return {rows:structuredClone(columns)};
   if(q.includes('pg_constraint'))return {rows:[]};
   if(q.includes('FROM pg_class'))return {rows:source().tables.map(({table_name,rls_enabled})=>({table_name,rls_enabled}))};
   if(q.includes(' AS orphan_count '))return {rows:[{orphan_count:orphan}]};
   if(q.includes(' AS collision_groups,'))return {rows:[{collision_groups:'2',affected_rows:'4'}]};
   if(q.startsWith('SELECT status,'))return {rows:[{status:'queued',row_count:'7'},{status:'done',row_count:'61476'}]};
   if(q.startsWith('SELECT count(*)::text AS row_count')) {
     if(failCounts)throw Object.assign(new Error('private DB message must not become a report'),{code:'42501'});
     const table=q.match(/FROM public\."([^"]+)"/)[1];
     return {rows:[{row_count:BASELINE[table]||'2',admin_count:'2',demo_count:'0',other_count:'0'}]};
   }
   throw new Error('Unexpected query '+q);
 }};
}
test('connection config is fixed to local restore, ignores PG/DATABASE_URL',()=>{
 const previous=process.env.DATABASE_URL;process.env.DATABASE_URL='postgres://PRODUCTION.invalid';
 try{assert.deepEqual([config().host,config().port,config().database],['127.0.0.1',55432,'pentagon_restore_test']);assert.equal(config().connectionString,undefined);}finally{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;}
});
test('identifier quoting escapes quotes',()=>assert.equal(qi('a"b'),'"a""b"'));
test('counts reject negatives, NaN, numeric objects and missing',()=>{for(const n of [-1,'-1','NaN',null,undefined,'01'])assert.equal(validCount(n),false);assert.equal(validCount('84872'),true);});
test('target report validates only the specified Supabase project',()=>{const t=target();t.expected_project_ref='wrong';assert.throws(()=>validateTarget(t),/INVALID/);});
test('partial target inventory is rejected',()=>{const t=target();t.inventory_complete=false;assert.throws(()=>validateTarget(t));});
test('target error entries are rejected',()=>{const t=target();t.count_errors=[{code:'42501'}];assert.throws(()=>validateTarget(t));});
test('reports with raw data or credentials are rejected',()=>{for(const key of ['raw_rows_included','credentials_included']){const t=target();t[key]=true;assert.throws(()=>validateTarget(t));}});
test('duplicate table or missing count rejects target report',()=>{const t=target();t.tables.push({...t.tables[0]});assert.throws(()=>validateTarget(t));const b=target();delete b.tables[0].row_count;assert.throws(()=>validateTarget(b));});
test('schema comparison flags omitted history table without discarding it',()=>{const t=target();t.tables=t.tables.filter(r=>r.table_name!=='provider_node_task_events');const r=compareSchema(source(),t);assert.ok(r.missing_target_tables.includes('provider_node_task_events'));assert.equal(r.import_allowed,false);});
test('schema comparison preserves target-only bootstrap columns',()=>{const t=target();t.columns.push({table_name:'provider_nodes',column_name:'bootstrap_install_id',sql_type:'text',nullable:true});const r=compareSchema(source(),t);assert.equal(r.target_only_columns[0].column_name,'bootstrap_install_id');});
test('timestamp timezone and nullability changes require review',()=>{const s=source(),t=target();s.columns.push({table_name:'check_results',column_name:'checked_at',sql_type:'timestamp with time zone',nullable:true});t.columns.push({table_name:'check_results',column_name:'checked_at',sql_type:'timestamp without time zone',nullable:false});const r=compareSchema(s,t);assert.equal(r.type_changes[0].column,'checked_at');assert.equal(r.nullability_risks[0].column,'checked_at');});
test('even matching schema is not row-level parity or import authorization',()=>{const r=compareSchema(source(),target());assert.deepEqual(r.missing_target_tables,[]);assert.equal(r.database_parity_tested,false);assert.equal(r.row_identity_mapping_tested,false);assert.equal(r.import_allowed,false);});
test('collector uses an explicit read-only snapshot and performs no writes',async()=>{const c=fake(),r=await collect(c);assert.equal(c.calls[0],'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.ok(c.calls.every(q=>/^(BEGIN|SET LOCAL|SELECT|ROLLBACK)/.test(q.trim())));assert.equal(c.calls.at(-1),'ROLLBACK');assert.deepEqual(r.baseline_mismatches,[]);assert.equal(r.uat_ready,false);assert.equal(r.raw_rows_included,false);});
for(const [key,value] of Object.entries({database:'postgres',role:'postgres',address:'10.0.0.1',port:5432,read_only:'off',isolation:'read committed'}))test('wrong '+key+' aborts before table reads',async()=>{const c=fake({identityPatch:{[key]:value}});await assert.rejects(()=>collect(c),/GUARD_FAILED/);assert.equal(c.calls.at(-1),'ROLLBACK');assert.equal(c.calls.some(q=>q.includes('FROM pg_class')),false);});
test('count access denied never becomes a false zero or pass',async()=>{const c=fake({failCounts:true});await assert.rejects(()=>collect(c),e=>e.code==='42501');assert.equal(c.calls.at(-1),'ROLLBACK');});
test('orphan counts and queued history are visible but never replayed',async()=>{const c=fake({orphan:'3'}),r=await collect(c);assert.equal(r.relation_checks[0].orphan_count,'3');assert.equal(r.source_global_domain_collisions.collision_groups,'2');assert.equal(r.task_status_counts[0].status,'queued');assert.equal(r.task_status_counts[0].row_count,'7');assert.equal(r.import_allowed,false);});
