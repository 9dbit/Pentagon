#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const {assess,toCount,BASELINE}=require('./pentagon-task-quarantine-audit.cjs');
const base=()=>({baseline:{...BASELINE},scoped_collision_groups:'0',
  task_node_tenant_mismatch:'0',task_node_fleet_mismatch:'0',
  duplicate_node_device_id_groups:'0',replay_risk_tasks:'0',
  orphan_task_node:'0',orphan_event_task:'0',event_missing_idempotency_key:'0'});
let passed=0;
function test(label,fn){try{fn();console.log('PASS '+label);passed++;}catch(e){console.error('FAIL '+label+': '+e.message);process.exitCode=1;}}
test('safe source still never authorizes import or UAT',()=>{
  const r=assess(base());assert.deepEqual(r.blockers,[]);
  assert.equal(r.target_data_import_permitted,false);
  assert.equal(r.task_replay_permitted,false);assert.equal(r.uat_ready,false);
});
test('source counts must match pinned backup baseline',()=>{
  const x=base();x.baseline.check_results='84873';
  assert.ok(assess(x).blockers.includes('SOURCE_SNAPSHOT_BASELINE_MISMATCH'));
});
test('source domain mapping scope collisions fail closed',()=>{
  const x=base();x.scoped_collision_groups='2';
  const r=assess(x);assert.equal(r.source_domain_scoped_key_unique,false);
  assert.ok(r.blockers.includes('SOURCE_DOMAIN_SCOPE_COLLISION'));
});
test('historical cross-tenant task references require human review',()=>{
  const x=base();x.task_node_tenant_mismatch='35392';
  assert.ok(assess(x).blockers.includes('CROSS_TENANT_TASK_NODE_REFERENCES_REQUIRE_REVIEW'));
});
test('historical cross-fleet task references require human review',()=>{
  const x=base();x.task_node_fleet_mismatch='10';
  assert.ok(assess(x).blockers.includes('CROSS_FLEET_TASK_NODE_REFERENCES_REQUIRE_REVIEW'));
});
test('duplicate node device identities require human review',()=>{
  const x=base();x.duplicate_node_device_id_groups='1';
  assert.ok(assess(x).blockers.includes('DUPLICATE_DEVICE_IDENTITY_REQUIRES_REVIEW'));
});
test('never replay queued or claimed historical tasks',()=>{
  const x=base();x.replay_risk_tasks='1164';
  const r=assess(x);assert.equal(r.pending_task_count,1164);
  assert.equal(r.task_replay_permitted,false);
  assert.ok(r.blockers.includes('HISTORICAL_PENDING_TASKS_MUST_BE_QUARANTINED'));
});
test('foreign key orphans prevent approval',()=>{
  const x=base();x.orphan_event_task='1';
  assert.ok(assess(x).blockers.includes('HISTORICAL_ORPHAN_RELATIONSHIP'));
});
test('idempotency key gaps prevent approval',()=>{
  const x=base();x.event_missing_idempotency_key='1';
  assert.ok(assess(x).blockers.includes('TASK_EVENT_IDEMPOTENCY_KEY_MISSING'));
});
test('invalid and unsafe counts reject report',()=>{
  for (const value of ['-1','1.0','NaN','9007199254740993','']) {
    assert.throws(()=>toCount(value),/INVALID_AGGREGATE_COUNT/);
  }
});
test('source approval never follows from empty blockers',()=>{
  const r=assess(base());assert.equal(r.source_target_mapping_verified,false);
  assert.equal(r.target_data_import_permitted,false);
});
console.log('TASK_QUARANTINE_TESTS_PASSED='+passed);
