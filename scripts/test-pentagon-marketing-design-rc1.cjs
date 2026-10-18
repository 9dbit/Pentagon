#!/usr/bin/env node
"use strict";
// RC1 marketing-only UX contract; no production services or network access.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const html=fs.readFileSync(path.join(__dirname,"../public/learn/index.html"),"utf8");
const checks=[];
function test(name,run){try{run();checks.push(name)}catch(e){throw Error("RC1_DESIGN_"+name+": "+e.message)}}
test("brand wordmark remains recognizable",()=>assert.match(html,/class="wordmark"[\s\S]*?<span>PENTAGON<\/span>/));
test("brand icon is the existing SVG",()=>assert.match(html,/src="\/pentagon-icon\.svg"/));
test("dark minimal palette retains restrained orange",()=>{assert.match(html,/#0b0b0e/);assert.match(html, /--accent:#fa6c35/)});
test("hero message qualifies unverified coverage",()=>assert.match(html,/is designed to bring domain availability/));
test("status explicitly says no public registrations",()=>assert.match(html,/Public registration and paid subscriptions are not open yet\./));
test("no invented lead collection form",()=>assert.doesNotMatch(html,/<form\b|name="email"|type="submit"/i));
test("primary CTA stays within landing page",()=>assert.match(html,/<a class="button" href="#capabilities">Explore capabilities/));
test("secondary CTA clearly labels login",()=>assert.match(html,/<a class="text-link" href="https:\/\/pentagon\.quest\/">Existing user login/));
test("header login labeled for screen readers",()=>assert.match(html,/aria-label="Existing users: sign in to the Pentagon cockpit"/));
test("navbar does not send visitors to empty staging APIs",()=>assert.match(html,/class="nav-cta" href="https:\/\/pentagon\.quest\/"/));
test("feature section exists as a functional anchor",()=>assert.match(html,/<section id="capabilities"/));
test("mobile CTA becomes full width and stacked",()=>{assert.match(html,/@media\(max-width:600px\)/);assert.match(html,/\.actions\{display:flex;flex-direction:column;align-items:stretch/);assert.match(html,/\.actions \.button\{width:100%/);});
test("mobile headline is responsive",()=>assert.match(html,/h1\{font-size:clamp\(39px,10\.7vw,54px\)/));
test("logo enlarged at mobile",()=>assert.match(html,/\.wordmark img\{height:28px;width:28px\}/));
test("button touch target at least 48px",()=>assert.match(html,/min-height:52px/));
test("secondary CTA touch target at least 44px",()=>assert.match(html,/\.text-link\{[^}]*min-height:44px/));
test("no mobile horizontal scroll masking as UX fix",()=>assert.match(html,/<meta name="viewport"/));
test("feature body copy is readable",()=>assert.match(html,/\.feature p\{font-size:15px/));
test("status copy is readable",()=>assert.match(html,/\.release-note\{[^}]*font-size:12\.5px/));
test("respect reduced motion",()=>assert.match(html,/@media\(prefers-reduced-motion:reduce\)/));
test("social card and canonical preserve production URL",()=>{assert.match(html,/property="og:image"/);assert.match(html,/rel="canonical" href="https:\/\/pentagon\.quest\/learn\/"/)});
test("preview never promotes guaranteed results",()=>assert.doesNotMatch(html,/guaranteed detection, guaranteed uptime/i));
console.log("PENTAGON_MARKETING_RC1_DESIGN_CHECKS_PASS="+checks.length);
