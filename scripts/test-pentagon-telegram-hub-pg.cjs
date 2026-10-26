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
  {email:"merchant-b@example.test",tenant:"merchant_b",role:"merchant_admin"},
  {email:"merchant-c@example.test",tenant:"merchant_c",role:"merchant_admin"}
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
  ["-100700003",{title:"PENTAGON | MERCHANT_C | REPORTS",type:"supergroup"}],
  ["-100700004",{title:"PENTAGON | MERCHANT_D | REPORTS",type:"supergroup"}],
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
  await pool.query("CREATE TABLE domains(id SERIAL PRIMARY KEY,domain TEXT UNIQUE NOT NULL,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE,global_status TEXT DEFAULT 'unknown',last_checked_at TIMESTAMP,project_name TEXT DEFAULT '',label TEXT DEFAULT '')");
  await pool.query("CREATE TABLE alerts(id SERIAL PRIMARY KEY,domain_id INT,old_status TEXT,new_status TEXT,message TEXT,sent_to_telegram BOOLEAN DEFAULT FALSE)");
  await pool.query("CREATE TABLE rank_keyword_groups(id SERIAL PRIMARY KEY,tenant TEXT NOT NULL,is_active BOOLEAN DEFAULT TRUE,keyword TEXT NOT NULL DEFAULT '',project_name TEXT DEFAULT '',last_checked_at TIMESTAMP)");
  await pool.query("CREATE TABLE rank_keyword_domains(id SERIAL PRIMARY KEY,group_id INT NOT NULL,domain TEXT NOT NULL,is_whitelisted BOOLEAN DEFAULT FALSE,last_position INTEGER,last_page INTEGER,last_status TEXT DEFAULT 'pending',last_checked_at TIMESTAMP)");
  await pool.query("CREATE TABLE rank_scan_results(id SERIAL PRIMARY KEY,group_id INT NOT NULL,keyword TEXT,position INTEGER,page INTEGER,host TEXT,classification TEXT,checked_at TIMESTAMP DEFAULT NOW(),node_id INTEGER)");
  await pool.query("CREATE TABLE provider_nodes(id SERIAL PRIMARY KEY,tenant TEXT NOT NULL DEFAULT 'admin',provider_name TEXT,last_health_status TEXT,last_ping_at TIMESTAMP,is_active BOOLEAN DEFAULT TRUE)");
  await pool.query("CREATE TABLE check_results(id SERIAL PRIMARY KEY,domain_id INTEGER,checker_type TEXT,provider_name TEXT,status TEXT,checked_at TIMESTAMP DEFAULT NOW())");
  await pool.query("INSERT INTO domains(domain,tenant,global_status,last_checked_at,project_name,label) VALUES "+
    "('merchant-a.example.test','merchant_a','working',NOW(),'Merchant A','landing_page'),"+
    "('merchant-b.example.test','merchant_b','warning',NOW(),'Merchant B','ms')");
  await pool.query("INSERT INTO rank_keyword_groups(tenant,keyword,project_name) VALUES "+
    "('merchant_a','Merchant A Official','Merchant A'),('merchant_b','Merchant B Secret','Merchant B')");
  await pool.query("INSERT INTO rank_keyword_domains(group_id,domain,is_whitelisted,last_position,last_page,last_status,last_checked_at) VALUES "+
    "(1,'merchant-a.example.test',TRUE,3,1,'found',NOW()),"+
    "(2,'merchant-b.example.test',TRUE,8,1,'found',NOW())");
  await pool.query("INSERT INTO provider_nodes(tenant,provider_name,last_health_status,last_ping_at) VALUES "+
    "('admin','Telkomsel','online',NOW()),('admin','XL','online',NOW()),"+
    "('admin','Indosat','online',NOW())");
  await pool.query("INSERT INTO check_results(domain_id,checker_type,provider_name,status) VALUES "+
    "(1,'node','Telkomsel','working'),(2,'node','XL','warning')");
  await pool.query("INSERT INTO rank_scan_results(group_id,keyword,position,page,host,classification,checked_at,node_id) VALUES "+
    "(1,'Merchant A Official',5,1,'merchant-a.example.test','whitelisted',NOW()-INTERVAL '1 day',NULL),"+
    "(1,'Merchant A Official',3,1,'merchant-a.example.test','whitelisted',NOW()-INTERVAL '2 minutes',NULL),"+
    "(1,'Merchant A Official',4,1,'merchant-a.example.test','whitelisted',NOW()-INTERVAL '2 minutes',1),"+
    "(1,'Merchant A Official',3,1,'merchant-a.example.test','whitelisted',NOW()-INTERVAL '2 minutes',2),"+
    "(2,'Merchant B Secret',8,1,'merchant-b.example.test','whitelisted',NOW()-INTERVAL '2 minutes',NULL)");
  const hub=require("../server/telegramHub");
  const permanent=require("../server/telegramPermanentGroups");
  const reports=require("../server/telegramHubReports");
  const {deliverTelegram,ensureOutboxTables}=require("../server/trustpositifAlertOutbox");
  await hub.ensureTables();
  await ensureOutboxTables();
  await permanent.ensurePermanentGroupTables();
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{
    const persona=req.headers["x-ci-persona"];
    if(persona==="admin")req.session={isAdmin:true,isDemo:false,
      isCustomerViewer:false,tenant:"admin",adminEmail:"superadmin@example.test"};
    else if(["merchant_a","merchant_b","merchant_c"].includes(persona))
      req.session={isAdmin:false,isDemo:false,isCustomerViewer:true,tenant:persona,
        adminEmail:persona==="merchant_a"?"merchant-a@example.test":persona==="merchant_b"?"merchant-b@example.test":"merchant-c@example.test"};
    next();
  });
  app.use(adminRoute,permanent.createPermanentGroupAdminRouter());
  app.use("/api/merchant/telegram-groups",permanent.createPermanentGroupMerchantRouter(pool,{
    tg:hub.tg,opsChatId:process.env.TELEGRAM_CHAT_ID
  }));
  const activation=require("../server/telegramMerchantActivation");
  const autoGroups=require("../server/telegramMerchantAutoProvisioner");
  app.use("/api/merchant/telegram-onboarding",activation.createActivationRouter(pool,{
    botName:hub.botName,tg:hub.tg
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
    assert.equal(other.data.preferences.rank_report,true,"Google Rank enabled by default for new merchant");
  });
  await test("Only authenticated Super Admin can generate group setup token",async()=>{
    assert.equal((await call(adminRoute+"/setup","POST",{tenant:"merchant_a"})).status,403);
    assert.equal((await call(adminRoute+"/setup","POST",{tenant:"merchant_a"},"merchant_b")).status,403);
    assert.equal((await call(adminRoute+"/setup","POST",{tenant:"demo"},"admin")).status,400);
  });
  let codeA="",codeB="";
  await test("Merchant Telegram setup is available only for the authenticated tenant",async()=>{
    const own="/api/merchant/telegram-groups/setup";
    assert.equal((await call(own,"POST",{},"anon")).status,403);
    assert.equal((await call(own,"POST",{},"admin")).status,403);
    assert.equal((await call(own,"POST",{tenant:"merchant_b"},"merchant_a")).data.error,
      "CROSS_TENANT_SETUP_DENIED");
    const setup=await call(own,"POST",{},"merchant_a");
    assert.equal(setup.status,201);
    assert.equal(setup.data.tenant,"merchant_a");
    assert.equal(setup.data.title,permanent.expectedTitle("merchant_a"));
    assert.equal(setup.data.expires_in_seconds,600);
    codeA=setup.data.command;
    assert.ok(/^\/bindreport merchant_a [A-Za-z0-9_-]+$/.test(codeA));
    const rows=(await pool.query(
      "SELECT tenant,requester_email FROM telegram_merchant_group_setup WHERE tenant='merchant_a'")).rows;
    assert.equal(rows.length,1);
    assert.equal(rows[0].requester_email,"merchant-a@example.test");
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int n FROM telegram_merchant_groups")).rows[0].n,0);
  });
  await test("One-time merchant token binds only the verified private group",async()=>{
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
    assert.equal((await call("/api/merchant/telegram-groups/setup","POST",{},"merchant_a")).status,409);
    assert.equal((await call("/api/merchant/telegram-groups/setup","POST",
      {tenant:"merchant_a"},"merchant_b")).status,403);
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
  await test("Rank auto-scanner checks only verified merchant group using bounded VPS pages",async()=>{
    const {runMerchantRankScans}=require("../server/telegramMerchantRankScanner");
    const scanned=[];
    const result=await runMerchantRankScans(pool,{checkGroup:async(group,nodeId,nodeName,opts)=>{
      scanned.push({tenant:group.tenant,group:group.id,nodeId,pages:opts.maxPages});
      await pool.query("UPDATE rank_keyword_groups SET last_checked_at=NOW() WHERE id=$1",[group.id]);
    }});
    assert.equal(result.status,"complete");
    assert.equal(result.scanned,1);
    assert.deepEqual(scanned.map(x=>x.tenant),["merchant_a"]);
    assert.equal(scanned[0].nodeId,null);
    assert.equal(scanned[0].pages,2);
    assert.equal((await pool.query("SELECT last_checked_at FROM rank_keyword_groups WHERE id=2")).rows[0].last_checked_at,null);
    const again=await runMerchantRankScans(pool,{checkGroup:async()=>{throw Error("must not rescan");}});
    assert.equal(again.scanned,0);
  });
  await test("Independent merchant TrustPositif and Google Rank reports stay isolated",async()=>{
    const queued=await call(route+"/report/send-now","POST",{});
    assert.equal(queued.status,202);
    assert.equal(queued.data.queued,2);
    const {rows}=await pool.query(
      "SELECT tenant,chat_id,kind,message FROM telegram_hub_report_outbox ORDER BY id");
    assert.equal(rows.length,2);
    assert.deepEqual(rows.map(r=>r.kind),["trustpositif_summary","google_rank"]);
    assert.ok(rows.every(r=>r.tenant==="merchant_a"&&r.chat_id==="-100700001"));
    assert.ok(rows.every(r=>!r.message.includes("merchant-b.example.test")));
    assert.ok(rows.every(r=>!r.message.includes("Merchant B Secret")));
    assert.match(rows[0].message,/TRUST POSITIF REPORT/);
    assert.match(rows[0].message,/merchant-a\.example\.test/);
    assert.match(rows[0].message,/CHECKER COVERAGE/);
    assert.match(rows[1].message,/GOOGLE RANK REPORT/);
    assert.match(rows[1].message,/Merchant A Official/);
    assert.match(rows[1].message,/#3/);
    assert.match(rows[1].message,/↑2/);
    assert.match(rows[1].message,/TSEL: #4/);
    assert.ok(rows.every(r=>r.message.length<4096));
    const again=await call(route+"/report/send-now","POST",{});
    assert.equal(again.status,409,"manual duplicate within one minute rejected");
    const result=await reports.drainReportOutbox(pool,4);
    assert.equal(result.claimed,2);
    const sent=calls.filter(c=>c.method==="sendMessage" &&
      /(?:GOOGLE RANK REPORT|TRUST POSITIF REPORT)/.test(c.body.text||""));
    assert.equal(sent.length,2);
    assert.ok(sent.every(c=>String(c.body.chat_id)==="-100700001"));
    assert.ok(sent.every(c=>c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url==="https://pentagon.quest"));
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
  await test("Rank auto-scanner now selects other merchant only after permanent binding",async()=>{
    const {runMerchantRankScans}=require("../server/telegramMerchantRankScanner");
    const seen=[];
    const result=await runMerchantRankScans(pool,{checkGroup:async(group)=>{
      seen.push(group.tenant);
      await pool.query("UPDATE rank_keyword_groups SET last_checked_at=NOW() WHERE id=$1",[group.id]);
    }});
    assert.equal(result.scanned,1);
    assert.deepEqual(seen,["merchant_b"]);
  });
  await test("Rank-only delivery respects toggles and isolated merchant destination",async()=>{
    assert.equal((await call(route+"/preferences","PATCH",
      {digest_enabled:false,rank_report:true},"merchant_b")).status,200);
    const queued=await call(route+"/report/send-now","POST",{},"merchant_b");
    assert.equal(queued.status,202);
    assert.equal(queued.data.queued,1);
    const data=(await pool.query("SELECT tenant,chat_id,kind,message FROM telegram_hub_report_outbox "+
      "WHERE tenant='merchant_b'")).rows;
    assert.equal(data.length,1);
    assert.equal(data[0].kind,"google_rank");
    assert.equal(data[0].chat_id,"-100700002");
    assert.match(data[0].message,/Merchant B Secret/);
    assert.doesNotMatch(data[0].message,/Merchant A Official/);
    assert.doesNotMatch(data[0].message,/merchant-a\.example\.test/);
    assert.equal((await reports.drainReportOutbox(pool,4)).claimed,1);
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
  await test("Signup lifecycle queues one unverified tenant report group without sending a message",async()=>{
    const inserted=await activation.prepareMerchantTenant("merchant_c","merchant-c@example.test",pool);
    assert.equal(inserted,true);
    assert.equal(await activation.prepareMerchantTenant("merchant_c","merchant-c@example.test",pool),true);
    const {rows}=await pool.query(
      "SELECT tenant,telegram_user_id,group_state FROM telegram_merchant_activations WHERE tenant='merchant_c'");
    assert.equal(rows.length,1);
    assert.equal(rows[0].group_state,"queued");
    assert.equal(rows[0].telegram_user_id,null);
    const initial=await call("/api/merchant/telegram-onboarding/status","GET",undefined,"merchant_c");
    assert.equal(initial.status,200);
    assert.equal(initial.data.identity_verified,false);
    assert.equal(initial.data.group_ready,false);
    assert.equal(initial.data.provisioner_configured,false);
    assert.equal((await autoGroups.runProvisioning(pool,{tg:hub.tg})).status,"service_account_not_configured");
    assert.equal((await call("/api/merchant/telegram-onboarding/activate","POST",{},"admin")).status,403);
  });
  await test("MTProto adapter automatically creates a dedicated private group exactly once",async()=>{
    const created=[];
    const adapter=async(action,data)=>{
      created.push({action,tenant:data.tenant,title:data.title,chat_id:data.chat_id});
      if(action==="create")return{chat_id:"-100700003"};
      if(action==="secure")return{ok:true,chat_id:data.chat_id};
      throw Error("Unexpected bridge call");
    };
    const result=await autoGroups.runProvisioning(pool,{
      adapter,tg:hub.tg,opsChatId:process.env.TELEGRAM_CHAT_ID
    });
    assert.equal(result.status,"created");
    assert.equal(result.tenant,"merchant_c");
    assert.deepEqual(created.map(x=>x.action),["create","secure"]);
    assert.ok(created.every(x=>x.tenant==="merchant_c"));
    const group=(await pool.query(
      "SELECT tenant,chat_id FROM telegram_merchant_groups WHERE tenant='merchant_c'")).rows[0];
    assert.equal(group.chat_id,"-100700003");
    const connection=(await pool.query(
      "SELECT status,enabled,chat_id FROM telegram_hub_connections WHERE tenant='merchant_c'")).rows[0];
    assert.equal(connection.chat_id,"-100700003");
    assert.equal(connection.enabled,false,"no merchant identity yet");
    assert.equal(connection.status,"disconnected");
    assert.equal((await autoGroups.runProvisioning(pool,{adapter,tg:hub.tg})).status,"idle");
  });
  await test("Telegram ID or QR is a hint, never proof of merchant account ownership",async()=>{
    const path="/api/merchant/telegram-onboarding";
    assert.equal((await call(path+"/identity-hint","POST",
      {identity:"@merchantC"},"merchant_c")).status,200);
    assert.equal((await call(path+"/identity-hint","POST",
      {identity:"https://t.me/+OtherGroup"},"merchant_c")).status,400);
    const qr=await call(path+"/activate","POST",{},"merchant_c");
    assert.equal(qr.status,201);
    assert.match(qr.data.url,/^https:\/\/t\.me\/PentagonReportTestBot\?start=pma_[A-Za-z0-9_-]{32}$/);
    assert.ok(!qr.data.url.includes("startgroup"));
    const deepLink=qr.data.url.split("start=")[1];
    const wrong=await call("/api/telegram/hub/webhook","POST",{
      update_id:10,message:{chat:{id:55555,type:"private"},
      from:{id:55555,username:"another_user"},text:"/start "+deepLink}
    },"anon");
    assert.equal(wrong.status,200);
    const statusAfterWrong=await call(path+"/status","GET",undefined,"merchant_c");
    assert.equal(statusAfterWrong.data.identity_verified,false);
    const good=await call("/api/telegram/hub/webhook","POST",{
      update_id:11,message:{chat:{id:55555,type:"private"},
      from:{id:55555,username:"merchantC"},text:"/start "+deepLink}
    },"anon");
    assert.equal(good.status,200);
    const final=await call(path+"/status","GET",undefined,"merchant_c");
    assert.equal(final.data.identity_verified,true);
    assert.equal(final.data.group_ready,true);
    const connection=(await pool.query(
      "SELECT enabled,status,chat_id FROM telegram_hub_connections WHERE tenant='merchant_c'")).rows[0];
    assert.equal(connection.enabled,true);
    assert.equal(connection.status,"connected");
    assert.equal(connection.chat_id,"-100700003");
    const invitation=calls.find(c=>c.method==="sendMessage" &&
      String(c.body.chat_id)==="55555" && String(c.body.text).includes("https://t.me/+FixtureInvite"));
    assert.ok(invitation,"verified merchant receives the private group invite");
    const history=await call(path+"/deliveries","GET",undefined,"merchant_c");
    assert.equal(history.status,200);
    assert.equal(history.data.tenant,"merchant_c");
    assert.ok(!history.data.deliveries.some(d=>String(d).includes("merchant_a")));
    assert.equal((await call(path+"/identity-hint","POST",
      {identity:"@other_user"},"merchant_c")).status,409);
  });
  await test("Partial MTProto failure retries securing the same group, never creating another",async()=>{
    await activation.prepareMerchantTenant("merchant_d","merchant-d@example.test",pool);
    const operations=[];let failOnce=true;
    const adapter=async(action,payload)=>{
      operations.push(action+":"+payload.tenant);
      if(action==="create")return {chat_id:"-100700004"};
      if(action==="secure"){
        if(failOnce){failOnce=false;throw Object.assign(new Error("Temporary error"),{code:"TEMPORARY_FAILURE"});}
        return {ok:true};
      }
      throw Error("unexpected operation");
    };
    const first=await autoGroups.runProvisioning(pool,{
      adapter,tg:hub.tg,opsChatId:process.env.TELEGRAM_CHAT_ID
    });
    assert.equal(first.status,"retry");
    const saved=(await pool.query(
      "SELECT created_group_chat_id,group_state FROM telegram_merchant_activations WHERE tenant='merchant_d'")).rows[0];
    assert.equal(saved.created_group_chat_id,"-100700004");
    assert.equal(saved.group_state,"retry");
    await pool.query("UPDATE telegram_merchant_activations SET next_provision_at=NOW() WHERE tenant='merchant_d'");
    const second=await autoGroups.runProvisioning(pool,{
      adapter,tg:hub.tg,opsChatId:process.env.TELEGRAM_CHAT_ID
    });
    assert.equal(second.status,"created");
    assert.equal(operations.filter(x=>x==="create:merchant_d").length,1);
    assert.equal(operations.filter(x=>x==="secure:merchant_d").length,2);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int n FROM telegram_merchant_groups WHERE tenant='merchant_d'")).rows[0].n,1);
    const connection=(await pool.query(
      "SELECT enabled,status FROM telegram_hub_connections WHERE tenant='merchant_d'")).rows[0];
    assert.equal(connection.enabled,false);
    assert.equal(connection.status,"disconnected");
  });
  console.log("PENTAGON_PERMANENT_TELEGRAM_E2E_PASS="+passed);
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{
  axios.post=realPost;
  if(server)await new Promise(r=>server.close(r));
  if(pool)await pool.end();
  if(admin){
    // CI runs an ephemeral PostgreSQL service. Never FORCE drop a test database
    // while a connection may still be closing: pg-pool emits an unhandled
    // 57P01 event when the forced termination hits an idle client.
    await admin.end();
  }
});
