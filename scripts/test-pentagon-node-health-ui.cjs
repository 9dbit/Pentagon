#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const src=p=>fs.readFileSync(path.join(__dirname,"..",p),"utf8");
const ui=src("src/MerchantAdminPage.jsx");
const card=src("src/MerchantNodeCardV2.jsx");
const css=src("src/MerchantAdminPage.css");
const backend=src("server/merchantAdminRoutes.js");
let passed=0;
function test(name,fn){fn();passed++;console.log("PASS "+name);}

test("merchant dashboard fetches individual guarded telemetry",()=>{
  assert.match(ui,/\/api\/merchant\/node-health/);
  assert.match(ui,/nodeHealth\.nodes/);
  assert.match(ui,/<MerchantNodeCardV2/);
  assert.match(ui,/setInterval\(reload,\s*60000\)/);
  assert.ok(!ui.includes('request("/api/nodes")'));
});
test("node card exposes signal, battery and status as separate visible concepts",()=>{
  for(const term of ["maSignalMeter","SIGNAL STRENGTH","maBatteryTrack","BATTERY LEVEL",
     "isCharging","maNodeEnabled","maNodeDot","connectivityText",
     "maConnectionDot","maHeartbeat","LAST READING","Battery reported"])
    assert.ok(card.includes(term),term);
  assert.match(card,/\[1,2,3,4,5\]\.map/);
  assert.match(card,/node\.signal_bars/);
  assert.match(card,/node\.battery_percent/);
  assert.match(card,/node\.is_active/);
  assert.match(card,/node\.last_seen_at/);
});
test("strict read-only tenant-scoped backend without raw node rows",()=>{
  assert.match(backend,/router\.get\("\/node-health"/);
  assert.match(backend,/serializeMerchantNodes/);
  assert.match(backend,/n\.tenant IN \('admin',\$1\)/);
  assert.match(backend,/router\.all\("\/node-health"/);
  const fragment=backend.slice(backend.indexOf('router.get("/node-health"'),backend.indexOf('router.all("/node-health"'));
  assert.ok(!fragment.includes("SELECT n.*"));
  assert.ok(!fragment.includes("t.*"));
});
test("solid orange no hairline Node Card styling",()=>{
  assert.match(css,/#ff7a00/i);
  const scoped=css.slice(css.indexOf("/* PENTAGON NODE HEALTH V2"));
  assert.match(scoped,/\.maNodeCardV2\{[^}]*background:#24272d/);
  assert.match(scoped,/\.maSignalMeter span\.filled\{background:#ff7a00/);
  assert.match(scoped,/\.maNodeStatusV2\{[^}]*background:#15181d/);
  assert.doesNotMatch(scoped,/linear-gradient\(/);
  assert.doesNotMatch(scoped,/backdrop-filter/);
  assert.doesNotMatch(scoped,/border:\s*1px/);
});
test("layout responsive desktop, tablet and 320px safe",()=>{
  assert.match(css,/@media\(min-width:1590px\)/);
  assert.match(css,/@media\(max-width:1190px\)/);
  assert.match(css,/@media\(max-width:760px\)/);
  assert.match(css,/@media\(max-width:340px\)/);
  assert.match(css,/\.maNodeGridV2\{grid-template-columns:1fr\}/);
  assert.match(css,/prefers-reduced-motion:reduce/);
});
console.log("PENTAGON_NODE_HEALTH_V2_UI_PASS="+passed);
