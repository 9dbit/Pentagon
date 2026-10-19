#!/usr/bin/env node
"use strict";
// Pentagon early-access campaign checks. No live lead capture in CI.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {createServer}=require("../server/marketingPreviewServer");
const pub=path.resolve(__dirname,"../public");
const campaign=fs.readFileSync(path.join(pub,"campaign/index.html"),"utf8");
const original=fs.readFileSync(path.join(pub,"learn/index.html"),"utf8");
let passes=0;
const check=(n,fn)=>{try{fn();passes++;}catch(e){throw Error("MARKETING_CAMPAIGN_"+n+": "+e.message)}};
check("original Replit design immutable",()=>assert.equal(crypto.createHash("sha1").update(original).digest("hex"),"6a037a88ef3a8deab3113513dc234495c7ccad00"));
check("original card layout retained",()=>{assert.equal((campaign.match(/class="lp-feature-card"/g)||[]).length,7);assert.match(campaign,/class="lp-mockup-wrap"/);assert.match(campaign,/class="lp-hero-h1"/);});
check("same branding",()=>{assert.match(campaign,/src="\/logo-icon\.png"/);assert.match(campaign,/src="\/logo-text\.png"/);});
check("all demo CTAs functional",()=>{assert.doesNotMatch(campaign,/demo\.pentagon\.quest/);assert.ok((campaign.match(/href="\/demo\/"/g)||[]).length>=4);});
check("unverified metrics absent",()=>{assert.doesNotMatch(campaign,/99\.9%|&lt;30s|<b>6\+<\/b>|Google rank depth|the link never dies|never blocked/i);});
check("no fabricated commercial plan",()=>{assert.match(campaign,/Early access and pricing/);assert.match(campaign,/No purchase or subscription is required to join the whitelist/);});
check("transparent preview disclosure",()=>{assert.match(campaign,/EARLY ACCESS PREVIEW/);assert.match(campaign,/Demo Lab uses fictional data/);});
check("consented whitelist remains active",()=>{assert.match(campaign,/id="wl-form"/);assert.match(campaign,/name="consent" required/);assert.match(campaign,/data-wl-open/);assert.match(campaign,/\/whitelist\.js/);});
check("campaign metadata not misleading",()=>{assert.match(campaign,/meta name="robots" content="noindex,nofollow"/);assert.match(campaign,/href="https:\/\/pentagon-marketing-static-rc1-staging\.up\.railway\.app\/campaign\/"/);assert.match(campaign,/og:image/);});
check("existing members login preserved",()=>assert.match(campaign,/href="https:\/\/pentagon\.quest\/login"/));
(async()=>{
 const app=createServer({whitelistEnabled:false,reviewEnabled:false});await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+app.address().port;
 try{
  const redirect=await fetch(base+"/campaign",{redirect:"manual"});
  check("route redirects",()=>{assert.equal(redirect.status,302);assert.equal(redirect.headers.get("location"),"/campaign/");});
  const res=await fetch(base+"/campaign/");
  const html=await res.text();
  check("campaign served",()=>{assert.equal(res.status,200);assert.match(res.headers.get("content-type"),/text\/html/);assert.match(html,/EARLY ACCESS PREVIEW/);assert.match(res.headers.get("x-robots-tag"),/noindex/);});
  const css=await fetch(base+"/assets/index-HN8rRKwo.css");
  check("Replit CSS still loads",()=>{assert.equal(css.status,200);assert.match(css.headers.get("content-type"),/text\/css/);});
  const demo=await fetch(base+"/demo/");
  check("simulated demo available",()=>{assert.equal(demo.status,200);});
  const form=await fetch(base+"/api/whitelist",{method:"POST",headers:{Origin:base,"content-type":"application/json"},body:JSON.stringify({email:"fake@example.test",consent:true})});
  check("disabled form fails clearly",()=>assert.equal(form.status,503));
  console.log("PENTAGON_MARKETING_CAMPAIGN_TEST_PASS="+passes);
 }finally{await new Promise(resolve=>app.close(resolve));}
})().catch(e=>{console.error("PENTAGON_CAMPAIGN_TEST_FAILED="+e.message);process.exitCode=1});
