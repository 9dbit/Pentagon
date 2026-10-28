#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const outbox = require("../server/trustpositifAlertOutbox");

if (process.env.CI !== "true" ||
    !/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(process.env.DATABASE_URL || "")) {
  console.error("ISOLATED_CI_POSTGRES_ONLY");
  process.exit(3);
}
// Use a separate schema: the consensus test already created fixture tables
// in public, and we must not overwrite or drop them.
const db = new Pool({ connectionString:process.env.DATABASE_URL, ssl:false,
  options:"-c search_path=trustpositif_outbox_ci,public" });
let passed=0;
async function check(label,fn) { await fn(); passed++; console.log("PASS "+label); }
async function domain(name,status) {
  return (await db.query(
    "INSERT INTO domains(domain,tenant,global_status) VALUES ($1,'admin',$2) RETURNING id,domain,tenant",
    [name,status]
  )).rows[0];
}
async function rows() {
  return (await db.query("SELECT * FROM trustpositif_notification_outbox ORDER BY id")).rows;
}
async function run() {
  try {
    await db.query("CREATE SCHEMA IF NOT EXISTS trustpositif_outbox_ci");
    await db.query(
      "CREATE TABLE domains(id SERIAL PRIMARY KEY,domain TEXT UNIQUE,project_name TEXT DEFAULT '',tenant TEXT NOT NULL DEFAULT 'admin',is_active BOOLEAN DEFAULT TRUE," +
      "global_status TEXT DEFAULT 'unknown',last_status TEXT DEFAULT 'unknown',last_checked_at TIMESTAMPTZ)"
    );
    await db.query(
      "CREATE TABLE alerts(id SERIAL PRIMARY KEY,domain_id INTEGER REFERENCES domains(id) ON DELETE CASCADE," +
      "old_status TEXT,new_status TEXT,message TEXT,sent_to_telegram BOOLEAN DEFAULT FALSE,created_at TIMESTAMPTZ DEFAULT NOW())"
    );
    await outbox.ensureOutboxTables(db);
    const a = await domain("alpha.example","warning");
    const t0 = new Date("2026-10-20T09:32:00Z");
    await check("Telegram message uses real supplied timestamps and escapes untrusted fields",async()=>{
      const message=outbox.formatEventMessage({
        domain:"<alpha.example>",eventType:"BLOCKED",
        nodes:[{id:1,name:"Alpha & Beta",provider:"ISP A"},{id:2,name:"North",provider:"ISP B"}],
        detectedAt:t0,confirmedAt:t0,source:"komdigi-domains_isp-tradevicepc-sha256:"+"a".repeat(32)
      });
      assert.match(message,/&lt;alpha\.example&gt;/);
      assert.match(message,/Alpha &amp; Beta/);
      assert.match(message,/2/);
      assert.match(message,/WIB/);
      assert.match(message,/AI Checker/);
      assert.match(message,/Komdigi domains_isp/);
      assert.doesNotMatch(message,/TRADEVICEPC/i);
    });
    let first;
    await check("blocked transition + dashboard alert + outbox commit atomically",async()=>{
      first=await outbox.enqueueTransition({
        domain:a,oldStatus:"warning",newStatus:"blocked",eventType:"BLOCKED",
        message:"Confirmed test-only alpha.example",db
      });
      assert.ok(first.queued);
      assert.equal((await rows()).length,1);
      assert.equal((await db.query("SELECT global_status FROM domains WHERE id=$1",[a.id])).rows[0].global_status,"blocked");
      assert.equal((await db.query("SELECT sent_to_telegram FROM alerts WHERE id=$1",[first.alertId])).rows[0].sent_to_telegram,false);
    });
    await check("concurrent stale transition cannot create a duplicate episode",async()=>{
      const duplicate=await outbox.enqueueTransition({
        domain:a,oldStatus:"warning",newStatus:"blocked",eventType:"BLOCKED",
        message:"Should never enter outbox",db
      });
      assert.equal(duplicate.queued,false);
      assert.equal((await rows()).length,1);
    });
    let sends=0;
    await check("one Telegram delivery marks alert sent and persists audited attempt",async()=>{
      const result=await outbox.drainOutbox({db,sender:async()=>{
        sends++;return{outcome:"sent",messageId:"synthetic-1"};
      }});
      assert.equal(result.claimed,1);
      assert.equal(sends,1);
      assert.equal((await rows())[0].status,"sent");
      assert.equal((await db.query("SELECT sent_to_telegram FROM alerts WHERE id=$1",[first.alertId])).rows[0].sent_to_telegram,true);
      assert.equal((await db.query("SELECT count(*)::int n FROM trustpositif_notification_attempts")).rows[0].n,1);
    });
    await check("after a service restart no duplicate Telegram send",async()=>{
      delete require.cache[require.resolve("../server/trustpositifAlertOutbox")];
      const reloaded=require("../server/trustpositifAlertOutbox");
      const result=await reloaded.drainOutbox({db,sender:async()=>{sends++;return{outcome:"sent"};}});
      assert.equal(result.claimed,0);
      assert.equal(sends,1);
    });
    const b=await domain("beta.example","warning");
    await outbox.enqueueTransition({domain:b,oldStatus:"warning",newStatus:"blocked",
      eventType:"BLOCKED",message:"Transient failure .example",db});
    await check("definite failed request retries with bounded exponential backoff",async()=>{
      const result=await outbox.drainOutbox({db,sender:async()=>({outcome:"retry",code:"ENOTFOUND"})});
      assert.equal(result.outcomes[0],"retry");
      const row=(await rows()).at(-1);
      assert.equal(row.status,"retry");
      assert.equal(row.attempts,1);
      assert.ok(new Date(row.next_attempt_at).getTime()>Date.now());
      const early=await outbox.drainOutbox({db,sender:async()=>{throw Error("EARLY_RETRY");}});
      assert.equal(early.claimed,0);
      const later=new Date(Date.now()+180000);
      const delivered=await outbox.drainOutbox({db,now:later,sender:async()=>({outcome:"sent"})});
      assert.equal(delivered.claimed,1);
      assert.equal((await rows()).at(-1).status,"sent");
    });
    const c=await domain("gamma.example","warning");
    await outbox.enqueueTransition({domain:c,oldStatus:"warning",newStatus:"blocked",
      eventType:"BLOCKED",message:"Ambiguous failure .example",db});
    await check("ambiguous timeout is held for review, never retried automatically",async()=>{
      const r=await outbox.drainOutbox({db,sender:async()=>({outcome:"uncertain",code:"ETIMEDOUT"})});
      assert.equal(r.outcomes[0],"uncertain");
      const n=await outbox.drainOutbox({db,now:new Date(Date.now()+86400000),sender:async()=>{throw Error("DUPLICATE");}});
      assert.equal(n.claimed,0);
      assert.equal((await rows()).at(-1).status,"uncertain");
    });
    const d=await domain("delta.example","warning");
    await outbox.enqueueTransition({domain:d,oldStatus:"warning",newStatus:"blocked",
      eventType:"BLOCKED",message:"Reconciled event .example",db});
    await db.query("UPDATE domains SET global_status='warning' WHERE id=$1",[d.id]);
    await check("superseded blocked event is cancelled without sending",async()=>{
      const r=await outbox.drainOutbox({db,sender:async()=>{throw Error("MUST_NOT_SEND");}});
      assert.deepEqual(r.outcomes,["cancelled"]);
    });
    await check("verified registry delisting produces one recovery notification",async()=>{
      const msg=outbox.formatEventMessage({
        domain:a.domain,eventType:"REGISTRY_DELISTED",nodes:[],confirmedAt:new Date(),source:"exact"
      });
      assert.match(msg,/network not yet cleared/);
      const e=await outbox.enqueueTransition({domain:a,oldStatus:"blocked",
        newStatus:"warning",eventType:"REGISTRY_DELISTED",message:msg,db});
      assert.ok(e.queued);
      const r=await outbox.drainOutbox({db,sender:async()=>({outcome:"sent"})});
      assert.deepEqual(r.outcomes,["sent"]);
    });
    await check("summary + RLS table hardening",async()=>{
      const summary=await outbox.deliverySummary("admin",db);
      assert.equal(summary.queued,0);
      assert.equal(summary.sent,3);
      assert.ok(summary.attention>=1);
      const r=await db.query(
        "SELECT relrowsecurity FROM pg_class WHERE relname='trustpositif_notification_outbox'"
      );
      assert.equal(r.rows[0].relrowsecurity,true);
      const log=await outbox.recentNotificationLog("admin",db);
      assert.ok(log.length>=4);
      assert.equal(log[0].event_type,"REGISTRY_DELISTED");
      assert.equal(log[0].status,"sent");
      assert.ok(Array.isArray(log[0].history));
      assert.ok(log[0].history[0].at);
    });
    console.log("PENTAGON_TRUSTPOSITIF_OUTBOX_PG_PASS="+passed);
  } finally { await db.end(); }
}
run().catch(e=>{console.error("OUTBOX_PG_FAIL="+e.stack);process.exitCode=1;});
