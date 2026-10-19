#!/usr/bin/env node
"use strict";
const a=require("node:assert/strict"),m=require("./audit-pentagon-marketing-readiness.cjs");
let n=0;const check=(name,f)=>{try{f();n++;}catch(e){throw Error(name+": "+e.message)}};
const html='<html><head><title>Pentagon Marketing</title><meta name="description" content="Monitor domain visibility and security across providers in a single platform"><meta property="og:title" content="Pentagon"><meta property="og:image" content="/og.png"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://pentagon.quest/"></head><body><main>Domain monitoring by Pentagon</main></body></html>';
check("marketing static content",()=>a.equal(m.inspectLanding(html).static_marketing_main,true));
check("empty SPA not marketing content",()=>a.equal(m.inspectLanding(html.replace(/<main>[\s\S]*<\/main>/,"<div id='root'></div>")).static_marketing_main,false));
check("reject HTML disguised as robots.txt",()=>a.equal(m.inspectRobots("<html>User-agent: *</html>","text/html"),false));
check("valid robots.txt",()=>a.equal(m.inspectRobots("User-agent: *\nDisallow: /api/\n","text/plain"),true));
check("reject HTML disguised as sitemap",()=>a.equal(m.inspectSitemap('<html>fallback</html>',"text/html"),false));
check("valid sitemap",()=>a.equal(m.inspectSitemap('<?xml version="1.0"?><urlset></urlset>',"application/xml"),true));
check("reject empty site",()=>a.equal(m.inspectLanding("").html_title,false));
const mock=async p=>({
"/":{status:200,ok:true,type:"text/html",content:"<html><div id=\'root\'></div></html>"},
"/learn/":{status:200,ok:true,type:"text/html",content:html},
"/api/health":{status:200,ok:true,type:"application/json",content:'{"ok":true,"database":"connected"}'},
"/robots.txt":{status:200,ok:true,type:"text/plain",content:"User-agent: *"},
"/sitemap.xml":{status:200,ok:true,type:"application/xml",content:"<urlset></urlset>"}
}[p]);
(async()=>{
  const good=await m.audit(mock);check("prelaunch good fixture",()=>a.equal(good.technical_prelaunch_ready,true));
  check("customer launch never inferred",()=>a.equal(good.customer_launch_ready,false));
  check("manual prelaunch not inferred",()=>a.equal(good.marketing_prelaunch_ready,false));
  check("dashboard remains separate marketing page",()=>a.equal(good.resource_status["/"],200));
  const fail=await m.audit(async p=>p==="/robots.txt"?{status:200,ok:true,type:"text/html",content:html}:mock(p));
  check("prelaunch fail on SPA robots",()=>a.equal(fail.technical_prelaunch_ready,false));
  console.log("PENTAGON_MARKETING_AUDIT_TESTS_PASS="+n);
})().catch(e=>{console.error(e.message);process.exitCode=1});
