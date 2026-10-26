#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const ui=fs.readFileSync(path.join(__dirname,"../src/MerchantTelegramHub.jsx"),"utf8");
const css=fs.readFileSync(path.join(__dirname,"../src/MerchantTelegramHub.css"),"utf8");
const hub=fs.readFileSync(path.join(__dirname,"../server/telegramHub.js"),"utf8");
const group=fs.readFileSync(path.join(__dirname,"../server/telegramPermanentGroups.js"),"utf8");
let passed=0;
function test(name,fn){fn();passed++;console.log("PASS "+name);}
test("Report Settings rendered for pending and connected merchant",()=>{
  const settingsIndex=ui.indexOf('className="maTgSection maTgSettingsSection"');
  const pendingIndex=ui.indexOf('{!ready?<div className="maTgSection">');
  assert.ok(settingsIndex>=0 && pendingIndex>settingsIndex,"settings must precede pending group UI");
  assert.doesNotMatch(ui,/\{ready&&<div className="maTgSection">\s*<h3>Report preferences/);
  assert.match(ui,/<h3><Bell size=\{18\}\/> Report Settings<\/h3>/);
});
test("Inputs can be changed without a linked group, with loading protection",()=>{
  assert.match(ui,/disabled=\{working\|\|!state\}/);
  assert.doesNotMatch(ui,/disabled=\{working\|\|!connected\}[\s\S]{0,60}checked=\{Boolean\(prefs\[key\]\)\}/);
  assert.match(ui,/Settings can be saved now/);
  assert.match(css,/\.maTgSettingsSection/);
});
test("Tenant scoped pending changes create disabled row and report saved status",()=>{
  assert.match(hub,/if\(!permittedTenant\(t\)\)return res\.status\(403\)/);
  assert.match(hub,/INSERT INTO telegram_hub_connections/);
  assert.match(hub,/FALSE,'disconnected'/);
  assert.match(hub,/ON CONFLICT\(tenant\) DO UPDATE/);
  assert.match(hub,/preferences_saved:Boolean\(c\)/);
});
test("Permanent group binding preserves preconfigured frequency and unique group",()=>{
  assert.match(group,/next_report_at=NOW\(\)\+\(telegram_hub_connections\.interval_minutes\*INTERVAL '1 minute'\)/);
  assert.match(group,/SELECT tenant FROM telegram_merchant_groups/);
});
console.log("PENTAGON_TELEGRAM_SETTINGS_VISIBILITY_PASS="+passed+"/4");
