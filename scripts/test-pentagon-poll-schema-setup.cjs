#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function fixture({ failFirst = false, firstQueryGate } = {}) {
  const queries = [], routes = {};
  let first = true;
  const db = { async query(sql, args = []) {
    queries.push({ sql, args });
    if (first) {
      first = false;
      if (firstQueryGate) await firstQueryGate;
      if (failFirst) throw new Error("fixture schema unavailable");
    }
    if (/SELECT \* FROM provider_nodes WHERE name=/.test(sql)) {
      assert.match(sql, /secret_key=\$2 AND is_active=true/);
      return { rows: args[0] === "Fixture" && args[1] === "fixture-only-key"
        ? [{ id: 7, name: "Fixture", provider_name: "Fixture ISP", network_type: "mobile" }] : [] };
    }
    return { rows: [], rowCount: 0 };
  } };
  function load(file, extra = {}) {
    const router = Object.fromEntries(["get", "post", "patch", "delete"].map(method =>
      [method, (route, handler) => { routes[`${file}:${method}:${route}`] = handler; }]));
    const mocks = { express: { Router: () => router }, axios: {}, "./nodeDiagnostics": require("../server/nodeDiagnostics"), "./db": { pool: db },
      crypto: require("node:crypto"), "./telegram": { sendTelegram() { throw new Error("Unexpected Telegram call"); } }, ...extra };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../server", file), "utf8"), {
      module, exports: module.exports, process: { env: {} }, Date, console,
      require(name) { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; }
    }, { filename: file });
    return module.exports;
  }
  const nodes = load("nodeRoutes.js");
  const tasks = load("agentPollRoutes.js", { "./nodeRoutes": nodes });
  async function poll(body = {}) {
    let status = 200, response;
    const res = { status(code) { status = code; return this; }, json(value) { response = value; return this; } };
    await routes["agentPollRoutes.js:post:/poll"]({ headers: {}, socket: {}, body: {
      node_name: "Fixture", secret_key: "fixture-only-key", telemetry: { battery_percent: 80 }, ...body
    } }, res, error => { throw error; });
    return { status, response };
  }
  return { nodes, tasks, queries, poll };
}

for (const kind of ["nodes", "tasks"]) {
  const method = kind === "nodes" ? "ensureNodeTable" : "ensureTaskTable";
  test(`${kind} setup runs once across concurrent and subsequent requests`, async () => {
    let release;
    const firstQueryGate = new Promise(resolve => { release = resolve; });
    const f = fixture({ firstQueryGate });
    const cold = [f[kind][method](), f[kind][method](), f[kind][method]()];
    assert.equal(f.queries.length, 1, "Concurrent initialization must share the first DDL request");
    release();
    await Promise.all(cold);
    const afterCold = f.queries.length;
    assert.ok(afterCold > 1);
    await Promise.all([f[kind][method](), f[kind][method]()]);
    assert.equal(f.queries.length, afterCold, "Warm requests must not re-run schema setup");
    assert.equal(f.queries.filter(q => q.sql.includes("ADD COLUMN IF NOT EXISTS last_health_reason")).length, 1);
  });

  test(`${kind} setup failure rejects all waiters and permits a later retry`, async () => {
    const f = fixture({ failFirst: true });
    const results = await Promise.allSettled([f[kind][method](), f[kind][method]()]);
    assert.ok(results.every(r => r.status === "rejected"));
    assert.equal(f.queries.length, 1);
    await f[kind][method]();
    assert.ok(f.queries.length > 1);
    const ready = f.queries.length;
    await f[kind][method]();
    assert.equal(f.queries.length, ready);
  });
}

test("warm polls retain per-request authentication, telemetry and atomic claims without DDL", async () => {
  const f = fixture();
  await f.tasks.ensureTaskTable();
  f.queries.length = 0;
  assert.equal((await f.poll()).status, 200);
  assert.equal((await f.poll({ network_ok: false, network_reason: "wrong network" })).response.waiting, true);
  assert.equal((await f.poll({ secret_key: "incorrect-fixture-key" })).status, 401);
  assert.equal(f.queries.filter(q => /SELECT \* FROM provider_nodes WHERE name=/.test(q.sql)).length, 3);
  assert.equal(f.queries.filter(q => /INSERT INTO node_telemetry/.test(q.sql)).length, 2);
  assert.equal(f.queries.filter(q => /FOR UPDATE SKIP LOCKED/.test(q.sql)).length, 1);
  assert.equal(f.queries.filter(q => /^\s*(?:CREATE|ALTER)\b/.test(q.sql)).length, 0);
  assert.equal(f.queries.filter(q => /EXPIRED_BEFORE_POLL/.test(q.sql)).length, 1);
});

test("failed cold setup cannot authenticate or dispatch a task", async () => {
  const f = fixture({ failFirst: true });
  await assert.rejects(f.poll(), /fixture schema unavailable/);
  assert.equal(f.queries.some(q => /secret_key=|FOR UPDATE SKIP LOCKED/.test(q.sql)), false);
  assert.equal((await f.poll()).status, 200);
});


test("busy heartbeat updates real telemetry but never claims or expires a task", async () => {
  const f=fixture(); await f.tasks.ensureTaskTable(); f.queries.length=0;
  const r=await f.poll({busy:true,telemetry:{battery_percent:80,diagnostics:{schema_version:1,task_busy:true,task_phase:"dns",secret_key:"must-not-persist",events:[{event:"TASK_START",at:"2026-10-29T00:00:00Z",duration_ms:0,token:"secret"}]}}});
  assert.equal(r.response.busy,true);assert.equal(r.response.task,null);
  assert.equal(f.queries.filter(q=>/FOR UPDATE SKIP LOCKED|EXPIRED_BEFORE_POLL/.test(q.sql)).length,0);
  const write=f.queries.find(q=>/INSERT INTO node_telemetry/.test(q.sql));
  assert.ok(write);const d=JSON.parse(write.args[18]);assert.equal(d.task_phase,"dns");assert.equal(d.task_busy,true);
  assert.equal(JSON.stringify(d).includes("secret"),false);
  assert.equal((await f.poll({busy:true,network_ok:false})).response.waiting,true);
  const count=f.queries.length;assert.equal((await f.poll({busy:true,secret_key:"bad"})).status,401);
  assert.equal(f.queries.slice(count).some(q=>/UPDATE|INSERT/.test(q.sql)),false);
});

test("diagnostics reject invalid types, discard arbitrary text and bound event history",()=>{
  const {normalizeDiagnostics:n}=require("../server/nodeDiagnostics");
  assert.equal(n(null),null);assert.equal(n({schema_version:2}),null);
  const d=n({schema_version:1,service_running:"true",effective_poll_ms:"3000",last_ack_age_ms:-1,task_phase:"token",last_error_code:"Bearer secret",ip:"private",events:Array.from({length:30},()=>({event:"POLL_ERROR",at:"invalid",duration_ms:Infinity,raw:"secret"}))});
  assert.equal(d.service_running,null);assert.equal(d.effective_poll_ms,null);assert.equal(d.last_ack_age_ms,null);
  assert.equal(d.events.length,20);assert.equal(d.events[0].at,null);assert.equal(d.last_error_code,"UNKNOWN");assert.equal(JSON.stringify(d).includes("secret"),false);
});
