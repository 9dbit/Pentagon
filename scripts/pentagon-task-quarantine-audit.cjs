#!/usr/bin/env node
'use strict';
// Pentagon source task/tenant quarantine audit. Run only against the verified
// restored local PostgreSQL snapshot. Never connects to Replit or Supabase.
// Every database operation runs inside one READ ONLY transaction.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const EXPECTED_BACKUP_SHA256 = '47f0c597e7dbd1836379c8244ef06ece46b81eeaeb42b5584888cffc36db0937';
const BASELINE = Object.freeze({check_results:'84872',provider_node_tasks:'61483',
  provider_node_task_events:'37989',domains:'18',provider_nodes:'9'});
const toCount = (x) => {
  if (typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x) || !Number.isSafeInteger(Number(x)))
    throw new Error('INVALID_AGGREGATE_COUNT');
  return Number(x);
};
function assess(data) {
  const collisions = toCount(data.scoped_collision_groups);
  const mismatch = toCount(data.task_node_tenant_mismatch);
  const fleetMismatch = toCount(data.task_node_fleet_mismatch);
  const deviceDuplicates = toCount(data.duplicate_node_device_id_groups);
  const open = toCount(data.replay_risk_tasks);
  const orphan = toCount(data.orphan_task_node) + toCount(data.orphan_event_task);
  const keyless = toCount(data.event_missing_idempotency_key);
  const baselineErrors = Object.entries(BASELINE).filter(([table,expected]) =>
    data.baseline[table] !== expected).map(([table])=>table);
  const blockers = [];
  if (baselineErrors.length) blockers.push('SOURCE_SNAPSHOT_BASELINE_MISMATCH');
  if (collisions) blockers.push('SOURCE_DOMAIN_SCOPE_COLLISION');
  if (mismatch) blockers.push('CROSS_TENANT_TASK_NODE_REFERENCES_REQUIRE_REVIEW');
  if (fleetMismatch) blockers.push('CROSS_FLEET_TASK_NODE_REFERENCES_REQUIRE_REVIEW');
  if (deviceDuplicates) blockers.push('DUPLICATE_DEVICE_IDENTITY_REQUIRES_REVIEW');
  if (open) blockers.push('HISTORICAL_PENDING_TASKS_MUST_BE_QUARANTINED');
  if (orphan) blockers.push('HISTORICAL_ORPHAN_RELATIONSHIP');
  if (keyless) blockers.push('TASK_EVENT_IDEMPOTENCY_KEY_MISSING');
  return {blockers,baseline_errors:baselineErrors,
    source_domain_scoped_key_unique:collisions===0,
    cross_tenant_task_count:mismatch, cross_fleet_task_count:fleetMismatch,
    duplicated_device_id_groups:deviceDuplicates, pending_task_count:open,
    task_replay_permitted:false, source_target_mapping_verified:false,
    target_data_import_permitted:false, uat_ready:false};
}
async function hashFile(file) {
  const h=crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function audit(client) {
  let active=false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    active=true;
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const id=(await client.query(`SELECT current_database() AS db,current_user AS username,
      host(inet_server_addr()) AS host,inet_server_port() AS port,
      current_setting('transaction_read_only') AS readonly,
      current_setting('transaction_isolation') AS isolation,
      transaction_timestamp() AS taken_at`)).rows[0];
    if (!id || id.db!=='pentagon_restore_test' || id.username!=='pentagon_restore' ||
        id.host!=='127.0.0.1' || Number(id.port)!==55432 ||
        id.readonly!=='on' || id.isolation!=='repeatable read')
      throw new Error('LOCAL_RESTORE_IDENTITY_GUARD_FAILED');
    const baseline={};
    for (const table of Object.keys(BASELINE)) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('INVALID_TABLE');
      baseline[table]=(await client.query('SELECT count(*)::text AS n FROM public."'+table+'"')).rows[0].n;
    }
    const scoped=(await client.query(`SELECT count(*)::text AS groups,COALESCE(sum(n),0)::text AS rows
      FROM (SELECT tenant,fleet,lower(btrim(domain)) AS norm,count(*) AS n
        FROM public.domains GROUP BY 1,2,3 HAVING count(*)>1) d`)).rows[0];
    const global=(await client.query(`SELECT count(*)::text AS groups,COALESCE(sum(n),0)::text AS rows
      FROM (SELECT lower(btrim(domain)) AS norm,count(*) AS n
        FROM public.domains GROUP BY 1 HAVING count(*)>1) d`)).rows[0];
    const byStatus=(await client.query(`SELECT t.tenant AS task_tenant,n.tenant AS node_tenant,
      t.status,count(*)::text AS count FROM public.provider_node_tasks t
      JOIN public.provider_nodes n ON n.id=t.node_id
      GROUP BY 1,2,3 ORDER BY 1,2,3`)).rows;
    const checks=(await client.query(`SELECT
      (SELECT count(*)::text FROM public.provider_node_tasks t
        JOIN public.provider_nodes n ON n.id=t.node_id
        WHERE t.tenant IS DISTINCT FROM n.tenant) AS task_node_tenant_mismatch,
      (SELECT count(DISTINCT t.node_id)::text FROM public.provider_node_tasks t
        JOIN public.provider_nodes n ON n.id=t.node_id
        WHERE t.tenant IS DISTINCT FROM n.tenant) AS affected_node_count,
      (SELECT count(*)::text FROM public.provider_node_tasks t
        JOIN public.provider_nodes n ON n.id=t.node_id
        WHERE t.fleet IS DISTINCT FROM n.fleet) AS task_node_fleet_mismatch,
      (SELECT count(*)::text FROM public.provider_node_tasks
        WHERE status IN ('queued','claimed')) AS replay_risk_tasks,
      (SELECT count(*)::text FROM public.provider_node_tasks t
        LEFT JOIN public.provider_nodes n ON n.id=t.node_id
        WHERE t.node_id IS NOT NULL AND n.id IS NULL) AS orphan_task_node,
      (SELECT count(*)::text FROM public.provider_node_task_events e
        LEFT JOIN public.provider_node_tasks t ON t.id=e.task_id
        WHERE e.task_id IS NOT NULL AND t.id IS NULL) AS orphan_event_task,
      (SELECT count(*)::text FROM public.provider_node_task_events
        WHERE idempotency_key IS NULL OR btrim(idempotency_key)='') AS event_missing_idempotency_key,
      (SELECT count(*)::text FROM (SELECT lower(btrim(device_id))
        FROM public.provider_nodes WHERE nullif(btrim(device_id),'') IS NOT NULL
        GROUP BY 1 HAVING count(*)>1) d) AS duplicate_node_device_id_groups`)).rows[0];
    const metrics={baseline,scoped_collision_groups:scoped.groups,
      scoped_collision_rows:scoped.rows,global_collision_groups:global.groups,
      global_collision_rows:global.rows,...checks,
      task_tenant_node_tenant_status:byStatus.map(r=>({
        task_tenant:r.task_tenant,node_tenant:r.node_tenant,status:r.status,count:r.count}))};
    const decision=assess(metrics);
    const report={report_type:'pentagon_source_task_quarantine',version:1,
      timestamp_utc:new Date(id.taken_at).toISOString(),
      source:'isolated_local_restore',backup_sha256:EXPECTED_BACKUP_SHA256,
      public_task_data_exported:false, credentials_included:false,
      database_read_only:true, target_connected:false,metrics,decision};
    await client.query('ROLLBACK');
    active=false;
    return report;
  } finally {
    if (active) await client.query('ROLLBACK').catch(()=>{});
  }
}
async function main() {
  if (process.argv.length!==2) throw new Error('NO_CLI_ARGUMENTS_ALLOWED');
  process.umask(0o077);
  const backup=path.join(os.homedir(),'Pentagon-Secure-Backups',
    'pentagon-heliumdb-20261012.dump');
  if (await hashFile(backup)!==EXPECTED_BACKUP_SHA256) throw new Error('BACKUP_HASH_MISMATCH');
  const {Client}=createRequire(path.join(process.cwd(),'package.json'))('pg');
  const client=new Client({host:'127.0.0.1',port:55432,database:'pentagon_restore_test',
    user:'pentagon_restore',ssl:false,application_name:'pentagon-task-quarantine-readonly',
    connectionTimeoutMillis:10000,query_timeout:130000});
  let report;
  try {
    await client.connect();
    report=await audit(client);
  } finally {
    await client.end().catch(()=>{});
  }
  const folder=path.join(os.homedir(),'Pentagon-Migration-Audit','reconciliation-reports');
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const file=path.join(folder,'task-quarantine-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex')+'.json');
  fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('QUARANTINE_AUDIT_COMPLETED');
  console.log('CROSS_TENANT_TASKS='+report.decision.cross_tenant_task_count);
  console.log('PENDING_HISTORICAL_TASKS='+report.decision.pending_task_count);
  console.log('SOURCE_SCOPED_DOMAIN_KEY_UNIQUE='+report.decision.source_domain_scoped_key_unique);
  console.log('MIGRATION_BLOCKERS='+report.decision.blockers.join(','));
  console.log('REPORT='+file);
  console.log('NO_IMPORT; NO_TASK_REPLAY; UAT_NOT_READY');
}
if(require.main===module) main().catch(e=>{
  const msg=String(e.message||'UNKNOWN');
  console.error('QUARANTINE_AUDIT_STOPPED:'+(/^[A-Z0-9_]{3,80}$/.test(msg)?msg:'OPERATION_FAILED'));
  process.exitCode=1;
});
else module.exports={assess,toCount,BASELINE};
