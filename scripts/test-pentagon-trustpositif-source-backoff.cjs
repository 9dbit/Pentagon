#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const folder=fs.mkdtempSync(path.join(os.tmpdir(),"pentagon-trust-source-backoff-"));
process.env.TRUSTPOSITIF_CACHE_PATH=path.join(folder,"fictional-domains_isp.txt");
process.env.TRUSTPOSITIF_PREWARM="false";
process.env.TRUSTPOSITIF_SOURCE_BACKOFF_MS="1800000";
const modulePath=require.resolve("../server/trustpositifRoutes");
const source=fs.readFileSync(path.join(__dirname,"../server/scheduler.js"),"utf8");
const boot=fs.readFileSync(path.join(__dirname,"../server/railway-entry.js"),"utf8");
let count=0;
function test(name,fn){fn();count++;process.stdout.write("PASS "+name+"\n");}
(async()=>{
 try{
  const a=require(modulePath);
  test("source breaker installed",()=>assert.equal(typeof a.sourceBackoffDiagnostics?.setSourceBackoff,"function"));
  a.sourceBackoffDiagnostics.setSourceBackoff();
  test("failure backoff at least 30 minutes",()=>assert.ok(a.sourceBackoffDiagnostics.getSourceBackoffUntil()-Date.now()>29*60000));
  await assert.rejects(a.ensureIndexedCache(),/OFFICIAL_SOURCE_BACKOFF/);
  count++;
  test("no registry downloaded while breaker active",()=>assert.equal(fs.existsSync(process.env.TRUSTPOSITIF_CACHE_PATH),false));
  delete require.cache[modulePath];
  const b=require(modulePath);
  test("breaker survives process-level module reload",()=>assert.ok(b.sourceBackoffDiagnostics.getSourceBackoffUntil()>Date.now()));
  await assert.rejects(b.ensureIndexedCache(),/OFFICIAL_SOURCE_BACKOFF/);
  count++;
  b.sourceBackoffDiagnostics.clearSourceBackoff();
  test("successful source recovery clears backoff",()=>assert.equal(b.sourceBackoffDiagnostics.getSourceBackoffUntil(),0));
  test("only explicit separate worker flag enables scoped mode",()=>{
   assert.match(source,/TRUSTPOSITIF_SCOPED_SCHEDULER \|\| "false"/);
   assert.match(source,/SCHEDULER_ENABLED \|\| "true"/);
   assert.match(boot,/startScopedTrustPositifScheduler\(\)/);
  });
  test("scoped worker never marks domain blocked without confirmation",()=>{
   assert.match(source,/options\.trustpositifOnly && !registryCheck\.confirmedBlocked && !registryCheck\.holdBlocked/);
   assert.match(source,/nodes\.length < 2/);
  });
  test("scanner bound limits and rotates across active domains",()=>{
   assert.match(source,/Math\.min\(20, Math\.max\(1/);
   assert.match(source,/scopedWatch\.cursor = \(scopedWatch\.cursor \+ domains\.length\) % total/);
   assert.match(source,/tenant='admin' AND is_active=TRUE/);
  });
  test("Telegram output HTML escaping and existing alert persistence",()=>{
   assert.match(source,/registryCheck\.nodes\?\.map\(n => htmlEsc\(n\.name\)\)/);
   assert.match(source,/INSERT INTO alerts/);
   assert.match(source,/sendTelegram\(message, telegramExtra\)/);
  });
  console.log("PENTAGON_TRUSTPOSITIF_SOURCE_BACKOFF_TESTS_PASS="+count);
 } finally{
  fs.rmSync(folder,{recursive:true,force:true});
 }
})().catch(e=>{console.error("PENTAGON_TRUSTPOSITIF_BREAKER_TEST_FAILED="+e.stack);process.exitCode=1});
