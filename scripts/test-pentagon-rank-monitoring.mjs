import assert from "node:assert/strict";
import { nodeReading, registryReading } from "../src/rankMonitoring.mjs";

const now = Date.parse("2026-10-29T03:00:00Z");
const ago = minutes => new Date(now - minutes * 60000).toISOString();
let passed = 0;
function check(name, run) { run(); passed++; console.log("PASS " + name); }
check("old stored online flag cannot override stale heartbeat", () => {
  assert.equal(nodeReading({ is_active:true, last_health_status:"online", telemetry_last_seen_at:ago(30) },now).status,"offline");
});
check("fresh degraded network stays degraded", () => {
  assert.equal(nodeReading({ is_active:true, connectivity:"degraded", last_seen_at:ago(1) },now).status,"degraded");
});
check("inactive nodes stay visible and inactive even with fresh telemetry", () => {
  assert.equal(nodeReading({ is_active:false, last_seen_at:ago(1) },now).status,"inactive");
});
check("unknown and future timestamps cannot appear online", () => {
  for (const last_seen_at of [null,"invalid",ago(-1)]) assert.equal(nodeReading({is_active:true,last_seen_at},now).status,"unknown");
});
check("freshness thresholds match Node Health", () => {
  for(const [age,status] of [[5,"online"],[6,"waiting"],[15,"waiting"],[16,"offline"]]) {
    assert.equal(nodeReading({is_active:true,last_seen_at:ago(age)},now).status,status);
  }
});
check("missing readings are N/A and actual zero battery is retained", () => {
  assert.equal(nodeReading({battery_percent:null},now).batteryText,"N/A");
  assert.equal(nodeReading({battery_percent:0},now).batteryText,"0%");
  assert.equal(nodeReading({},now).signal,"N/A");
});
const evidence = { registry_source:"tradevicepc_registry_snapshot_sha256:fixture",registry_checked_at:ago(3),registry_listed:false };
check("verified not-listed counts as registry evidence without declaring domain safe", () => {
  const r=registryReading({domains:[evidence]},now);
  assert.equal(r.status,"available");assert.equal(r.checked,1);
  assert.equal(r.global_status,undefined);
});
check("API reachability or unverified lookup cannot fake AI Checker availability", () => {
  for(const row of [{ok:true,checkedAt:ago(1)}, {...evidence,registry_listed:null}, {...evidence,registry_source:"openai_http_probe"}]) {
    assert.equal(registryReading({domains:[row]},now).status,"unknown");
  }
});
check("old registry and future registry are not fresh", () => {
  assert.equal(registryReading({domains:[{...evidence,registry_checked_at:ago(721)}]},now).status,"stale");
  assert.equal(registryReading({domains:[{...evidence,registry_checked_at:ago(-1)}]},now).status,"unknown");
});
check("partial coverage is explicit", () => {
  const r=registryReading({domains:[evidence,{...evidence,registry_checked_at:ago(721)},{}]},now);
  assert.equal(r.checked,1);assert.equal(r.total,3);
});
check("empty or failed registry stays unknown", () => {
  for(const value of [null,{}, {domains:[]}]) assert.equal(registryReading(value,now).status,"unknown");
});
console.log("PENTAGON_RANK_MONITORING_TESTS_PASS="+passed);
