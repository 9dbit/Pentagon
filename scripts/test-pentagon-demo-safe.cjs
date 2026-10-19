#!/usr/bin/env node
"use strict";
// Static, read-only, data-isolated Pentagon demo checks. No DB or production endpoints.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {createServer}=require("../server/marketingPreviewServer");
const root=path.resolve(__dirname,"../public/demo");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"demo.css"),"utf8");
const js=fs.readFileSync(path.join(root,"demo.js"),"utf8");
let checks=0;
function check(name,fn){try{fn();checks++;}catch(e){throw Error("PENTAGON_DEMO_"+name+"_FAILED: "+e.message)}}
check("no live or personal data claim",()=>{assert.match(html,/SANDBOX · MOCK DATA/);assert.match(html,/All domains, providers, rank data, alerts and events are fictional/);assert.match(html,/no production data/i);});
check("retains Pentagon branding",()=>{assert.match(html,/src="\/logo-icon\.png"/);assert.match(html,/src="\/logo-text\.png"/);});
check("5 functional tabs",()=>{assert.equal((html.match(/role="tab" aria-selected/g)||[]).length,5);assert.equal((html.match(/role="tabpanel"/g)||[]).length,5);});
check("interactive controls have real handlers",()=>{assert.match(js,/addEventListener\("change"/);assert.match(js,/addEventListener\("click"/);assert.match(js,/addEventListener\("keydown"/);assert.match(js,/addEventListener\("input"/);});
check("no side effect APIs",()=>{assert.doesNotMatch(js,/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB/i);assert.doesNotMatch(html,/<form\b/i);});
check("reserved DNS domains only",()=>{const matches=js.match(/[a-z0-9-]+\.(?:com|net|org|example|id|app)/gi)||[];assert.ok(matches.length>=4);assert.ok(matches.every(x=>x.endsWith(".example")),JSON.stringify(matches));});
check("fictional provider names",()=>{assert.match(js,/Example Provider A/);assert.match(js,/Example Provider B/);assert.match(js,/Example Provider C/);assert.doesNotMatch(js,/Telkomsel|Indosat|XL Axiata|Biznet|Telkom Indonesia/i);});
check("scenario copy distinguishes mock Google data",()=>assert.match(html,/not Google data/i));
check("standalone UI responsive",()=>{assert.match(css,/@media\(max-width:600px\)/);assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);});
check("no production dashboard authentication",()=>{assert.doesNotMatch(js,/\/api\/auth|\/api\/domains|\/api\/whitelist|DATABASE_URL|supabase/i);assert.doesNotMatch(html,/name="password"|type="password"/i);});
check("noindex in body and CSP from host",()=>assert.match(html,/<meta name="robots" content="noindex,nofollow,noarchive"/));
const tests=async()=>{
 const app=createServer({whitelistEnabled:false,reviewEnabled:false});
 await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+app.address().port;
 try{
  const get=async(name,opts={})=>{const r=await fetch(base+name,{redirect:"manual",...opts});return{response:r,body:await r.text()}};
  let item=await get("/demo",{redirect:"manual"});
  check("canonical route redirect",()=>{assert.equal(item.response.status,302);assert.equal(item.response.headers.get("location"),"/demo/");});
  item=await get("/demo/");
  check("demo real HTML served with noindex",()=>{assert.equal(item.response.status,200);assert.match(item.response.headers.get("content-type"),/text\/html/);assert.match(item.response.headers.get("x-robots-tag"),/noindex/);assert.match(item.body,/SANDBOX · MOCK DATA/);});
  item=await get("/demo/demo.js");
  check("local Javascript served",()=>{assert.equal(item.response.status,200);assert.match(item.response.headers.get("content-type"),/application\/javascript/);assert.match(item.body,/Example Provider A/);});
  item=await get("/demo/demo.css");
  check("local CSS served",()=>{assert.equal(item.response.status,200);assert.match(item.response.headers.get("content-type"),/text\/css/);assert.match(item.body,/\.metrics/);});
  item=await get("/demo/",{method:"HEAD"});
  check("head has no body",()=>{assert.equal(item.response.status,200);assert.equal(item.body,"");});
  item=await get("/api/domains");
  check("no real API endpoints",()=>assert.equal(item.response.status,404));
  item=await get("/api/whitelist-review/requests");
  check("protected review endpoint unavailable",()=>assert.equal(item.response.status,503));
  console.log("PENTAGON_DEMO_SAFE_PREVIEW_PASS="+checks);
 }finally{await new Promise(resolve=>app.close(resolve));}
};
tests().catch(e=>{console.error("PENTAGON_DEMO_TEST_FAILED="+e.message);process.exitCode=1});
