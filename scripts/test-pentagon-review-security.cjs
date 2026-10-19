#!/usr/bin/env node
"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const assert=require("node:assert/strict");
const {createServer,saveWhitelistRequest}=require("../server/marketingPreviewServer");
const {passwordHash,checkPassword,getEntries}=require("../server/marketingWhitelistReview");
const SECRET="Pentagon-Review-Test-Only-Long-2026-strong";
let passes=0;
function check(name,fn){try{fn();passes++;}catch(e){throw Error("REVIEW_"+name+": "+e.message);}}
async function withServer(options,fn){
 const server=createServer(options);await new Promise(r=>server.listen(0,"127.0.0.1",r));
 try{await fn("http://127.0.0.1:"+server.address().port);}
 finally{await new Promise(r=>server.close(r));}
}
async function req(origin,route,method="GET",body=null,cookie="",csrf="",source=origin){
 const headers={};
 if(body!==null)headers["content-type"]="application/json";
 if(method!=="GET"&&source)headers.origin=source;
 if(cookie)headers.Cookie=cookie;
 if(csrf)headers["x-csrf-token"]=csrf;
 const res=await fetch(origin+route,{method,headers,redirect:"manual",body:body===null?undefined:JSON.stringify(body)});
 return{status:res.status,headers:res.headers,text:await res.text()};
}
const decode=x=>JSON.parse(x.text);
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"pentagon-review-tests-"));
 try{
  const hash=passwordHash(SECRET);
  check("hash uses scrypt",()=>{assert.match(hash,/^scrypt:16384:[a-f0-9]{32}:[a-f0-9]{64}$/);assert.equal(checkPassword(SECRET,hash),true);assert.equal(checkPassword("wrong",hash),false);});
  await withServer({whitelistEnabled:true,whitelistDataDir:dir,reviewEnabled:true,reviewPasswordHash:hash},async origin=>{
   const page=await req(origin,"/review/");
   check("review page is static only",()=>{assert.equal(page.status,200);assert.match(page.text,/Whitelist Review/);assert.doesNotMatch(page.text,/@example\.test/);});
   const css=await req(origin,"/review/review.css");const js=await req(origin,"/review/review.js");
   check("review assets available",()=>{assert.equal(css.status,200);assert.equal(js.status,200);assert.match(js.text,/review\/decision/);});
   const anon=await req(origin,"/api/whitelist-review/requests");
   check("anonymous denied",()=>{assert.equal(anon.status,401);assert.doesNotMatch(anon.text,/example\.test/);});
   const anonCsv=await req(origin,"/api/whitelist-review/export");
   check("anonymous export denied",()=>assert.equal(anonCsv.status,401));
   const publicPost=await req(origin,"/api/whitelist","POST",{email:"qa-review@example.test",consent:true});
   check("public request accepted and pending",()=>{assert.equal(publicPost.status,202);assert.equal(getEntries(dir).length,1);});
   const attemptNoOrigin=await req(origin,"/api/whitelist-review/login","POST",{password:SECRET},"","",null);
   check("login CSRF same origin required",()=>assert.equal(attemptNoOrigin.status,403));
   const attemptWrong=await req(origin,"/api/whitelist-review/login","POST",{password:"wrong"});
   check("wrong password rejected",()=>assert.equal(attemptWrong.status,401));
   const login=await req(origin,"/api/whitelist-review/login","POST",{password:SECRET});
   const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
   const payload=decode(login);
   check("strong auth cookie only",()=>{assert.equal(login.status,200);assert.equal(payload.authenticated,true);assert.match(cookie,/__Host-pentagon_review=[a-f0-9]{64}$/);const c=login.headers.get("set-cookie");assert.match(c,/Secure/);assert.match(c,/HttpOnly/);assert.match(c,/SameSite=Strict/);assert.ok(payload.csrf.length>30);assert.doesNotMatch(login.text,/Pentagon-Review-Test/);});
   const session=await req(origin,"/api/whitelist-review/session","GET",null,cookie);
   check("session restored from cookie",()=>{assert.equal(session.status,200);assert.equal(decode(session).authenticated,true);});
   const list=await req(origin,"/api/whitelist-review/requests","GET",null,cookie);
   check("authenticated list",()=>{assert.equal(list.status,200);assert.equal(decode(list).items[0].email,"qa-review@example.test");assert.equal(decode(list).counts.pending,1);});
   const badCsrf=await req(origin,"/api/whitelist-review/decision","POST",{email:"qa-review@example.test",status:"approved"},cookie,"wrong");
   check("csrf rejects modification",()=>{assert.equal(badCsrf.status,403);assert.equal(getEntries(dir)[0].status,"pending");});
   const crossOrigin=await req(origin,"/api/whitelist-review/decision","POST",{email:"qa-review@example.test",status:"approved"},cookie,payload.csrf,"https://evil.example");
   check("cross origin rejects modification",()=>{assert.equal(crossOrigin.status,403);assert.equal(getEntries(dir)[0].status,"pending");});
   const approve=await req(origin,"/api/whitelist-review/decision","POST",{email:"qa-review@example.test",status:"approved"},cookie,payload.csrf);
   check("approval only updates marketing request",()=>{assert.equal(approve.status,200);assert.equal(getEntries(dir)[0].status,"approved");assert.equal(getEntries(dir)[0].reviewSource,"manual");});
   const csv=await req(origin,"/api/whitelist-review/export","GET",null,cookie);
   check("CSV export gated",()=>{assert.equal(csv.status,200);assert.match(csv.headers.get("content-disposition"),/attachment/);assert.match(csv.text,/qa-review@example\.test/);assert.match(csv.text,/approved/);});
   const invalid=await req(origin,"/api/whitelist-review/delete","POST",{email:"qa-review@example.test",confirm:"NO"},cookie,payload.csrf);
   check("deletion requires confirmation",()=>{assert.equal(invalid.status,422);assert.equal(getEntries(dir).length,1);});
   const deletion=await req(origin,"/api/whitelist-review/delete","POST",{email:"qa-review@example.test",confirm:"DELETE"},cookie,payload.csrf);
   check("explicit deletion removes PII",()=>{assert.equal(deletion.status,200);assert.equal(getEntries(dir).length,0);});
   const auditFile=path.join(dir,"review-audit.jsonl");
   check("audit excludes PII",()=>{const s=fs.readFileSync(auditFile,"utf8");assert.match(s,/decision_approved/);assert.match(s,/delete/);assert.doesNotMatch(s,/@example\.test/);});
   const demo=await req(origin,"/api/auth/me");
   check("never grants Pentagon production access",()=>assert.equal(demo.status,404));
   const logout=await req(origin,"/api/whitelist-review/logout","POST",{},cookie,payload.csrf);
   const after=await req(origin,"/api/whitelist-review/requests","GET",null,cookie);
   check("logout invalidates session",()=>{assert.equal(logout.status,200);assert.equal(after.status,401);});
  });
  await withServer({whitelistEnabled:true,whitelistDataDir:dir,reviewEnabled:false,reviewPasswordHash:hash},async origin=>{
   const login=await req(origin,"/api/whitelist-review/login","POST",{password:SECRET});
   check("review gate disables login",()=>assert.equal(login.status,503));
  });
  check("review data is private file",()=>{if(process.platform!=="win32")assert.equal(fs.statSync(path.join(dir,"requests.jsonl")).mode&0o777,0o600);});
  const stale=fs.mkdtempSync(path.join(dir,"stale-"));
  saveWhitelistRequest(stale,"stale@example.test",Date.UTC(2024,0,1));
  await withServer({whitelistEnabled:false,whitelistDataDir:stale,reviewEnabled:true,reviewPasswordHash:hash},async origin=>{
   const login=await req(origin,"/api/whitelist-review/login","POST",{password:SECRET});const cred=decode(login);
   const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
   const prune=await req(origin,"/api/whitelist-review/prune","POST",{},cookie,cred.csrf);
   check("manual retention cleanup",()=>{assert.equal(prune.status,200);assert.equal(decode(prune).deleted,1);assert.equal(getEntries(stale).length,0);});
  });
  console.log("PENTAGON_MARKETING_REVIEW_SECURITY_PASS="+passes);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error("PENTAGON_REVIEW_TEST_FAILED="+e.message);process.exitCode=1});
