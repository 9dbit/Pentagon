#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = relative => fs.readFileSync(path.join(root, relative), "utf8");
const agent = source("server/agentPollRoutes.js");
const checker = source("server/nodeChecker.js");
const scheduler = source("server/scheduler.js");
const watch = source("server/trustpositifWatch.js");
let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log("PASS " + label);
}

check("Agent results cannot independently promote any customer domain global status", () => {
  assert.doesNotMatch(agent, /syncDomainStatusFromTask/);
  assert.doesNotMatch(agent, /UPDATE\s+domains\b/i);
  assert.match(agent, /UPDATE provider_node_tasks[\s\S]*?result=\$1::jsonb/);
  assert.match(agent, /WHERE id=\$2 AND node_id=\$3 AND status IN \('claimed','error'\)/);
});

check("Agent result endpoint rejects tasks not owned or not claimed by the node", () => {
  assert.match(agent, /SELECT status FROM provider_node_tasks WHERE id=\$1 AND node_id=\$2 LIMIT 1/);
  assert.match(agent, /if \(!taskRows\[0\]\) return res\.status\(404\)/);
  assert.match(agent, /if \(!\["claimed", "error", "done"\]\.includes\(taskRows\[0\]\.status\)\)/);
});

check("A late successful provider result clears any prior polling timeout marker", () => {
  assert.match(agent, /SET status='done', result=\$1::jsonb, error=NULL, completed_at=NOW\(\)/);
});

check("Poll deadline cannot invalidate a claimed or completed task", () => {
  assert.match(agent, /status='error', error='Node polling timeout', completed_at=NOW\(\) WHERE id=\$1 AND status='queued'/);
  assert.doesNotMatch(agent, /status <> 'done'/);
});

check("Node checker does not overwrite verified handset heartbeat with a task timeout", () => {
  const poll = checker.match(/async function checkViaPollingNode\([\s\S]*?\n\}\n/);
  assert.ok(poll, "polling function not found");
  assert.doesNotMatch(poll[0], /UPDATE provider_nodes/);
  assert.match(poll[0], /waitForNodeTask\(taskId, 120000\)/);
});

check("Scoped TrustPositif worker keeps independent provider consensus as status owner", () => {
  assert.match(scheduler, /registryCheck\.confirmedBlocked/);
  assert.match(scheduler, /if \(options\.trustpositifOnly && !registryCheck\.confirmedBlocked/);
  assert.match(scheduler, /const sampled = await Promise\.all\(nodes\.map\(node => checkViaNode/);
  assert.match(watch, /const MIN_NODES\s*=\s*2/);
  assert.match(watch, /checkAfterNodeConsensus/);
});

console.log("PENTAGON_POLLING_EVIDENCE_GUARD_PASS=" + passed + "/6");
