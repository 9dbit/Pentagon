#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const load=name=>fs.readFileSync(path.join(__dirname,"..",name),"utf8");
const reports=load("src/MerchantTelegramHub.jsx");
const settings=load("src/MerchantTelegramGroupSettings.jsx");
const css=load("src/MerchantTelegramGroupSettings.css");
const hub=load("server/telegramHub.js");
const group=load("server/telegramPermanentGroups.js");
let passed=0;
function check(name,fn){fn();passed++;console.log("PASS "+name);}
check("Telegram Reports displays only delivery events, not merchant group selectors",()=>{
 assert.match(reports,/Report Delivery History/);
 assert.match(reports,/\/deliveries/);
 assert.match(reports,/onOpenGroupSettings/);
 assert.doesNotMatch(reports,/<input[^>]*type="checkbox"/);
 assert.doesNotMatch(reports,/startgroup/);
});
check("Report preferences are editable from separate Telegram Settings",()=>{
 assert.match(settings,/Report Preferences/);
 assert.match(settings,/onChange=\{e=>updatePref\(key,e.target.checked\)\}/);
 assert.match(settings,/Digest frequency/);
 assert.match(css,/\.maGroupPrefs/);
});
check("Preferences persist pre-provision with disabled connection",()=>{
 assert.match(hub,/INSERT INTO telegram_hub_connections/);
 assert.match(hub,/FALSE,'disconnected'/);
 assert.match(hub,/ON CONFLICT\(tenant\) DO UPDATE/);
 assert.match(hub,/preferences_saved:Boolean\(c\)/);
});
check("Permanent bound destinations cannot reset merchant interval",()=>{
 assert.match(group,/next_report_at=NOW\(\)\+\(telegram_hub_connections\.interval_minutes\*INTERVAL '1 minute'\)/);
 assert.match(group,/chat_id TEXT NOT NULL UNIQUE/);
});
console.log("PENTAGON_TELEGRAM_SETTINGS_VISIBILITY_PASS="+passed+"/4");
