#!/usr/bin/env node
"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const source=fs.readFileSync(path.join(__dirname,"../server/projectRoutes.js"),"utf8");
let count=0;
function test(name,fn){try{fn();count++;}catch(e){throw Error(name+": "+e.message);}}
test("project router globally gated on trusted session and schema",()=>assert.match(source,/router\.use\(requireAuthenticatedScope\)/));
test("read project and domains with fleet",()=>{
  assert.match(source,/FROM \(SELECT \* FROM projects WHERE tenant=\$1 AND fleet=\$2\)/);
  assert.match(source,/FULL OUTER JOIN \(SELECT \* FROM domains WHERE tenant=\$1 AND fleet=\$2\)/);
});
test("read parameters are authenticated",()=>assert.match(source,/\[tenant, fleet\]/));
test("duplicate project within trusted scope",()=>assert.match(source,/LOWER\(name\)=LOWER\(\$1\) AND tenant=\$2 AND fleet=\$3/));
test("create writes tenant and fleet",()=>assert.match(source,/INSERT INTO projects \(name, notes, tenant, fleet\) VALUES \(\$1,\$2,\$3,\$4\)/));
test("create does not trust user JSON",()=>assert.match(source,/\[name, notes, req\.migrationScope\.tenant, req\.migrationScope\.fleet\]/));
test("project rename is blocked",()=>assert.match(source,/router\.patch\("\/:name", \(req, res\) => res\.status\(503\)/));
test("project delete is blocked",()=>assert.match(source,/router\.delete\("\/:name", \(req, res\) => res\.status\(503\)/));
test("no unscoped cascading rename SQL",()=>assert.doesNotMatch(source,/UPDATE domains SET project_name/));
test("no unscoped delete SQL",()=>assert.doesNotMatch(source,/DELETE FROM projects WHERE name=/));
test("no direct anonymous tenant fallback",()=>assert.doesNotMatch(source,/req\.tenant \|\| 'admin'/));
test("no automatic unsafe new global constraint",()=>assert.doesNotMatch(source,/DROP CONSTRAINT/));
console.log("PENTAGON_PROJECT_SAFETY_TESTS_PASS="+count);
