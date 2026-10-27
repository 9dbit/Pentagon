"use strict";
const assert=require("node:assert/strict");
const test=require("node:test");
const express=require("express");
const {createMerchantSignupIntake}=require("../server/merchantSignupIntake");

async function run(enabled, payload, originOverride) {
 const writes=[];
 const app=express();app.use(express.json());
 app.use("/api/merchant-signup",createMerchantSignupIntake({query:async(sql,params)=>{writes.push({sql,params});return {rowCount:1};}},{enabled}));
 const server=app.listen(0,"127.0.0.1");
 try{
  const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  const response=await fetch(origin+"/api/merchant-signup",{method:"POST",headers:{"Content-Type":"application/json","Origin":originOverride||origin},body:JSON.stringify(payload)});
  return {status:response.status,body:await response.json(),writes};
 }finally{await new Promise(resolve=>server.close(resolve));}
}
const good={email:"merchant@example.com",company:"Example Co",consent:true};
test("disabled by default on explicit off",async()=>{
 const r=await run(false,good);assert.equal(r.status,503);assert.equal(r.writes.length,0);
});
test("pending application never writes role, tenant or password",async()=>{
 const r=await run(true,{...good,password:"should-not-be-used"});
 assert.equal(r.status,202);assert.equal(r.body.status,"pending");
 assert.equal(r.writes.length,1);assert.equal(r.writes[0].params.length,3);
 assert.equal(r.writes[0].sql.includes("merchant_signup_requests"),true);
 assert.equal(r.writes[0].sql.includes("merchant_admin"),false);
});
test("requires explicit consent",async()=>{const r=await run(true,{...good,consent:false});assert.equal(r.status,422);assert.equal(r.writes.length,0);});
test("rejects invalid origin",async()=>{const r=await run(true,good,"https://evil.example");assert.equal(r.status,403);assert.equal(r.writes.length,0);});
test("honeypot does not create record",async()=>{const r=await run(true,{...good,websiteCheck:"spam"});assert.equal(r.status,202);assert.equal(r.writes.length,0);});
