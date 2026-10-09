#!/usr/bin/env node
'use strict';
// Back up Pentagon's public application schema only. NEVER restores to a database.
// Uses the existing, checksum-pinned target-preflight parser and verified Supabase CA.
// Run with PostgreSQL 17 client tools available in PATH. No npm install is needed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const PREFLIGHT_SHA = '6a34068a691091967ea6714c4758bfc4325d2d503f6913c3ab9b42a56e478895';
const PROJECT = 'odjsifsxhdesvkyzsnbw';
class Stop extends Error { constructor(code) { super(code); this.code = code; } }
function cleanEnvironment(input) {
  const env = { ...input, LANG: 'C', LC_ALL: 'C' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG') || /DATABASE_URL|^PENTAGON_TARGET_URL$/.test(key) ||
        key === 'NODE_TLS_REJECT_UNAUTHORIZED') delete env[key];
  }
  return env;
}
function pgPassField(value) {
  const text = String(value);
  if (/[\r\n\x00]/.test(text)) throw new Stop('INVALID_PASSWORD_FILE_FIELD');
  return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}
function toolMajor(text, tool) {
  const match = String(text).match(new RegExp('^' + tool + ' \\(PostgreSQL\\) (\\d+)\\.'));
  if (!match || Number(match[1]) !== 17) throw new Stop('POSTGRESQL_17_TOOLS_REQUIRED');
  return 17;
}
function findTool(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  throw new Stop('TOOL_MISSING_' + name.toUpperCase());
}
function command(exe, args, env, logFile, timeout = 600000) {
  // No shell interpolation. Database passwords are NEVER arguments or env values.
  const result = spawnSync(exe, args, {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout, killSignal: 'SIGTERM', maxBuffer: 8 * 1024 * 1024
  });
  if (logFile) fs.writeFileSync(logFile, result.stderr || '', { mode: 0o600 });
  if (result.error || result.status !== 0) {
    const e = String(result.stderr || '');
    let reason = 'COMMAND_FAILED';
    if (/certificate|SSL error|TLS/i.test(e)) reason = 'TLS_VERIFICATION_FAILED';
    else if (/password authentication failed/i.test(e)) reason = 'AUTHENTICATION_FAILED';
    else if (/permission denied/i.test(e)) reason = 'BACKUP_PERMISSION_DENIED';
    else if (result.error?.code === 'ETIMEDOUT' || /timeout|timed out/i.test(e)) reason = 'TIMEOUT';
    throw new Stop(path.basename(exe).toUpperCase() + '_' + reason);
  }
  return result.stdout;
}
function readSecret() {
  try {
    return execFileSync('bash', ['-c',
      'set +x; IFS= read -r -s -p "Paste Pentagon TARGET PostgreSQL URL (hidden): " secret </dev/tty || exit 2; printf "\\n" >/dev/tty; printf "%s" "$secret"'
    ], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 16384 });
  } catch { throw new Stop('INPUT_CANCELLED'); }
}
function dumpArgs(file) {
  // Preserve ownership/ACL metadata in the archive; do not disable RLS or triggers.
  // This is application-scope only, not Auth, Storage, roles, or a full project backup.
  return ['--no-password', '--dbname=postgres', '--format=custom', '--schema=public',
    '--strict-names', '--lock-wait-timeout=10000', '--file=' + file];
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function main(options = {}) {
  const cwd = options.cwd || process.cwd();
  const home = options.home || os.homedir();
  const originalEnv = options.env || process.env;
  const getSecret = options.readSecret || readSecret;
  const env = cleanEnvironment(originalEnv);
  const preflightFile = path.join(cwd, 'pentagon-target-preflight.cjs');
  if (!fs.existsSync(preflightFile) || await hashFile(preflightFile) !== PREFLIGHT_SHA)
    throw new Stop('PREFLIGHT_FILE_MISSING_OR_CHECKSUM_MISMATCH');
  const { parseDestination } = require(preflightFile);
  const caFile = path.resolve(originalEnv.PENTAGON_CA_FILE ||
    path.join(home, 'pentagon-private-backups', 'certs', 'supabase-prod-ca-2021.crt'));
  const ca = fs.readFileSync(caFile, 'utf8');
  const cert = new crypto.X509Certificate(ca);
  if (ca.includes('PRIVATE KEY') || !cert.ca || Date.now() < Date.parse(cert.validFrom) ||
      Date.now() >= Date.parse(cert.validTo)) throw new Stop('CA_INVALID_OR_EXPIRED');
  const tools = {}, versions = {};
  for (const name of ['pg_dump', 'pg_restore', 'psql']) {
    tools[name] = findTool(name, env);
    versions[name] = command(tools[name], ['--version'], env, null, 10000).trim();
    toolMajor(versions[name], name);
  }
  console.log('POSTGRESQL_17_TOOLS_OK');
  const config = parseDestination(getSecret(), caFile);
  const parent = path.join(home, 'pentagon-private-backups', 'target-backups');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const dir = fs.mkdtempSync(path.join(parent, 'pentagon-public-'));
  fs.chmodSync(dir, 0o700);
  const passFile = path.join(dir, '.temporary-pgpass');
  const partial = path.join(dir, 'target-public.dump.partial');
  const archive = path.join(dir, 'target-public.dump');
  let ok = false;
  const cleanup = () => { try { fs.unlinkSync(passFile); } catch {} };
  process.once('exit', cleanup);
  try {
    fs.writeFileSync(passFile,
      [config.host, config.port, config.database, config.user, config.password].map(pgPassField).join(':') + '\n',
      { mode: 0o600, flag: 'wx' });
    const dbEnv = { ...env,
      PGHOST: config.host, PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: config.user,
      PGPASSFILE: passFile, PGSSLMODE: 'verify-full', PGSSLROOTCERT: caFile,
      PGGSSENCMODE: 'disable', PGCONNECT_TIMEOUT: '15', PGCLIENTENCODING: 'UTF8',
      PGAPPNAME: 'pentagon-public-backup',
      PGOPTIONS: '-c default_transaction_read_only=on -c timezone=UTC'
    };
    const identity = JSON.parse(command(tools.psql,
      ['-X', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT json_build_object('database',current_database(),'server_version_num',current_setting('server_version_num'),'read_only',current_setting('transaction_read_only'),'captured_at',now(),'public_tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'))"],
      dbEnv, path.join(dir, 'connection.stderr.log'), 45000));
    if (identity.database !== 'postgres' || identity.read_only !== 'on' ||
        Math.floor(Number(identity.server_version_num) / 10000) !== 17 ||
        Number(identity.public_tables) < 1) throw new Stop('TARGET_VERSION_OR_READ_ONLY_GUARD_FAILED');
    console.log('TARGET_VERIFIED=' + PROJECT + '; READ_ONLY=on; SCOPE=public');
    const started = new Date().toISOString();
    command(tools.pg_dump, dumpArgs(partial), dbEnv, path.join(dir, 'pg_dump.stderr.log'));
    if (!fs.statSync(partial).size) throw new Stop('EMPTY_ARCHIVE');
    const manifest = command(tools.pg_restore, ['--list', partial], env, path.join(dir, 'manifest.stderr.log'));
    if (!/TABLE DATA public /.test(manifest)) throw new Stop('ARCHIVE_HAS_NO_PUBLIC_TABLE_DATA');
    fs.writeFileSync(path.join(dir, 'manifest.txt'), manifest, { mode: 0o600, flag: 'wx' });
    // No -d/--dbname is supplied: this decodes to /dev/null, not to any database.
    command(tools.pg_restore, ['--file=/dev/null', partial], env, path.join(dir, 'decode.stderr.log'));
    const sha256 = await hashFile(partial);
    fs.renameSync(partial, archive);
    fs.chmodSync(archive, 0o600);
    const bytes = fs.statSync(archive).size;
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sha256 + '  target-public.dump\n', { mode: 0o600, flag: 'wx' });
    const report = { project_ref: PROJECT, scope: ['public'], started_at: started,
      completed_at: new Date().toISOString(), identity, versions, archive_bytes: bytes, sha256,
      archive_decode_pass: true, isolated_restore_tested: false, offsite_copy_verified: false,
      includes_auth_storage_or_global_roles: false, no_data_imported: true,
      note: 'Application public-schema archive only. Not a full Supabase project backup. Read detailed logs privately; never publish archives or credentials.' };
    fs.writeFileSync(path.join(dir, 'backup-summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    ok = true;
    console.log('TARGET_PUBLIC_BACKUP_DECODE_PASS');
    console.log('BACKUP=' + archive);
    console.log('BYTES=' + bytes);
    console.log('SHA256=' + sha256);
    console.log('SUMMARY=' + path.join(dir, 'backup-summary.json'));
    console.log('NO_DATA_IMPORTED; SOURCE_DATABASE_URL_UNCHANGED; ISOLATED_RESTORE_NOT_TESTED');
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
    config.password = '';
    if (!ok) console.error('INCOMPLETE_BACKUP_NOT_VALID; private diagnostic directory: ' + dir);
  }
}
if (require.main === module) {
  main().catch(error => {
    const code = /^[A-Z0-9_]+$/.test(String(error.code)) ? error.code : 'BACKUP_OPERATION_FAILED';
    console.error('TARGET_BACKUP_STOPPED: ' + code);
    console.error('No data import or database upgrade was performed. Do not share passwords or raw private logs.');
    process.exitCode = 1;
  });
} else {
  module.exports = { cleanEnvironment, pgPassField, toolMajor, dumpArgs, main };
}
