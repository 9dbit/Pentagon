#!/usr/bin/env node
'use strict';
// Read-only backup of Pentagon's Replit heliumdb. No restore, imports, or cloud mutation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

class Stop extends Error {
  constructor(code) { super(code); this.code = code; }
}
function guardUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Stop('INVALID_SOURCE_URL'); }
  let db, user, password;
  try {
    db = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch { throw new Stop('INVALID_SOURCE_ENCODING'); }
  const host = url.hostname.toLowerCase();
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || db !== 'heliumdb' ||
      !host || /supabase\.co$|railway\.(app|internal)$/.test(host) || url.hash ||
      !user || !password) throw new Stop('WRONG_SOURCE_DATABASE');
  const port = Number(url.port || '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Stop('INVALID_SOURCE_PORT');
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode && !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode)) {
    throw new Stop('UNSUPPORTED_SOURCE_SSLMODE');
  }
  return { host, port, db, user, password, sslmode };
}
function cleanEnv(input) {
  const env = { ...input, LANG: 'C', LC_ALL: 'C' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG') || /DATABASE_URL|^PENTAGON_TARGET_URL$/.test(key) ||
        key === 'NODE_TLS_REJECT_UNAUTHORIZED') delete env[key];
  }
  return env;
}
function passField(value) {
  const text = String(value);
  if (/[\r\n\x00]/.test(text)) throw new Stop('INVALID_CREDENTIAL_FIELD');
  return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}
function requireTool(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch {}
  }
  throw new Stop('MISSING_' + name.toUpperCase());
}
function run(exe, args, env, logPath, timeout = 600000) {
  const result = spawnSync(exe, args, {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    killSignal: 'SIGTERM', maxBuffer: 12 * 1024 * 1024
  });
  if (logPath) fs.writeFileSync(logPath, result.stderr || '', { flag: 'wx', mode: 0o600 });
  if (result.error || result.status !== 0) {
    const stderr = String(result.stderr || '');
    let reason = 'COMMAND_FAILED';
    if (/authentication failed|no password supplied|password is required/i.test(stderr)) reason = 'AUTH_FAILED';
    else if (/certificate|SSL error|TLS/i.test(stderr)) reason = 'SSL_FAILED';
    else if (/permission denied/i.test(stderr)) reason = 'PERMISSION_DENIED';
    else if (result.error?.code === 'ETIMEDOUT' || /timeout|timed out/i.test(stderr)) reason = 'TIMEOUT';
    else if (/server version mismatch|aborting because of server version/i.test(stderr)) reason = 'PG_VERSION_MISMATCH';
    throw new Stop(path.basename(exe).toUpperCase() + '_' + reason);
  }
  return result.stdout;
}
async function hashFile(file) {
  const sha = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk);
  return sha.digest('hex');
}
async function inspectSource(Client, raw) {
  const client = new Client({ connectionString: raw, connectionTimeoutMillis: 15000 });
  let active = false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    active = true;
    await client.query("SET LOCAL statement_timeout = '60s'");
    const result = await client.query(
      "SELECT current_database() AS database, " +
      "current_setting('transaction_read_only') AS read_only, " +
      "current_setting('server_version_num') AS server_version_num, " +
      "(SELECT count(*) FROM public.check_results)::text AS check_results, " +
      "(SELECT count(*) FROM public.provider_node_tasks)::text AS provider_node_tasks, " +
      "(SELECT count(*) FROM public.provider_nodes WHERE tenant='admin')::text AS admin_nodes, " +
      "(SELECT count(*) FROM public.domains)::text AS domains"
    );
    const row = result.rows[0];
    if (!row || row.database !== 'heliumdb' || row.read_only !== 'on' ||
        Number(row.check_results) < 76856 ||
        Number(row.provider_node_tasks) < 55456 ||
        Number(row.admin_nodes) < 6 || Number(row.domains) < 18) {
      throw new Stop('SOURCE_BASELINE_OR_READ_ONLY_GUARD_FAILED');
    }
    await client.query('ROLLBACK');
    active = false;
    return row;
  } finally {
    if (active) await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}
async function main() {
  process.umask(0o077);
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Stop('DATABASE_URL_MISSING');
  const source = guardUrl(raw);
  const { Client } = createRequire(path.join(process.cwd(), 'package.json'))('pg');
  const identity = await inspectSource(Client, raw);
  console.log('SOURCE_BASELINE_VERIFIED; DATABASE=heliumdb; READ_ONLY=on');
  console.log('CHECK_RESULTS=' + identity.check_results + '; PROVIDER_NODE_TASKS=' + identity.provider_node_tasks);
  const env = cleanEnv(process.env);
  const pgDump = requireTool('pg_dump', env);
  const pgRestore = requireTool('pg_restore', env);
  const versions = {
    pg_dump: run(pgDump, ['--version'], env, null, 10000).trim(),
    pg_restore: run(pgRestore, ['--version'], env, null, 10000).trim()
  };
  const major = Number(String(versions.pg_dump).match(/PostgreSQL\) (\d+)/)?.[1]);
  const restoreMajor = Number(String(versions.pg_restore).match(/PostgreSQL\) (\d+)/)?.[1]);
  const serverMajor = Math.floor(Number(identity.server_version_num) / 10000);
  if (!Number.isInteger(major) || major < serverMajor || !Number.isInteger(restoreMajor) || restoreMajor < major) {
    throw new Stop('INCOMPATIBLE_POSTGRES_TOOLS');
  }
  console.log('BACKUP_TOOLS_OK; SERVER_MAJOR=' + serverMajor + '; PG_DUMP_MAJOR=' + major);
  const parent = path.join(os.homedir(), 'pentagon-private-backups', 'source-backups');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const dir = fs.mkdtempSync(path.join(parent, 'heliumdb-'));
  fs.chmodSync(dir, 0o700);
  const passFile = path.join(dir, '.pgpass.temporary');
  const partial = path.join(dir, 'pentagon-source.dump.partial');
  const archive = path.join(dir, 'pentagon-source.dump');
  let complete = false;
  const removePassword = () => { try { fs.unlinkSync(passFile); } catch {} };
  process.once('exit', removePassword);
  try {
    fs.writeFileSync(passFile, [source.host, source.port, source.db, source.user, source.password]
      .map(passField).join(':') + '\n', { mode: 0o600, flag: 'wx' });
    source.password = '';
    const pgEnv = { ...env,
      PGHOST: source.host, PGPORT: String(source.port), PGDATABASE: source.db,
      PGUSER: source.user, PGPASSFILE: passFile, PGCONNECT_TIMEOUT: '15',
      PGAPPNAME: 'pentagon-source-backup', PGCLIENTENCODING: 'UTF8',
      PGGSSENCMODE: 'disable'
    };
    if (source.sslmode) pgEnv.PGSSLMODE = source.sslmode;
    const started = new Date().toISOString();
    run(pgDump, ['--no-password', '--dbname=heliumdb', '--format=custom',
      '--lock-wait-timeout=10000', '--file=' + partial], pgEnv,
      path.join(dir, 'pg_dump.stderr.log'), 1200000);
    const size = fs.statSync(partial).size;
    if (size < 1024) throw new Stop('ARCHIVE_TOO_SMALL');
    const toc = run(pgRestore, ['--list', partial], env,
      path.join(dir, 'manifest.stderr.log'), 60000);
    for (const table of ['check_results', 'provider_node_tasks', 'provider_node_task_events', 'domains', 'provider_nodes']) {
      if (!new RegExp('TABLE DATA public ' + table + ' ').test(toc))
        throw new Stop('ARCHIVE_MISSING_' + table.toUpperCase());
    }
    fs.writeFileSync(path.join(dir, 'manifest.txt'), toc, { flag: 'wx', mode: 0o600 });
    run(pgRestore, ['--file=/dev/null', partial], env,
      path.join(dir, 'decode.stderr.log'), 1200000);
    const checksum = await hashFile(partial);
    fs.renameSync(partial, archive);
    fs.chmodSync(archive, 0o600);
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), checksum + '  pentagon-source.dump\n',
      { mode: 0o600, flag: 'wx' });
    const report = {
      type: 'pentagon_heliumdb_source_backup', version: 1, source_database: 'heliumdb',
      source_server_version_num: identity.server_version_num,
      source_baseline_pre_dump: {
        check_results: identity.check_results, provider_node_tasks: identity.provider_node_tasks,
        admin_nodes: identity.admin_nodes, domains: identity.domains
      },
      note: 'Live source counts can change during backup; these are pre-dump, not archive equality assertions.',
      started_at: started, completed_at: new Date().toISOString(), versions,
      bytes: size, sha256: checksum, archive_decode_pass: true,
      isolated_restore_tested: false, encrypted_offsite_copy_verified: false,
      no_data_imported: true, source_database_modified: false
    };
    fs.writeFileSync(path.join(dir, 'backup-summary.json'), JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    complete = true;
    console.log('SOURCE_BACKUP_DECODE_PASS');
    console.log('BACKUP=' + archive);
    console.log('BYTES=' + size);
    console.log('SHA256=' + checksum);
    console.log('SUMMARY=' + path.join(dir, 'backup-summary.json'));
    console.log('OFFSITE_COPY_NOT_VERIFIED; ISOLATED_RESTORE_NOT_TESTED; NO_DATA_IMPORTED');
  } finally {
    removePassword();
    process.removeListener('exit', removePassword);
    if (!complete) console.error('INCOMPLETE_SOURCE_BACKUP_NOT_VALID; PRIVATE_DIR=' + dir);
  }
}
if (require.main === module) {
  main().catch(error => {
    const code = /^[A-Z0-9_]{2,64}$/.test(String(error?.code)) ? error.code : 'BACKUP_OPERATION_FAILED';
    console.error('SOURCE_BACKUP_STOPPED: ' + code);
    console.error('No data was imported. Do not share private logs or credentials.');
    process.exitCode = 1;
  });
} else {
  module.exports = { guardUrl, cleanEnv, passField, inspectSource };
}
