#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {deliverTelegram}=require("../server/trustpositifAlertOutbox");
const BOT={token:"synthetic-not-real",chatId:"-100111111111"};
const sent=[];
const transport={post:async(url,body)=>{
  assert.ok(url.includes("/botsynthetic-not-real/sendMessage"));
  sent.push({...body});
  return {status:200,data:{ok:true,result:{message_id:sent.length}}};
}};
const db={async query(sql,args){
  assert.match(sql,/SELECT d\.tenant,s\.value/);
  assert.match(sql,/WHERE d\.id=\$1/);
  const id=args[0];
  const map={
    1:{tenant:"merchantA",value:JSON.stringify({enabled:true,chat_id:"-100222222222"})},
    2:{tenant:"merchantB",value:JSON.stringify({enabled:true,chat_id:"-100333333333"})},
    3:{tenant:"merchantC",value:JSON.stringify({enabled:false,chat_id:"-100444444444"})},
    4:{tenant:"merchantD",value:null},
    5:{tenant:"merchantE",value:"invalid_json"},
    6:{tenant:"merchantF",value:JSON.stringify({enabled:true,chat_id:"127.0.0.1"})}
  };
  return {rows:map[id]?[map[id]]:[]};
}};
let passed=0;
async function test(name,fn){await fn();passed++;console.log("PASS "+name);}
(async()=>{
  await test("Two merchants route alerts to their own Telegram chats",async()=>{
    assert.equal((await deliverTelegram("<b>Domain A</b>",{domain_id:1},{db,transport,botConfig:BOT})).outcome,"sent");
    assert.equal((await deliverTelegram("<b>Domain B</b>",{domain_id:2},{db,transport,botConfig:BOT})).outcome,"sent");
    assert.deepEqual(sent.map(x=>x.chat_id),["-100222222222","-100333333333"]);
  });
  await test("Explicit merchant opt-out cancels future alert without global fallback",async()=>{
    const count=sent.length;
    const r=await deliverTelegram("Sensitive", {domain_id:3},{db,transport,botConfig:BOT});
    assert.equal(r.outcome,"cancelled");assert.equal(sent.length,count);
  });
  await test("No merchant override preserves prior global fallback",async()=>{
    assert.equal((await deliverTelegram("Legacy",{domain_id:4},{db,transport,botConfig:BOT})).outcome,"sent");
    assert.equal(sent[sent.length-1].chat_id,BOT.chatId);
  });
  await test("Malformed config, invalid chat and deleted domain never send",async()=>{
    const count=sent.length;
    assert.equal((await deliverTelegram("Bad",{domain_id:5},{db,transport,botConfig:BOT})).outcome,"failed");
    assert.equal((await deliverTelegram("Bad",{domain_id:6},{db,transport,botConfig:BOT})).outcome,"failed");
    assert.equal((await deliverTelegram("Gone",{domain_id:999},{db,transport,botConfig:BOT})).outcome,"cancelled");
    assert.equal(sent.length,count);
  });
  await test("Database query error retries without leaking to global chat",async()=>{
    const broken={query:async()=>{throw new Error("DB unavailable");}};
    const count=sent.length;
    assert.equal((await deliverTelegram("Do not reroute",{domain_id:1},{db:broken,transport,botConfig:BOT})).outcome,"retry");
    assert.equal(sent.length,count);
  });
  console.log("PENTAGON_MERCHANT_TELEGRAM_ROUTING_PASS="+passed);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
