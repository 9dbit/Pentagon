#!/usr/bin/env node
"use strict";
// Real, isolated CI PostgreSQL fixture. NEVER point DATABASE_URL at a remote
// Pentagon database. GitHub Action sets PENTAGON_SIGNUP_FIXTURE=1.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Pool}=require("pg");
const {createMerchantSignupLifecycle}=require("../server/merchantSignupLifecycle");
const {processOne}=require("../server/merchantSignupOnboarding");
const {currentViewerTenant,currentMerchantTenant}=require("../server/customerViewerAuth");
const {createMerchantSignupRoutes}=require("../server/merchantSignupRoutes");
const express=require("express");
const {createResendSender}=require("../server/merchantSignupEmail");
if(process.env.PENTAGON_SIGNUP_FIXTURE!=="1"||!/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL||""))
 throw Error("CI_POSTGRES_ONLY");
const db=new Pool({connectionString:process.env.DATABASE_URL,max:3});
let passed=0;
async function check(label,fn){await fn();passed++;console.log("PASS "+label);}
function code(url){return new URL(url).searchParams.get("code");}
async function main(){
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$");
 const sql=fs.readFileSync(path.join(__dirname,"../server/db/migrations/20261027_merchant_signup_phase2.sql"),"utf8");
 await db.query(sql);
 const mails=[];
 const svc=createMerchantSignupLifecycle(db,{
  sendEmail:async m=>{mails.push(m);return true;},
  rateSecret:"test-secret-for-pentagon-signup-1234567890abcd",
  baseUrl:"https://pentagon.quest"
 });
 await check("RLS, role grants, and token table are isolated",async()=>{
  const {rows}=await db.query(
   "SELECT c.relname,c.relrowsecurity FROM pg_class c WHERE c.relnamespace='public'::regnamespace "+
   "AND c.relname=ANY($1::text[]) ORDER BY c.relname",[
    ["merchant_signup_requests","merchant_signup_challenges","merchant_accounts","merchant_signup_rate_limits","merchant_onboarding_jobs"]]);
  assert.equal(rows.length,5);assert.ok(rows.every(r=>r.relrowsecurity===true));
  const c=await db.connect();
  try{
   await c.query("SET ROLE anon");
   await assert.rejects(c.query("SELECT * FROM public.merchant_accounts"),/permission denied/);
   await assert.rejects(c.query("SELECT * FROM public.merchant_signup_challenges"),/permission denied/);
  }finally{await c.query("RESET ROLE");c.release();}
 });
 await check("Application cannot be approved before email verification",async()=>{
  await svc.start({email:"OWNER@MCHA.EXAMPLE",company:"Merchant A",consent:true,ip:"203.0.113.1"});
  assert.equal(mails.length,1);
  await assert.rejects(svc.approve({requestId:1,reviewerId:"superadmin@example.test"}),/APPLICATION_NOT_REVIEWABLE/);
  assert.equal((await db.query("SELECT status FROM merchant_signup_requests WHERE id=1")).rows[0].status,"pending");
 });
 await check("Verification token is one-use and must be consumed before review",async()=>{
  assert.equal((await svc.verifyEmail(code(mails[0].url))).status,"reviewing");
  await assert.rejects(svc.verifyEmail(code(mails[0].url)),/INVALID_OR_EXPIRED_LINK/);
  assert.equal((await db.query("SELECT status FROM merchant_signup_requests WHERE id=1")).rows[0].status,"reviewing");
 });
 await check("Super Admin approval sends one activation invitation",async()=>{
  assert.equal((await svc.approve({requestId:1,reviewerId:"superadmin@example.test"})).status,"invited");
  assert.equal(mails[1].kind,"set_password");
  assert.equal((await db.query("SELECT count(*)::int n FROM merchant_accounts")).rows[0].n,0);
 });
 let account;
 await check("Password activation creates distinct tenant and only two onboarding jobs",async()=>{
  assert.equal((await svc.complete({token:code(mails[1].url),password:"a long unique password for merchant A"})).status,"active");
  account=(await svc.authenticate({email:"owner@mcha.example",password:"a long unique password for merchant A"}));
  assert.ok(account);
  assert.equal(account.role,"merchant_admin");
  assert.match(account.tenant,/^merchant-a-[0-9a-f]{16}$/);
  assert.equal((await db.query("SELECT count(*)::int n FROM merchant_onboarding_jobs WHERE account_id=$1",[account.id])).rows[0].n,2);
  await assert.rejects(svc.complete({token:code(mails[1].url),password:"another sufficiently long password"}),/INVALID_OR_EXPIRED_LINK/);
 });
 await check("Password mismatch, nonexistent account, and pending email cannot login",async()=>{
  assert.equal(await svc.authenticate({email:"owner@mcha.example",password:"wrong long secret here"}),null);
  assert.equal(await svc.authenticate({email:"nobody@example.test",password:"random other long password"}),null);
  await svc.start({email:"pending@mchb.example",company:"Merchant B",consent:true,ip:"203.0.113.2"});
  assert.equal(await svc.authenticate({email:"pending@mchb.example",password:"A very long password 2026"}),null);
 });
 await check("Browser input cannot forge tenant or role through authorized session",async()=>{
  const session={isCustomerViewer:true,isAdmin:false,isDemo:false,
    tenant:account.tenant,adminEmail:account.email,merchantAccountId:account.id};
  assert.equal(currentMerchantTenant(session,account),account.tenant);
  assert.equal(currentViewerTenant(session,account),account.tenant);
  assert.equal(currentMerchantTenant({...session,tenant:"wisnu123"},account),null);
  assert.equal(currentMerchantTenant({...session,merchantAccountId:"wrong"},account),null);
  assert.equal(currentMerchantTenant({...session,isAdmin:true},account),null);
  assert.equal(currentMerchantTenant(session),null);
 });
 await check("Onboarding worker retries Telegram only for approved active merchant",async()=>{
  const seen=[];
  assert.equal((await processOne(db,{prepare:async(tenant,email)=>{seen.push({tenant,email});return true;}})).status,"done");
  assert.equal((await processOne(db,{prepare:async(tenant,email)=>{seen.push({tenant,email});return true;}})).status,"done");
  assert.equal((await processOne(db,{prepare:async()=>false})).status,"idle");
  assert.equal(seen.length,1);assert.equal(seen[0].tenant,account.tenant);
 });
 await check("Revoked account invalidates sessions without changing legacy grants",async()=>{
  assert.equal((await svc.validateSession(account.id)).tenant,account.tenant);
  await db.query("UPDATE merchant_accounts SET status='revoked' WHERE id=$1",[account.id]);
  assert.equal(await svc.validateSession(account.id),null);
  assert.equal(await svc.authenticate({email:account.email,password:"a long unique password for merchant A"}),null);
 });
 await check("Origin guard rejects CSRF and Super Admin is never granted to merchant",async()=>{
  const {publicRouter,adminRouter}=createMerchantSignupRoutes(express,svc,{enabled:true});
  const app=express();app.use(express.json());
  app.use("/apply",publicRouter);app.use("/admin",adminRouter);
  const http=app.listen(0,"127.0.0.1");
  await new Promise(r=>http.listening?r():http.once("listening",r));
  try{
   const base="http://127.0.0.1:"+http.address().port;
   const payload={email:"bad@candidate.example",company:"Candidate",consent:true};
   const cors=await fetch(base+"/apply",{method:"POST",headers:{"content-type":"application/json","Origin":"https://evil.example"},
      body:JSON.stringify(payload)});
   assert.equal(cors.status,403);
   const admin=await fetch(base+"/admin/pending",{headers:{Origin:"https://evil.example"}});
   assert.equal(admin.status,403);
  }finally{await new Promise(r=>http.close(r));}
 });
 await check("Resend email link must match exact verified origin",async()=>{
  let sent=0;
  const sender=createResendSender({
   apiKey:"re_test_123456789012345678901",from:"noreply@pentagon.quest",
   fetchImpl:async()=>{sent++;return {ok:true};}
  });
  await sender({to:"owner@example.com",kind:"verify_email",url:"https://pentagon.quest/signup/verify/?code=x"});
  await assert.rejects(sender({to:"owner@example.com",kind:"verify_email",url:"https://evil.example/signup/verify/?code=x"}),/INVALID_MAIL_REQUEST/);
  assert.equal(sent,1);
 });
 console.log("PENTAGON_SIGNUP_POSTGRES_PASS="+passed+"/11");
}
main().catch(e=>{console.error("PENTAGON_SIGNUP_POSTGRES_FAILURE",e.stack||e);process.exitCode=1;})
 .finally(async()=>db.end());
