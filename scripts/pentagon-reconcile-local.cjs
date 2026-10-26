#!/usr/bin/env node
'use strict';
// Reconciliation evidence from the ALREADY RESTORED local Pentagon database.
// No restore, INSERT, UPDATE, DDL, target connection, or background jobs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const PROJECT = 'odjsifsxhdesvkyzsnbw';
const ARCHIVE_SHA = '47f0c597e7dbd1836379c8244ef06ece46b81eeaeb42b5584888cffc36db0937';
const BASELINE = Object.freeze({check_results:'84872', provider_node_tasks:'61483',
  provider_node_task_events:'37989', domains:'18', provider_nodes:'9', alerts:'5'});
const LINKS = [
  ['check_results','domain_id','domains','id'], ['alerts','domain_id','domains','id'],
  ['provider_node_tasks','node_id','provider_nodes','id'],
  ['provider_node_task_events','task_id','provider_node_tasks','id'],
  ['provider_node_task_events','node_id','provider_nodes','id'],
  ['rank_scan_results','group_id','rank_keyword_groups','id'],
  ['rank_scan_results','node_id','provider_nodes','id']
];
class Stop extends Error { constructor(code) { super(code); this.code = code; } }
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
const validCount = x => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
const config = () => ({host:'127.0.0.1', port:55432, database:'pentagon_restore_test',
  user:'pentagon_restore', password:'', ssl:false, options:'-c timezone=UTC',
  connectionTimeoutMillis:10000, query_timeout:120000,
  application_name:'pentagon-local-reconciliation-readonly'});
function validateTarget(t) {
  if (!t || t.report_type !== 'pentagon_target_preflight' || t.version !== 1 ||
      t.expected_project_ref !== PROJECT || t.database !== 'postgres' ||
      t.inventory_complete !== true || t.transaction_read_only !== true ||
      t.raw_rows_included !== false || t.credentials_included !== false ||
      !['tables','columns','constraints','sequences','count_errors'].every(k => Array.isArray(t[k])) ||
      t.count_errors.length || !Number.isFinite(Date.parse(t.captured_at_utc)) ||
      !t.tables.length || t.tables.some(r => !validCount(r.row_count)) ||
      new Set(t.tables.map(r => r.table_name)).size !== t.tables.length) {
    throw new Stop('INVALID_OR_PARTIAL_TARGET_REPORT');
  }
  return t;
}
function compareSchema(s, t) {
  validateTarget(t);
  const tables = new Map(t.tables.map(r => [r.table_name,r]));
  const columns = new Map(t.columns.map(r => [r.table_name + '.' + r.column_name,r]));
  const sourceTables = new Set(s.tables.map(r => r.table_name));
  const sourceColumns = new Set(s.columns.map(r => r.table_name + '.' + r.column_name));
  return {target_captured_at_utc:t.captured_at_utc,
    missing_target_tables:s.tables.filter(r => !tables.has(r.table_name)).map(r => r.table_name),
    target_only_tables:t.tables.filter(r => !sourceTables.has(r.table_name)).map(r => r.table_name),
    source_columns_not_in_target:s.columns.filter(r => !columns.has(r.table_name + '.' + r.column_name)),
    target_only_columns:t.columns.filter(r => !sourceColumns.has(r.table_name + '.' + r.column_name)),
    type_changes:s.columns.flatMap(r => {
      const target = columns.get(r.table_name + '.' + r.column_name);
      return target && target.sql_type !== r.sql_type ? [{table:r.table_name,column:r.column_name,
        source_type:r.sql_type,target_type:target.sql_type}] : [];
    }),
    nullability_risks:s.columns.filter(r => r.nullable && columns.get(r.table_name + '.' + r.column_name)?.nullable === false)
      .map(r => ({table:r.table_name,column:r.column_name})),
    counts:s.tables.map(r => ({table:r.table_name,source:r.row_count,
      target:tables.get(r.table_name)?.row_count ?? null})),
    target_unique_constraints:t.constraints.filter(r => r.type === 'u'),
    target_rls_missing:t.tables.filter(r => r.rls_enabled !== true).map(r => r.table_name),
    target_is_saved_inventory_not_live:true,
    row_identity_mapping_tested:false, database_parity_tested:false, import_allowed:false};
}
async function collect(client) {
  let active = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); active = true;
    await client.query("SET LOCAL statement_timeout = '90s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query('SET LOCAL row_security = off');
    const identity = (await client.query(`SELECT current_database() AS database,
      current_user AS role, host(inet_server_addr()) AS address, inet_server_port() AS port,
      current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_isolation') AS isolation,
      transaction_timestamp() AS captured_at`)).rows[0];
    if (!identity || identity.database !== 'pentagon_restore_test' || identity.role !== 'pentagon_restore' ||
        identity.address !== '127.0.0.1' || Number(identity.port) !== 55432 ||
        identity.read_only !== 'on' || identity.isolation !== 'repeatable read') {
      throw new Stop('LOCAL_RESTORE_IDENTITY_OR_READ_ONLY_GUARD_FAILED');
    }
    const tables = (await client.query(`SELECT c.relname AS table_name,c.relrowsecurity AS rls_enabled
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows;
    if (!tables.length || tables.length > 256) throw new Stop('INVALID_SOURCE_INVENTORY');
    const columns = (await client.query(`SELECT c.relname AS table_name,a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS sql_type,NOT a.attnotnull AS nullable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`)).rows;
    const constraints = (await client.query(`SELECT c.relname AS table_name,k.conname AS constraint_name,
      k.contype AS type,k.convalidated AS validated,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND k.contype IN ('p','u','f','c') ORDER BY c.relname,k.conname`)).rows;
    const has = (table,column) => columns.some(r => r.table_name === table && r.column_name === column);
    const census = [];
    for (const t of tables) {
      const suffix = has(t.table_name,'tenant') ? `,
        count(*) FILTER (WHERE tenant='admin')::text AS admin_count,
        count(*) FILTER (WHERE tenant='demo')::text AS demo_count,
        count(*) FILTER (WHERE tenant IS NULL OR tenant NOT IN ('admin','demo'))::text AS other_count` : '';
      const row = (await client.query(`SELECT count(*)::text AS row_count${suffix}
        FROM public.${qi(t.table_name)}`)).rows[0];
      if (!row || !validCount(row.row_count)) throw new Stop('INVALID_SOURCE_COUNT');
      census.push({...t,...row});
    }
    const links = [];
    for (const [child,fk,parent,pk] of LINKS) {
      if (!has(child,fk) || !has(parent,pk)) {
        links.push({child,fk,parent,status:'NOT_CHECKED_MISSING_COLUMN'}); continue;
      }
      const r = (await client.query(`SELECT count(*)::text AS orphan_count FROM public.${qi(child)} c
        LEFT JOIN public.${qi(parent)} p ON p.${qi(pk)}=c.${qi(fk)}
        WHERE c.${qi(fk)} IS NOT NULL AND p.${qi(pk)} IS NULL`)).rows[0];
      if (!validCount(r?.orphan_count)) throw new Stop('INVALID_ORPHAN_COUNT');
      links.push({child,fk,parent,orphan_count:r.orphan_count});
    }
    let collisions = {status:'NOT_CHECKED_MISSING_COLUMN'};
    if (has('domains','domain')) {
      collisions = (await client.query(`SELECT count(*)::text AS collision_groups,
        coalesce(sum(n),0)::text AS affected_rows FROM (
          SELECT domain,count(*) AS n FROM public.domains WHERE domain IS NOT NULL
          GROUP BY domain HAVING count(*)>1) x`)).rows[0];
    }
    let taskStatuses = [];
    if (has('provider_node_tasks','status')) {
      taskStatuses = (await client.query(`SELECT status,count(*)::text AS row_count
        FROM public.provider_node_tasks GROUP BY status ORDER BY status`)).rows;
      if (taskStatuses.some(r => !validCount(r.row_count))) throw new Stop('INVALID_TASK_STATUS_COUNT');
    }
    const baselineMismatch = Object.entries(BASELINE).filter(([t,n]) => census.find(r => r.table_name===t)?.row_count !== n)
      .map(([table,expected]) => ({table,expected,actual:census.find(r => r.table_name===table)?.row_count ?? null}));
    const report = {report_type:'pentagon_local_reconciliation',version:1,
      captured_at_utc:new Date(identity.captured_at).toISOString(),identity,tables:census,columns,constraints,
      baseline_mismatches:baselineMismatch,expected_public_tables:50,table_count_matches_baseline:tables.length===50,
      relation_checks:links,source_global_domain_collisions:collisions,task_status_counts:taskStatuses,
      task_replay_policy:'Do not import into the live polling queue until every source status and target ID collision is reviewed.',
      source_schema_discovery_complete:true,raw_rows_included:false,credentials_included:false,
      import_allowed:false,uat_ready:false,parity_tested:false};
    await client.query('ROLLBACK'); active = false;
    return report;
  } finally { if (active) await client.query('ROLLBACK').catch(() => {}); }
}
async function fileHash(filename) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) h.update(chunk);
  return h.digest('hex');
}
async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Stop('USAGE_OPTIONAL_TARGET_REPORT_PATH_ONLY');
  const target = args[0] ? validateTarget(JSON.parse(fs.readFileSync(args[0],'utf8').replace(/^\uFEFF/,''))) : null;
  const backup = path.join(os.homedir(),'Pentagon-Secure-Backups','pentagon-heliumdb-20261012.dump');
  if (await fileHash(backup) !== ARCHIVE_SHA) throw new Stop('LOCAL_BACKUP_SHA256_MISMATCH');
  const { Client } = createRequire(path.join(process.cwd(),'package.json'))('pg');
  const client = new Client(config());
  try {
    await client.connect();
    const report = await collect(client); report.archive_sha256 = ARCHIVE_SHA;
    if (target) report.target_comparison = compareSchema(report,target);
    const dir = path.join(os.homedir(),'Pentagon-Migration-Audit','reconciliation-reports');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const out = path.join(dir,'source-reconciliation-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex')+'.json');
    fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log('LOCAL_RECONCILIATION_INVENTORY_READY');
    console.log('TABLES='+report.tables.length+'; BASELINE_DIFFERENCES='+report.baseline_mismatches.length);
    console.log('REPORT='+out);
    console.log('NO_DATA_IMPORTED; ROW_MAPPING_NOT_TESTED; UAT_NOT_READY');
  } finally { await client.end().catch(() => {}); }
}
if (require.main === module) main().catch(e => {
  console.error('LOCAL_RECONCILIATION_STOPPED:'+(/^[A-Z0-9_]{2,80}$/.test(String(e.code))?e.code:'OPERATION_FAILED'));
  process.exitCode=1;
});
else module.exports={config,qi,validCount,validateTarget,compareSchema,collect,BASELINE};
