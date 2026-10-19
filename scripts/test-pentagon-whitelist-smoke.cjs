#!/usr/bin/env node
"use strict";
// CI HTTP and persistence smoke tests for isolated marketing staging.
// Uses generated *.example.test addresses ONLY; no real lead data or production calls.
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {createServer,validEmail,saveWhitelistRequest}=require("../server/marketingPreviewServer");
let count=0;
function ok(desc,cb){try{cb();count++}catch(e){throw Error("WHITELIST_"+desc+": "+e.message)}}
async function withServer(options,fn){
 const s=createServer(options);await new Promise(resolve=>s.listen(0,"127.0.0.1",resolve));
 try{await fn("http://127.0.0.1:"+s.address().port)}finally{await new Promise(resolve=>s.close(resolve))}
}
async function request(base,path,method="GET",body,origin=true){
 const headers={};if(body!==undefined)headers["content-type"]="application/json";
 if(origin)headers.origin=base;
 const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:"manual"});
 const type=res.headers.get("content-type")||"";
 return{status:res.status,type,body:await res.text(),res};
}
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"pentagon-wl-test-"));
 try{
  ok("valid email normalization",()=>assert.equal(validEmail("  QA@Example.Test  "),"qa@example.test"));
  ok("reject malicious email",()=>assert.equal(validEmail("alice\r\nBcc:etc@a.test"),null));
  await withServer({whitelistEnabled:false},async base=>{
   const hero=await request(base,"/learn/");
   ok("original landing served",()=>{assert.equal(hero.status,200);assert.match(hero.body,/Your domain defense/);assert.match(hero.body,/Pentagon ShieldLink/);assert.match(hero.body,/Join Whitelist/);});
   ok("staging noindex",()=>assert.equal(hero.res.headers.get("x-robots-tag"),"noindex, nofollow, noarchive"));
   const css=await request(base,"/assets/index-HN8rRKwo.css");
   ok("original CSS served",()=>{assert.equal(css.status,200);assert.match(css.type,/text\/css/);assert.match(css.body,/\.lp-root/);});
   const logo=await request(base,"/logo-icon.png");
   ok("original logo served",()=>{assert.equal(logo.status,200);assert.match(logo.type,/image\/png/)});
   const script=await request(base,"/whitelist.js");
   ok("whitelist script local",()=>{assert.equal(script.status,200);assert.match(script.type,/javascript/);assert.match(script.body,/\/api\/whitelist/)});
   const privacy=await request(base,"/privacy/");
   ok("privacy notice",()=>{assert.equal(privacy.status,200);assert.match(privacy.body,/Whitelist Privacy Notice/);});
   const r=await request(base,"/api/whitelist","POST",{email:"qa@example.test",consent:true});
   ok("disabled cannot claim success",()=>{assert.equal(r.status,503);assert.match(r.body,/not enabled/);});
   const auth=await request(base,"/api/auth/me");
   ok("production APIs absent",()=>assert.equal(auth.status,404));
   const sitemap=await request(base,"/sitemap.xml");
   ok("correct sitemap XML",()=>{assert.equal(sitemap.status,200);assert.match(sitemap.type,/xml/);});
  });
  await withServer({whitelistEnabled:true,whitelistDataDir:tmp},async base=>{
   const invalid=await request(base,"/api/whitelist","POST",{email:"not-email",consent:true});
   ok("invalid email rejected",()=>assert.equal(invalid.status,422));
   const noConsent=await request(base,"/api/whitelist","POST",{email:"qa@example.test",consent:false});
   ok("consent required",()=>assert.equal(noConsent.status,422));
   const wrongOrigin=await request(base,"/api/whitelist","POST",{email:"qa@example.test",consent:true},false);
   ok("cross origin rejected",()=>assert.equal(wrongOrigin.status,403));
   const bot=await request(base,"/api/whitelist","POST",{email:"robot@example.test",consent:true,companyWebsite:"bot"});
   ok("honeypot neutralized",()=>assert.equal(bot.status,202));
   ok("honeypot did not save",()=>assert.equal(fs.existsSync(path.join(tmp,"requests.jsonl")),false));
   const valid=await request(base,"/api/whitelist","POST",{email:"  QA@Example.Test  ",consent:true,companyWebsite:""});
   ok("valid request accepted",()=>{assert.equal(valid.status,202);assert.deepEqual(JSON.parse(valid.body),{ok:true,status:"pending"})});
   const file=path.join(tmp,"requests.jsonl");
   const rows=()=>fs.readFileSync(file,"utf8").trim().split("\n").map(x=>JSON.parse(x));
   ok("persists only minimal optin",()=>{const r=rows();assert.equal(r.length,1);assert.equal(r[0].email,"qa@example.test");assert.equal(r[0].status,"pending");assert.equal(r[0].consent,true)});
   const again=await request(base,"/api/whitelist","POST",{email:"qa@example.test",consent:true});
   ok("idempotent repeated email",()=>{assert.equal(again.status,202);assert.equal(rows().length,1)});
   const another=await request(base,"/api/whitelist","POST",{email:"new@example.test",consent:true});
   ok("second request persisted",()=>{assert.equal(another.status,202);assert.equal(rows().length,2)});
   ok("private file mode",()=>{if(process.platform!=="win32")assert.equal(fs.statSync(file).mode&0o777,0o600)});
   const get=await request(base,"/api/whitelist");
   ok("no public list API",()=>assert.equal(get.status,404));
  });
  ok("retention expires stale records",()=>{
   const oldDir=fs.mkdtempSync(path.join(tmp,"expiry-"));
   const old=Date.UTC(2024,0,1),newer=Date.UTC(2026,9,19);
   saveWhitelistRequest(oldDir,"old@example.test",old);saveWhitelistRequest(oldDir,"new@example.test",newer);
   const rows=fs.readFileSync(path.join(oldDir,"requests.jsonl"),"utf8");
   assert.doesNotMatch(rows,/old@example\.test/);assert.match(rows,/new@example\.test/);
  });
  console.log("PENTAGON_WHITELIST_SMOKE_PASS="+count);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error("PENTAGON_WHITELIST_TEST_FAILED="+e.message);process.exitCode=1});
