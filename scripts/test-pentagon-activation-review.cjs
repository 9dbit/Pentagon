#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {buildReviewPlan,verifyMappingReport,main,DECISION_TYPE,digest}=require("./pentagon-activation-review.cjs");
let pass=0;
async function check(label,fn){await fn();pass++;console.log("PASS "+label);}
const fixture=()=>({
  report_type:"pentagon_local_mapping_review",
  captured_at_utc:"2026-10-18T05:00:35.224Z",
  production_connections:0,production_writes:0,import_allowed:false,
  status:"REVIEW_COMPLETE_IMPORT_BLOCKED",local_cluster_stopped:true,
  domain_mapping_candidates:[
    {target_id:12,target_tenant:"admin",status:"BLOCKED_MISSING_TARGET_FLEET",
      source_same_tenant_count:2,source_candidates:[
        {id:2,tenant:"admin",fleet:"fleet-north"},
        {id:9,tenant:"admin",fleet:"fleet-south"}]},
    {target_id:14,target_tenant:"demo",status:"BLOCKED_MISSING_TARGET_FLEET",
      source_same_tenant_count:2,source_candidates:[
        {id:3,tenant:"demo",fleet:"fleet-north"},
        {id:10,tenant:"demo",fleet:"fleet-south"}]}
  ],
  node_mapping_candidates:[
    {target_id:25,target_tenant:"admin",same_id_present:true,
      same_id_name_matches:true,same_id_tenant_matches:false,source_same_name_count:2},
    {target_id:26,target_tenant:"admin",same_id_present:false,
      same_id_name_matches:false,same_id_tenant_matches:false,source_same_name_count:0}
  ]
});
const sha="3".repeat(64);
function decisions(){return {
  type:DECISION_TYPE,version:1,report_sha256:sha,
  reviewed_by:"pentagon-reviewer",review_ticket:"SEC-2026-1020",
  reviewed_at_utc:"2026-10-20T16:00:00.000Z",
  domains:[],nodes:[]
};}
async function run(){
await check("offline plan quarantines every unresolved fleet and node",()=>{
 const p=buildReviewPlan(fixture(),sha);
 assert.equal(p.gate,"MANUAL_RECONCILIATION_REQUIRED");
 assert.equal(p.counts.domain_targets,2);
 assert.equal(p.counts.domain_requires_review,2);
 assert.equal(p.counts.disputed_source_domain_targets,2);
 assert.equal(p.counts.node_requires_review,2);
 assert.equal(p.counts.identity_conflicted_nodes,1);
 assert.equal(p.counts.target_only_nodes,1);
 assert.equal(p.safety.activation_allowed,false);
 assert.equal(p.safety.task_replay_allowed,false);
 assert.equal(p.evidence.import_allowed,false);
});
await check("a human choice must select same tenant, same source ID, same fleet",()=>{
 const d=decisions();
 d.domains.push({target_id:12,target_tenant:"admin",action:"select_source_fleet",
   source_id:9,source_tenant:"admin",source_fleet:"fleet-south"});
 const p=buildReviewPlan(fixture(),sha,d);
 assert.equal(p.counts.domain_reviewed,1);
 assert.equal(p.counts.domain_requires_review,1);
 assert.equal(p.domain_reviews[0].selected_source.fleet,"fleet-south");
 assert.equal(p.safety.activation_allowed,false);
});
await check("cross-tenant source substitution is refused",()=>{
 const d=decisions();
 d.domains.push({target_id:12,target_tenant:"admin",action:"select_source_fleet",
   source_id:3,source_tenant:"demo",source_fleet:"fleet-north"});
 assert.throws(()=>buildReviewPlan(fixture(),sha,d),/DOMAIN_SOURCE_FLEET_NOT_IN_REPORT/);
});
await check("candidate guessing with an incorrect fleet is refused",()=>{
 const d=decisions();
 d.domains.push({target_id:12,target_tenant:"admin",action:"select_source_fleet",
   source_id:2,source_tenant:"admin",source_fleet:"fleet-south"});
 assert.throws(()=>buildReviewPlan(fixture(),sha,d),/DOMAIN_SOURCE_FLEET_NOT_IN_REPORT/);
});
await check("report fingerprint binds every review decision",()=>{
 const d=decisions();
 d.report_sha256="a".repeat(64);
 assert.throws(()=>buildReviewPlan(fixture(),sha,d),/DECISION_REPORT_HASH_MISMATCH/);
});
await check("ambiguous same-ID node cannot be silently repurposed",()=>{
 const d=decisions();
 d.nodes.push({target_id:25,target_tenant:"admin",action:"preserve_target_only"});
 assert.throws(()=>buildReviewPlan(fixture(),sha,d),/NODE_PRESERVATION_NOT_SAFE/);
});
await check("node conflicts can be manually quarantined and target-only nodes preserved",()=>{
 const d=decisions();
 d.nodes.push({target_id:25,target_tenant:"admin",action:"quarantine_conflict"});
 d.nodes.push({target_id:26,target_tenant:"admin",action:"preserve_target_only"});
 const p=buildReviewPlan(fixture(),sha,d);
 assert.equal(p.counts.node_requires_review,0);
 assert.equal(p.node_reviews[0].result,"NODE_CONFLICT_QUARANTINED");
 assert.equal(p.node_reviews[1].result,"TARGET_ONLY_NODE_PRESERVED_NOT_ACTIVATED");
});
await check("duplicate targets and duplicate approval rows stop",()=>{
 const a=fixture();a.domain_mapping_candidates.push({...a.domain_mapping_candidates[0]});
 assert.throws(()=>verifyMappingReport(a),/DUPLICATE_TARGET_DOMAIN_ID/);
 const d=decisions();
 d.domains.push({target_id:12,target_tenant:"admin",action:"select_source_fleet",
   source_id:2,source_tenant:"admin",source_fleet:"fleet-north"});
 d.domains.push({...d.domains[0]});
 assert.throws(()=>buildReviewPlan(fixture(),sha,d),/DUPLICATE_DOMAIN_DECISION/);
});
await check("complete manual review remains blocked pending fresh target and separate release",()=>{
 const d=decisions();
 d.domains.push({target_id:12,target_tenant:"admin",action:"select_source_fleet",
   source_id:2,source_tenant:"admin",source_fleet:"fleet-north"});
 d.domains.push({target_id:14,target_tenant:"demo",action:"select_source_fleet",
   source_id:10,source_tenant:"demo",source_fleet:"fleet-south"});
 d.nodes.push({target_id:25,target_tenant:"admin",action:"quarantine_conflict"});
 d.nodes.push({target_id:26,target_tenant:"admin",action:"preserve_target_only"});
 const p=buildReviewPlan(fixture(),sha,d);
 assert.equal(p.gate,"MAPPING_REVIEWED_AWAIT_FRESH_TARGET_BACKUP_AND_SEPARATE_RELEASE");
 assert.equal(p.safety.activation_allowed,false);
 assert.equal(p.safety.target_fleet_schema_verified,false);
});
await check("unsafe/malformed local mapping report cannot proceed",()=>{
 const a=fixture();a.import_allowed=true;
 assert.throws(()=>buildReviewPlan(a,sha),/REPORT_SAFETY_GATE_FAILED/);
 const b=fixture();b.production_connections=1;
 assert.throws(()=>buildReviewPlan(b,sha),/REPORT_SAFETY_GATE_FAILED/);
 const c=fixture();c.local_cluster_stopped=false;
 assert.throws(()=>buildReviewPlan(c,sha),/REPORT_SAFETY_GATE_FAILED/);
});
await check("actual CLI saves a local private-only review and never overwrites it",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"pentagon-activation-ci-"));
 try{
  const source=path.join(dir,"mapping.json"),out=path.join(dir,"review.json");
  fs.writeFileSync(source,JSON.stringify(fixture()));
  const expected=digest(fs.readFileSync(source));
  const plan=main(["--report",source,"--out",out]);
  assert.equal(plan.report_sha256,expected);
  assert.equal(JSON.parse(fs.readFileSync(out,"utf8")).counts.domain_requires_review,2);
  assert.throws(()=>main(["--report",source,"--out",out]),/OUTPUT_EXISTS_USE_NEW_REPORT_PATH/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
console.log("PENTAGON_SAFE_ACTIVATION_REVIEW_PASS="+pass);
}
run().catch(err=>{console.error("ACTIVATION_REVIEW_TEST_FAILED="+err.stack);process.exitCode=1;});
