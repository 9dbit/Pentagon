#!/usr/bin/env node
"use strict";
/*
 * Pentagon local-only activation review.
 * Input: previously produced, immutable local mapping report.
 * Output: private quarantine/review plan, NEVER executable SQL.
 * No database, HTTP, migrations, bot, cron, or environment credentials.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPORT_TYPE = "pentagon_local_mapping_review";
const DECISION_TYPE = "pentagon_approved_mapping_review_v1";
const PLAN_TYPE = "pentagon_safe_activation_review_v1";

class ReviewStop extends Error {
  constructor(code) { super(code); this.code = code; }
}
const ensure = (ok, code) => { if (!ok) throw new ReviewStop(code); };
const id = x => {
  const s = String(x ?? "").trim();
  ensure(/^[1-9][0-9]*$/.test(s) && s.length <= 18, "INVALID_MAPPING_ID");
  return s;
};
const tenant = x => {
  const t = String(x || "").trim();
  ensure(/^[a-z][a-z0-9_-]{0,63}$/.test(t), "INVALID_MAPPING_TENANT");
  return t;
};
const fleet = x => {
  const f = String(x || "").trim();
  ensure(f.length > 0 && f.length <= 150 && !/[\x00-\x1f]/.test(f), "INVALID_MAPPING_FLEET");
  return f;
};
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const hashJson = value => digest(JSON.stringify(value));
const num = x => Number.isFinite(Number(x)) ? Number(x) : 0;

function verifyMappingReport(r) {
  ensure(r && typeof r === "object" && !Array.isArray(r), "REPORT_NOT_OBJECT");
  ensure(r.report_type === REPORT_TYPE &&
    r.status === "REVIEW_COMPLETE_IMPORT_BLOCKED" &&
    r.import_allowed === false &&
    r.production_connections === 0 &&
    r.production_writes === 0 &&
    r.local_cluster_stopped === true &&
    Number.isFinite(Date.parse(r.captured_at_utc)) &&
    Array.isArray(r.domain_mapping_candidates) &&
    Array.isArray(r.node_mapping_candidates), "REPORT_SAFETY_GATE_FAILED");

  const domainKeys = new Set(), nodeKeys = new Set();
  for (const row of r.domain_mapping_candidates) {
    const key = tenant(row.target_tenant) + ":" + id(row.target_id);
    ensure(!domainKeys.has(key), "DUPLICATE_TARGET_DOMAIN_ID");
    domainKeys.add(key);
    ensure(Array.isArray(row.source_candidates), "INVALID_SOURCE_DOMAIN_CANDIDATES");
    const choices = new Set();
    for (const c of row.source_candidates) {
      const k = tenant(c.tenant) + ":" + id(c.id) + ":" + fleet(c.fleet);
      ensure(!choices.has(k), "DUPLICATE_DOMAIN_CHOICE");
      choices.add(k);
    }
  }
  for (const row of r.node_mapping_candidates) {
    const key = tenant(row.target_tenant) + ":" + id(row.target_id);
    ensure(!nodeKeys.has(key), "DUPLICATE_TARGET_NODE_ID");
    nodeKeys.add(key);
  }
  return r;
}

function parseDecisions(d, sha) {
  if (!d) return { domains:new Map(), nodes:new Map(), applied:false };
  ensure(d.type === DECISION_TYPE && d.version === 1 &&
    typeof d.report_sha256 === "string" && /^[a-f0-9]{64}$/.test(d.report_sha256) &&
    d.report_sha256 === sha, "DECISION_REPORT_HASH_MISMATCH");
  // Human-attested change ticket required. A string is not cryptographic proof
  // or authorization to execute a production migration.
  ensure(typeof d.reviewed_by === "string" &&
    /^[A-Za-z0-9_.@ -]{3,100}$/.test(d.reviewed_by) &&
    typeof d.review_ticket === "string" &&
    /^[A-Za-z0-9_./-]{4,120}$/.test(d.review_ticket) &&
    Number.isFinite(Date.parse(d.reviewed_at_utc)) &&
    Array.isArray(d.domains) && Array.isArray(d.nodes), "INCOMPLETE_REVIEW_ATTESTATION");
  const domains = new Map(),nodes = new Map();
  for (const row of d.domains) {
    const k = tenant(row.target_tenant) + ":" + id(row.target_id);
    ensure(!domains.has(k), "DUPLICATE_DOMAIN_DECISION");
    domains.set(k,row);
  }
  for (const row of d.nodes) {
    const k = tenant(row.target_tenant) + ":" + id(row.target_id);
    ensure(!nodes.has(k), "DUPLICATE_NODE_DECISION");
    nodes.set(k,row);
  }
  return { domains,nodes,applied:true,attested_by:d.reviewed_by,review_ticket:d.review_ticket };
}

function buildReviewPlan(report, reportSha256, decisions=null) {
  verifyMappingReport(report);
  ensure(typeof reportSha256 === "string" && /^[a-f0-9]{64}$/.test(reportSha256),
    "INVALID_REPORT_DIGEST");
  const reviewed = parseDecisions(decisions,reportSha256);
  const domainRows = [],nodeRows = [];
  let domainsApproved = 0,nodesReviewed = 0;
  const domainSeen = new Set(),nodeSeen = new Set();
  for (const row of report.domain_mapping_candidates) {
    const key = tenant(row.target_tenant) + ":" + id(row.target_id);
    domainSeen.add(key);
    const alternatives = row.source_candidates.map(c=>({
      id:id(c.id),tenant:tenant(c.tenant),fleet:fleet(c.fleet)
    }));
    const valid = alternatives.filter(c => c.tenant===tenant(row.target_tenant));
    const choice = reviewed.domains.get(key);
    let result = "REQUIRES_FLEET_REVIEW",selected = null;
    if (choice) {
      ensure(choice.action==="select_source_fleet", "INVALID_DOMAIN_REVIEW_ACTION");
      const selectedKey = tenant(choice.source_tenant)+":"+
        id(choice.source_id)+":"+fleet(choice.source_fleet);
      selected = valid.find(c => c.tenant+":"+c.id+":"+c.fleet===selectedKey);
      ensure(Boolean(selected), "DOMAIN_SOURCE_FLEET_NOT_IN_REPORT");
      result = "MANUALLY_REVIEWED_NOT_ACTIVATED";
      domainsApproved++;
    } else if (!valid.length) {
      result = "NO_SAME_TENANT_SOURCE";
    }
    domainRows.push({
      target_id:id(row.target_id),tenant:tenant(row.target_tenant),
      source_same_tenant_count:valid.length,
      choices:valid,result,
      selected_source:selected
    });
  }
  for (const row of report.node_mapping_candidates) {
    const key = tenant(row.target_tenant)+":"+id(row.target_id);
    nodeSeen.add(key);
    const choice = reviewed.nodes.get(key);
    let result = row.same_id_present && row.same_id_tenant_matches !== true
      ? "BLOCKED_NODE_ID_TENANT_CONFLICT" : row.same_id_present !== true
        ? "REVIEW_TARGET_ONLY_NODE" : "REVIEW_NODE_IDENTITY";
    let decision = null;
    if (choice) {
      ensure(choice.action==="preserve_target_only" || choice.action==="quarantine_conflict",
        "UNSUPPORTED_NODE_REVIEW_ACTION");
      // No implicit reuse of a historical node ID in the new polling network.
      if (choice.action==="preserve_target_only") {
        ensure(row.same_id_present===false && row.source_same_name_count===0,
          "NODE_PRESERVATION_NOT_SAFE");
      }
      result = choice.action==="preserve_target_only"
        ? "TARGET_ONLY_NODE_PRESERVED_NOT_ACTIVATED" : "NODE_CONFLICT_QUARANTINED";
      decision = choice.action;
      nodesReviewed++;
    }
    nodeRows.push({target_id:id(row.target_id),tenant:tenant(row.target_tenant),
      same_id_present:Boolean(row.same_id_present),
      same_id_tenant_matches:row.same_id_tenant_matches === true,
      result,decision});
  }
  for (const k of reviewed.domains.keys()) ensure(domainSeen.has(k), "UNKNOWN_TARGET_DOMAIN_DECISION");
  for (const k of reviewed.nodes.keys()) ensure(nodeSeen.has(k), "UNKNOWN_TARGET_NODE_DECISION");
  const counts = {
    domain_targets:domainRows.length,
    domain_reviewed:domainsApproved,
    domain_requires_review:domainRows.length-domainsApproved,
    node_targets:nodeRows.length,
    node_reviewed:nodesReviewed,
    node_requires_review:nodeRows.length-nodesReviewed,
    disputed_source_domain_targets:domainRows.filter(x=>x.source_same_tenant_count>1).length,
    identity_conflicted_nodes:nodeRows.filter(x=>x.same_id_present && !x.same_id_tenant_matches).length,
    target_only_nodes:nodeRows.filter(x=>!x.same_id_present).length
  };
  return {
    type:PLAN_TYPE,version:1,report_sha256:reportSha256,
    source_captured_at_utc:report.captured_at_utc,
    safety:{production_connections:0,production_writes:0,rollback_required_before_import:true,
      target_fleet_schema_verified:false,fresh_target_snapshot_verified:false,
      approval_does_not_grant_execution:true,activation_allowed:false,task_replay_allowed:false},
    gate: counts.domain_requires_review===0 && counts.node_requires_review===0
      ? "MAPPING_REVIEWED_AWAIT_FRESH_TARGET_BACKUP_AND_SEPARATE_RELEASE"
      : "MANUAL_RECONCILIATION_REQUIRED",
    counts,domain_reviews:domainRows,node_reviews:nodeRows,
    evidence:{review_ticket:reviewed.review_ticket||null,reviewer:reviewed.attested_by||null,
      import_allowed:false,source_report_import_allowed:report.import_allowed}
  };
}

function args(argv) {
  const allowed = new Set(["--report","--out","--decisions"]);
  const result = {};
  ensure(argv.length>=4 && argv.length%2===0, "USAGE_REPORT_OUT_OPTIONAL_DECISIONS");
  for (let i=0;i<argv.length;i+=2) {
    const k = argv[i],v=argv[i+1];
    ensure(allowed.has(k) && !result[k] && !!v && !v.startsWith("--"), "INVALID_CLI_ARGUMENT");
    result[k]=v;
  }
  ensure(result["--report"] && result["--out"] && path.resolve(result["--report"])!==path.resolve(result["--out"]),
    "REPORT_OUT_REQUIRED");
  return result;
}

function main(argv=process.argv.slice(2)) {
  process.umask(0o077);
  const cfg=args(argv);
  const bytes=fs.readFileSync(cfg["--report"]);
  ensure(bytes.length>0 && bytes.length<10485760, "UNEXPECTED_MAPPING_REPORT_SIZE");
  const parsed=JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/,""));
  const sha=digest(bytes);
  const decisions=cfg["--decisions"]
    ? JSON.parse(fs.readFileSync(cfg["--decisions"],"utf8")) : null;
  const plan=buildReviewPlan(parsed,sha,decisions);
  const dest=path.resolve(cfg["--out"]);
  ensure(!fs.existsSync(dest), "OUTPUT_EXISTS_USE_NEW_REPORT_PATH");
  fs.writeFileSync(dest,JSON.stringify(plan,null,2)+"\n",{flag:"wx",mode:0o600});
  console.log([
    "PENTAGON_ACTIVATION_REVIEW_LOCAL_ONLY",
    "GATE="+plan.gate,
    "DOMAIN_TARGETS="+plan.counts.domain_targets,
    "DOMAIN_REVIEW_REQUIRED="+plan.counts.domain_requires_review,
    "NODE_TARGETS="+plan.counts.node_targets,
    "NODE_REVIEW_REQUIRED="+plan.counts.node_requires_review,
    "NO_LIVE_DB_OR_TELEGRAM_ACCESS",
    "OUTPUT="+dest
  ].join("\n"));
  return plan;
}

if(require.main===module){
  try{main();}
  catch(e){console.error("ACTIVATION_REVIEW_STOPPED:"+(
    e instanceof ReviewStop?e.code:"MALFORMED_OR_UNAVAILABLE_LOCAL_REPORT"));process.exitCode=2;}
}
module.exports={REPORT_TYPE,DECISION_TYPE,PLAN_TYPE,ReviewStop,digest,verifyMappingReport,
  buildReviewPlan,parseDecisions,main};
