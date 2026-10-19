#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {registerMarketingStaticRoutes}=require("../server/marketingStaticRoutes");
const {inspectLanding,inspectRobots,inspectSitemap,audit}=require("./audit-pentagon-marketing-readiness.cjs");
const root=path.join(__dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"pentagon-marketing-"));
let pass=0;
const check=(name,fn)=>{try{fn();pass++;}catch(e){throw Error(name+": "+e.message)}};
const routes=new Map();
const app={get:(route,handler)=>{assert.equal(routes.has(route),false);routes.set(route,handler);}};
function simulate(route){
 const h=routes.get(route);if(!h)throw Error("UNREGISTERED_ROUTE_"+route);
 const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;return this},
   status(n){this.statusCode=n;return this},type(t){this.headers["content-type"]=t;return this},
   send(txt){this.body=txt;return this},redirect(n,loc){this.statusCode=n;this.headers.location=loc;return this},
   sendFile(fp){this.file=fp;this.body=fs.readFileSync(fp,"utf8");return this}};
 return h({path:route},res),res;
}
(async()=>{
 try{
  fs.mkdirSync(path.join(tmp,"learn"),{recursive:true});
  for(const asset of ["robots.txt","sitemap.xml","learn/index.html"]){
    fs.copyFileSync(path.join(root,"public",asset),path.join(tmp,asset));
  }
  registerMarketingStaticRoutes(app,tmp);
  check("only four explicit routes",()=>assert.deepEqual([...routes.keys()],["/learn","/learn/","/robots.txt","/sitemap.xml"]));
  check("app root not hijacked",()=>assert.equal(routes.has("/"),false));
  check("canonical trailing slash does not self-redirect",()=>{
    let forwarded=0;
    routes.get("/learn")({path:"/learn/"},{},()=>{forwarded++});
    assert.equal(forwarded,1);
  });
  check("API routes untouched",()=>assert.equal(routes.has("/api/health"),false));
  check("clean canonical redirects",()=>{const r=simulate("/learn");assert.equal(r.statusCode,308);assert.equal(r.headers.location,"/learn/")});
  const home=simulate("/learn/");
  check("HTML correct content type",()=>assert.match(home.headers["content-type"],/text\/html/i));
  check("marketing page is semantic HTML",()=>{const c=inspectLanding(home.body);assert.ok(Object.values(c).every(Boolean),JSON.stringify(c));});
  check("landing canonical is separate",()=>assert.match(home.body,/<link rel="canonical" href="https:\/\/pentagon\.quest\/learn\/"/));
  check("landing whitelist requires consent",()=>{assert.match(home.body,/id="wl-form"/);assert.match(home.body,/name="consent" required/);assert.doesNotMatch(home.body,/<input[^>]*type="password"/i)});
  check("correct robots type",()=>{const r=simulate("/robots.txt");assert.equal(inspectRobots(r.body,r.headers["content-type"]),true);assert.match(r.body,/Disallow:\s*\/api\//)});
  check("correct sitemap type",()=>{const r=simulate("/sitemap.xml");assert.equal(inspectSitemap(r.body,r.headers["content-type"]),true);assert.match(r.body,/<loc>https:\/\/pentagon\.quest\/learn\/<\/loc>/)});
  check("short public cache and MIME guard",()=>{const r=simulate("/learn/");assert.match(r.headers["cache-control"],/max-age=300/);assert.equal(r.headers["x-content-type-options"],"nosniff")});
  const mock=async url=>{
    if(url==="/")return {status:200,ok:true,type:"text/html",content:"<html><div id='root'></div></html>"};
    if(url==="/api/health")return {status:200,ok:true,type:"application/json",content:'{"ok":true,"database":"connected"}'};
    const r=simulate(url);return {status:r.statusCode,ok:r.statusCode===200,type:r.headers["content-type"],content:r.body};
  };
  const result=await audit(mock);
  check("technical prelaunch checks pass on local fixture",()=>assert.equal(result.technical_prelaunch_ready,true));
  check("business prelaunch still requires consent/copy review",()=>assert.equal(result.marketing_prelaunch_ready,false));
  check("paid customer launch never inferred",()=>assert.equal(result.customer_launch_ready,false));
  fs.unlinkSync(path.join(tmp,"robots.txt"));
  check("missing robots is 503 not dashboard HTML",()=>{const r=simulate("/robots.txt");assert.equal(r.statusCode,503);assert.doesNotMatch(r.body,/<html/i)});
  const missing=await audit(mock);
  check("missing robots blocks technical prelaunch",()=>assert.equal(missing.technical_prelaunch_ready,false));
  console.log("PENTAGON_MARKETING_STATIC_LOCAL_TESTS_PASS="+pass);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(err=>{console.error("STATIC_ROUTE_TESTS_FAILED="+err.message);process.exitCode=1});
