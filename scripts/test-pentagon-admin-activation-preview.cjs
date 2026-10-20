#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {buildAdminPreview}=require("./pentagon-admin-activation-preview.cjs");
let passed=0;const t=(name,fn)=>{fn();passed++;console.log("PASS "+name);};
const sr=(id,domain,tenant,fleet,is_active=true)=>({id,domain,tenant,fleet,is_active,project_name:"QA Project"});
const tr=(id,domain,tenant)=>({id,domain,tenant,is_active:true});
t("two admin records in different fleets collapse into ONE monitor-only candidate",()=>{
 const source=[sr(9,"Admin.Example","admin","fleet-one"),sr(16,"admin.example","admin","fleet-two"),
   sr(1,"demo1.example","demo","fleet-one"),sr(2,"demo1.example","demo","fleet-two")];
 const p=buildAdminPreview(source,[tr(1,"demo1.example","demo")]);
 assert.equal(p.counts.source_admin,2);
 assert.equal(p.counts.source_admin_unique_hosts,1);
 assert.equal(p.counts.monitor_only_candidate_hosts,1);
 assert.equal(p.counts.historical_multi_fleet_admin_hosts,1);
 assert.deepEqual(p.source_admin_reviews[0].source_ids,["9","16"]);
 assert.deepEqual(p.source_admin_reviews[0].origin_fleets,["fleet-one","fleet-two"]);
 assert.equal(p.source_admin_reviews[0].activation_allowed,false);
 assert.equal(p.gates.task_history_not_migrated,true);
 assert.equal(p.gates.activation_allowed,false);
});
t("host reused across tenants is not an admin candidate",()=>{
 const p=buildAdminPreview([sr(1,"same.example","admin","north"),sr(2,"same.example","demo","south")],[]);
 assert.equal(p.counts.monitor_only_candidate_hosts,0);
 assert.equal(p.source_admin_reviews[0].reason,"SOURCE_CROSS_TENANT_HOST_CONFLICT");
});
t("existing target occupant of any tenant prohibits preview",()=>{
 const p=buildAdminPreview([sr(1,"alpha.example","admin","north")],[tr(1,"ALPHA.EXAMPLE","demo")]);
 assert.equal(p.source_admin_reviews[0].reason,"TARGET_HOST_ALREADY_OCCUPIED");
});
t("disabled source admin record prohibits activation",()=>{
 const p=buildAdminPreview([sr(1,"alpha.example","admin","north",false)],[]);
 assert.equal(p.source_admin_reviews[0].reason,"SOURCE_HAS_DISABLED_RECORD");
});
t("duplicate same-fleet source identities are blocked",()=>{
 const p=buildAdminPreview([sr(1,"alpha.example","admin","north"),sr(2,"alpha.example","admin","north")],[]);
 assert.equal(p.source_admin_reviews[0].reason,"SOURCE_DUPLICATE_WITHIN_FLEET");
});
t("missing fleet blocks even one source record",()=>{
 const p=buildAdminPreview([sr(1,"alpha.example","admin","")],[]);
 assert.equal(p.source_admin_reviews[0].reason,"MISSING_SOURCE_FLEET");
});
t("invalid hostnames cannot be activated",()=>{
 const p=buildAdminPreview([sr(1,"https://example.com/","admin","north")],[]);
 assert.equal(p.source_admin_reviews[0].reason,"INVALID_HOSTNAME");
});
t("unique active admin domain is preview candidate but still not executable",()=>{
 const p=buildAdminPreview([sr(3,"alpha.example","admin","north")],[]);
 assert.equal(p.counts.monitor_only_candidate_hosts,1);
 assert.equal(p.source_admin_reviews[0].history_requires_fleet_mapping,false);
 assert.equal(p.gates.activation_allowed,false);
 assert.equal(p.gates.fresh_target_check_required,true);
});
t("read-only preview does not alter source or target fixtures",()=>{
 const source=[sr(3,"one.example","admin","east"),sr(5,"one.example","admin","west")],
   target=[tr(7,"two.example","demo")];
 const before=JSON.stringify({source,target});
 buildAdminPreview(source,target);buildAdminPreview(source,target);
 assert.equal(JSON.stringify({source,target}),before);
});
t("empty admin source returns no approvals or fabricated hosts",()=>{
 const p=buildAdminPreview([sr(2,"demo.example","demo","east")],[tr(4,"demo.example","demo")]);
 assert.equal(p.counts.monitor_only_candidate_hosts,0);
 assert.equal(p.counts.source_admin_unique_hosts,0);
 assert.equal(p.gates.activation_allowed,false);
});
console.log("PENTAGON_ADMIN_MONITOR_ONLY_PREVIEW_PASS="+passed);
