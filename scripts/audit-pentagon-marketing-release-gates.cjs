#!/usr/bin/env node
"use strict";
// Read-only RC1 release evidence, intentionally flags unverified public claims.
// A successful audit run means the evidence report was generated, NOT a launch GO.
const fs=require("node:fs"),path=require("node:path"),dns=require("node:dns/promises");
const html=fs.readFileSync(path.join(__dirname,"../public/learn/index.html"),"utf8");
const sandbox=fs.readFileSync(path.join(__dirname,"../public/demo/index.html"),"utf8");
const now=new Date().toISOString();
const claims=[
{id:"UPTIME_999",claim:"99.9% Uptime accuracy",present:/<b>99\.9%<\/b><span>Uptime accuracy<\/span>/.test(html),evidence:"30-day monitored check and independent validation sample",status:"UNVERIFIED"},
{id:"LATENCY_30S",claim:"Less than 30s alert latency",present:/<b>&lt;30s<\/b><span>Alert latency<\/span>/.test(html),evidence:"End-to-end event-to-notification P95/P99 across representative provider paths",status:"UNVERIFIED"},
{id:"ISP_6",claim:"6+ ISP networks covered",present:/<b>6\+<\/b><span>ISP networks covered<\/span>/.test(html),evidence:"Distinct validated upstream carriers, not merely provider node counts",status:"UNVERIFIED"},
{id:"TOP100",claim:"Top 100 Google rank depth",present:/<b>Top 100<\/b><span>Google rank depth<\/span>/.test(html),evidence:"Controlled rank crawl results and quota/consent compliance",status:"UNVERIFIED"},
{id:"SHIELDLINK",claim:"ShieldLink automatic failover / always online",present:/automatically switches to a backup domain/.test(html),evidence:"End-to-end primary-block/fallback failover and rollback with independently observed availability",status:"UNVERIFIED"}
];
const pricingEmpty=/<div class="lp-pricing-grid"><\/div>/.test(html);
const links=[...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(x=>x[1]);
const demoLinks=links.filter(x=>x.startsWith("https://demo.pentagon.quest"));
const preview={
hasMockDataLabel:/SANDBOX · MOCK DATA/.test(sandbox),
hasNoindex:/noindex,nofollow,noarchive/.test(sandbox),
hasNoRealDataConnections:!/\bfetch\s*\(/.test(fs.readFileSync(path.join(__dirname,"../public/demo/demo.js"),"utf8")),
originalCTAUnchanged:demoLinks.length>=2
};
const output={
auditedAt:now,product:"Pentagon",scope:"marketing RC1 staging, read-only",
releaseDecision:"NO_GO",
codeReady:claims.every(x=>x.present)&&preview.hasMockDataLabel&&preview.hasNoindex&&preview.hasNoRealDataConnections,
originalLandingCopyPreserved:claims.every(x=>x.present),
originalDemoLinksFound:demoLinks.length,
sandboxDemoReadyForReview:preview,
gates:[
 {id:"DEMO_DNS",status:"PENDING_LIVE_DNS",action:"Prove demo.pentagon.quest resolves and serves a real sandbox before retargeting/launch."},
 {id:"PRICING",status:pricingEmpty?"OPEN":"NEEDS_APPROVAL",detail:pricingEmpty?"Original Replit pricing grid contains no plan cards.":"Pricing requires verified plan approval.",action:"Confirm plans/prices or approve alternative copy."},
 ...claims.map(c=>({id:c.id,status:c.status,originalClaimPresent:c.present,evidenceNeeded:c.evidence})),
 {id:"PRIVACY",status:"PENDING_OWNER_LEGAL_APPROVAL",action:"Confirm contact, consent, retention, backup/delete SOP and access permissions."},
 {id:"PRODUCTION_ROUTING",status:"PENDING_RELEASE_ARCHITECTURE",action:"Sign off public whitelist API hosting, rollback and mail operations without touching Replit or production."},
 {id:"FINAL_SIGNOFF",status:"NOT_GRANTED",action:"Owner explicit GO required before production merge/deploy/DNS."}
 ],
 operationalGuards:{
 sourceBranch:"feature/pentagon-marketing-prelaunch-20261018",
 productionMergeAllowed:false,
 productionDeployAllowed:false,
 marketingStagingOnly:true,
 autoAdminWhitelistGrant:false
 }
};
async function live(){
 const host="demo.pentagon.quest";
 try{const records=await Promise.race([dns.resolve4(host),new Promise((_,reject)=>setTimeout(()=>reject(Error("DNS_TIMEOUT")),7500))]);
   output.gates[0].status=records.length?"DNS_RESOLVES_NOT_APP_VERIFIED":"DNS_NO_A_RECORD";
 }catch(e){output.gates[0].status="DNS_NOT_RESOLVED";output.gates[0].detail=e.code||e.message;}
 const publicStaging="https://pentagon-marketing-static-rc1-staging.up.railway.app";
 output.stagingChecks={};
 for(const p of ["/health","/demo/","/learn/","/robots.txt","/review/"]){
  const abort=AbortSignal.timeout(9500);
  try{
   const r=await fetch(publicStaging+p,{method:"GET",redirect:"manual",signal:abort});
   // Discard response body, never collect email, session, or authentication data.
   output.stagingChecks[p]={status:r.status,noindex:(r.headers.get("x-robots-tag")||"").includes("noindex"),type:r.headers.get("content-type")||""};
   await r.body?.cancel();
  }catch(e){output.stagingChecks[p]={status:"UNAVAILABLE",error:e.cause?.code||e.name||"HTTP_ERROR"};}
 }
}
(async()=>{
 if(process.argv.includes("--live"))await live();
 if(process.argv.includes("--ci")){
  if(!output.codeReady||!output.originalLandingCopyPreserved||!output.originalDemoLinksFound){
   process.stderr.write("RC1_RELEASE_AUDIT_SOURCE_GUARD_FAILED\n");process.exitCode=1;
  }
 }
 const human=output.gates.map(g=>g.id+"="+g.status).join(" ");
 process.stderr.write("PENTAGON_RC1_RELEASE_GATE="+output.releaseDecision+" "+human+"\n");
 process.stdout.write(JSON.stringify(output,null,2)+"\n");
})().catch(e=>{process.stderr.write("RC1_AUDIT_ERROR="+e.message+"\n");process.exitCode=1});
