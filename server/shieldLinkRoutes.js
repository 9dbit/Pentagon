"use strict";
const express=require("express");
const crypto=require("crypto");
const fs=require("fs");
const path=require("path");
const {pool}=require("./db");
const {requireMerchantAdmin}=require("./customerViewerAuth");
const {sendShieldStatus}=require("./shieldLinkStatus");
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_BASE="https://pentagon.quest/s/";
const schema=fs.readFileSync(path.join(__dirname,"shieldLinkSchema.sql"),"utf8");
async function initializeShieldSchema(db=pool){await db.query(schema);}
function fail(code,status=400){throw Object.assign(new Error(code),{status});}
function normalizedUrl(value) {
  if(typeof value!=="string"||!value.trim()||value.length>2048||/[\x00-\x20\\]/.test(value.trim()))fail("INVALID_DESTINATION");
  let u;try{u=new URL(value.includes("://")?value:"https://"+value);}catch(_){fail("INVALID_DESTINATION");}
  if(!["https:","http:"].includes(u.protocol)||u.username||u.password||u.port||
    !u.hostname.includes(".")||!/[a-z]/i.test(u.hostname)||u.hostname.endsWith(".")||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname)||
    /^(pentagon\.quest|www\.pentagon\.quest|penta\.quest)$/.test(u.hostname))fail("INVALID_DESTINATION");
  return u.toString();
}
function text(value,max){if(typeof value!=="string"||value.length>max)fail("INVALID_FIELD");return value.trim();}
function host(value){try{return new URL(value).hostname.replace(/^www\./,"").toLowerCase();}catch(_){return "";}}
function destinationStatus(domain,now=Date.now()) {
  if(!domain)return {eligible:false,code:"not_owned",text:"Domain tidak terdaftar di project ini"};
  if(domain.is_active!==true)return {eligible:false,code:"inactive",text:"Domain dinonaktifkan"};
  if(domain.registry_listed===true)return {eligible:false,code:"registry_listed",text:"Tercatat di registry Trust Positif"};
  if(domain.global_status==="blocked")return {eligible:false,code:"network_blocked",text:"Hasil monitoring: terblokir"};
  const stamp=domain?.last_checked_at?new Date(domain.last_checked_at).getTime():NaN;
  if(!Number.isFinite(stamp))return {eligible:false,code:"unchecked",text:"Belum ada hasil jaringan yang valid"};
  if(stamp>now)return {eligible:false,code:"invalid_timestamp",text:"Waktu pemeriksaan tidak valid"};
  if(now-stamp>24*3600000)return {eligible:false,code:"stale",text:"Hasil jaringan lebih dari 24 jam"};
  if(domain.global_status!=="working")return {eligible:false,code:"network_unverified",text:"Jaringan belum terverifikasi terjangkau"};
  return {eligible:true,code:"ready",text:"Siap digunakan"};
}
function eligible(domain,now=Date.now()){return destinationStatus(domain,now).eligible;}
function destinationChecks(link,stock,domains,now=Date.now()) {
  const owned=new Map(domains.filter(d=>String(d.project_name||"")===link.project_name).map(d=>[String(d.domain).replace(/^www\./,"").toLowerCase(),d]));
  return [{url:link.primary_url,role:"primary"},...stock.map(d=>({id:d.id,url:d.domain_url,role:"fallback"}))].map(item=>{
    let url;try{url=normalizedUrl(item.url);}catch(_){return {...item,eligible:false,code:"invalid_url",text:"URL tujuan tidak valid"};}
    const domain=owned.get(host(url));
    return {...item,url,...destinationStatus(domain,now),last_checked_at:domain?.last_checked_at||null,registry_checked_at:domain?.registry_checked_at||null};
  });
}
function selectTarget(link,stock,domains,now=Date.now()) {
  if(!link.is_active)return {url:null,reason:"paused"};
  const ready=destinationChecks(link,stock,domains,now).find(d=>d.eligible);
  return ready?{url:ready.url,reason:ready.role}:{url:null,reason:"no_verified_destination"};
}
async function requireReady(link,stock,tenant,db){
  const checks=destinationChecks(link,stock,await ownedDomains(tenant,db));
  if(!checks.some(d=>d.eligible))throw Object.assign(new Error("NO_READY_DESTINATION"),{status:422,checks});
}
async function ownedDomains(tenant,db) {
  return (await db.query("SELECT d.domain,d.project_name,d.is_active,d.global_status,d.last_checked_at,"+
    "m.registry_listed,m.registry_checked_at FROM domains d LEFT JOIN trustpositif_domain_monitor m "+
    "ON m.tenant=d.tenant AND m.domain=LOWER(TRIM(d.domain)) WHERE d.tenant=$1 ORDER BY d.domain",[tenant])).rows;
}
async function validateDestination(url,tenant,project,db){
  const value=normalizedUrl(url);
  const d=(await db.query("SELECT domain FROM domains WHERE tenant=$1 AND is_active=TRUE "+
    "AND COALESCE(project_name,'')=$2 AND REGEXP_REPLACE(LOWER(TRIM(domain)),'^www\\.','')=$3 LIMIT 1",
    [tenant,project,host(value)])).rows[0];
  if(!d)fail("OWN_ACTIVE_PROJECT_DOMAIN_REQUIRED",400);
  return value;
}
function createShieldLinkRouter(db=pool,{merchant=false}={}) {
  const router=express.Router();
  if(merchant)router.use(requireMerchantAdmin);
  router.use((req,res,next)=>{
    res.set("Cache-Control","private, no-store");
    if(!merchant&&(!req.session?.isAdmin||req.session.isDemo||req.session.isCustomerViewer))
      return res.status(403).json({error:"ADMIN_REQUIRED"});
    const origin=req.headers.origin;
    if(!["GET","HEAD"].includes(req.method)&&origin&&
      !["https://pentagon.quest","https://www.pentagon.quest","https://pentagon-hot-standby.onrender.com"].includes(origin)&&
      !(process.env.NODE_ENV!=="production"&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)))
      return res.status(403).json({error:"ORIGIN_DENIED"});
    next();
  });
  const tenant=req=>merchant?req.merchantTenant:"admin";
  const safe=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){
    const status=e.status||(e.code==="23505"?409:503);
    res.status(status).json({error:e.status?e.message:status===409?"DUPLICATE_DESTINATION":"SHIELDLINK_UNAVAILABLE",...(e.checks?{destinations:e.checks}:{})});
  }};
  async function transaction(req,id,fn){
    if(id&&!UUID.test(id))fail("LINK_NOT_FOUND",404);
    const tx=await db.connect();
    try{
      await tx.query("BEGIN");
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))",["shield:"+tenant(req)]);
      const link=id?(await tx.query("SELECT * FROM shield_links WHERE id=$1 AND tenant=$2 FOR UPDATE",[id,tenant(req)])).rows[0]:null;
      if(id&&!link)fail("LINK_NOT_FOUND",404);
      const out=await fn(tx,link);await tx.query("COMMIT");return out;
    }catch(e){await tx.query("ROLLBACK");throw e;}finally{tx.release();}
  }
  router.get("/",safe(async(req,res)=>{
    const own=tenant(req),domains=await ownedDomains(own,db);
    const links=(await db.query("SELECT * FROM shield_links WHERE tenant=$1 ORDER BY created_at DESC",[own])).rows;
    const stock=(await db.query("SELECT d.* FROM shield_link_domains d JOIN shield_links l ON l.id=d.link_id "+
      "WHERE l.tenant=$1 ORDER BY d.priority,d.created_at,d.id",[own])).rows;
    res.json({links:links.map(l=>{const fallback=stock.filter(d=>d.link_id===l.id);return {
      id:l.id,slug:l.slug,label:l.label,project_name:l.project_name,primary_url:l.primary_url,
      is_active:l.is_active,redirect_count:Number(l.redirect_count),last_redirect_at:l.last_redirect_at,
      shortlink:PUBLIC_BASE+l.slug,domains:fallback,target:selectTarget(l,fallback,domains),destinations:destinationChecks(l,fallback,domains)
    };}),project_domains:domains.map(d=>({...d,eligible:eligible(d),readiness:destinationStatus(d)}))});
  }));
  router.post("/",safe(async(req,res)=>{
    const label=text(req.body?.label||"",80),project=text(req.body?.project_name||"",120);
    const active=req.body?.is_active===undefined?true:req.body.is_active;
    if(typeof active!=="boolean")fail("INVALID_STATUS");
    const result=await transaction(req,null,async tx=>{
      const count=Number((await tx.query("SELECT COUNT(*) AS count FROM shield_links WHERE tenant=$1",[tenant(req)])).rows[0].count);
      if(count>=50)fail("SHIELDLINK_LIMIT",409);
      const primary=await validateDestination(req.body?.primary_url,tenant(req),project,tx);
      if(active)await requireReady({project_name:project,primary_url:primary},[],tenant(req),tx);
      const id=crypto.randomUUID(),slug=crypto.randomBytes(9).toString("base64url");
      await tx.query("INSERT INTO shield_links(id,tenant,slug,label,project_name,primary_url,is_active) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id,tenant(req),slug,label,project,primary,active]);
      return {id,slug,shortlink:PUBLIC_BASE+slug,is_active:active};
    });res.status(201).json(result);
  }));
  router.patch("/:id",safe(async(req,res)=>{
    await transaction(req,req.params.id,async(tx,link)=>{
      const fields=[],args=[];
      if(Object.hasOwn(req.body||{},"label")){args.push(text(req.body.label,80));fields.push("label=$"+args.length);}
      if(Object.hasOwn(req.body||{},"is_active")){
        if(typeof req.body.is_active!=="boolean")fail("INVALID_STATUS");
        args.push(req.body.is_active);fields.push("is_active=$"+args.length);
      }
      if(Object.hasOwn(req.body||{},"primary_url")){
        args.push(await validateDestination(req.body.primary_url,tenant(req),link.project_name,tx));fields.push("primary_url=$"+args.length);
      }
      if((req.body?.is_active??link.is_active)&&(req.body?.is_active===true||Object.hasOwn(req.body||{},"primary_url"))){
        const stock=(await tx.query("SELECT * FROM shield_link_domains WHERE link_id=$1 ORDER BY priority,created_at,id",[link.id])).rows;
        await requireReady({...link,primary_url:req.body.primary_url||link.primary_url},stock,tenant(req),tx);
      }
      if(!fields.length)fail("NO_EDITABLE_FIELDS");
      args.push(link.id,tenant(req));
      await tx.query("UPDATE shield_links SET "+fields.join(",")+",updated_at=NOW() WHERE id=$"+(args.length-1)+" AND tenant=$"+args.length,args);
    });res.json({ok:true});
  }));
  router.post("/:id/domains",safe(async(req,res)=>{
    await transaction(req,req.params.id,async(tx,link)=>{
      const stock=(await tx.query("SELECT domain_url,priority FROM shield_link_domains WHERE link_id=$1",[link.id])).rows;
      if(stock.length>=30)fail("FALLBACK_LIMIT",409);
      const url=await validateDestination(req.body?.domain_url,tenant(req),link.project_name,tx);
      if(url===link.primary_url)fail("PRIMARY_ALREADY_SELECTED",409);
      const priority=Math.max(0,...stock.map(x=>x.priority))+1;
      await tx.query("INSERT INTO shield_link_domains(id,link_id,domain_url,priority) VALUES($1,$2,$3,$4)",[crypto.randomUUID(),link.id,url,priority]);
    });res.status(201).json({ok:true});
  }));
  router.put("/:id/order",safe(async(req,res)=>{
    await transaction(req,req.params.id,async(tx,link)=>{
      const ids=req.body?.ids;
      if(!Array.isArray(ids)||ids.length>30||new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(String(id))))fail("INVALID_ORDER");
      const current=(await tx.query("SELECT id FROM shield_link_domains WHERE link_id=$1",[link.id])).rows.map(r=>r.id);
      if(current.length!==ids.length||ids.some(id=>!current.includes(id)))fail("FALLBACK_CHANGED",409);
      for(let i=0;i<ids.length;i++)await tx.query("UPDATE shield_link_domains SET priority=$1 WHERE id=$2 AND link_id=$3",[i+1,ids[i],link.id]);
    });res.json({ok:true});
  }));
  router.delete("/:id/domains/:domainId",safe(async(req,res)=>{
    await transaction(req,req.params.id,async(tx,link)=>{
      if(!UUID.test(req.params.domainId))fail("FALLBACK_NOT_FOUND",404);
      const result=await tx.query("DELETE FROM shield_link_domains WHERE id=$1 AND link_id=$2",[req.params.domainId,link.id]);
      if(!result.rowCount)fail("FALLBACK_NOT_FOUND",404);
    });res.json({ok:true});
  }));
  router.delete("/:id",safe(async(req,res)=>{
    await transaction(req,req.params.id,(tx,link)=>tx.query("DELETE FROM shield_links WHERE id=$1 AND tenant=$2",[link.id,tenant(req)]));
    res.json({ok:true});
  }));
  return router;
}
function createShieldRedirectRouter(db=pool){
  const router=express.Router();
  router.get("/:slug",async(req,res)=>{
    res.set({"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Robots-Tag":"noindex, nofollow"});
    if(!/^[a-zA-Z0-9_-]{8,40}$/.test(req.params.slug))return sendShieldStatus(res,"missing");
    let tx;
    try{
      tx=await db.connect();await tx.query("BEGIN");
      const link=(await tx.query("SELECT * FROM shield_links WHERE slug=$1 FOR UPDATE",[req.params.slug])).rows[0];
      if(!link){await tx.query("ROLLBACK");return sendShieldStatus(res,"missing");}
      const domains=await ownedDomains(link.tenant,tx);
      const stock=(await tx.query("SELECT * FROM shield_link_domains WHERE link_id=$1 ORDER BY priority,created_at,id",[link.id])).rows;
      const target=selectTarget(link,stock,domains);
      if(!target.url){await tx.query("ROLLBACK");return sendShieldStatus(res,target.reason==="paused"?"paused":"unavailable",req.params.slug);}
      if(req.method!=="HEAD")await tx.query("UPDATE shield_links SET redirect_count=redirect_count+1,last_redirect_at=NOW(),last_target_url=$1 WHERE id=$2",[target.url,link.id]);
      await tx.query("COMMIT");return res.redirect(302,target.url);
    }catch(_){if(tx)await tx.query("ROLLBACK").catch(()=>{});return sendShieldStatus(res,"service",req.params.slug);}
    finally{tx?.release();}
  });return router;
}
module.exports={schema,initializeShieldSchema,createShieldLinkRouter,createShieldRedirectRouter,normalizedUrl,eligible,selectTarget,destinationStatus,destinationChecks};
