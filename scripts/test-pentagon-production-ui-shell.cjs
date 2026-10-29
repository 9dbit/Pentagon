#!/usr/bin/env node
"use strict";
// Production SPA shell contract. Does not start the server or touch a database.
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const server=read("server/index.js");
const boot=read("server/railway-entry.js");
const src=read("src/App.jsx");
let pass=0;
function test(name,fn){try{fn();pass++;}catch(err){throw Error("PENTAGON_PROD_SHELL_"+name+": "+err.message);}}
test("compiled index has routing priority",()=>{
 const compiled=server.indexOf("if (fs.existsSync(builtFrontendIndex)) return res.sendFile(builtFrontendIndex)");
 const legacy=server.indexOf("if (fs.existsSync(legacyFrontendIndex)) return res.sendFile(legacyFrontendIndex)");
 assert.ok(compiled>=0 && legacy>compiled);
});
test("legacy static shell no longer intercepts root",()=>{
 assert.doesNotMatch(server,/app\.get\("\/",\s*\(req,\s*res,\s*next\)\s*=>/);
 assert.doesNotMatch(server,/if \(fs\.existsSync\(importedFrontendIndex\)\)/);
});
test("static assets still served",()=>assert.match(server,/app\.use\(express\.static\(distPath, \{ index: false \}\)\)/));
test("all SPA deep links fall back to compiled HTML",()=>assert.match(server,/app\.get\("\*", \(req, res\) =>/));
test("legacy artifact retained as emergency fallback",()=>assert.match(server,/legacyFrontendIndex = path\.join\(distPath, "replit-index\.html"\)/));
test("app shell HTML receives no-store on GET navigation",()=>{
 assert.match(boot,/requestsHtml && !requestPath\.startsWith\("\/api\/"\)/);
 assert.match(boot,/no-store, no-cache, must-revalidate/);
});
test("API auth remains on existing server",()=>{assert.match(server,/app\.get\("\/api\/auth\/me"/);assert.match(server,/app\.get\("\/api\/health"/);});
test("react report is in current source",()=>{assert.match(src,/import GoogleRankReport from/);assert.match(src,/import "\.\/report-layout\.css"/);});
const htmlPath=path.join(root,"dist","index.html");
test("new compiled frontend actually exists",()=>assert.ok(fs.statSync(htmlPath).size>300));
const html=read("dist/index.html");
test("compiled HTML preserves Pentagon identity",()=>{assert.match(html,/Pentagon/);assert.match(html,/og:title/);});
const jsMatch=html.match(/src="(\/assets\/[^"]+\.js)"/);
test("Vite index references hashed js asset",()=>{assert.ok(jsMatch);assert.ok(fs.existsSync(path.join(root,"dist",jsMatch[1])));});
const compiledJs=fs.readFileSync(path.join(root,"dist",jsMatch[1]),"utf8");
test("built JS contains both new report layouts",()=>{
 for(const marker of ["Keyword reports","whitelistSerpTable","Halaman SERP","Rank keseluruhan","Defence Center","Trusted domains"])assert.ok(compiledJs.includes(marker),marker);
});
const cssFiles=fs.readdirSync(path.join(root,"dist","assets")).filter(f=>f.endsWith(".css"));
test("built CSS includes responsive report",()=>{
 assert.ok(cssFiles.length);
 const css=cssFiles.map(f=>read("dist/assets/"+f)).join("\n");
 for(const marker of ["whitelistSerpScroll","whitelistSerpTable","defenseMetrics","reportBtnPrimary"])assert.ok(css.includes(marker),marker);
});
test("existing Replit source preserved on disk",()=>assert.ok(fs.existsSync(path.join(root,"public","replit-index.html"))));
console.log("PENTAGON_PRODUCTION_SHELL_TESTS_PASS="+pass);
