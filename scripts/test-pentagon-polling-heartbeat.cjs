#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Exercise production handlers with isolated queue/DB/HTTP boundaries. Never
// load db.js, dispatch real tasks, or contact devices or notification services.
function load(file, mocks) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, "../server", file), "utf8");
  vm.runInNewContext(source, {
    module, exports: module.exports, Date, console, process: { env: {} },
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    }
  }, { filename: file });
  return module.exports;
}

const node = { id: 7, name: "Fixture", provider_name: "Fixture ISP",
  network_type: "mobile", endpoint_url: "poll://fixture" };

for (const outcome of ["timeout", "error", "success", "queue failure", "wait failure"]) {
  test(`polling ${outcome} preserves the latest device heartbeat and SIM state`, async () => {
    const state = { last_health_status: "waiting", last_health_reason: "wrong network",
      last_ping_at: "2026-10-28T00:00:00Z" };
    const original = { ...state };
    const writes = [];
    const expected = outcome === "success"
      ? { status: "warning", reason: "TLS handshake failed" }
      : { status: "warning", reason: `Queue ${outcome}`, __polling_state: outcome };
    const checker = load("nodeChecker.js", {
      axios: { post() { throw new Error("Unexpected live HTTP"); } },
      "./db": { pool: { async query(sql) { writes.push(sql); return { rows: [] }; } } },
      "./nodeRoutes": { cleanBase: value => value },
      "./agentPollRoutes": {
        async enqueueNodeTask() {
          if (outcome === "queue failure") throw new Error("queue unavailable");
          return "fixture-task";
        },
        async waitForNodeTask() {
          // Simulate a newer authenticated poll while the caller was waiting.
          state.last_ping_at = "2026-10-28T00:01:00Z";
          if (outcome === "wait failure") throw new Error("queue read unavailable");
          return expected;
        }
      }
    });
    const result = await checker.checkViaNode("fixture.example", node);
    assert.equal(result.status, "warning");
    assert.equal(result.node_id, node.id);
    assert.equal(result.provider_name, node.provider_name);
    assert.equal(state.last_health_status, original.last_health_status);
    assert.equal(state.last_health_reason, original.last_health_reason);
    assert.equal(writes.length, 0, "Queue outcomes must not write device health or invent a ping");
    if (!outcome.endsWith("failure")) assert.equal(result.reason, expected.reason);
  });
}

test("direct HTTP nodes still record a successful network response", async () => {
  const writes = [];
  const checker = load("nodeChecker.js", {
    axios: { async post() { return { data: { status: "working", reason: "HTTP 200" } }; } },
    "./db": { pool: { async query(sql, args) { writes.push({ sql, args }); } } },
    "./nodeRoutes": { cleanBase: value => value },
    "./agentPollRoutes": {}
  });
  const result = await checker.checkViaNode("fixture.example", { ...node, endpoint_url: "https://node.example" });
  assert.equal(result.status, "working");
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /last_health_status='online'/);
  assert.equal(writes[0].args[0], node.id);
});

for (const outcome of ["fresh", "stale", "lookup failure"]) {
  test(`manual polling-node ping is read-only for ${outcome} telemetry`, async () => {
    const handlers = {};
    const writes = [];
    const router = Object.fromEntries(["get", "post", "patch", "delete"].map(method =>
      [method, (route, handler) => { handlers[`${method} ${route}`] = handler; }]));
    load("nodeRoutes.js", {
      express: { Router: () => router },
      axios: { get() { throw new Error("Polling ping must not contact an HTTP agent"); } },
      "./db": { pool: { async query(sql) {
        if (/^UPDATE provider_nodes/.test(sql)) writes.push(sql);
        if (sql.startsWith("SELECT * FROM provider_nodes")) return { rows: [node] };
        if (sql.includes("FROM node_telemetry")) {
          if (outcome === "lookup failure") throw new Error("telemetry unavailable");
          return { rows: [{ last_seen_at: new Date(Date.now() - (outcome === "fresh" ? 1000 : 600000)) }] };
        }
        return { rows: [] };
      } } }
    });
    let response;
    await handlers["post /:id/ping"]({ params: { id: "7" } },
      { json: value => { response = value; } }, err => { throw err; });
    assert.equal(writes.length, 0, "A dashboard ping must not overwrite agent-owned heartbeat state");
    if (outcome === "lookup failure") assert.equal(response.ok, false);
    else assert.equal(response.health, outcome === "fresh" ? "online" : "waiting");
  });
}
