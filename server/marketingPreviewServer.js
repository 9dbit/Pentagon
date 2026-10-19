"use strict";
// Pentagon marketing RC1: isolated static Replit-parity preview and opt-in request queue.
// No Pentagon application, login credentials, admin allowlist, scheduler or production database.
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {reviewRouter}=require("./marketingWhitelistReview");
const ROOT=path.resolve(__dirname,"../public");
const MIME=Object.freeze({
 "/learn/":["learn/index.html","text/html; charset=utf-8"],
 "/demo/":["demo/index.html","text/html; charset=utf-8"],
 "/demo/demo.css":["demo/demo.css","text/css; charset=utf-8"],
 "/demo/demo.js":["demo/demo.js","application/javascript; charset=utf-8"],
 "/privacy/":["privacy/index.html","text/html; charset=utf-8"],
 "/review/":["review/index.html","text/html; charset=utf-8"],
 "/review/review.css":["review/review.css","text/css; charset=utf-8"],
 "/review/review.js":["review/review.js","application/javascript; charset=utf-8"],
 "/whitelist.css":["whitelist.css","text/css; charset=utf-8"],
 "/whitelist.js":["whitelist.js","application/javascript; charset=utf-8"],
 "/assets/index-HN8rRKwo.css":["assets/index-HN8rRKwo.css","text/css; charset=utf-8"],
 "/sidebar.css":["sidebar.css","text/css; charset=utf-8"],
 "/app-patches.css":["app-patches.css","text/css; charset=utf-8"],
 "/logo-rotation.css":["logo-rotation.css","text/css; charset=utf-8"],
 "/rank-defense-v2.css":["rank-defense-v2.css","text/css; charset=utf-8"],
 "/serp-alerts-polish.css":["serp-alerts-polish.css","text/css; charset=utf-8"],
 "/logo-icon.png":["logo-icon.png","image/png"],
 "/logo-text.png":["logo-text.png","image/png"],
 "/replit-hero-canvas-desktop.png":["replit-hero-canvas-desktop.png","image/png"],
 "/replit-hero-canvas-mobile.png":["replit-hero-canvas-mobile.png","image/png"],
 "/pentagon-icon.svg":["pentagon-icon.svg","image/svg+xml"],
 "/og-image.png":["og-image.png","image/png"],
 "/sitemap.xml":["sitemap.xml","application/xml; charset=utf-8"]
});
const files=Object.fromEntries(Object.entries(MIME).map(([url,[p,mime]])=>{
 const src=path.join(ROOT,p);return [url,{data:fs.readFileSync(src),mime}];
}));
const ROBOTS=Buffer.from("User-agent: *\nDisallow: /\n","utf8");
const HEADERS=Object.freeze({
 "X-Robots-Tag":"noindex, nofollow, noarchive",
 "X-Content-Type-Options":"nosniff",
 "X-Frame-Options":"DENY",
 "Referrer-Policy":"strict-origin-when-cross-origin",
 "Permissions-Policy":"camera=(), microphone=(), geolocation=()",
 "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
 "Cache-Control":"no-store, max-age=0"
});
function respond(res,code,body,type){
 const data=Buffer.from(body);res.statusCode=code;res.setHeader("Content-Type",type||"application/json; charset=utf-8");
 res.setHeader("Content-Length",String(data.length));res.end(data);
}
function validEmail(value){
 if(typeof value!=="string")return null;
 const e=value.trim().toLowerCase();
 if(e.length>254||e.length<6||/[\r\n<>]/.test(e))return null;
 if(!/^[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(e))return null;
 return e;
}
function saveWhitelistRequest(dir,email,nowMs=Date.now()){
 // One Node process / one Railway volume; synchronous, atomic writes prevent interleaving.
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const dest=path.join(dir,"requests.jsonl");
 const maxBytes=2*1024*1024;
 let rows=[];
 if(fs.existsSync(dest)){
   if(fs.statSync(dest).size>maxBytes)throw Error("WHITELIST_STORAGE_LIMIT");
   rows=fs.readFileSync(dest,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));
 }
 const cutoff=nowMs-365*24*3600*1000;
 rows=rows.filter(x=>x&&typeof x.requestedAt==="string"&&new Date(x.requestedAt).getTime()>=cutoff);
 const present=rows.find(x=>x.email===email);
 if(!present){
   if(rows.length>=10000)throw Error("WHITELIST_STORAGE_LIMIT");
   rows.push({email,requestedAt:new Date(nowMs).toISOString(),consent:true,status:"pending",source:"pentagon-marketing-rc1"});
 }
 const filename=path.join(dir,".requests-"+crypto.randomBytes(8).toString("hex")+".tmp");
 try{
  const fd=fs.openSync(filename,"wx",0o600);
  try{fs.writeFileSync(fd,rows.map(x=>JSON.stringify(x)).join("\n")+"\n","utf8");fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(filename,dest);
 }finally{if(fs.existsSync(filename))fs.rmSync(filename,{force:true});}
 return {stored:!present};
}
async function readJson(req,maxBytes=2048){
 let len=0;const chunks=[];
 for await(const chunk of req){
   len+=chunk.length;if(len>maxBytes)throw Error("BODY_TOO_LARGE");
   chunks.push(chunk);
 }
 try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
 catch{throw Error("INVALID_JSON");}
}
function createServer(opts={}){
 const enabled=opts.whitelistEnabled===undefined?process.env.WHITELIST_ENABLED==="true":opts.whitelistEnabled;
 const dataDir=opts.whitelistDataDir||process.env.WHITELIST_DATA_DIR||"/data/whitelist";
 const recent=new Map();
 const review=reviewRouter({dataDir,enabled:opts.reviewEnabled===undefined?process.env.WHITELIST_REVIEW_ENABLED==="true":opts.reviewEnabled,passwordHash:opts.reviewPasswordHash||process.env.WHITELIST_REVIEW_SCRYPT||""});
 return http.createServer(async(req,res)=>{
  for(const [key,value]of Object.entries(HEADERS))res.setHeader(key,value);
  res.setHeader("Content-Type","text/plain; charset=utf-8");
  let pathname;
  try{pathname=new URL(req.url,"http://local.invalid").pathname;}
  catch{return respond(res,400,JSON.stringify({error:"Bad request"}));}
  if(await review.route(req,res,new URL(req.url,"http://local.invalid")))return;
  if(pathname==="/api/whitelist"&&req.method==="POST"){
   if(!enabled)return respond(res,503,JSON.stringify({error:"Whitelist requests are not enabled yet."}));
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"]||""))
     return respond(res,415,JSON.stringify({error:"JSON required"}));
   try{
    const from=new URL(req.headers.origin||"");
    const host=(req.headers.host||"").toLowerCase();
    if(!host||from.host.toLowerCase()!==host||!["http:","https:"].includes(from.protocol))
      return respond(res,403,JSON.stringify({error:"Invalid request origin"}));
   }catch{return respond(res,403,JSON.stringify({error:"Invalid request origin"}));}
   const key=req.socket.remoteAddress||"shared";
   const now=Date.now();const hits=(recent.get(key)||[]).filter(t=>now-t<60000);
   if(hits.length>=30)return respond(res,429,JSON.stringify({error:"Please try again later"}));
   hits.push(now);recent.set(key,hits);
   if(recent.size>1000)recent.clear();
   let data;
   try{data=await readJson(req);}
   catch(e){return respond(res,e.message==="BODY_TOO_LARGE"?413:400,JSON.stringify({error:"Invalid request data"}));}
   if(!data||typeof data!=="object"||Array.isArray(data))
      return respond(res,400,JSON.stringify({error:"Invalid request data"}));
   if(data.companyWebsite)return respond(res,202,JSON.stringify({ok:true,status:"pending"}));
   const email=validEmail(data.email);
   if(!email||data.consent!==true)
      return respond(res,422,JSON.stringify({error:"A valid email and consent are required."}));
   try{saveWhitelistRequest(dataDir,email,now);}
   catch(_){return respond(res,503,JSON.stringify({error:"Submission temporarily unavailable. Please try again later."}));}
   return respond(res,202,JSON.stringify({ok:true,status:"pending"}));
  }
  if(req.method!=="GET"&&req.method!=="HEAD"){
   res.setHeader("Allow","GET, HEAD");
   return respond(res,405,JSON.stringify({error:"Method not allowed"}));
  }
  if(pathname==="/"||pathname==="/learn"||pathname==="/privacy"||pathname==="/review"||pathname==="/demo"){
   res.writeHead(302,{"Location":pathname==="/privacy"?"/privacy/":pathname==="/review"?"/review/":pathname==="/demo"?"/demo/":"/learn/"});
   return res.end();
  }
  if(pathname==="/health"){
   return respond(res,200,JSON.stringify({ok:true,service:"pentagon-marketing-rc1",database:"not-connected",scheduler:"disabled"}));
  }
  if(pathname==="/robots.txt"){
   res.setHeader("Content-Length",String(ROBOTS.length));res.writeHead(200);
   return res.end(req.method==="HEAD"?undefined:ROBOTS);
  }
  const asset=files[pathname];
  if(!asset)return respond(res,404,"Preview path not found\n","text/plain; charset=utf-8");
  res.setHeader("Content-Type",asset.mime);
  res.setHeader("Content-Length",String(asset.data.length));
  res.writeHead(200);res.end(req.method==="HEAD"?undefined:asset.data);
 });
}
if(require.main===module){
 const port=Number(process.env.PORT||3000);
 if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error("INVALID_PORT");
 createServer().listen(port,"0.0.0.0",()=>console.log("PENTAGON_STATIC_PREVIEW_READY"));
}
module.exports={createServer,validEmail,saveWhitelistRequest};
