"use strict";
const {pool}=require("./db");
const {prepareMerchantTenant}=require("./telegramMerchantActivation");
let running=false,timer=null;
function code(error){return String(error?.code||"UNAVAILABLE").replace(/[^A-Za-z0-9_]/g,"").slice(0,40);}
async function processOne(db=pool,{prepare=prepareMerchantTenant}={}){
 if(running)return {status:"running"};
 running=true;
 let c,job;
 try{
  c=await db.connect();
  await c.query("BEGIN");
  // A crashed worker may leave 'running'. Requeue only after its lease expires.
  await c.query(
    "UPDATE merchant_onboarding_jobs SET status='retry' WHERE status='running' AND next_run_at<NOW()");
  const claim=await c.query(
    "SELECT j.id,j.kind,j.tenant,j.account_id FROM merchant_onboarding_jobs j "+
    "JOIN merchant_accounts a ON a.id=j.account_id AND a.tenant=j.tenant "+
    "WHERE j.status IN('queued','retry') AND j.next_run_at<=NOW() AND a.status='active' "+
    "ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED");
  job=claim.rows[0];
  if(!job){await c.query("COMMIT");return {status:"idle"};}
  await c.query(
    "UPDATE merchant_onboarding_jobs SET status='running', attempts=attempts+1,"+
    "next_run_at=NOW()+INTERVAL '15 minutes' WHERE id=$1",[job.id]);
  await c.query("COMMIT");
  c.release();c=null;
  try{
   if(job.kind==="telegram_group"){
    const email=(await db.query("SELECT email FROM merchant_accounts WHERE id=$1 AND status='active'",[job.account_id])).rows[0]?.email;
    if(!email)throw Object.assign(new Error("ACCOUNT_NOT_ACTIVE"),{code:"ACCOUNT_NOT_ACTIVE"});
    const ok=await prepare(job.tenant,email,db);
    if(ok!==true)throw Object.assign(new Error("TELEGRAM_QUEUE_UNAVAILABLE"),{code:"TELEGRAM_QUEUE_UNAVAILABLE"});
   }else if(job.kind!=="merchant_bootstrap")throw Object.assign(new Error("UNKNOWN_JOB"),{code:"UNKNOWN_JOB"});
   await db.query("UPDATE merchant_onboarding_jobs SET status='done',last_error_code=NULL WHERE id=$1",[job.id]);
   return {status:"done",kind:job.kind};
  }catch(e){
   await db.query(
    "UPDATE merchant_onboarding_jobs SET status='retry',last_error_code=$2,"+
    "next_run_at=NOW()+INTERVAL '30 minutes' WHERE id=$1",[job.id,code(e)]);
   return {status:"retry",kind:job.kind};
  }
 }catch(e){if(c)await c.query("ROLLBACK").catch(()=>{});throw e;}
 finally{c?.release();running=false;}
}
function startSignupOnboarding(db=pool){
 if(timer)return;
 const tick=()=>processOne(db).catch(e=>console.warn("[Merchant Signup] onboarding worker unavailable",code(e)));
 const first=setTimeout(tick,12000);first.unref?.();
 timer=setInterval(tick,60000);timer.unref?.();
}
module.exports={processOne,startSignupOnboarding};
