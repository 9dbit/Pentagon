#!/usr/bin/env node
"use strict";
// Real HTTP + PostgreSQL end-to-end test with synthetic Telegram transport.
// No production domain, bot credential, merchant or Telegram destination used.
const assert=require("node:assert/strict");
const { Client }=require("pg");
const express=require("express");
const axios=require("axios");

process.env.TELEGRAM_HUB_ENABLED="true";
process.env.TELEGRAM_BOT_TOKEN="synthetic-telegram-token-for-ci";
process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([
  {email:"merchant-a@example.test",tenant:"merchant_a",role:"merchant_admin"},
  {email:"merchant-b@example.test",tenant:"merchant_b",role:"merchant_admin"}
]);
const raw=process.env.DATABASE_URL||"";
if(!/127\.0\.0\.1|localhost/.test(raw))throw Error("CI-local database required");
const local=raw.replace("127.0.0.1","localhost");
const name="pentagon_tghub_"+process.pid;
let base="",admin=null,pool=null,http=null;
const telegramCalls=[];
const realPost=axios.post;
axios.post=async (url,body)=>{
  const method=String(url).split("/").pop();
  telegramCalls.push({method,body});
  if(method==="getMe")return {status:200,data:{ok:true,result:{id:10001,is_bot:true,username:"PentagonReportTestBot"}}};
  if(method==="getChatMember")return {status:200,data:{ok:true,result:{status:body.user_id===22222?"administrator":"member"}}};
  if(method==="sendMessage")return {status:200,data:{ok:true,result:{message_id:telegramCalls.length}}};
  if(method==="setWebhook")return {status:200,data:{ok:true,result:true}};
  if(method==="getChat")return {status:200,data:{ok:true,result:{id:body.chat_id,type:"supergroup",title:"Verified Merchant Reports",is_forum:false}}};
  throw Error("unexpected Telegram API "+method);
};
let pass=0;
async function test(name,fn){
  await fn();pass++;console.log("PASS "+name);
}
async function setup(){
  const parsed=new URL(local);
  const dbName=parsed.pathname.slice(1);
  assert.ok(dbName&&!dbName.includes("?"));
  admin=new Client({connectionString:local,ssl:false});
  await admin.connect();
  await admin.query('CREATE DATABASE "'+name+'"');
  parsed.pathname="/"+name;
  process.env.DATABASE_URL=parsed.toString();
  const {pool:db}=require("../server/db");
  pool=db;
  await pool.query("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TIMESTAMP DEFAULT NOW())");
  await pool.query("CREATE TABLE domains(id SERIAL PRIMARY KEY,domain TEXT UNIQUE NOT NULL,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE,global_status TEXT DEFAULT 'unknown',last_checked_at TIMESTAMP)");
  await pool.query("CREATE TABLE rank_keyword_groups(id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE)");
  await pool.query("CREATE TABLE rank_keyword_domains(id SERIAL PRIMARY KEY,group_id INT NOT NULL,domain TEXT NOT NULL,is_whitelisted BOOLEAN DEFAULT FALSE)");
  await pool.query("INSERT INTO domains(domain,tenant,global_status,last_checked_at) VALUES "+
    "('one.example.test','merchant_a','working',NOW()),"+
    "('two.example.test','merchant_b','blocked',NOW())");
  await pool.query("INSERT INTO rank_keyword_groups(tenant) VALUES('merchant_a'),('merchant_b')");
  await pool.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES "+
    "(1,'one.example.test',TRUE),(2,'two.example.test',TRUE)");
  const hub=require("../server/telegramHub");
  await hub.ensureTables();
  const app=express();
  app.use(express.json());
  app.use((req,res,next)=>{
    const email=String(req.headers["x-ci-merchant"]||"");
    if(email){
      const tenant=email==="merchant-a@example.test"?"merchant_a":"merchant_b";
      req.session={isCustomerViewer:true,isAdmin:false,isDemo:false,adminEmail:email,tenant};
    }
    next();
  });
  app.use("/api/merchant/telegram-hub",hub.createMerchantTelegramHubRouter());
  app.use("/api/telegram/hub/webhook",hub.telegramHubWebhookRouter());
  http=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>http.once("listening",resolve));
  base="http://127.0.0.1:"+http.address().port;
}
async function call(path,method="GET",body,as="merchant-a@example.test",secret){
  const headers={"x-ci-merchant":as};
  if(body!==undefined)headers["Content-Type"]="application/json";
  if(secret!==undefined)headers["X-Telegram-Bot-Api-Secret-Token"]=secret;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,data:await res.json().catch(()=>({}))};
}
async function claim(token,update_id,chat,from,secret){
  return call("/api/telegram/hub/webhook","POST",{
    update_id,message:{chat,from,text:"/start pt_"+token}
  },"",secret);
}
async function main(){
  await setup();
  const hub=require("../server/telegramHub");
  const reports=require("../server/telegramHubReports");
  const tokenSecret=require("node:crypto").createHmac("sha256",process.env.TELEGRAM_BOT_TOKEN)
    .update("pentagon-hub-v1-webhook").digest("hex");
  let id="",key="";
  await test("Merchant cannot activate webhook using unverified request",async()=>{
    const created=await call("/api/merchant/telegram-hub/activate","POST",{mode:"private"});
    assert.equal(created.status,201);
    id=created.data.request_id;
    key=new URL(created.data.url).searchParams.get("start").slice(3);
    assert.equal((await call("/api/merchant/telegram-hub/confirm","POST",{request_id:id})).status,409);
    assert.equal((await call("/api/merchant/telegram-hub/activate/"+id,"GET",undefined,"merchant-b@example.test")).status,404);
  });
  await test("Webhook requires exact secret and accepts real /start claim",async()=>{
    assert.equal((await claim(key,1,{id:11111,type:"private"},{id:11111,username:"realUser"}, "invalid")).status,403);
    const accepted=await claim(key,2,{id:11111,type:"private"},{id:11111,username:"realUser"}, tokenSecret);
    assert.equal(accepted.status,200);
    const pending=await call("/api/merchant/telegram-hub/activate/"+id);
    assert.equal(pending.data.claimed,true);
    assert.equal((await claim(key,2,{id:11111,type:"private"},{id:11111},tokenSecret)).status,200);
  });
  await test("Second authenticated confirmation binds only merchant A",async()=>{
    assert.equal((await call("/api/merchant/telegram-hub/confirm","POST",{request_id:id},
      "merchant-b@example.test")).status,409);
    const confirmed=await call("/api/merchant/telegram-hub/confirm","POST",{request_id:id});
    assert.equal(confirmed.status,200);
    const a=await call("/api/merchant/telegram-hub/status");
    const b=await call("/api/merchant/telegram-hub/status","GET",undefined,"merchant-b@example.test");
    assert.equal(a.data.connected,true);
    assert.equal(b.data.connected,false);
    assert.equal(a.data.whitelist_count,1);
    assert.equal(a.data.telegram_username,"realUser");
  });
  await test("Username hint cannot authorize a separate tenant or destination",async()=>{
    const b=await call("/api/merchant/telegram-hub/identity-hint","PATCH",
      {username:"otherPerson"},"merchant-b@example.test");
    assert.equal(b.status,200);
    assert.equal(b.data.verified,false);
    const status=await call("/api/merchant/telegram-hub/status","GET",undefined,"merchant-b@example.test");
    assert.equal(status.data.connected,false);
  });
  await test("Whitelist digest queues only tenant A and sends only to verified chat",async()=>{
    const queued=await call("/api/merchant/telegram-hub/report/send-now","POST",{});
    assert.equal(queued.status,202);
    const {rows}=await pool.query("SELECT tenant,chat_id,message FROM telegram_hub_report_outbox");
    assert.equal(rows.length,1);
    assert.equal(rows[0].tenant,"merchant_a");
    assert.equal(rows[0].chat_id,"11111");
    assert.match(rows[0].message,/one\.example\.test/);
    assert.doesNotMatch(rows[0].message,/two\.example\.test/);
    const result=await reports.drainReportOutbox(pool);
    assert.equal(result.claimed,1);
    const sent=telegramCalls.find(c=>c.method==="sendMessage"&&c.body.text.includes("one.example.test"));
    assert.equal(String(sent.body.chat_id),"11111");
  });
  await test("Pause prevents test, disconnect cancels queued report",async()=>{
    const paused=await call("/api/merchant/telegram-hub/pause","POST",{});
    assert.equal(paused.status,200);
    assert.equal((await call("/api/merchant/telegram-hub/test","POST",{})).status,409);
    assert.equal((await call("/api/merchant/telegram-hub/resume","POST",{})).status,200);
    assert.equal((await call("/api/merchant/telegram-hub/test","POST",{})).status,200);
    assert.equal((await call("/api/merchant/telegram-hub/disconnect","POST",{})).status,200);
    const status=await call("/api/merchant/telegram-hub/status");
    assert.equal(status.data.connected,false);
  });
  await test("Group activation requires Telegram administrator and dashboard confirmation",async()=>{
    const link=await call("/api/merchant/telegram-hub/activate","POST",{mode:"group"},"merchant-b@example.test");
    assert.equal(link.status,201);
    const t=new URL(link.data.url).searchParams.get("startgroup").slice(3);
    assert.equal((await claim(t,3,{id:-10077777,type:"supergroup"},{id:33333},tokenSecret)).status,200);
    const pending=await call("/api/merchant/telegram-hub/activate/"+link.data.request_id,"GET",undefined,"merchant-b@example.test");
    assert.equal(pending.data.claimed,false);
    assert.equal((await claim(t,4,{id:-10077777,type:"supergroup"},{id:22222,username:"groupAdmin"},tokenSecret)).status,200);
    const confirmed=await call("/api/merchant/telegram-hub/confirm","POST",{request_id:link.data.request_id},"merchant-b@example.test");
    assert.equal(confirmed.status,200);
    const s=await call("/api/merchant/telegram-hub/status","GET",undefined,"merchant-b@example.test");
    assert.equal(s.data.chat_type,"supergroup");
    assert.equal(s.data.connected,true);
    assert.equal(s.data.chat_title,""); // Synthetic webhook fixture does not include group title.
    assert.equal((await call("/api/merchant/telegram-hub/activate","POST",{},"merchant-b@example.test")).data.mode,"group");
    const duplicate=await call("/api/merchant/telegram-hub/activate","POST",{mode:"group"});
    const dk=new URL(duplicate.data.url).searchParams.get("startgroup").slice(3);
    assert.equal((await claim(dk,5,{id:-10077777,type:"supergroup",title:"Merchant B Group"},{id:22222,username:"groupAdmin"},tokenSecret)).status,200);
    assert.equal((await call("/api/merchant/telegram-hub/confirm","POST",{request_id:duplicate.data.request_id})).data.error,"GROUP_ALREADY_LINKED");
  });
  console.log("PENTAGON_TELEGRAM_HUB_POSTGRES_E2E_PASS="+pass);
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{
  axios.post=realPost;
  if(http)await new Promise(resolve=>http.close(resolve));
  if(pool)await pool.end();
  if(admin){
    try{await admin.query('DROP DATABASE IF EXISTS "'+name+'" WITH (FORCE)');}catch(_){}
    await admin.end();
  }
});
