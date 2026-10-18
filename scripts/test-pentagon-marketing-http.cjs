#!/usr/bin/env node
"use strict";
// Real Express HTTP check inside built Docker image. No DB and no production API.
const assert=require("node:assert/strict"),path=require("node:path"),express=require("express");
const {registerMarketingStaticRoutes}=require("../server/marketingStaticRoutes");
const dist=path.resolve(__dirname,"../dist");
const app=express();
registerMarketingStaticRoutes(app,dist);
app.get("/",(_req,res)=>res.status(200).type("text/html").send("<html><div id='root'></div></html>"));
app.get("/api/health",(_req,res)=>res.status(200).json({ok:true,database:"mock-only"}));
app.use(express.static(dist,{index:false}));
app.get("*",(_req,res)=>res.status(200).type("text/html").send("<html>SPA fallback</html>"));
let passed=0;
function check(name,fn){try{fn();passed++;}catch(e){throw Error("HTTP_"+name+": "+e.message)}}
(async()=>{
 const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
 try{
  const base="http://127.0.0.1:"+server.address().port;
  const get=async(uri,options={})=>{const r=await fetch(base+uri,options);return{status:r.status,headers:r.headers,body:await r.text()}};
  const home=await get("/");
  check("dashboard_root_preserved",()=>{assert.equal(home.status,200);assert.match(home.body,/id='root'/)});
  const health=await get("/api/health");
  check("app_api_root_not_intercepted",()=>{assert.equal(health.status,200);assert.match(health.body,/mock-only/)});
  const redirect=await get("/learn",{redirect:"manual"});
  check("canonical_redirect",()=>{assert.equal(redirect.status,308);assert.equal(redirect.headers.get("location"),"/learn/")});
  const landing=await get("/learn/");
  check("landing_status_html",()=>{assert.equal(landing.status,200);assert.match(landing.headers.get("content-type"),/text\/html/);assert.match(landing.body,/<main\b/i)});
  check("correct_canonical_meta",()=>assert.match(landing.body,/https:\/\/pentagon\.quest\/learn\//));
  check("security_mime_guard",()=>assert.equal(landing.headers.get("x-content-type-options"),"nosniff"));
  check("public_caching",()=>assert.match(landing.headers.get("cache-control"),/max-age=300/));
  const robots=await get("/robots.txt");
  check("robots_real_text",()=>{assert.equal(robots.status,200);assert.match(robots.headers.get("content-type"),/text\/plain/);assert.match(robots.body,/^User-agent:\s*\*/m);assert.doesNotMatch(robots.body,/<html/i)});
  const sitemap=await get("/sitemap.xml");
  check("sitemap_real_xml",()=>{assert.equal(sitemap.status,200);assert.match(sitemap.headers.get("content-type"),/application\/xml/);assert.match(sitemap.body,/<urlset/);assert.doesNotMatch(sitemap.body,/<html/i)});
  const logo=await get("/pentagon-icon.svg");
  check("existing_logo_served",()=>{assert.equal(logo.status,200);assert.match(logo.headers.get("content-type"),/image\/svg\+xml/)});
  const og=await fetch(base+"/og-image.png");
  check("existing_social_image_served",()=>assert.equal(og.status,200));
  const extra=await get("/unknown-safe-path");
  check("unrelated_app_spa_fallback_preserved",()=>{assert.equal(extra.status,200);assert.match(extra.body,/SPA fallback/)});
  console.log("PENTAGON_MARKETING_HTTP_TESTS_PASS="+passed);
 }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error("MARKETING_HTTP_TEST_STOPPED="+e.message);process.exitCode=1});
