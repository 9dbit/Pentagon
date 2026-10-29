"use strict";
const express=require("express");
const crypto=require("crypto");
const fs=require("fs");
const path=require("path");
const {pool}=require("./db");
const {requireMerchantAdmin}=require("./customerViewerAuth");
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
function eligible(domain,now=Date.now()) {
  const stamp=domain?.last_checked_at?new Date(domain.last_checked_at).getTime():NaN;
  return domain?.is_active===true&&domain.global_status==="working"&&
    domain.registry_listed!==true&&Number.isFinite(stamp)&&stamp<=now&&now-stamp<=24*3600000;
}
function selectTarget(link,stock,domains,now=Date.now()) {
  if(!link.is_active)return {url:null,reason:"paused"};
  const owned=new Map(domains.filter(d=>String(d.project_name||"")===link.project_name).map(d=>[String(d.domain).replace(/^www\./,"").toLowerCase(),d]));
  const candidates=[{url:link.primary_url,primary:true},...stock.map(d=>({url:d.domain_url,primary:false}))];
  for(const item of candidates){
    let url;try{url=normalizedUrl(item.url);}catch(_){continue;}
    if(eligible(owned.get(host(url)),now))return {url,reason:item.primary?"primary":"fallback"};
  }
  return {url:null,reason:"no_verified_destination"};
}
async function ownedDomains(tenant,db) {
  return (await db.query("SELECT d.domain,d.project_name,d.is_active,d.global_status,d.last_checked_at,"+
    "m.registry_listed FROM domains d LEFT JOIN trustpositif_domain_monitor m "+
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
    res.status(status).json({error:e.status?e.message:status===409?"DUPLICATE_DESTINATION":"SHIELDLINK_UNAVAILABLE"});
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
      shortlink:PUBLIC_BASE+l.slug,domains:fallback,target:selectTarget(l,fallback,domains)
    };}),project_domains:domains.map(d=>({...d,eligible:eligible(d)}))});
  }));
  router.post("/",safe(async(req,res)=>{
    const label=text(req.body?.label||"",80),project=text(req.body?.project_name||"",120);
    const result=await transaction(req,null,async tx=>{
      const count=Number((await tx.query("SELECT COUNT(*) AS count FROM shield_links WHERE tenant=$1",[tenant(req)])).rows[0].count);
      if(count>=50)fail("SHIELDLINK_LIMIT",409);
      const primary=await validateDestination(req.body?.primary_url,tenant(req),project,tx);
      const id=crypto.randomUUID(),slug=crypto.randomBytes(9).toString("base64url");
      await tx.query("INSERT INTO shield_links(id,tenant,slug,label,project_name,primary_url) VALUES($1,$2,$3,$4,$5,$6)",
        [id,tenant(req),slug,label,project,primary]);
      return {id,slug,shortlink:PUBLIC_BASE+slug};
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
    if(!/^[a-zA-Z0-9_-]{8,40}$/.test(req.params.slug))return res.status(404).send("Link tidak ditemukan.");
    let tx;
    try{
      tx=await db.connect();await tx.query("BEGIN");
      const link=(await tx.query("SELECT * FROM shield_links WHERE slug=$1 FOR UPDATE",[req.params.slug])).rows[0];
      if(!link){await tx.query("ROLLBACK");return res.status(404).send("Link tidak ditemukan.");}
      const domains=await ownedDomains(link.tenant,tx);
      const stock=(await tx.query("SELECT * FROM shield_link_domains WHERE link_id=$1 ORDER BY priority,created_at,id",[link.id])).rows;
      const target=selectTarget(link,stock,domains);
      if(!target.url){await tx.query("ROLLBACK");res.set("Retry-After","60");return res.status(503).send("Tujuan belum tersedia. Silakan coba kembali nanti.");}
      if(req.method!=="HEAD")await tx.query("UPDATE shield_links SET redirect_count=redirect_count+1,last_redirect_at=NOW(),last_target_url=$1 WHERE id=$2",[target.url,link.id]);
      await tx.query("COMMIT");return res.redirect(302,target.url);
    }catch(_){if(tx)await tx.query("ROLLBACK").catch(()=>{});return res.status(503).send("Layanan sementara tidak tersedia.");}
    finally{tx?.release();}
  });return router;
}
module.exports={schema,initializeShieldSchema,createShieldLinkRouter,createShieldRedirectRouter,normalizedUrl,eligible,selectTarget};
