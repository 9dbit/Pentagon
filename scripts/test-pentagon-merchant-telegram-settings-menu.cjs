#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const load=n=>fs.readFileSync(path.join(__dirname,"..",n),"utf8");
const app=load("src/MerchantAdminPage.jsx");
const reports=load("src/MerchantTelegramHub.jsx");
const settings=load("src/MerchantTelegramGroupSettings.jsx");
const activation=load("server/telegramMerchantActivation.js");
const auto=load("server/telegramMerchantAutoProvisioner.js");
const bridge=load("telegram_mt_bridge/app.py");
let passed=0;
function check(name,fn){fn();passed++;console.log("PASS "+name);}
check("Merchant Telegram Settings appears on desktop and mobile",()=>{
 assert.match(app,/key: "telegram-settings", text: "Telegram Settings"/);
 assert.match(app,/NAV\.map/);
 assert.match(app,/page === "telegram-settings"/);
 assert.match(app,/<MerchantTelegramGroupSettings onBackToReports=/);
 assert.match(reports,/Activate Telegram Report/);
});
check("Activation UI offers QR, Telegram ID and camera scanning",()=>{
 assert.match(settings,/Activate Telegram Report/);
 assert.match(settings,/QRCodeSVG/);
 assert.match(settings,/Telegram username or numeric user ID/);
 assert.match(settings,/Scan Merchant QR/);
 assert.match(settings,/getUserMedia/);
 assert.match(settings,/BarcodeDetector/);
 assert.match(settings,/validProfileQr/);
});
check("Tenant identity comes from authenticated session, not merchant form",()=>{
 assert.match(activation,/router\.use\(requireMerchantAdmin\)/);
 assert.match(activation,/const tenant=req\.merchantTenant/);
 assert.match(activation,/\/activate/);
 assert.match(activation,/\/identity-hint/);
 assert.match(activation,/\/deliveries/);
 assert.match(activation,/token_hash/);
 assert.match(activation,/identity_hint_kind/);
 assert.match(activation,/chat_id/);
});
check("Real group auto-provisioner keeps unique tenant-chat mapping",()=>{
 assert.match(auto,/telegram_merchant_groups/);
 assert.match(auto,/pg_try_advisory_lock/);
 assert.match(auto,/PENTAGON_TELEGRAM_MT_BRIDGE_KEY/);
 assert.match(auto,/GROUP_ALREADY_BOUND/);
 assert.match(auto,/group_state='ready'/);
 assert.match(auto,/getChatMember/);
});
check("MTProto bridge requires user session and verifies dedicated private group",()=>{
 assert.match(bridge,/StringSession/);
 assert.match(bridge,/CreateChannelRequest/);
 assert.match(bridge,/megagroup=True/);
 assert.match(bridge,/getattr\(channel, "creator", False\)/);
 assert.match(bridge,/EditAdminRequest/);
 assert.match(bridge,/compare_digest/);
});
console.log("PENTAGON_MERCHANT_TELEGRAM_SETTINGS_MENU_PASS="+passed+"/5");
