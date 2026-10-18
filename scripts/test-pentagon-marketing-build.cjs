#!/usr/bin/env node
"use strict";
// Pure read-only check of the exact Vite 'dist' output packaged by Docker.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const dist=path.resolve(process.argv[2]||path.join(__dirname,"..","dist"));
let checks=0;
function check(name,fn){try{fn();checks++}catch(e){throw Error("BUILD_ASSET_"+name+"_FAILED: "+e.message)}}
function asset(file){const p=path.join(dist,file);assert.ok(fs.existsSync(p),"missing "+file);assert.ok(fs.statSync(p).isFile());return fs.readFileSync(p,"utf8");}
check("dist_is_directory",()=>assert.ok(fs.statSync(dist).isDirectory()));
let landing,robots,sitemap;
check("marketing_html",()=>{landing=asset("learn/index.html");assert.match(landing,/<main\b/i);assert.match(landing,/<h1\b/i)});
check("marketing_canonical",()=>assert.match(landing,/<link rel="canonical" href="https:\/\/pentagon\.quest\/learn\/"/i));
check("marketing_no_signup_form",()=>assert.doesNotMatch(landing,/<form\b|payment gateway|guaranteed uptime/i));
check("marketing_no_external_tracker",()=>assert.doesNotMatch(landing,/<script\s+src="https?:\/\//i));
check("robots_txt",()=>{robots=asset("robots.txt");assert.match(robots,/^User-agent:\s*\*/m);assert.doesNotMatch(robots,/<html/i)});
check("sitemap_xml",()=>{sitemap=asset("sitemap.xml");assert.match(sitemap,/<urlset/);assert.match(sitemap,/<loc>https:\/\/pentagon\.quest\/learn\/<\/loc>/);assert.doesNotMatch(sitemap,/<html/i)});
check("brand_icon",()=>{const p=path.join(dist,"pentagon-icon.svg");assert.ok(fs.existsSync(p));assert.ok(fs.statSync(p).size>100)});
check("og_image",()=>{const p=path.join(dist,"og-image.png");assert.ok(fs.existsSync(p));assert.ok(fs.statSync(p).size>500)});
check("operational_frontend_shell_preserved",()=>{const s=asset("replit-index.html");assert.match(s,/<html/i)});
check("vite_bundle_present",()=>assert.match(asset("index.html"),/<script|<div|<html/i));
console.log("PENTAGON_MARKETING_BUILD_ASSET_PASS="+checks);
