#!/usr/bin/env node
"use strict";
// End-to-end Express + local PostgreSQL + mocked Telegram Bot API.
// NEVER runs against production or sends real Telegram messages.
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {Client}=require("pg");
const express=require("express");
const axios=require("axios");

process.env.TELEGRAM_HUB_ENABLED="true";
process.env.TELEGRAM_BOT_TOKEN="synthetic-telegram-token-for-local-ci";
process.env.TELEGRAM_CHAT_ID="-100999999";
process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([
  {email:"merchant-a@example.test",tenant:"merchant_a",role:"merchant_admin"},
  {email:"merchant-b@example.test",tenant:"merchant_b",role:"merchant_admin"}
]);
const original=process.env.DATABASE_URL||"";
if(process.env.CI!=="true"||
   !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(original))
  throw Error("LOCAL_CI_POSTGRES_REQUIRED");
const parsed=new URL(original.replace("127.0.0.1","localhost"));
const fixture="pentagon_tgperm_"+process.pid;
let admin=null,pool=null,server=null,base="";
const groupMap=new Map([
  ["-100700001",{title:"PENTAGON | MERCHANT_A | REPORTS",type:"supergroup"}],
  ["-100700002",{title:"PENTAGON | MERCHANT_B | REPORTS",type:"supergroup"}],
  ["-100999999",{title:"Domain Radar Staff Operations",type:"supergroup",is_forum:true}]
]);
const calls=[];
const realPost=axios.post;
axios.post=async(url,body)=>{
  const method=String(url).split("/").pop();
  calls.push({method,body});
  if(method==="getMe")return{status:200,data:{ok:true,result:{id:9001,is_bot:true,username:"PentagonReportTestBot"}}};
  if(method==="getChat")return{status:200,data:{ok:true,result:{id:body.chat_id,
    ...groupMap.get(String(body.chat_id))}}};
  if(method==="getChatMember"){
    const isBot=String(body.user_id)==="9001";
    const isOperator=String(body.user_id)==="22222";
    return{status:200,data:{ok:true,result:isBot?
      {status:"administrator",can_invite_users:true}:
      {status:isOperator?"administrator":"member"}}};
  }
  if(method==="createChatInviteLink")
    return{status:200,data:{ok:true,result:{invite_link:"https://t.me/+FixtureInvite"+calls.length}}};
  if(method==="sendMessage")
    return{status:200,data:{ok:true,result:{message_id:calls.length}}};
  if(method==="setWebhook")return{status:200,data:{ok:true,result:true}};
  throw Error("Unexpected Telegram method: "+method);
};
const secret=crypto.createHmac("sha256",process.env.TELEGRAM_BOT_TOKEN)
  .update("pentagon-hub-v1-webhook").digest("hex");
let passed=0;
async function test(label,fn){await fn();passed++;console.log("PASS "+label);}
async function call(path,method="GET",body,persona="merchant_a"){
  const headers={"x-ci-persona":persona};
  if(body!==undefined)headers["content-type"]="application/json";
  if(path==="/api/telegram/hub/webhook")headers["X-Telegram-Bot-Api-Secret-Token"]=secret;
  const response=await fetch(base+path,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body)});
  return{status:response.status,data:await response.json().catch(()=>({}))};
}
const route="/api/merchant/telegram-hub";
const invite="/api/merchant/telegram-groups/invite";
const adminRoute="/api/admin/telegram-groups";
async function sendBind(command,id,updateId=1,fromId=22222){
  return call("/api/telegram/hub/webhook","POST",{update_id:updateId,message:{
    chat:{id:Number(id),type:"supergroup",title:groupMap.get(id)?.title},
    from:{id:fromId,is_bot:false,username:"operator"},
    text:command
  }},"anon");
}
async function main(){
  parsed.pathname="/"+fixture;
  admin=new Client({connectionString:original.replace("127.0.0.1","localhost"),ssl:false});
  await admin.connect();
  await admin.query('CREATE DATABASE "'+fixture+'"');
  process.env.DATABASE_URL=parsed.toString();
  const {pool:db}=require("../server/db");pool=db;
  await pool.query("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TIMESTAMP DEFAULT NOW())");
  await pool.query("CREATE TABLE domains(id SERIAL PRIMARY KEY,domain TEXT UNIQUE NOT NULL,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE,global_status TEXT DEFAULT 'unknown',last_checked_at TIMESTAMP)");
  await pool.query("CREATE TABLE rank_keyword_groups(id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE)");
  await pool.query("CREATE TABLE rank_keyword_domains(id SERIAL PRIMARY KEY,group_id INT NOT NULL,domain TEXT NOT NULL,is_whitelisted BOOLEAN DEFAULT FALSE)");
  await pool.query("INSERT INTO domains(domain,tenant,global_status,last_checked_at) VALUES "+
    "('merchant-a.example.test','merchant_a','working',NOW()),"+
    "('merchant-b.example.test','merchant_b','warning',NOW())");
  await pool.query("INSERT INTO rank_keyword_groups(tenant) VALUES('merchant_a'),('merchant_b')");
  await pool.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted) VALUES "+
    "(1,'merchant-a.example.test',TRUE),(2,'merchant-b.example.test',TRUE)");
  const hub=require("../server/telegramHub");
  const permanent=require("../server/telegramPermanentGroups");
  const reports=require("../server/telegramHubReports");
  const {deliverTelegram}=require("../server/trustpositifAlertOutbox");
  await hub.ensureTables();
  await permanent.ensurePermanentGroupTables();
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{
    const persona=req.headers["x-ci-persona"];
    if(persona==="admin")req.session={isAdmin:true,isDemo:false,
      isCustomerViewer:false,tenant:"admin",adminEmail:"superadmin@example.test"};
    else if(["merchant_a","merchant_b"].includes(persona))
      req.session={isAdmin:false,isDemo:false,isCustomerViewer:true,tenant:persona,
        adminEmail:persona==="merchant_a"?"merchant-a@example.test":"merchant-b@example.test"};
    next();
  });
  app.use(adminRoute,permanent.createPermanentGroupAdminRouter());
  app.use("/api/merchant/telegram-groups",permanent.createPermanentGroupMerchantRouter(pool,{
    tg:hub.tg,opsChatId:process.env.TELEGRAM_CHAT_ID
  }));
  app.use(route,hub.createMerchantTelegramHubRouter());
  app.use("/api/telegram/hub/webhook",hub.telegramHubWebhookRouter());
  server=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  base="http://127.0.0.1:"+server.address().port;

  await test("Unprovisioned merchant cannot receive a wrong-group QR or report",async()=>{
    assert.equal((await call(invite,"POST",{})).status,409);
    assert.equal((await call(route+"/activate","POST",{mode:"group"})).status,410);
    assert.equal((await call(route+"/confirm","POST",{request_id:crypto.randomUUID()})).status,410);
    assert.equal((await call(route+"/report/send-now","POST",{})).status,409);
    const d=await pool.query("SELECT id FROM domains WHERE tenant='merchant_a'");
    const r=await deliverTelegram("Sensitive merchant alert",{domain_id:d.rows[0].id,event_type:"BLOCKED"},
      {botConfig:{token:process.env.TELEGRAM_BOT_TOKEN,chatId:process.env.TELEGRAM_CHAT_ID}});
    assert.equal(r.outcome,"cancelled");
    assert.equal(r.code,"MERCHANT_PERMANENT_GROUP_NOT_READY");
  });
  await test("Merchant can save report settings before permanent group activation",async()=>{
    const before=await call(route+"/status");
    assert.equal(before.status,200);
    assert.equal(before.data.permanent_group_ready,false);
    assert.equal(before.data.connected,false);
    assert.equal(before.data.preferences_saved,false);
    const payload={digest_enabled:true,immediate_alert:false,
      recovery_alert:false,node_warning:false,rank_report:true,interval_minutes:30};
    const saved=await call(route+"/preferences","PATCH",payload);
    assert.equal(saved.status,200);
    assert.equal(saved.data.saved,true);
    assert.equal(saved.data.delivery_active,false);
    const after=await call(route+"/status");
    assert.equal(after.data.connected,false);
    assert.equal(after.data.preferences_saved,true);
    for(const [key,value] of Object.entries(payload))
      assert.equal(after.data.preferences[key],value,"saved preference "+key);
    const row=(await pool.query(
      "SELECT tenant,chat_id,enabled,status,interval_minutes FROM telegram_hub_connections WHERE tenant='merchant_a'")).rows[0];
    assert.equal(row.tenant,"merchant_a");
    assert.equal(row.chat_id,null);
    assert.equal(row.enabled,false);
    assert.equal(row.status,"disconnected");
    assert.equal(row.interval_minutes,30);
    assert.equal((await call(route+"/test","POST",{})).status,409);
    assert.equal((await call(route+"/preferences","PATCH",{rank_report:"yes"})).status,400);
    assert.equal((await call(route+"/preferences","PATCH",{interval_minutes:11})).status,400);
    assert.equal((await call(route+"/preferences","PATCH",{})).status,400);
    const other=await call(route+"/status","GET",undefined,"merchant_b");
    assert.equal(other.data.preferences_saved,false);
    assert.equal(other.data.preferences.interval_minutes,60);
    assert.equal(other.data.preferences.immediate_alert,true);
  });
  await test("Only authenticated Super Admin can generate group setup token",async()=>{
    assert.equal((await call(adminRoute+"/setup","POST",{tenant:"merchant_a"})).status,403);
    assert.equal((await call(adminRoute+"/setup","POST",{tenant:"merchant_a"},"merchant_b")).status,403);
    assert.equal((await call(adminRoute+"/setup","POST",{tenant:"demo"},"admin")).status,400);
  });
  let codeA="",codeB="";
  await test("One-time admin token binds only a verified private group",async()=>{
    const setup=await call(adminRoute+"/setup","POST",{tenant:"merchant_a"},"admin");
    assert.equal(setup.status,201);
    assert.equal(setup.data.title,permanent.expectedTitle("merchant_a"));
    codeA=setup.data.command;
    assert.ok(/^\/bindreport merchant_a [A-Za-z0-9_-]+$/.test(codeA));
    const wrong=await sendBind(codeA,"-100700002",1);
    assert.equal(wrong.status,200);
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM telegram_merchant_groups")).rows[0].n,0);
    const rejectNonAdmin=await sendBind(codeA,"-100700001",2,33333);
    assert.equal(rejectNonAdmin.status,200);
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM telegram_merchant_groups")).rows[0].n,0);
    const good=await sendBind(codeA,"-100700001",3);
    assert.equal(good.status,200);
    const row=(await pool.query("SELECT tenant,chat_title,chat_id FROM telegram_merchant_groups")).rows[0];
    assert.equal(row.tenant,"merchant_a");assert.equal(row.chat_id,"-100700001");
    assert.equal(row.chat_title,permanent.expectedTitle("merchant_a"));
    const c=(await pool.query(
      "SELECT enabled,status,chat_id,interval_minutes,immediate_alert,recovery_alert,node_warning,rank_report,next_report_at "+
      "FROM telegram_hub_connections WHERE tenant='merchant_a'")).rows[0];
    assert.equal(c.status,"connected");
    assert.equal(c.enabled,true);
    assert.equal(c.chat_id,"-100700001");
    assert.equal(c.interval_minutes,30);
    assert.equal(c.immediate_alert,false);
    assert.equal(c.recovery_alert,false);
    assert.equal(c.node_warning,false);
    assert.equal(c.rank_report,true);
    const minutesUntilReport=(new Date(c.next_report_at).getTime()-Date.now())/60000;
    assert.ok(minutesUntilReport>=28&&minutesUntilReport<=31,
      "pre-binding digest interval preserved: "+minutesUntilReport);

  });
  await test("A merchant QR opens only its pre-bound group, no Telegram group picker",async()=>{
    const status=await call(route+"/status");
    assert.equal(status.status,200);
    assert.equal(status.data.permanent_group_ready,true);
    assert.equal(status.data.permanent_group_title,permanent.expectedTitle("merchant_a"));
    assert.equal(status.data.whitelist_count,1);
    const qr=await call(invite,"POST",{});
    assert.equal(qr.status,201);
    assert.ok(qr.data.url.startsWith("https://t.me/+FixtureInvite"));
    assert.ok(!qr.data.url.includes("startgroup"));
    assert.equal(qr.data.group_title,permanent.expectedTitle("merchant_a"));
    const sent=calls.filter(c=>c.method==="createChatInviteLink");
    assert.equal(String(sent.at(-1).body.chat_id),"-100700001");
    assert.equal(sent.at(-1).body.member_limit,1);
    assert.ok(sent.at(-1).body.expire_date>Math.floor(Date.now()/1000));
    assert.equal((await call(invite,"POST",{},"merchant_b")).status,409);
  });
  await test("Tenant A digest and Telegram test never send to B or shared ops",async()=>{
    const queued=await call(route+"/report/send-now","POST",{});
    assert.equal(queued.status,202);
    const {rows}=await pool.query("SELECT tenant,chat_id,message FROM telegram_hub_report_outbox");
    assert.equal(rows.length,1);assert.equal(rows[0].tenant,"merchant_a");
    assert.equal(rows[0].chat_id,"-100700001");
    assert.match(rows[0].message,/merchant-a\.example\.test/);
    assert.doesNotMatch(rows[0].message,/merchant-b\.example\.test/);
    const result=await reports.drainReportOutbox(pool);
    assert.equal(result.claimed,1);
    const sent=calls.find(c=>c.method==="sendMessage" &&
      c.body.text?.includes("merchant-a.example.test"));
    assert.equal(String(sent?.body?.chat_id),"-100700001");
    const testResult=await call(route+"/test","POST",{});
    assert.equal(testResult.status,200);
    assert.equal(String(calls.at(-1).body.chat_id),"-100700001");
    assert.equal((await call(route+"/disconnect","POST",{})).status,409);
  });
  await test("One group cannot become another merchant's report destination",async()=>{
    const setup=await call(adminRoute+"/setup","POST",{tenant:"merchant_b"},"admin");
    assert.equal(setup.status,201);codeB=setup.data.command;
    assert.equal((await sendBind(codeB,"-100700001",4)).status,200);
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM telegram_merchant_groups")).rows[0].n,1);
    assert.equal((await sendBind(codeB,"-100999999",5)).status,200);
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM telegram_merchant_groups")).rows[0].n,1);
    assert.equal((await sendBind(codeB,"-100700002",6)).status,200);
    const rows=(await pool.query("SELECT tenant,chat_id FROM telegram_merchant_groups ORDER BY tenant")).rows;
    assert.deepEqual(rows.map(x=>x.tenant),["merchant_a","merchant_b"]);
    assert.notEqual(rows[0].chat_id,rows[1].chat_id);
    assert.equal((await call(invite,"POST",{},"merchant_b")).data.group_title,
      permanent.expectedTitle("merchant_b"));
    assert.equal((await call(adminRoute+"/setup","POST",{tenant:"merchant_a"},"admin")).status,409);
  });
  await test("Merchant preferences retain pause and resume without reassigning group",async()=>{
    assert.equal((await call(route+"/pause","POST",{})).status,200);
    assert.equal((await call(route+"/test","POST",{})).status,409);
    assert.equal((await call(route+"/resume","POST",{})).status,200);
    const a=(await pool.query("SELECT chat_id FROM telegram_hub_connections WHERE tenant='merchant_a'")).rows[0];
    assert.equal(a.chat_id,"-100700001");
    assert.equal((await call(route+"/status")).data.permanent_group_ready,true);
    const changed=await call(route+"/preferences","PATCH",
      {immediate_alert:true,interval_minutes:180});
    assert.equal(changed.status,200);
    assert.equal(changed.data.delivery_active,true);
    const current=(await pool.query(
      "SELECT chat_id,interval_minutes,immediate_alert FROM telegram_hub_connections WHERE tenant='merchant_a'")).rows[0];
    assert.equal(current.chat_id,"-100700001");
    assert.equal(current.interval_minutes,180);
    assert.equal(current.immediate_alert,true);

  });
  console.log("PENTAGON_PERMANENT_TELEGRAM_E2E_PASS="+passed);
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{
  axios.post=realPost;
  if(server)await new Promise(r=>server.close(r));
  if(pool)await pool.end();
  if(admin){
    try{await admin.query('DROP DATABASE IF EXISTS "'+fixture+'" WITH (FORCE)');}catch(_){}
    await admin.end();
  }
});
