import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { serpReading } from "../src/serpReading.mjs";
const require = createRequire(import.meta.url);
const now=Date.parse('2026-10-29T10:00:00Z'), checked='2026-10-29T09:00:00Z';
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('rank and page are the domain result, not a keyword best rank',()=>{
  const r=serpReading({last_position:13,last_page:2,last_status:'found',last_checked_at:checked},now);
  assert.equal(r.position,13);assert.equal(r.page,2);assert.equal(r.status,'found');
});
test('not found clears obsolete numeric fields',()=>{
  const r=serpReading({last_position:1,last_page:1,last_status:'not_found',last_checked_at:checked},now);
  assert.equal(r.position,null);assert.equal(r.page,null);assert.equal(r.status,'not_found');
});
test('missing invalid or future check time never invents a verified position',()=>{
  for(const stamp of [null,'invalid','2027-01-01T00:00:00Z']) {
    const r=serpReading({last_position:1,last_page:1,last_status:'found',last_checked_at:stamp},now);
    assert.equal(r.status,'pending');assert.equal(r.position,null);
  }
});
test('pending and scan errors are different from not-found',()=>{
  for(const [status,want] of [['pending','pending'],['error','unavailable']]) {
    assert.equal(serpReading({last_status:status,last_checked_at:checked},now).status,want);
  }
});
test('invalid rank and missing page are not fabricated',()=>{
  for(const value of [0,-1,1.2,true,'invalid']) {
    assert.equal(serpReading({last_position:value,last_status:'found',last_checked_at:checked},now).position,null);
  }
  assert.equal(serpReading({last_position:13,last_status:'found',last_checked_at:checked},now).page,null);
});
test('report renders every whitelisted domain including not found and unscanned',()=>{
  const code=require('esbuild').buildSync({entryPoints:['src/WhitelistRankResults.jsx'],bundle:true,write:false,
    platform:'node',format:'cjs',external:['react'],loader:{'.css':'empty'}}).outputFiles[0].text;
  const mod={exports:{}};new Function('require','module','exports',code)(require,mod,mod.exports);
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const html=renderToStaticMarkup(React.createElement(mod.exports.default,{keyword:'Fixture',domains:[
    {domain:'ranked.example',last_position:13,last_page:2,last_status:'found',last_checked_at:'2020-01-01T00:00:00Z'},
    {domain:'absent.example',last_status:'not_found',last_checked_at:'2020-01-01T00:00:00Z'},
    {domain:'pending.example',last_status:'pending'}]}));
  for(const text of ['ranked.example','absent.example','pending.example','#13','Halaman SERP','Tidak ditemukan dalam hasil scan','Belum diperiksa'])assert.ok(html.includes(text),text);
  assert.equal((html.match(/scope="row"/g)||[]).length,3);
});
test('each checker column renders its own result and timestamp without copying SERP rank',()=>{
  const code=require('esbuild').buildSync({entryPoints:['src/WhitelistRankResults.jsx'],bundle:true,write:false,
    platform:'node',format:'cjs',external:['react'],loader:{'.css':'empty'}}).outputFiles[0].text;
  const mod={exports:{}};new Function('require','module','exports',code)(require,mod,mod.exports);
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const html=renderToStaticMarkup(React.createElement(mod.exports.default,{keyword:'Fixture',domains:[
    {domain:'ranked.example',last_position:13,last_page:2,last_status:'found',last_checked_at:'2020-01-01T00:00:00Z'}],
    evidence:{nodes:[{key:'a',label:'Telkomsel',is_active:true},{key:'b',label:'XL',is_active:false}],domains:[
      {domain:'ranked.example',node_results:{a:{text:'Warning jaringan',state:'warning',checked_at:'2020-01-01T00:00:00Z'},
        b:{text:'Lama · Terjangkau',state:'stale',checked_at:'2019-01-01T00:00:00Z'}},
        ai:{text:'Tercatat registry',state:'listed',checked_at:'2020-01-01T00:00:00Z'}}]}}));
  for(const text of ['Telkomsel','XL','nonaktif','Warning jaringan','Lama · Terjangkau','AI Checker','Tercatat registry','Registry TrustPositif'])assert.ok(html.includes(text),text);
  assert.equal((html.match(/#13/g)||[]).length,1);
});
test('monitoring stays on Overview while Google Rank renders SERP results',()=>{
  const merchant=fs.readFileSync('src/MerchantAdminPage.jsx','utf8');
  const rank=fs.readFileSync('src/GoogleRankReport.jsx','utf8');
  const app=fs.readFileSync('src/App.jsx','utf8');
  assert.match(merchant,/page === "overview" && <>\s*<RankMonitoringPanel/);
  assert.doesNotMatch(merchant.slice(merchant.indexOf('{page === "keywords"'),merchant.indexOf('{page === "nodes"')),/RankMonitoringPanel/);
  assert.doesNotMatch(rank,/RankMonitoringPanel/);
  assert.match(app,/function renderDashboardPage\(\).*<RankMonitoringPanel audience="admin"/);
  for(const source of [merchant,rank,fs.readFileSync('src/CustomerViewerPage.jsx','utf8')])assert.match(source,/<WhitelistRankResults/);
});
console.log('PENTAGON_WHITELIST_SERP_PASS='+passed);
