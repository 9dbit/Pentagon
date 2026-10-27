#!/usr/bin/env node
"use strict";
// Offline-only Telegram branding tests. No live Bot API calls or database.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {ensureTelegramBotBrand,DISPLAY_NAME}=require("../server/telegramHubBrand");
const hubSource=fs.readFileSync(path.join(__dirname,"../server/telegramHub.js"),"utf8");
let passed=0;
async function test(name,fn){await fn();passed++;console.log("PASS "+name);}
function fakeBot(names={"":"Domainradar",id:"Domainradar",en:"Domainradar"}){
  const state=new Map(Object.entries(names));
  const calls=[];
  return {state,calls,call:async(method,data)=>{
    calls.push({method,data});
    if(method==="getMyName")return {name:state.get(data.language_code)||""};
    if(method==="setMyName"){state.set(data.language_code,data.name);return true;}
    throw Error("Unexpected Telegram API method: "+method);
  }};
}
async function main(){
  await test("Existing bot display names switch to Pentagon in fallback, Indonesian and English",async()=>{
    const bot=fakeBot();
    const result=await ensureTelegramBotBrand(bot.call);
    assert.deepEqual(result,{name:"Pentagon",updated:3,verified:3});
    assert.equal(bot.state.get(""),"Pentagon");
    assert.equal(bot.state.get("id"),"Pentagon");
    assert.equal(bot.state.get("en"),"Pentagon");
    assert.equal(bot.calls.filter(x=>x.method==="setMyName").length,3);
    assert.ok(bot.calls.every(x=>!JSON.stringify(x.data).includes("chat_id")));
  });
  await test("Idempotent startups never make redundant rename calls",async()=>{
    const bot=fakeBot({"":"Pentagon",id:"Pentagon",en:"Pentagon"});
    const result=await ensureTelegramBotBrand(bot.call);
    assert.equal(result.updated,0);
    assert.equal(bot.calls.filter(x=>x.method==="setMyName").length,0);
  });
  await test("Only legacy localized name is updated",async()=>{
    const bot=fakeBot({"":"Pentagon",id:"Domainradar",en:"Pentagon"});
    assert.equal((await ensureTelegramBotBrand(bot.call)).updated,1);
    assert.deepEqual(bot.calls.filter(x=>x.method==="setMyName").map(x=>x.data.language_code),["id"]);
  });
  await test("Telegram API rejection or ineffective update must fail verification",async()=>{
    await assert.rejects(
      ensureTelegramBotBrand(async method=>method==="getMyName"?{name:"Domainradar"}:false),
      /TELEGRAM_BOT_NAME_UPDATE_REJECTED/
    );
    await assert.rejects(
      ensureTelegramBotBrand(async method=>method==="getMyName"?{name:"Domainradar"}:true),
      /TELEGRAM_BOT_NAME_VERIFICATION_FAILED/
    );
  });
  await test("Startup performs best-effort brand change without blocking report workers",async()=>{
    assert.match(hubSource,/const \{ensureTelegramBotBrand\}=require\("\.\/telegramHubBrand"\)/);
    assert.match(hubSource,/await ensureTelegramBotBrand\(tg\)/);
    assert.match(hubSource,/bot display name update pending/);
    assert.match(hubSource,/await tg\("setWebhook"/);
    assert.match(hubSource,/merchantAutoGroups\.startProvisioning/);
    assert.equal(DISPLAY_NAME,"Pentagon");
  });
  console.log("PENTAGON_TELEGRAM_BOT_NAME_PASS="+passed+"/5");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
