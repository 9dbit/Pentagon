#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {Pool}=require("pg");
const fs=require("node:fs");
const path=require("node:path");
const {guardedCompleteTask}=require("../server/agentPollRoutes");
if(process.env.CI!=="true" ||
   !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(process.env.DATABASE_URL||"")){
  console.error("LOCAL_CI_POSTGRES_REQUIRED");
  process.exit(3);
}
const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:false,
  options:"-c search_path=node_queue_fixture"});
let checks=0;
async function test(name,fn){await fn();checks++;console.log("PASS "+name);}
async function main(){
  try{
    await db.query("CREATE SCHEMA IF NOT EXISTS node_queue_fixture");
    await db.query("CREATE TABLE node_queue_fixture.provider_node_tasks ("+
      "id TEXT PRIMARY KEY,node_id INT NOT NULL,status TEXT,result JSONB,error TEXT,"+
      "created_at TIMESTAMPTZ DEFAULT NOW(),claimed_at TIMESTAMPTZ,"+
      "completed_at TIMESTAMPTZ)");
    await db.query("INSERT INTO provider_node_tasks(id,node_id,status,error) VALUES"+
      "('queued',9,'queued',NULL),('claimed',9,'claimed',NULL),"+
      "('expired',9,'error','Node polling timeout'),"+
      "('done',9,'done',NULL),('foreign',17,'claimed',NULL)");
    await test("claimed active result is accepted exactly once",async()=>{
      assert.equal(await guardedCompleteTask(db,9,"claimed",{status:"warning",reason:"ssl error"}),true);
      assert.equal(await guardedCompleteTask(db,9,"claimed",{status:"blocked"}),false);
      const row=(await db.query("SELECT status,result->>'status' AS value FROM provider_node_tasks WHERE id='claimed'")).rows[0];
      assert.equal(row.status,"done");assert.equal(row.value,"warning");
    });
    await test("late reply after timeout cannot resurrect an expired node task",async()=>{
      assert.equal(await guardedCompleteTask(db,9,"expired",{status:"blocked"}),false);
      const row=(await db.query("SELECT status,error,result FROM provider_node_tasks WHERE id='expired'")).rows[0];
      assert.equal(row.status,"error");assert.equal(row.error,"Node polling timeout");assert.equal(row.result,null);
    });
    await test("unclaimed, done and foreign node results are rejected",async()=>{
      assert.equal(await guardedCompleteTask(db,9,"queued",{status:"blocked"}),false);
      assert.equal(await guardedCompleteTask(db,9,"done",{status:"blocked"}),false);
      assert.equal(await guardedCompleteTask(db,9,"foreign",{status:"blocked"}),false);
    });
    await test("no single-node response can modify merchant global_status",async()=>{
      const source=fs.readFileSync(path.join(__dirname,"../server/agentPollRoutes.js"),"utf8");
      assert.doesNotMatch(source,/UPDATE\s+domains|SET\s+global_status\s*=/i);
      assert.match(source,/FOR UPDATE SKIP LOCKED/);
      assert.match(source,/EXPIRED_BEFORE_POLL/);
      assert.match(source,/TASK_NO_LONGER_ACTIVE/);
      assert.match(source,/status IN \('queued','claimed'\)/);
      const node=fs.readFileSync(path.join(__dirname,"../server/nodeChecker.js"),"utf8");
      assert.match(node,/PENTAGON_NODE_CHECK_TIMEOUT_MS\|\|90000/);
    });
    console.log("PENTAGON_NODE_TASK_SAFETY_PG_PASS="+checks);
  }finally{await db.end();}
}
main().catch(e=>{console.error("NODE_TASK_SAFETY_PG_FAIL="+e.stack);process.exitCode=1;});
