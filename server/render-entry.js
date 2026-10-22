"use strict";

/*
 * Render entrypoint for a staged, fail-closed Railway replacement.
 * PRE-FLIGHT MODE: no database connection, no sessions, no exposed customer
 * data, no node jobs, no Telegram, no secrets and no legacy demo seeding.
 * LIVE MODE: verify secrets, account binding and the exact existing database
 * BEFORE requiring the legacy production server.
 */
require("dotenv").config();
const http = require("node:http");
const { URL } = require("node:url");

const isPreflight = process.env.PENTAGON_RENDER_PREFLIGHT_ONLY === "true";
const host = "0.0.0.0";
const port = Number(process.env.PORT || 10000);

function startPreflight() {
  const app = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const health = req.method === "GET" && req.url?.split("?")[0] === "/health/preflight";
    res.statusCode = health ? 200 : 503;
    res.end(JSON.stringify(health ?
      { ok: true, ready: false, mode: "render-preflight", database: "not_connected" } :
      { ok: false, ready: false, reason: "RENDER_MIGRATION_PREFLIGHT_ONLY" }));
  });
  app.listen(port, host, () =>
    console.log("[Render Preflight] build started safely; customer API disabled"));
}

function fail(reason) {
  // Never print a connection string, password, token, email or raw env var.
  console.error("[Render Activation] BLOCKED:", reason);
  process.exitCode = 78;
}

async function startProduction() {
  const required = [
    "DATABASE_URL",
    "SESSION_SECRET",
    "ADMIN_PASSWORD",
    "PENTAGON_TEST_USERS_JSON",
    "PENTAGON_CUSTOMER_VIEWERS_JSON",
    "NODE_BOOTSTRAP_TOKEN"
  ];
  const absent = required.filter(key => !process.env[key]?.trim());
  if (absent.length) return fail("REQUIRED_CONFIGURATION_MISSING (" + absent.length + " keys)");

  if (String(process.env.NODE_ENV) !== "production") return fail("NODE_ENV_NOT_PRODUCTION");
  if (process.env.SESSION_SECRET.length < 32 ||
      process.env.ADMIN_PASSWORD.length < 12) return fail("WEAK_AUTH_CONFIGURATION");

  let parsed;
  try {
    parsed = new URL(process.env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
        !parsed.hostname || !parsed.pathname) throw new Error("invalid");
  } catch (_) { return fail("DATABASE_URL_INVALID"); }

  const { readTestUsers } = require("./testAccountAuth");
  const { readCustomerViewers } = require("./customerViewerAuth");
  const users = readTestUsers();
  const viewers = readCustomerViewers();
  const expectedTenant = process.env.PENTAGON_RENDER_EXPECTED_TENANT || "wisnu123";
  if (!viewers.some(v => v.tenant === expectedTenant &&
    users.some(u => u.email === v.email))) return fail("CUSTOMER_AUTH_BINDING_NOT_VERIFIED");

  // This server must never run the old broad monitoring scheduler concurrently
  // with the Railway deployment. Scoped worker flag remains explicitly off
  // until separate checker and cutover verification.
  process.env.SCHEDULER_ENABLED = "false";
  process.env.TRUSTPOSITIF_SCOPED_SCHEDULER = "false";
  process.env.TRUSTPOSITIF_PREWARM = "false";

  const { Pool } = require("pg");
  const secure = !["localhost", "127.0.0.1"].includes(parsed.hostname);
  const probe = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: secure ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
    max: 1
  });
  let valid = false;
  try {
    const { rows } = await probe.query(
      "SELECT (SELECT COUNT(*)::int FROM public.domains WHERE tenant=$1 AND is_active=TRUE) AS domains," +
      "(SELECT COUNT(*)::int FROM public.rank_keyword_groups WHERE tenant=$1 AND is_active=TRUE) AS keywords," +
      "(SELECT COUNT(*)::int FROM public.rank_keyword_domains d JOIN public.rank_keyword_groups g ON g.id=d.group_id " +
      "WHERE g.tenant=$1 AND g.is_active=TRUE AND d.is_whitelisted=TRUE) AS whitelist_links",
      [expectedTenant]
    );
    valid = Number(rows[0]?.domains) === 5 &&
      Number(rows[0]?.keywords) === 5 &&
      Number(rows[0]?.whitelist_links) === 25;
  } catch (_) { return fail("SUPABASE_PREFLIGHT_QUERY_FAILED"); }
  finally { await probe.end().catch(() => {}); }
  if (!valid) return fail("EXPECTED_CUSTOMER_SNAPSHOT_MISMATCH");

  console.log("[Render Activation] production DB identity and customer schema verified; legacy scheduler disabled");
  // Reuse the already-CI-tested production adapter. Never fork the engine.
  require("./railway-entry");
}

if (!Number.isInteger(port) || port < 0 || port > 65535) fail("INVALID_PORT");
else if (isPreflight) startPreflight();
else startProduction().catch(() => fail("STARTUP_PREFLIGHT_FAILED"));
