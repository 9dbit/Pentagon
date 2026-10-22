#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const env = {...process.env};
for (const key of [
  "DATABASE_URL","SESSION_SECRET","ADMIN_PASSWORD",
  "NODE_BOOTSTRAP_TOKEN","PENTAGON_TEST_USERS_JSON",
  "PENTAGON_CUSTOMER_VIEWERS_JSON"
]) delete env[key];
env.NODE_ENV="production";
env.PORT="0";

async function blockedNoCredentials() {
  const proc=spawn(process.execPath,["server/render-entry.js"],{
    env:{...env,PENTAGON_RENDER_PREFLIGHT_ONLY:"false"},
    stdio:["ignore","pipe","pipe"]
  });
  let output="";
  proc.stdout.on("data",chunk=>output+=String(chunk));
  proc.stderr.on("data",chunk=>output+=String(chunk));
  const rc=await new Promise((resolve,reject)=>{
    const kill=setTimeout(()=>{proc.kill("SIGKILL");reject(new Error("SECRET_GUARD_HUNG"));},6000);
    proc.on("exit",code=>{clearTimeout(kill);resolve(code)});
    proc.on("error",reject);
  });
  assert.equal(rc,78);
  assert.match(output,/REQUIRED_CONFIGURATION_MISSING/);
  assert.ok(!output.includes("postgres://"));
  console.log("PASS live mode refuses absent credentials without listening");
}

async function preflightOnly() {
  const proc=spawn(process.execPath,["server/render-entry.js"],{
    env:{...env,PENTAGON_RENDER_PREFLIGHT_ONLY:"true"},
    stdio:["ignore","pipe","pipe"]
  });
  let stdout="",stderr="";
  proc.stderr.on("data",b=>stderr+=String(b));
  const port=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{proc.kill("SIGKILL");reject(new Error("PREFLIGHT_START_TIMEOUT "+stderr.slice(0,150)));},7000);
    proc.stdout.on("data",b=>{
      stdout+=String(b);
      const match=stdout.match(/LISTENING PORT=(\d+)/);
      if(match){clearTimeout(timeout);resolve(Number(match[1]));}
    });
    proc.on("error",e=>{clearTimeout(timeout);reject(e)});
    proc.once("exit",()=>{clearTimeout(timeout);reject(new Error("PREFLIGHT_EXITED"))});
  });
  try {
    for(const [path,method,expected] of [
      ["/health/preflight","GET",200],
      ["/api/health","GET",503],
      ["/api/auth/me","GET",503],
      ["/api/customer/overview","GET",503],
      ["/api/telegram/test","POST",503],
      ["/","GET",503]
    ]){
      const response=await fetch("http://127.0.0.1:"+port+path,{method});
      assert.equal(response.status,expected,path);
      const body=await response.json();
      assert.equal(body.ready,false);
      assert.equal(response.headers.get("cache-control"),"no-store");
    }
    console.log("PASS preflight only serves nonsecret health and fails closed for every live endpoint");
  }finally{proc.kill("SIGTERM");}
}
(async()=>{
  await blockedNoCredentials();
  await preflightOnly();
  console.log("PENTAGON_RENDER_PREFLIGHT_PASS=2");
})().catch(e=>{console.error("RENDER_QA_FAILED="+e.message);process.exitCode=1;});
