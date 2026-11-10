"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDiagnostics } = require("../server/nodeDiagnostics");

test("connection diagnosis retains only safe phases and endpoint aliases", () => {
  const raw = { schema_version: 1, last_error_code: "TIMEOUT", last_error_phase: "connect", control_endpoint: "pentagon",
    secret_key: "private-test-value", url: "https://user:private-test-value@example.test",
    events: [{ event: "NETWORK_CHANGE", at: "2026-11-10T05:00:00Z", duration_ms: 0, raw: "private-test-value" }] };
  const result = normalizeDiagnostics(raw);
  assert.equal(result.last_error_code, "TIMEOUT");
  assert.equal(result.last_error_phase, "connect");
  assert.equal(result.control_endpoint, "pentagon");
  assert.deepEqual(result.events, [{ event: "NETWORK_CHANGE", at: "2026-11-10T05:00:00Z", duration_ms: 0 }]);
  assert.ok(!JSON.stringify(result).includes("private-test-value"));
});

test("untrusted endpoint URLs and exception messages are discarded", () => {
  for (const value of ["https://secret@example.test", "10.0.0.1", "TLS token=private-test-value", {}, ["railway"]]) {
    const result = normalizeDiagnostics({ schema_version: 1, control_endpoint: value, last_error_phase: value, events: [{ event: value }] });
    assert.equal(result.control_endpoint, "unknown");
    assert.equal(result.last_error_phase, "unknown");
    assert.deepEqual(result.events, []);
  }
});

test("old diagnostics and new safe recovery events stay backward compatible", () => {
  const legacy = normalizeDiagnostics({ schema_version: 1, last_error_code: "NONE", task_busy: false, service_running: true });
  assert.equal(legacy.last_error_code, "NONE");
  assert.equal(legacy.task_busy, false);
  assert.equal(legacy.service_running, true);
  assert.equal(legacy.control_endpoint, "unknown");
  for (const event of ["RECONNECT_REQUESTED", "TRANSPORT_RESET", "ENDPOINT_SWITCH"]) {
    assert.equal(normalizeDiagnostics({ schema_version: 1, events: [{ event }] }).events[0].event, event);
  }
});
