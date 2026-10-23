#!/usr/bin/env node
'use strict';

// Pentagon destination inventory only. No restore, schema changes, or data writes.
// Run from the original Replit workspace: node pentagon-target-preflight.cjs
// Paste the EXISTING Pentagon Railway DATABASE_URL into the hidden prompt.
// This script never changes process.env.DATABASE_URL or imports the application.
// Optional: PENTAGON_CA_FILE=/private/path/supabase-ca.crt (certificate, not key).
// Documentation: https://supabase.com/docs/guides/database/connecting-to-postgres
//                https://node-postgres.com/features/ssl

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const PROJECT = 'odjsifsxhdesvkyzsnbw';
const IMPORTANT = [
  'projects', 'domains', 'check_results', 'alerts', 'provider_nodes',
  'provider_node_tasks', 'provider_node_task_events', 'node_telemetry',
  'rank_keyword_groups', 'rank_keyword_domains', 'rank_scan_results',
  'shield_links', 'pentagon_usage_logs', 'usage_logs', 'app_settings'
];

class SafeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function parseDestination(raw, caFile) {
  let u;
  try { u = new URL(String(raw || '').trim()); }
  catch { throw new SafeError('INVALID_URL', 'Use a PostgreSQL connection URL, not an API URL or API key.'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hash) {
    throw new SafeError('INVALID_URL', 'Use a correctly URL-encoded PostgreSQL connection URL.');
  }
  let user, password, database;
  try {
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
    database = decodeURIComponent(u.pathname.slice(1));
  } catch { throw new SafeError('INVALID_ENCODING', 'The connection URL contains invalid percent-encoding.'); }
  const host = u.hostname.toLowerCase();
  const direct = host === `db.${PROJECT}.supabase.co`;
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)
    && user === `postgres.${PROJECT}`;
  if ((!direct && !pooler) || (direct && user !== 'postgres')) {
    throw new SafeError('WRONG_TARGET', 'Destination rejected. It must be the existing Pentagon Supabase project, not helium or another project.');
  }
  if ((u.port || '5432') !== '5432' || database !== 'postgres') {
    throw new SafeError('WRONG_MODE', 'Use a direct or session-pooler connection to database postgres on port 5432.');
  }
  if (!password || /YOUR[-_ ]?PASSWORD|\[PASSWORD\]/i.test(password)) {
    throw new SafeError('PASSWORD_MISSING', 'Use the existing complete connection string; do not reset a production password for this test.');
  }
  const ssl = { rejectUnauthorized: true, servername: host };
  if (caFile) {
    let ca;
    try { ca = fs.readFileSync(caFile, 'utf8'); }
    catch { throw new SafeError('CA_FILE_UNREADABLE', 'The specified certificate file could not be read.'); }
    if (!ca.includes('-----BEGIN CERTIFICATE-----') || ca.includes('PRIVATE KEY')) {
      throw new SafeError('CA_FILE_INVALID', 'Use the trusted Supabase root certificate, never a private key.');
    }
    ssl.ca = ca;
  }
  // Use explicit fields, not connectionString: URL sslmode options cannot
  // override certificate validation. No URL query options are forwarded.
  return {
    host, port: 5432, database, user, password, ssl,
    connectionTimeoutMillis: 15000,
    query_timeout: 45000,
    application_name: 'pentagon-readonly-target-preflight'
  };
}

function quoteIdentifier(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function safeCode(error) {
  return /^[A-Z0-9_]{2,64}$/.test(String(error && error.code))
    ? String(error.code) : 'OPERATION_FAILED';
}

const TABLE_SQL = `
SELECT c.oid::text AS oid, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       c.relispartition AS is_partition
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
ORDER BY c.relname`;

const COLUMN_SQL = `
SELECT c.relname AS table_name, a.attnum AS position, a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS sql_type,
       NOT a.attnotnull AS nullable, a.attidentity AS identity_kind,
       a.attgenerated AS generated_kind, d.oid IS NOT NULL AS has_default,
       md5(pg_get_expr(d.adbin, d.adrelid)) AS default_expression_hash
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=c.oid
LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
WHERE n.nspname='public' AND c.relkind IN ('r','p')
  AND a.attnum>0 AND NOT a.attisdropped
ORDER BY c.relname,a.attnum`;

const CONSTRAINT_SQL = `
SELECT c.relname AS table_name, k.conname AS constraint_name, k.contype AS type,
       k.convalidated AS validated, k.condeferrable AS deferrable,
       pg_get_constraintdef(k.oid) AS definition
FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND k.contype IN ('p','u','f')
ORDER BY c.relname,k.conname`;

const SEQUENCE_SQL = `
SELECT tab.relname AS table_name, att.attname AS column_name,
       seq.relname AS sequence_name, s.start_value, s.increment_by,
       s.min_value, s.max_value, s.last_value
FROM pg_class seq JOIN pg_depend dep ON dep.objid=seq.oid
  AND dep.classid='pg_class'::regclass AND dep.refclassid='pg_class'::regclass
  AND dep.deptype IN ('a','i')
JOIN pg_class tab ON tab.oid=dep.refobjid
JOIN pg_namespace ns ON ns.oid=tab.relnamespace
JOIN pg_attribute att ON att.attrelid=tab.oid AND att.attnum=dep.refobjsubid
LEFT JOIN pg_sequences s ON s.schemaname='public' AND s.sequencename=seq.relname
WHERE seq.relkind='S' AND ns.nspname='public'
ORDER BY tab.relname,att.attname`;

async function collectInventory(client) {
  let active = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    active = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    // This does not bypass RLS. It makes insufficient table access an error
    // rather than silently reporting filtered counts as complete counts.
    await client.query('SET LOCAL row_security = off');
    const identity = (await client.query(`SELECT current_database() AS database,
      current_setting('server_version_num') AS server_version_num,
      current_setting('transaction_read_only') AS read_only,
      transaction_timestamp() AS captured_at`)).rows[0];
    if (!identity || identity.read_only !== 'on' || identity.database !== 'postgres') {
      throw new SafeError('READ_ONLY_GUARD_FAILED', 'Read-only transaction verification failed. No migration was attempted.');
    }
    const tables = (await client.query(TABLE_SQL)).rows;
    if (!tables.length || tables.length > 256) {
      throw new SafeError('UNEXPECTED_INVENTORY', 'Empty or unexpectedly large application-table inventory; review the selected database.');
    }
    const columns = (await client.query(COLUMN_SQL)).rows;
    const constraints = (await client.query(CONSTRAINT_SQL)).rows;
    const sequences = (await client.query(SEQUENCE_SQL)).rows;
    const report = {
      report_type: 'pentagon_target_preflight', version: 1,
      expected_project_ref: PROJECT,
      database: identity.database,
      server_version_num: identity.server_version_num,
      captured_at_utc: new Date(identity.captured_at).toISOString(),
      transaction_read_only: true,
      raw_rows_included: false, credentials_included: false,
      migration_allowed: false, parity_tested: false,
      note: 'Inventory only. Sequence positions can advance independently of the transaction snapshot. No automatic import is authorized.',
      tables: [], columns, constraints, sequences, count_errors: []
    };
    for (const table of tables) {
      const hasTenant = columns.some(c => c.table_name === table.table_name && c.column_name === 'tenant');
      await client.query('SAVEPOINT preflight_table');
      try {
        const tenantPart = hasTenant ? `,
          count(*) FILTER (WHERE tenant='admin')::text AS admin_count,
          count(*) FILTER (WHERE tenant='demo')::text AS demo_count,
          count(*) FILTER (WHERE tenant IS NULL OR tenant NOT IN ('admin','demo'))::text AS other_count` : '';
        const sql = `SELECT count(*)::text AS row_count${tenantPart}
                     FROM public.${quoteIdentifier(table.table_name)}`;
        const counts = (await client.query(sql)).rows[0];
        report.tables.push({ ...table, ...counts });
        await client.query('RELEASE SAVEPOINT preflight_table');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT preflight_table');
        await client.query('RELEASE SAVEPOINT preflight_table');
        const detail = { table_name: table.table_name, code: safeCode(error) };
        report.count_errors.push(detail);
        report.tables.push({ ...table, count_status: 'UNVERIFIED', error_code: detail.code });
      }
    }
    report.missing_source_tables = IMPORTANT.filter(name => !tables.some(t => t.table_name === name));
    report.inventory_complete = report.count_errors.length === 0;
    await client.query('COMMIT');
    active = false;
    return report;
  } finally {
    if (active) await client.query('ROLLBACK').catch(() => {});
  }
}

function promptConnection() {
  if (process.env.PENTAGON_TARGET_URL) {
    const value = process.env.PENTAGON_TARGET_URL;
    delete process.env.PENTAGON_TARGET_URL;
    return value;
  }
  // Secret is entered only into the user's local terminal, not chat, a shell
  // command line, a file, or shell history. The bash code itself has no secret.
  try {
    return execFileSync('bash', ['-c',
      'set +x; IFS= read -r -s -p "Paste Pentagon TARGET PostgreSQL URL (hidden): " secret </dev/tty || exit 2; printf "\\n" >/dev/tty; printf "%s" "$secret"'
    ], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 16384 });
  } catch { throw new SafeError('INPUT_CANCELLED', 'No connection was entered. Run this command in an interactive Replit Shell.'); }
}

async function main() {
  let Client;
  try { ({ Client } = createRequire(path.join(process.cwd(), 'package.json'))('pg')); }
  catch { throw new SafeError('PG_NOT_FOUND', 'Run from the Pentagon workspace containing its existing pg dependency; this utility does not install packages.'); }
  const config = parseDestination(promptConnection(), process.env.PENTAGON_CA_FILE);
  const client = new Client(config);
  try {
    await client.connect();
    const report = await collectInventory(client);
    const dir = path.join(os.homedir(), 'pentagon-private-backups', 'target-reports');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(dir, `pentagon-target-${stamp}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(report.inventory_complete ? 'TARGET_INVENTORY_READY' : 'TARGET_INVENTORY_PARTIAL');
    console.log('Project: ' + PROJECT);
    console.log('Public tables: ' + report.tables.length);
    for (const table of report.tables.filter(t => IMPORTANT.includes(t.table_name))) {
      console.log(table.table_name + ': ' + (table.row_count ?? 'UNVERIFIED') +
        (table.admin_count === undefined ? '' : ` (admin=${table.admin_count}, demo=${table.demo_count}, other=${table.other_count})`));
    }
    console.log('Missing source tables: ' + (report.missing_source_tables.join(', ') || 'none'));
    console.log('Report: ' + filename);
    console.log('NO_DATA_IMPORTED; SOURCE_DATABASE_URL_UNCHANGED; PARITY_NOT_TESTED');
    if (!report.inventory_complete) process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
    config.password = '';
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('TARGET_PREFLIGHT_STOPPED: ' + safeCode(error));
    if (error instanceof SafeError) console.error(error.message);
    else if (/CERT|TLS|SELF_SIGNED/.test(safeCode(error))) {
      console.error('Certificate verification failed. Supply the trusted Supabase root certificate using PENTAGON_CA_FILE; do not disable TLS validation.');
    }
    console.error('No database migration was performed. Do not paste credentials or raw connection strings into chat.');
    process.exitCode = 1;
  });
} else {
  module.exports = { PROJECT, IMPORTANT, parseDestination, quoteIdentifier, safeCode, collectInventory };
}
