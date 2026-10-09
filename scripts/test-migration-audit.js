#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { compareSnapshots, REQUIRED_HISTORICAL_TABLES } = require("./migration-audit");

const required = [...REQUIRED_HISTORICAL_TABLES, "pentagon_http_sessions"];
const row = (name) => ({
  name, count: "4", row_digest: "a".repeat(32), schema_digest: "b".repeat(64)
});
const snapshot = (host = "pooler.supabase.com") => ({
  audit_version: 2,
  tables: required.map(row),
  errors: [],
  all_fk_valid: true,
  captured_at_utc: "2026-10-09T12:00:00Z",
  db_identity: { host, database: "postgres", port: "5432" }
});
const source = snapshot("helium");

function test(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (err) {
    console.error("FAIL " + name + ": " + err.message);
    process.exitCode = 1;
  }
}

test("different databases with equal rows may satisfy DB parity only", () => {
  const result = compareSnapshots(source, snapshot());
  assert.equal(result.database_parity_pass, true);
  assert.equal(result.ready_to_cutover, false);
});
test("reject accidental same-database comparison", () => {
  const result = compareSnapshots(source, snapshot("helium"));
  assert.equal(result.database_parity_pass, false);
  assert.match(result.validation_errors.join(" "), /SAME PostgreSQL database/);
});
test("missing task-event history must block migration", () => {
  const other = snapshot();
  other.tables = other.tables.filter((t) => t.name !== "provider_node_task_events");
  const result = compareSnapshots(source, other);
  assert.equal(result.database_parity_pass, false);
  assert.equal(result.blocking.find((t) =>
    t.table === "provider_node_task_events")?.status, "MISSING_ON_TARGET");
});
test("historical provider tasks count mismatch must block", () => {
  const other = snapshot();
  other.tables.find((t) => t.name === "provider_node_tasks").count = "3";
  assert.equal(compareSnapshots(source, other).database_parity_pass, false);
});
test("historical row fingerprint mismatch must block", () => {
  const other = snapshot();
  other.tables.find((t) => t.name === "check_results").row_digest = "c".repeat(32);
  const result = compareSnapshots(source, other);
  assert.equal(result.database_parity_pass, false);
  assert.equal(result.blocking.find((t) => t.table === "check_results")?.status,
    "DATA_MISMATCH");
});
test("reject incomplete fingerprint", () => {
  const other = snapshot();
  other.tables[0].row_digest = "invalid";
  assert.equal(compareSnapshots(source, other).database_parity_pass, false);
});
test("reject obsolete audit format", () => {
  const other = snapshot();
  other.audit_version = 1;
  const result = compareSnapshots(source, other);
  assert.equal(result.database_parity_pass, false);
  assert.match(result.validation_errors.join(" "), /stale audit version/);
});
test("only expiring sessions may differ without blocking DB parity", () => {
  const other = snapshot();
  other.tables.find((t) => t.name === "pentagon_http_sessions").count = "9";
  const result = compareSnapshots(source, other);
  assert.equal(result.database_parity_pass, true);
  assert.equal(result.volatile_differences.length, 1);
});
test("foreign key validation is mandatory", () => {
  const other = snapshot();
  other.all_fk_valid = false;
  assert.equal(compareSnapshots(source, other).database_parity_pass, false);
});
test("empty inventories are invalid", () => {
  const other = snapshot();
  other.tables = [];
  assert.equal(compareSnapshots(source, other).database_parity_pass, false);
});
