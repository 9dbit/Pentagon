#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {trustPositifReportPages,rankReportPages,statusOf,rankState}=require("../server/telegramMerchantReportFormats");

const now=new Date("2026-10-26T14:00:00Z");
let passed=0;
function check(name,fn){fn();passed++;console.log("PASS "+name);}
function safe(pages,marker) {
  assert.ok(pages.length>0);
  for(const p of pages){
    assert.ok(p.length<4096,"Telegram message too long");
    assert.match(p,marker);
    assert.doesNotMatch(p,/<script|<\/script>|<img|onerror=/i);
  }
}
check("Warn on unconfirmed block; confirm only from official transition",()=>{
  const base={global_status:"blocked",last_checked_at:now};
  assert.equal(statusOf(base,now),"BLOCKED / REVIEW");
  assert.equal(statusOf({...base,latest_registry_event:"BLOCKED"},now),"CONFIRMED BLOCKED");
  assert.equal(statusOf({...base,latest_registry_event:"REGISTRY_DELISTED"},now),"BLOCKED / REVIEW");
  assert.equal(statusOf({global_status:"working",last_checked_at:null},now),"UNKNOWN");
  assert.equal(statusOf({global_status:"working",last_checked_at:"2026-10-22T00:00:00Z"},now),"STALE");
});
check("TrustPositif summary escapes HTML and never claims unknown safe",()=>{
  const domains=[
    {domain_id:1,domain:"a&<test>.example",global_status:"warning",last_checked_at:now},
    {domain_id:2,domain:"b.example",global_status:"blocked",latest_registry_event:"BLOCKED",
      latest_registry_event_at:now,last_checked_at:now},
    {domain_id:3,domain:"c.example",global_status:"working",last_checked_at:null},
    {domain_id:4,domain:"d.example",global_status:"blocked",last_checked_at:now}
  ];
  const node=[{provider_name:"Telkomsel",last_health_status:"online",last_ping_at:now},
    {provider_name:"Indosat",last_health_status:"offline",last_ping_at:now}];
  const checks=[{domain_id:1,provider_name:"Telkomsel",status:"warning"}];
  const p=trustPositifReportPages("merchant_a",domains,node,checks,now);
  safe(p,/TRUST POSITIF REPORT/);
  const all=p.join("\n");
  assert.match(all,/Confirmed blocked:<\/b> 1/);
  assert.match(all,/BLOCKED \/ REVIEW/);
  assert.match(all,/UNKNOWN/);
  assert.match(all,/CHECKER COVERAGE:<\/b> 1\/2/);
  assert.match(all,/a&amp;&lt;test&gt;\.example/);
  assert.doesNotMatch(all,/a&<test>/);
  assert.match(all,/Network evidence: TSEL: warning/);
});
check("Exact official registry listing never falsely claims ISP-confirmed BLOCKED",()=>{
  const listed={domain_id:5,domain:"www.wisnu123.net",global_status:"warning",
    registry_listed:true,registry_checked_at:now,last_checked_at:now};
  assert.equal(statusOf(listed,now),"REGISTRY LISTED / ISP PENDING");
  assert.equal(statusOf({...listed,latest_registry_event:"BLOCKED"},now),
    "REGISTRY LISTED / ISP PENDING");
  assert.equal(statusOf({...listed,registry_checked_at:"2026-10-23T00:00:00Z"},now),
    "WARNING");
  const page=trustPositifReportPages("wisnu123",[listed],[],[],now);
  safe(page,/TRUST POSITIF REPORT/);
  assert.match(page.join(""),/REGISTRY LISTED \/ ISP PENDING/);
  assert.match(page.join(""),/Registry listed:<\/b> 1/);
  assert.match(page.join(""),/AI Checker registry/);
  assert.doesNotMatch(page.join(""),/TRADEVICEPC/i);
  assert.doesNotMatch(page.join(""),/CONFIRMED BLOCKED<\/b>/);
});
check("Rank summary uses only stored positions and historical evidence",()=>{
  const rows=[
    {group_id:1,keyword:"Brand & <script>",domain:"a.example",domain_label:"landing_page",
      last_position:3,last_status:"found",last_checked_at:now,previous_position:5},
    {group_id:2,keyword:"Second",domain:"b.example",domain_label:"ms",
      last_position:8,last_status:"found",last_checked_at:now,previous_position:7},
    {group_id:3,keyword:"Missing",domain:"c.example",last_position:null,
      last_status:"not_found",last_checked_at:now,previous_position:null},
    {group_id:4,keyword:"Unscanned",domain:"d.example",last_position:null,
      last_status:"pending",last_checked_at:null,previous_position:null}
  ];
  const nodes=[{id:10,provider_name:"Telkomsel"},{id:11,provider_name:"XL"}];
  const snapshots=[{group_id:1,domain:"a.example",node_id:10,position:4,checked_at:now}];
  const p=rankReportPages("merchant_a",rows,nodes,snapshots,now);
  safe(p,/GOOGLE RANK REPORT/);
  const all=p.join("\n");
  assert.match(all,/Keywords:<\/b> 4/);
  assert.match(all,/Top 10:<\/b> 2/);
  assert.match(all,/Top 3:<\/b> 1/);
  assert.match(all,/↑2/);
  assert.match(all,/↓1/);
  assert.match(all,/Brand &amp; &lt;script&gt;/);
  assert.match(all,/NOT FOUND/);
  assert.match(all,/NOT CHECKED/);
  assert.match(all,/TSEL: #4/);
  assert.match(all,/XL: —/);
  assert.doesNotMatch(all,/<script>/);
});
check("Rank stale never counted as current ranked",()=>{
  const current=rankState({last_position:3,last_status:"found",
    last_checked_at:"2026-10-24T00:00:00Z",previous_position:5},now);
  assert.equal(current.text,"STALE");
  assert.equal(current.position,null);
  const p=rankReportPages("merchant_a",[],[],[],now);
  safe(p,/GOOGLE RANK REPORT/);
  assert.match(p.join(""),/Keywords:<\/b> 0/);
});
check("Telegram pagination keeps each HTML page bounded",()=>{
  const rows=Array.from({length:120},(_,i)=>({
    domain_id:i+1,domain:"merchant-"+i+".example.test",global_status:"warning",last_checked_at:now
  }));
  const pages=trustPositifReportPages("merchant_a",rows,[],[],now);
  assert.ok(pages.length>1);
  safe(pages,/TRUST POSITIF REPORT/);
  assert.ok(pages.every(x=>/Part \d+\/\d+/.test(x)));
  assert.ok(pages.every(x=>x.length<=3250+65),"page bound");
});
console.log("PENTAGON_MERCHANT_REPORT_FORMATS_PASS="+passed+"/5");
