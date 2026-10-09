#!/usr/bin/env node
"use strict";

/**
 * Read-only Pentagon PostgreSQL parity audit.
 *
 * Run on the SOURCE Replit environment:
 *   node scripts/migration-audit.js --out=source-audit.json
 * Run on the TARGET Railway/Supabase environment:
 *   node scripts/migration-audit.js --out=target-audit.json --compare=source-audit.json
 *
 * Uses an existing DATABASE_URL. Never prints credentials or raw table rows.
 * Use --development ONLY when intentionally auditing the legacy
 * DATABASE_URL_DEVELOPMENT (not for Railway production).
 */
const { Client } = require("pg");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const flag = (prefix) => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
const development = argv.includes("--development");
const outputPath = flag("--out=");
const comparisonPath = flag("--compare=");
const connectionString = development
  ? process.env.DATABASE_URL_DEVELOPMENT
  : process.env.DATABASE_URL;

const VOLATILE = new Set([
  "pentagon_http_sessions", "user_sessions", "node_telemetry",
  "provider_node_tasks", "analytics_cache", "domain_intel_cache"
]);
function fail(message) {
  console.error("[Pentagon audit] " + message);
  process.exitCode = 2;
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function identifier(s) {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(s)) throw Error("Invalid table name");
  return '"' + s + '"';
}
function compareSnapshots(source, target) {
  const expected = new Map(source.tables.map((t) => [t.name, t]));
  const actual = new Map(target.tables.map((t) => [t.name, t]));
  const names = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const differences = names.map((name) => {
    const a = expected.get(name), b = actual.get(name);
    const status = !a ? "ADDED_ON_TARGET"
      : !b ? "MISSING_ON_TARGET"
      : a.error || b.error ? "AUDIT_ERROR"
      : a.count !== b.count ? "COUNT_MISMATCH"
      : a.row_digest !== b.row_digest ? "DATA_MISMATCH"
      : a.schema_digest !== b.schema_digest ? "SCHEMA_MISMATCH"
      : "MATCH";
    return { table: name, category: VOLATILE.has(name) ? "volatile" : "business",
      source_count: a?.count ?? null, target_count: b?.count ?? null, status };
  });
  const blocking = differences.filter((t) => t.category === "business" && t.status !== "MATCH");
  const warnings = differences.filter((t) => t.category === "volatile" && t.status !== "MATCH");
  return { ready_to_cutover: blocking.length === 0 && source.errors.length === 0
    && target.errors.length === 0 && source.all_fk_valid && target.all_fk_valid,
    blocking, volatile_differences: warnings, per_table: differences };
}
async function run() {
  if (!connectionString) {
    fail("Missing selected connection URL. Set DATABASE_URL or use --development.");
    return;
  }
  const u = new URL(connectionString);
  if (!["postgresql:", "postgres:"].includes(u.protocol)) {
    fail("Selected DATABASE_URL must use postgresql:// or postgres://.");
    return;
  }
  const client = new Client({
    connectionString,
    // Replit's original PostgreSQL endpoint is the private host 'helium'.
    // It does not necessarily offer TLS; never force an SSL handshake there.
    // Public Supabase connections still validate the server certificate.
    ssl: ["localhost", "127.0.0.1", "::1", "helium"].includes(u.hostname)
      ? false : { rejectUnauthorized: process.env.PENTAGON_AUDIT_ALLOW_SELF_SIGNED !== "true" },
    application_name: "pentagon-readonly-migration-audit"
  });
  let inTransaction = false;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    inTransaction = true;
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const started = (await client.query("SELECT now() AS captured_at")).rows[0].captured_at;
    const list = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
    );
    const report = {
      audit_version: 1,
      captured_at_utc: new Date(started).toISOString(),
      source_label: development ? "development_environment" : "database_url_environment",
      credentials_included: false,
      raw_data_included: false,
      tables: [],
      errors: []
    };
    for (const { table_name: name } of list.rows) {
      const qname = identifier(name);
      try {
        await client.query("SAVEPOINT audit_one");
        const schema = await client.query(
          "SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns " +
          "WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
          [name]
        );
        // Each row is canonicalized using PostgreSQL jsonb::text, so a
        // consistent checksum is independent of physical row ordering.
        const result = await client.query(`
          SELECT count(*)::text AS count,
            md5(coalesce(string_agg(md5(to_jsonb(t)::text), E'\\n'
                ORDER BY md5(to_jsonb(t)::text)), '')) AS row_digest
          FROM public.${qname} AS t
        `);
        report.tables.push({
          name, count: result.rows[0].count,
          schema_digest: hash(JSON.stringify(schema.rows)),
          row_digest: result.rows[0].row_digest,
          ...(schema.rows.some((col) => col.column_name === "tenant") ? {
            tenant_counts: Object.fromEntries((await client.query(
              `SELECT tenant, count(*)::text AS n FROM public.${qname} GROUP BY tenant ORDER BY tenant`
            )).rows.map((row) => [String(row.tenant ?? "(null)"), row.n]))
          } : {}),
          category: VOLATILE.has(name) ? "volatile" : "business"
        });
        await client.query("RELEASE SAVEPOINT audit_one");
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT audit_one");
        await client.query("RELEASE SAVEPOINT audit_one");
        const message = e.code || e.message;
        report.errors.push({ table: name, error: message });
        report.tables.push({ name, error: message,
          category: VOLATILE.has(name) ? "volatile" : "business" });
      }
    }
    const fks = await client.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE convalidated)::int AS valid " +
      "FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace"
    );
    report.foreign_keys_total = fks.rows[0].total;
    report.foreign_keys_valid = fks.rows[0].valid;
    report.all_fk_valid = report.foreign_keys_total === report.foreign_keys_valid;
    report.table_count = report.tables.length;
    await client.query("COMMIT");
    inTransaction = false;
    if (comparisonPath) {
      const baseline = JSON.parse(fs.readFileSync(comparisonPath, "utf8"));
      if (!Array.isArray(baseline.tables) || !Array.isArray(baseline.errors))
        throw Error("Baseline file is not a Pentagon migration audit.");
      report.comparison = compareSnapshots(baseline, report);
      if (!report.comparison.ready_to_cutover) process.exitCode = 1;
    }
    if (outputPath) {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) process.exitCode = 1;
  } catch (e) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    fail(e.code ? "Database operation failed: " + e.code : e.message);
  } finally {
    await client.end().catch(() => {});
  }
}
run();
