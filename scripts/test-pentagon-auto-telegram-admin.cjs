#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const read=p=>fs.readFileSync(path.join(__dirname,"..",p),"utf8");
const component=read("src/TelegramPermanentGroupsAdmin.jsx");
const css=read("src/TelegramPermanentGroupsAdmin.css");
const server=read("server/telegramPermanentGroups.js");
let passed=0;
function check(name,test){test();passed++;console.log("PASS "+name);}
check("Super Admin sees auto provisioning status not manual-first flow",()=>{
  assert.match(component,/Merchant Report Provisioning/);
  assert.match(component,/Automatic group creation is on hold/);
  assert.match(component,/group\.group_state/);
  assert.match(component,/identity_verified/);
  assert.match(component,/provisioner_configured/);
  assert.match(component,/PENTAGON \| /);
});
check("Manual group setup only in closed recovery details",()=>{
  assert.match(component,/<details className="tgPermRecovery">/);
  assert.match(component,/Super Admin recovery only/);
  assert.match(component,/\/setup","POST",\{tenant\}/);
});
check("Admin directory joins tenant activation state without exposing user ID",()=>{
  assert.match(server,/telegram_merchant_activations a ON a\.tenant=t\.tenant/);
  assert.match(server,/a\.group_state/);
  assert.match(server,/a\.group_attempts/);
  assert.match(server,/activation\.bridgeAvailable\(\)/);
  const span=server.slice(server.indexOf('router.get("/list"'),server.indexOf('router.post("/setup"'));
  assert.doesNotMatch(span,/telegram_user_id/);
  assert.doesNotMatch(span,/token_hash/);
});
check("Mobile group monitoring uses responsive three-stage status",()=>{
  assert.match(css,/\.tgPermAutoStats/);
  assert.match(css,/\.tgPermAutoRow/);
  assert.match(css,/@media\(max-width:760px\)/);
});
console.log("PENTAGON_AUTO_TELEGRAM_ADMIN_PASS="+passed+"/4");
