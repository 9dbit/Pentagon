"use strict";
// Staging-only marketing review. Never mutates Pentagon admin allowlists, auth or customer accounts.
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {snapshotFromDirectory,sealSnapshot}=require("./marketingWhitelistBackup");
const COOKIE="__Host-pentagon_review";
const STATUSES=new Set(["pending","approved","rejected"]);
const LIMIT_BYTES=2*1024*1024;
const SESSION_MS=4*60*60*1000;
function passwordHash(password,salt=crypto.randomBytes(16)){
 if(typeof password!=="string"||password.length<20)throw Error("WEAK_REVIEW_PASSWORD");
 const hash=crypto.scryptSync(password,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024});
 return "scrypt:16384:"+salt.toString("hex")+":"+hash.toString("hex");
}
function checkPassword(password,stored){
 if(typeof password!=="string"||password.length>512||typeof stored!=="string")return false;
 const p=stored.split(":");
 if(p.length!==4||p[0]!=="scrypt"||p[1]!=="16384"||!/^[a-f0-9]{32}$/i.test(p[2])||!/^[a-f0-9]{64}$/i.test(p[3]))return false;
 const expected=Buffer.from(p[3],"hex");
 const actual=crypto.scryptSync(password,Buffer.from(p[2],"hex"),32,{N:16384,r:8,p:1,maxmem:64*1024*1024});
 return crypto.timingSafeEqual(expected,actual);
}
function getEntries(dir){
 const file=path.join(dir,"requests.jsonl");
 if(!fs.existsSync(file))return [];
 if(fs.statSync(file).size>LIMIT_BYTES)throw Error("WHITELIST_FILE_TOO_LARGE");
 return fs.readFileSync(file,"utf8").split("\n").filter(Boolean).map(x=>{
  const r=JSON.parse(x);
  if(!r||typeof r.email!=="string"||!STATUSES.has(r.status))throw Error("WHITELIST_FILE_INVALID");
  return r;
 });
}
function persist(dir,rows){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(rows.length>10000)throw Error("WHITELIST_ROW_LIMIT");
 const text=rows.map(x=>JSON.stringify(x)).join("\n")+(rows.length?"\n":"");
 if(Buffer.byteLength(text)>LIMIT_BYTES)throw Error("WHITELIST_FILE_TOO_LARGE");
 const filename=path.join(dir,".review-"+crypto.randomBytes(9).toString("hex")+".tmp");
 try{
  const fd=fs.openSync(filename,"wx",0o600);
  try{fs.writeFileSync(fd,text,"utf8");fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(filename,path.join(dir,"requests.jsonl"));
 }finally{if(fs.existsSync(filename))fs.rmSync(filename,{force:true});}
}
function addAudit(dir,operation){
 // No emails, credentials, source addresses or plaintext PII in the audit file.
 const entry=JSON.stringify({at:new Date().toISOString(),operation,source:"pentagon-staging-whitelist-review"})+"\n";
 const file=path.join(dir,"review-audit.jsonl");
 const fd=fs.openSync(file,"a",0o600);
 try{fs.writeSync(fd,entry);fs.fsyncSync(fd);}
 finally{fs.closeSync(fd);}
}
function mutate(dir,operation,email,status){
 const rows=getEntries(dir);
 const index=rows.findIndex(x=>x.email===email);
 if(index<0)return false;
 if(operation==="delete")rows.splice(index,1);
 else if(operation==="decision"){
  if(!STATUSES.has(status))return false;
  rows[index]={...rows[index],status,reviewedAt:new Date().toISOString(),reviewSource:"manual"};
 }else return false;
 persist(dir,rows);
 addAudit(dir,operation==="decision"?"decision_"+status:"delete");
 return true;
}
function csvCell(value){
 const raw=String(value??"");
 const safe=/^[=+\-@\t\r]/.test(raw)?"'"+raw:raw;
 return '"'+safe.replace(/"/g,'""')+'"';
}
function makeCsv(rows){
 const header=["email","requested_at","status","reviewed_at","consent"];
 return [header.join(","),...rows.map(x=>[x.email,x.requestedAt,x.status,x.reviewedAt||"",x.consent?"yes":"no"].map(csvCell).join(","))].join("\r\n")+"\r\n";
}
async function parseJson(req,maxBytes=2048){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"]||""))throw Error("REVIEW_INVALID_CONTENT_TYPE");
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Error("REVIEW_TOO_LARGE");chunks.push(chunk);}
 try{
  const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error("REVIEW_INVALID_JSON");
  return parsed;
 }catch{throw Error("REVIEW_INVALID_JSON");}
}
function validOrigin(req){
 try{
  const origin=new URL(req.headers.origin||"");
  return ["https:","http:"].includes(origin.protocol)&&origin.host.toLowerCase()===(req.headers.host||"").toLowerCase();
 }catch{return false;}
}
function send(res,code,body,type="application/json; charset=utf-8"){
 const buf=Buffer.from(typeof body==="string"?body:JSON.stringify(body),"utf8");
 res.statusCode=code;res.setHeader("Content-Type",type);res.setHeader("Content-Length",String(buf.length));res.end(buf);
}
function reviewRouter(config={}){
 const enabled=config.enabled!==false;
 const hash=config.passwordHash||"";
 const dir=config.dataDir||"/data/whitelist";
 const sessions=new Map(),failures=new Map();
 const configured=enabled&&hash.split(":").length===4;
 function lookup(req){
  const token=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE+"="))?.slice(COOKIE.length+1)||"";
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const session=sessions.get(token);
  if(!session)return null;
  if(session.expires<Date.now()){sessions.delete(token);return null;}
  return {token,session};
 }
 function requireSession(req,res,mutating=false){
  const entry=lookup(req);
  if(!entry){send(res,401,{error:"Reviewer sign-in required."});return null;}
  if(mutating){
   if(!validOrigin(req)||req.headers["x-csrf-token"]!==entry.session.csrf){send(res,403,{error:"Invalid review request."});return null;}
  }
  return entry;
 }
 const route=async(req,res,url)=>{
  const pathname=url.pathname;
  if(!pathname.startsWith("/api/whitelist-review/"))return false;
  res.setHeader("Cache-Control","private, no-store");
  if(!enabled){send(res,503,{error:"Review is unavailable."});return true;}
  if(pathname==="/api/whitelist-review/session"&&req.method==="GET"){
   const entry=lookup(req);
   send(res,200,{authenticated:Boolean(entry),configured,csrf:entry?.session.csrf||null,expiresAt:entry?.session.expires||null});
   return true;
  }
  if(pathname==="/api/whitelist-review/login"&&req.method==="POST"){
   if(!validOrigin(req)){send(res,403,{error:"Invalid review request."});return true;}
   if(!configured){send(res,503,{error:"Reviewer access is not configured."});return true;}
   const ip=req.socket.remoteAddress||"unknown";
   const now=Date.now();
   const attempts=(failures.get(ip)||[]).filter(t=>now-t<15*60*1000);
   if(attempts.length>=5){send(res,429,{error:"Too many sign-in attempts. Try again later."});return true;}
   let obj;
   try{obj=await parseJson(req,1200);}
   catch{send(res,400,{error:"Invalid sign-in request."});return true;}
   // Only cryptographic key material is configured. No shared admin credentials.
   if(!checkPassword(obj.password,hash)){
    attempts.push(now);failures.set(ip,attempts);
    if(failures.size>500)failures.clear();
    send(res,401,{error:"Incorrect review passphrase."});
    return true;
   }
   failures.delete(ip);
   const token=crypto.randomBytes(32).toString("hex");
   const csrf=crypto.randomBytes(24).toString("hex");
   const expires=Date.now()+SESSION_MS;
   if(sessions.size>=80)sessions.clear();
   sessions.set(token,{csrf,expires});
   res.setHeader("Set-Cookie",COOKIE+"="+token+"; Path=/; Max-Age=14400; Secure; HttpOnly; SameSite=Strict");
   send(res,200,{authenticated:true,csrf,expiresAt:expires});
   return true;
  }
  if(pathname==="/api/whitelist-review/logout"&&req.method==="POST"){
   const entry=requireSession(req,res,true);
   if(!entry)return true;
   sessions.delete(entry.token);
   res.setHeader("Set-Cookie",COOKIE+"=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict");
   send(res,200,{ok:true});return true;
  }
  if(pathname==="/api/whitelist-review/requests"&&req.method==="GET"){
   if(!requireSession(req,res))return true;
   try{
    const all=getEntries(dir);
    const query=(url.searchParams.get("q")||"").trim().toLowerCase().slice(0,80);
    const status=url.searchParams.get("status")||"all";
    const filtered=all.filter(x=>(status==="all"||x.status===status)&&(!query||x.email.toLowerCase().includes(query))).sort((a,b)=>String(b.requestedAt).localeCompare(String(a.requestedAt)));
    const offset=Math.max(0,Math.min(10000,Number(url.searchParams.get("offset"))||0));
    const counts={all:all.length,pending:0,approved:0,rejected:0};
    for(const x of all)counts[x.status]++;
    send(res,200,{items:filtered.slice(offset,offset+100),total:filtered.length,counts,offset,limit:100,notice:"Approved is for outreach review only; it does not create accounts or grant admin access."});
   }catch{send(res,503,{error:"Review data unavailable."});}
   return true;
  }
  if(pathname==="/api/whitelist-review/export"&&req.method==="GET"){
   if(!requireSession(req,res))return true;
   try{
    const csv=makeCsv(getEntries(dir));
    res.setHeader("Content-Disposition",'attachment; filename="pentagon-staging-whitelist.csv"');
    send(res,200,csv,"text/csv; charset=utf-8");
   }catch{send(res,503,{error:"Export unavailable."});}
   return true;
  }
  if(pathname==="/api/whitelist-review/backup"&&req.method==="POST"){
   // Backup is never a public endpoint. Only an authenticated staging reviewer
   // with a same-origin CSRF token can export a snapshot sealed to a client key.
   if(!requireSession(req,res,true))return true;
   let data;
   try{data=await parseJson(req,5500);}
   catch{send(res,400,{error:"Invalid encrypted backup request."});return true;}
   if(data.purpose!=="encrypted-backup"||typeof data.recipientPublicKey!=="string"||
      data.recipientPublicKey.length>4600){
    send(res,422,{error:"A valid backup recipient key is required."});return true;
   }
   try{
    const snap=snapshotFromDirectory(dir);
    const envelope=sealSnapshot(snap,data.recipientPublicKey);
    res.setHeader("Content-Disposition",'attachment; filename="pentagon-staging-whitelist.encrypted.json"');
    res.setHeader("Pragma","no-cache");
    send(res,200,envelope);
   }catch{
    // Never log names, email addresses, the snapshot or the recipient key.
    send(res,503,{error:"Encrypted backup currently unavailable."});
   }
   return true;
  }
  if(pathname==="/api/whitelist-review/decision"&&req.method==="POST"){
   if(!requireSession(req,res,true))return true;
   let data;
   try{data=await parseJson(req);}catch{send(res,400,{error:"Invalid review decision."});return true;}
   const email=typeof data.email==="string"?data.email.trim().toLowerCase():"";
   if(!email||email.length>254||!STATUSES.has(data.status)){
    send(res,422,{error:"Invalid email or decision status."});return true;
   }
   try{const changed=mutate(dir,"decision",email,data.status);send(res,changed?200:404,changed?{ok:true,status:data.status}:{error:"Request not found."});}
   catch{send(res,503,{error:"Review update unavailable."});}
   return true;
  }
  if(pathname==="/api/whitelist-review/delete"&&req.method==="POST"){
   if(!requireSession(req,res,true))return true;
   let data;
   try{data=await parseJson(req);}catch{send(res,400,{error:"Invalid deletion request."});return true;}
   const email=typeof data.email==="string"?data.email.trim().toLowerCase():"";
   if(!email||email.length>254||data.confirm!=="DELETE"){
    send(res,422,{error:"Deletion confirmation is required."});return true;
   }
   try{const changed=mutate(dir,"delete",email);send(res,changed?200:404,changed?{ok:true,deleted:true}:{error:"Request not found."});}
   catch{send(res,503,{error:"Deletion unavailable."});}
   return true;
  }
  if(pathname==="/api/whitelist-review/prune"&&req.method==="POST"){
   if(!requireSession(req,res,true))return true;
   try{
    const rows=getEntries(dir),now=Date.now(),old=now-365*24*3600*1000;
    const filtered=rows.filter(x=>Number.isFinite(Date.parse(x.requestedAt))&&Date.parse(x.requestedAt)>=old);
    persist(dir,filtered);
    addAudit(dir,"retention_prune");
    send(res,200,{ok:true,deleted:rows.length-filtered.length});
   }catch{send(res,503,{error:"Retention cleanup unavailable."});}
   return true;
  }
  send(res,404,{error:"Review path not found."});
  return true;
 };
 return{route};
}
module.exports={reviewRouter,passwordHash,checkPassword,getEntries,makeCsv};
