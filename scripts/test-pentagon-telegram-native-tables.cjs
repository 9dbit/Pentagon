#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {
  ROWS_PER_PAGE,trustPositifNativePages,googleRankNativePages,
  minsSince,providerHealth
}=require("../server/telegramMerchantNativeReports");
const NOW=new Date("2026-10-27T08:05:00.000Z");
let passed=0;
function run(title,fn){fn();passed++;console.log("PASS "+title);}
function verifyPages(pages,expected){
  assert.ok(Array.isArray(pages)&&pages.length>0);
  for(const page of pages){
    const html=page.rich_message.html;
    assert.match(html,/^<h3>/);
    assert.match(html,expected);
    assert.match(html,/<table bordered striped>/);
    assert.match(html,/<tr><th>.*<\/th>/);
    assert.match(html,/<footer>/);
    assert.ok(html.length<24000);
    assert.ok(page.message.length<3800);
    assert.doesNotMatch(page.message,/<table|<h3>/);
    assert.deepEqual(Object.keys(page.rich_message).sort(),["html","skip_entity_detection"]);
    assert.equal(page.rich_message.skip_entity_detection,true);
  }
}
run("Trust Positif native table has 3 mobile columns, real healthy providers and Waktu WIB",()=>{
  const rows=[
    {domain_id:1,domain:"safe.example",global_status:"working",last_checked_at:NOW},
    {domain_id:2,domain:"alert.example",global_status:"warning",last_checked_at:NOW},
    {domain_id:3,domain:"blocked.example",global_status:"blocked",last_checked_at:NOW,
      latest_registry_event:"BLOCKED",latest_registry_event_at:NOW},
    {domain_id:4,domain:"unknown.example",global_status:"unknown",last_checked_at:null},
    {domain_id:5,domain:"stale.example",global_status:"working",
      last_checked_at:"2026-10-23T08:05:00Z"}
  ];
  const nodes=[
    {provider_name:"Telkomsel",last_health_status:"online",last_ping_at:NOW},
    {provider_name:"Indosat",last_health_status:"offline",last_ping_at:NOW},
    {provider_name:"XL",last_health_status:"online",last_ping_at:"2026-10-26T08:05:00Z"}
  ];
  const obs=[{domain_id:2,provider_name:"Telkomsel",status:"warning"}];
  const pages=trustPositifNativePages("wisnu123",rows,nodes,obs,NOW,60);
  verifyPages(pages,/TRUST POSITIF REPORT/);
  assert.equal(pages.length,1);
  const text=pages[0].rich_message.html;
  assert.match(text,/<th>Domain<\/th><th>Status<\/th><th>Age<\/th>/);
  assert.match(text,/1\/3<\/b> Healthy Providers/);
  assert.match(text,/27 Okt 2026/);
  assert.match(text,/🚨 Blocked/);
  assert.match(text,/⚠️ Warning/);
  assert.match(text,/⌛ Stale/);
  assert.match(text,/❔ Unknown/);
  assert.match(text,/Network evidence/);
  assert.match(text,/Setiap 1 jam/);
  assert.match(pages[0].message,/safe\.example/);
  assert.match(pages[0].message,/blocked\.example/);
});
run("Trust summary doesn't pretend blocked without registry evidence or stale is safe",()=>{
  const a=trustPositifNativePages("test",[
    {domain_id:1,domain:"unconfirmed.test",global_status:"blocked",last_checked_at:NOW},
    {domain_id:2,domain:"missing.test",global_status:"working",last_checked_at:null}
  ],[],[],NOW);
  const rich=a[0].rich_message.html;
  assert.match(rich,/🔴 Review/);
  assert.match(rich,/❔ Unknown/);
  assert.match(rich,/0<\/b> Confirmed Blocked/);
  assert.match(rich,/Unknown\/Stale bukan berarti aman/);
});
run("Dynamic merchant/domain and evidence are escaped, never turn into active Telegram rich markup",()=>{
  const pages=trustPositifNativePages("wisnu<&",[
    {domain_id:1,domain:'x<script>alert("x")</script>.example',global_status:"warning",last_checked_at:NOW}
  ],[],[{domain_id:1,provider_name:"<img onerror=alert(1)>",status:"<b>boom</b>"}],NOW);
  verifyPages(pages,/TRUST POSITIF/);
  const html=pages[0].rich_message.html;
  assert.match(html,/wisnu&lt;&amp;/i);
  assert.match(html,/x&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>|<img|<b>boom<\/b>/);
  assert.ok(!html.includes("onerror=alert(1)>"));
});
run("Native trust pagination and legacy equivalent are fixed at 8 rows without data loss",()=>{
  const rows=Array.from({length:25},(_,i)=>({
    domain_id:i+1,domain:"unique-"+i+".example",global_status:"working",last_checked_at:NOW
  }));
  const p=trustPositifNativePages("tenantA",rows,[],[],NOW);
  assert.equal(ROWS_PER_PAGE,8);
  assert.equal(p.length,4);
  p.forEach(x=>verifyPages([x],/TRUST POSITIF/));
  assert.match(p[0].rich_message.html,/Bagian 1\/4/);
  assert.match(p[3].message,/Bagian 4\/4/);
  for(let i=0;i<25;i++){
    const needle="unique-"+i+".example";
    assert.equal(p.filter(x=>x.rich_message.html.includes(needle)).length,1);
    assert.equal(p.filter(x=>x.message.includes(needle)).length,1);
  }
});
run("Google ranking uses only valid saved positions, signed deltas and real snapshots",()=>{
  const rows=[
    {group_id:1,keyword:"Brand & Deals",domain:"brand.example",last_checked_at:NOW,
      last_position:3,previous_position:5,last_status:"found"},
    {group_id:2,keyword:"Second",domain:"second.example",last_checked_at:NOW,
      last_position:8,previous_position:7,last_status:"found"},
    {group_id:3,keyword:"Missing",domain:"missing.example",last_checked_at:NOW,
      last_position:null,last_status:"not_found"},
    {group_id:4,keyword:"Never scanned",domain:"not-checked.example",last_checked_at:null,
      last_position:null,last_status:"pending"},
    {group_id:5,keyword:"Stale 3 days",domain:"stale.example",last_checked_at:"2026-10-23T00:00:00Z",
      last_position:2,last_status:"found"}
  ];
  const nodes=[{id:11,provider_name:"Telkomsel"}];
  const snapshots=[{group_id:1,domain:"brand.example",node_id:11,position:4,checked_at:NOW}];
  const p=googleRankNativePages("wisnu123",rows,nodes,snapshots,NOW,60);
  verifyPages(p,/GOOGLE RANK REPORT/);
  assert.equal(p.length,1);
  const html=p[0].rich_message.html;
  assert.match(html,/5<\/b> Keywords/);
  assert.match(html,/5<\/b> Domain Links/);
  assert.match(html,/2<\/b> Valid Positions/);
  assert.match(html,/<th>Keyword<\/th><th>Position<\/th><th>Δ Rank<\/th>/);
  assert.match(html,/Brand &amp; Deals/);
  assert.match(html,/#3/);
  assert.match(html,/▲ \+2/);
  assert.match(html,/▼ −1/);
  assert.match(html,/N\/D/);
  assert.doesNotMatch(html,/#2<\/td>/);
  assert.match(html,/TELKOMSEL #4/);
  assert.match(p[0].message,/Brand &amp; Deals/);
});
run("No rank data never shows fictional position, healthy scanner or movement",()=>{
  const pages=googleRankNativePages("merchant_a",[],[],[],NOW);
  verifyPages(pages,/GOOGLE RANK/);
  assert.match(pages[0].rich_message.html,/0<\/b> Keywords/);
  assert.match(pages[0].rich_message.html,/Belum ada keyword/);
  assert.doesNotMatch(pages[0].rich_message.html,/Checker snapshot/);
  assert.ok(minsSince(null,NOW)==="—");
  assert.equal(providerHealth([],NOW).healthy,0);
});
run("Google ranks with >8 keywords paginate and never mix unknown merchant data",()=>{
  const rows=Array.from({length:19},(_,i)=>({
    group_id:i+1,keyword:"term-"+i+" & <script>",domain:"merchant-a-"+i+".example",
    last_checked_at:null,last_position:null,last_status:"pending"
  }));
  const pages=googleRankNativePages("merchant_a",rows,[],[],NOW,180);
  assert.equal(pages.length,3);
  for(const p of pages){
    verifyPages([p],/GOOGLE RANK/);
    assert.match(p.rich_message.html,/Setiap 3 jam/);
    assert.doesNotMatch(p.rich_message.html,/<script>/);
    assert.doesNotMatch(p.rich_message.html,/merchant_b/);
  }
  for(let i=0;i<19;i++){
    const needle="term-"+i+" &amp; &lt;script&gt;";
    assert.equal(pages.filter(p=>p.rich_message.html.includes(needle)).length,1);
  }
});
console.log("PENTAGON_NATIVE_TELEGRAM_TABLES_PASS="+passed+"/7");
