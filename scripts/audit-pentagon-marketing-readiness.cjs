#!/usr/bin/env node
"use strict";
// Public-only technical marketing readiness audit. No credentials; no login; no DB mutations.
const assert=require("node:assert/strict");
const BASE="https://pentagon.quest";
const REQUEST_TIMEOUT=12000;
function find(html,pattern){return pattern.test(html);}
function inspectLanding(html){
  const h=String(html||"");
  const checks={
    html_title:find(h,/<title[^>]*>[^<\s][^<]*<\/title>/i),
    meta_description:find(h,/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{30,}["']/i),
    og_title:find(h,/<meta[^>]+property=["']og:title["']/i),
    og_image:find(h,/<meta[^>]+property=["']og:image["']/i),
    canonical:find(h,/<link[^>]+rel=["']canonical["']/i),
    mobile_viewport:find(h,/<meta[^>]+name=["']viewport["']/i),
    static_marketing_main:find(h,/<main(?:\s|>)[\s\S]*?(?:monitor|domain|security|pentagon|trustpositif)[\s\S]*?<\/main>/i)
  };
  return checks;
}
function inspectRobots(text,type){
  return /text\/plain/i.test(type)&&/^\s*User-agent:\s*\*/im.test(String(text||""))&&!/<html|<div|<script/i.test(text);
}
function inspectSitemap(text,type){
  return /(text\/xml|application\/xml)/i.test(type)&&/<(?:urlset|sitemapindex)(?:\s|>)/i.test(String(text||""))&&!/<html/i.test(text);
}
async function getResource(path){
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),REQUEST_TIMEOUT);
  try{
    const r=await fetch(BASE+path,{redirect:"follow",signal:c.signal,headers:{"accept":"text/html,text/plain,application/xml,application/json"}});
    const content=await r.text();
    return {status:r.status,ok:r.ok,type:r.headers.get("content-type")||"",content};
  }finally{clearTimeout(timer);}
}
async function audit(fetcher=getResource){
  const resources={};
  for(const path of ["/","/api/health","/robots.txt","/sitemap.xml"]){
    try{resources[path]=await fetcher(path);}
    catch{resources[path]={status:0,ok:false,type:"",content:""};}
  }
  const checks={site_http200:resources["/"].status===200};
  Object.assign(checks,inspectLanding(resources["/"].content));
  const h=resources["/api/health"];
  let health={};
  if(h.ok){try{health=JSON.parse(h.content);}catch{}}
  checks.backend_health=Boolean(h.status===200&&health.ok===true&&health.database==="connected");
  checks.robots_txt=resources["/robots.txt"].status===200&&inspectRobots(resources["/robots.txt"].content,resources["/robots.txt"].type);
  checks.sitemap_xml=resources["/sitemap.xml"].status===200&&inspectSitemap(resources["/sitemap.xml"].content,resources["/sitemap.xml"].type);
  return {checked_at_utc:new Date().toISOString(),domain:BASE,
    marketing_prelaunch_ready:checks.site_http200&&checks.backend_health&&checks.static_marketing_main&&checks.robots_txt&&checks.sitemap_xml,
    customer_launch_ready:false, // Intentionally NOT inferred from public HTTP response.
    manual_gates:["waitlist CTA and privacy notice","claims review","live provider-node E2E","source delta migration","auth/RLS/UAT/rollback"],
    checks,status:checks.site_http200&&checks.backend_health?"WEBSITE_UP_MARKETING_NOT_YET_VERIFIED":"WEBSITE_HEALTH_BLOCKED",
    resource_status:Object.fromEntries(Object.entries(resources).map(([p,x])=>[p,x.status]))};
}
async function main(){
  const result=await audit();console.log(JSON.stringify(result,null,2));
  if(!result.marketing_prelaunch_ready)process.exitCode=2;
}
if(require.main===module)main().catch(()=>{console.error("PUBLIC_MARKETING_AUDIT_FAILED");process.exitCode=2;});
else module.exports={inspectLanding,inspectRobots,inspectSitemap,audit};
