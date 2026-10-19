#!/usr/bin/env node
"use strict";
// Source-matching checks for the user's original public Pentagon Replit landing.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const pub=path.join(__dirname,"../public");
const html=fs.readFileSync(path.join(pub,"learn/index.html"),"utf8");
const css=fs.readFileSync(path.join(pub,"whitelist.css"),"utf8");
let checks=0;
function check(label,fn){try{fn();checks++}catch(e){throw Error("REPLIT_PARITY_"+label+": "+e.message)}}
check("pentagon brand logo original",()=>{assert.match(html,/src="\/logo-icon\.png"/);assert.match(html,/src="\/logo-text\.png"/)});
check("source CSS preserved",()=>{assert.match(html,/href="\/assets\/index-HN8rRKwo\.css"/);assert.match(html,/class="lp-root"/)});
check("hero headline exact",()=>assert.match(html,/Your domain defense<br><span class="lp-hero-accent">command center\.<\/span>/));
check("hero content exact",()=>assert.match(html,/Monitor domain availability, Google rank shifts, suspicious SERP results, provider node health, and ISP block status/));
check("real mockup preserved",()=>assert.match(html,/class="lp-mockup-wrap"/));
check("seven feature cards present",()=>assert.equal((html.match(/class="lp-feature-card"/g)||[]).length,7));
for(const heading of ["Pentagon ShieldLink","Domain Uptime Monitoring","Google Rank Tracking","Provider Node Health","Telegram Smart Alerts","Status Classification","Multi-Project Management"]){
 check("feature "+heading,()=>assert.ok(html.includes(heading)));
}
check("ShieldLink section exact",()=>{assert.match(html,/One link,/);assert.match(html,/always online\./);assert.match(html,/penta\.quest\/yourname/)});
check("pricing content original",()=>{assert.match(html,/Simple, transparent plans/);assert.match(html,/Need a custom setup\?/);});
check("original stats not silently changed",()=>{for(const s of ["99.9%","Top 100","Uptime accuracy","Alert latency"])assert.ok(html.includes(s));});
check("original CTA texts retained",()=>{assert.match(html,/Get Started →/);assert.match(html,/Try Demo Free/);assert.match(html,/Activate ShieldLink →/);});
check("Join Whitelist visible",()=>{assert.match(html,/Join Whitelist/);assert.match(html,/data-wl-open/);assert.match(html,/id="wl-modal"/);});
check("nav scroll controls actionable",()=>{assert.match(html,/data-scroll-to="features"/);assert.match(html,/data-scroll-to="pricing"/)});
check("existing login stays at production",()=>assert.match(html,/href="https:\/\/pentagon\.quest\/login"/));
check("demo continues to original site",()=>assert.match(html,/href="https:\/\/demo\.pentagon\.quest"/));
check("whitelist has real consent checkbox",()=>{assert.match(html,/name="consent" required/);assert.match(html,/href="\/privacy\/"/);});
check("preview form does not accept passwords",()=>assert.doesNotMatch(html,/<input[^>]*type="password"/));
check("staging noindex HTML",()=>assert.match(html,/<meta name="robots" content="noindex,nofollow"/));
check("original layout responsive styles remain",()=>{assert.match(html,/class="lp-hamburger"/);assert.match(css,/@media\(max-width:768px\)/)});
check("CSS blocks backdrop when modal is hidden",()=>assert.match(css,/\.wl-backdrop\[hidden\]\{display:none!important\}/));
console.log("PENTAGON_REPLIT_PARITY_DESIGN_PASS="+checks);
