"use strict";
const crypto=require("node:crypto");
const {normalizeEmail,normalizeCompany,hashPassword,verifyPassword,
 generateOneTimeToken,hashToken,tenantSlug}=require("./merchantSignupSecurity");
const RECEIVED=Object.freeze({ok:true,status:"pending",message:"If this address can register, check your email."});
const DUMMY_HASH="scrypt-v1$"+crypto.randomBytes(24).toString("base64url")+"$"+crypto.randomBytes(64).toString("base64url");
const failure=code=>Object.assign(new Error(code),{code});
async function tx(pool,fn){const c=await pool.connect();try{await c.query("BEGIN");const out=await fn(c);await c.query("COMMIT");return out;}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}}
function createMerchantSignupLifecycle(pool,{sendEmail,rateSecret,baseUrl="https://pentagon.quest",afterActivated}={}){
 if(!pool||typeof pool.connect!=="function"||typeof pool.query!=="function")throw new Error("INVALID_DB_POOL");
 if(typeof sendEmail!=="function"||typeof rateSecret!=="string"||rateSecret.length<32)throw new Error("SIGNUP_DEPENDENCY_UNAVAILABLE");
 const url=new URL(baseUrl);
 if(url.protocol!=="https:"||url.pathname!=="/"||url.search||url.hash)throw new Error("INVALID_SIGNUP_URL");
 async function rateLimit(c,raw,limit=5){
  const key=crypto.createHmac("sha256",rateSecret).update(raw).digest("hex");
  const {rows}=await c.query(
   "INSERT INTO merchant_signup_rate_limits(key_hash,window_started_at,hits) VALUES($1,NOW(),1) "+
   "ON CONFLICT(key_hash) DO UPDATE SET "+
   "window_started_at=CASE WHEN merchant_signup_rate_limits.window_started_at<NOW()-INTERVAL '1 hour' THEN NOW() ELSE merchant_signup_rate_limits.window_started_at END,"+
   "hits=CASE WHEN merchant_signup_rate_limits.window_started_at<NOW()-INTERVAL '1 hour' THEN 1 ELSE merchant_signup_rate_limits.hits+1 END,"+
   "updated_at=NOW() RETURNING hits",[key]);
  if(Number(rows[0]?.hits)>limit)throw failure("TOO_MANY_REQUESTS");
 }
 async function issue(c,id,purpose,minutes){
  const token=generateOneTimeToken();
  await c.query("UPDATE merchant_signup_challenges SET consumed_at=NOW() WHERE request_id=$1 AND purpose=$2 AND consumed_at IS NULL",[id,purpose]);
  await c.query("INSERT INTO merchant_signup_challenges(request_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,NOW()+($4::int*INTERVAL '1 minute'))",[id,purpose,hashToken(token),minutes]);
  return token;
 }
 async function useToken(c,token,purpose){
  const digest=hashToken(token);if(!digest)throw failure("INVALID_OR_EXPIRED_LINK");
  const {rows}=await c.query(
   "SELECT c.id AS challenge_id,r.* FROM merchant_signup_challenges c "+
   "JOIN merchant_signup_requests r ON r.id=c.request_id "+
   "WHERE c.token_hash=$1 AND c.purpose=$2 AND c.consumed_at IS NULL "+
   "AND c.expires_at>NOW() FOR UPDATE OF c,r",[digest,purpose]);
  if(rows.length!==1)throw failure("INVALID_OR_EXPIRED_LINK");
  return rows[0];
 }
 async function start({email,company,consent,ip,honeypot}={}){
  if(honeypot)return RECEIVED;
  const e=normalizeEmail(email),name=normalizeCompany(company);
  if(!e||!name||consent!==true||typeof ip!=="string"||!ip)throw failure("INVALID_SIGNUP_DETAILS");
  const fingerprint=crypto.createHash("sha256").update(e).digest("hex");
  const data=await tx(pool,async c=>{
   await rateLimit(c,"signup:"+ip);
   const inserted=await c.query(
    "INSERT INTO merchant_signup_requests(email,email_fingerprint,company,status,consent_at,source) "+
    "VALUES($1,$2,$3,'pending',NOW(),'landing') ON CONFLICT(email_fingerprint) DO NOTHING RETURNING id,email,status",
    [e,fingerprint,name]);
   const match=inserted.rows.length?inserted:await c.query(
     "SELECT id,email,status FROM merchant_signup_requests WHERE email_fingerprint=$1 FOR UPDATE",[fingerprint]);
   if(match.rows[0]?.status!=="pending")return null;
   const token=await issue(c,match.rows[0].id,"verify_email",20);
   return {email:match.rows[0].email,token};
  });
  if(data)await sendEmail({to:data.email,kind:"verify_email",
   url:url.origin+"/signup/verify/?code="+encodeURIComponent(data.token)});
  return RECEIVED;
 }
 async function verifyEmail(token){
  return tx(pool,async c=>{
   const r=await useToken(c,token,"verify_email");
   if(r.status!=="pending"&&r.status!=="reviewing")throw failure("APPLICATION_NOT_PENDING");
   await c.query("UPDATE merchant_signup_challenges SET consumed_at=NOW() WHERE id=$1",[r.challenge_id]);
   await c.query("UPDATE merchant_signup_requests SET email_verified_at=COALESCE(email_verified_at,NOW()),status='reviewing',updated_at=NOW() WHERE id=$1",[r.id]);
   return {ok:true,status:"reviewing"};
  });
 }
 async function listReview(){
  const {rows}=await pool.query(
   "SELECT id,email,company,email_verified_at,created_at,status "+
   "FROM merchant_signup_requests WHERE status IN ('reviewing','invited') "+
   "ORDER BY created_at ASC LIMIT 100");
  return rows;
 }
 async function approve({requestId,reviewerId}={}){
  if(!Number.isSafeInteger(requestId)||requestId<=0||typeof reviewerId!=="string"||reviewerId.length<3)
    throw failure("INVALID_APPROVAL");
  const data=await tx(pool,async c=>{
   const {rows}=await c.query("SELECT id,email,status,email_verified_at FROM merchant_signup_requests WHERE id=$1 FOR UPDATE",[requestId]);
   const r=rows[0];if(!r||r.status!=="reviewing"||!r.email_verified_at)throw failure("APPLICATION_NOT_REVIEWABLE");
   const token=await issue(c,r.id,"set_password",30);
   await c.query("UPDATE merchant_signup_requests SET status='invited',approved_at=NOW(),approved_by=$2,updated_at=NOW() WHERE id=$1",[r.id,reviewerId]);
   return {to:r.email,token};
  });
  await sendEmail({to:data.to,kind:"set_password",url:url.origin+"/signup/complete/?code="+encodeURIComponent(data.token)});
  return {ok:true,status:"invited"};
 }
 async function reissue({requestId,reviewerId}={}){
  if(!Number.isSafeInteger(requestId)||requestId<=0||typeof reviewerId!=="string"||reviewerId.length<3)throw failure("INVALID_REQUEST");
  const data=await tx(pool,async c=>{
   const {rows}=await c.query("SELECT id,email,status,email_verified_at,approved_at FROM merchant_signup_requests WHERE id=$1 FOR UPDATE",[requestId]);
   const r=rows[0];if(!r||r.status!=="invited"||!r.email_verified_at||!r.approved_at)throw failure("APPLICATION_NOT_REVIEWABLE");
   return {to:r.email,token:await issue(c,r.id,"set_password",30)};
  });
  await sendEmail({to:data.to,kind:"set_password",url:url.origin+"/signup/complete/?code="+encodeURIComponent(data.token)});
  return {ok:true,status:"invited"};
 }
 async function complete({token,password}={}){
  const passwordHash=await hashPassword(password);
  const account=await tx(pool,async c=>{
   const r=await useToken(c,token,"set_password");
   if(r.status!=="invited"||!r.email_verified_at||!r.approved_at)throw failure("APPLICATION_NOT_APPROVED");
   let created=null;
   for(let i=0;i<4;i++){
    const tenant=tenantSlug(r.company);
    const result=await c.query(
     "INSERT INTO merchant_accounts(request_id,email,tenant,password_hash,email_verified_at) "+
     "VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id,email,tenant",
     [r.id,r.email,tenant,passwordHash,r.email_verified_at]);
    if(result.rows.length){created=result.rows[0];break;}
   }
   if(!created)throw failure("MERCHANT_ACCOUNT_CONFLICT");
   await c.query("UPDATE merchant_signup_challenges SET consumed_at=NOW() WHERE id=$1",[r.challenge_id]);
   await c.query("UPDATE merchant_signup_requests SET status='active',activated_at=NOW(),updated_at=NOW() WHERE id=$1",[r.id]);
   await c.query(
    "INSERT INTO merchant_onboarding_jobs(account_id,tenant,kind) VALUES($1,$2,'merchant_bootstrap'),($1,$2,'telegram_group') "+
    "ON CONFLICT(account_id,kind) DO NOTHING",[created.id,created.tenant]);
   return created;
  });
  if(typeof afterActivated==="function"){
   Promise.resolve().then(()=>afterActivated(account.tenant,account.email)).catch(e=>
     console.warn("[Merchant Signup] Telegram onboarding queued",String(e?.code||"UNAVAILABLE").slice(0,25)));
  }
  return {ok:true,status:"active"};
 }
 async function accountExists(email){
  const e=normalizeEmail(email);if(!e)return false;
  const {rows}=await pool.query("SELECT id FROM merchant_accounts WHERE email=$1 LIMIT 1",[e]);return rows.length>0;
 }
 async function authenticate({email,password}={}){
  const e=normalizeEmail(email);
  if(!e||typeof password!=="string")return null;
  const {rows}=await pool.query("SELECT id,email,tenant,status,role,password_hash FROM merchant_accounts WHERE email=$1 LIMIT 1",[e]);
  const a=rows[0],eligible=Boolean(a&&a.status==="active"&&a.role==="merchant_admin");
  const good=await verifyPassword(password,eligible?a.password_hash:DUMMY_HASH);
  if(!eligible||!good)return null;
  return {id:a.id,email:a.email,tenant:a.tenant,role:"merchant_admin"};
 }
 async function validateSession(id){
  if(typeof id!=="string"||!/^[0-9a-f-]{36}$/i.test(id))return null;
  const {rows}=await pool.query("SELECT id,email,tenant,status,role FROM merchant_accounts WHERE id=$1 LIMIT 1",[id]);
  const a=rows[0];return a?.status==="active"&&a.role==="merchant_admin"?{
   id:a.id,email:a.email,tenant:a.tenant,role:a.role
  }:null;
 }
 return {start,verifyEmail,listReview,approve,reissue,complete,accountExists,authenticate,validateSession};
}
module.exports={createMerchantSignupLifecycle};
