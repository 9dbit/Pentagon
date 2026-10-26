#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const load=name=>fs.readFileSync(path.join(__dirname,"..",name),"utf8");
const app=load("src/MerchantAdminPage.jsx");
const reports=load("src/MerchantTelegramHub.jsx");
const settings=load("src/MerchantTelegramGroupSettings.jsx");
const backend=load("server/telegramPermanentGroups.js");
let passed=0;
function check(name,fn){fn();passed++;console.log("PASS "+name);}
check("Merchant Admin sidebar exposes Telegram Settings on desktop and mobile",()=>{
  assert.match(app,/key: "telegram-settings", text: "Telegram Settings"/);
  assert.match(app,/NAV\.map/);
  assert.match(app,/page === "telegram-settings"/);
  assert.match(app,/<MerchantTelegramGroupSettings onBackToReports=/);
});
check("Merchant Reports provides a direct action to group setup",()=>{
  assert.match(reports,/<MerchantTelegramHub/);
  assert.match(reports,/onOpenGroupSettings/);
  assert.match(reports,/Open Telegram Group Settings/);
  assert.match(reports,/Telegram Group Settings/);
});
check("Merchant setup UI is session-derived, never selects or posts another tenant",()=>{
  assert.match(settings,/\/api\/merchant\/telegram-groups\/setup/);
  assert.match(settings,/api\("\/api\/merchant\/telegram-groups\/setup","POST",\{\}\)/);
  assert.match(settings,/PENTAGON \| /);
  assert.match(settings,/Generate setup code/);
  assert.match(settings,/10 minutes/);
  assert.match(settings,/Add the Pentagon reporting bot/);
  assert.doesNotMatch(settings,/<select[^>]*tenant/);
});
check("Backend requires merchant session and rejects cross-tenant setup",()=>{
  assert.match(backend,/router\.use\(requireMerchantAdmin\)/);
  assert.match(backend,/const tenant=req\.merchantTenant/);
  assert.match(backend,/CROSS_TENANT_SETUP_DENIED/);
  assert.match(backend,/issueGroupSetup\(tenant,req\.session\.adminEmail,db\)/);
  assert.match(backend,/MERCHANT_GROUP_PERMANENTLY_BOUND/);
});
check("Existing permanent binding and direct invite protections retained",()=>{
  assert.match(backend,/expectedTitle\(tenant\)/);
  assert.match(backend,/chat_id TEXT NOT NULL UNIQUE/);
  assert.match(backend,/chat\.title/);
  assert.match(backend,/can_invite_users/);
  assert.match(backend,/configuredOpsChatId|opsChatId/);
  assert.match(backend,/createChatInviteLink/);
});
console.log("PENTAGON_MERCHANT_TELEGRAM_SETTINGS_MENU_PASS="+passed+"/5");
