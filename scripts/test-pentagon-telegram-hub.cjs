#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
process.env.TELEGRAM_HUB_ENABLED="true";
process.env.TELEGRAM_BOT_TOKEN="synthetic-test-token-not-real";
const crypto=require("node:crypto");
const hub=require("../server/telegramHub");
const reports=require("../server/telegramHubReports");
let passed=0;
function test(name,fn){
  fn();passed++;console.log("PASS "+name);
}
test("Webhook secret rejects missing, forged and mismatched values",()=>{
  assert.equal(hub.verifyWebhookSecret(null),false);
  assert.equal(hub.verifyWebhookSecret("x"),false);
  const correct=crypto.createHmac("sha256",process.env.TELEGRAM_BOT_TOKEN)
    .update("pentagon-hub-v1-webhook").digest("hex");
  assert.equal(hub.verifyWebhookSecret(correct),true);
  assert.equal(hub.verifyWebhookSecret(correct.slice(0,-1)+"0"),false);
});
test("Tenant validation excludes demo and malformed identity",()=>{
  assert.equal(hub.permittedTenant("merchant_a"),true);
  assert.equal(hub.permittedTenant("merchant-b"),true);
  assert.equal(hub.permittedTenant("demo"),false);
  assert.equal(hub.permittedTenant("test_merchant"),false);
  assert.equal(hub.permittedTenant("../admin"),false);
});
test("Token hash stable without storing plaintext",()=>{
  assert.match(hub.hashToken("one-time-secret"),/^[a-f0-9]{64}$/);
  assert.notEqual(hub.hashToken("one-time-secret"),"one-time-secret");
  assert.notEqual(hub.hashToken("one-time-secret"),hub.hashToken("other-token"));
});
test("Digest only renders tenant-provided whitelist rows",()=>{
  const now=new Date("2026-10-26T08:00:00Z");
  const pages=reports.buildReportPages("merchant_a",[
    {domain:"own.example",global_status:"working",last_checked_at:"2026-10-26T07:59:00Z"},
    {domain:"blocked.example",global_status:"blocked",last_checked_at:"2026-10-26T07:58:00Z"},
    {domain:"stale.example",global_status:"working",last_checked_at:"2026-10-24T07:00:00Z"}
  ],now);
  assert.equal(pages.length,1);
  assert.match(pages[0],/own\.example/);
  assert.match(pages[0],/blocked\.example/);
  assert.match(pages[0],/Stale:.*1/);
  assert.match(pages[0],/Unknown\/stale does not mean safe/);
  assert.ok(!pages[0].includes("other.example"));
});
test("Escaping strips executable Telegram HTML from a domain string",()=>{
  const pages=reports.buildReportPages("tenant",[
    {domain:"<b>bad</b>.example",global_status:"blocked",last_checked_at:"2026-10-26T08:00:00Z"}
  ],new Date("2026-10-26T08:00:00Z"));
  assert.ok(pages[0].includes("&lt;b&gt;bad&lt;/b&gt;.example"));
  assert.ok(!pages[0].includes("<b>bad</b>.example"));
});
test("Long whitelist reports paginate beneath Telegram message cap",()=>{
  const rows=Array.from({length:160},(_,i)=>({
    domain:"merchant-"+i+"-subdomain-very-long.example",
    global_status:i%2?"working":"warning",
    last_checked_at:"2026-10-26T08:00:00Z"
  }));
  const pages=reports.buildReportPages("tenant",rows,new Date("2026-10-26T08:00:00Z"));
  assert.ok(pages.length>=4);
  assert.ok(pages.every(p=>p.length<3900));
  assert.equal((pages.join("\n").match(/merchant-[0-9]+-subdomain/g)||[]).length,160);
});
test("Empty whitelist is not reported as fully healthy",()=>{
  const pages=reports.buildReportPages("tenant",[],new Date());
  assert.match(pages[0],/No active whitelisted domains/);
  assert.match(pages[0],/Unknown\/stale does not mean safe/);
});
test("Stale and unchecked records cannot be labelled working",()=>{
  const now=Date.parse("2026-10-26T08:00:00Z");
  assert.equal(reports.domainStatus({global_status:"working",last_checked_at:null},now),"UNKNOWN (not checked)");
  assert.equal(reports.domainStatus({global_status:"working",last_checked_at:"2026-10-23T00:00:00Z"},now),"STALE");
});
console.log("PENTAGON_TELEGRAM_HUB_PASS="+passed);
