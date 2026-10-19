"use strict";
// Owner-operated TRADEVICEPC only. The staging service never receives the
// recipient private key or its local decryption passphrase.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const crypto=require("node:crypto"),cp=require("node:child_process");
const {openSealedBackup}=require("./marketingWhitelistBackup");
const URL_ROOT="https://pentagon-marketing-static-rc1-staging.up.railway.app";
const MAX_BACKUP_RESPONSE_BYTES=12*1024*1024;
const home=process.env.USERPROFILE||os.homedir();
const root=path.join(home,"Pentagon-Secure-Backups");
const keyDir=path.join(root,"Pentagon-Marketing-Whitelist-Backup");
const reviewerDpapi=path.join(root,"pentagon-marketing-review-password.dpapi");
const privatePath=path.join(keyDir,"recipient-private.encrypted.pem");
const publicPath=path.join(keyDir,"recipient-public.pem");
const passPath=path.join(keyDir,"recipient-passphrase.dpapi");
const decryptCmd="$ErrorActionPreference='Stop';$secret=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim());$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secret.Dispose()}";
const encryptCmd="$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();$s=ConvertTo-SecureString -String $p -AsPlainText -Force;try{[Console]::Out.Write(($s|ConvertFrom-SecureString))}finally{$s.Dispose()}";
function ps(command,input){
 const r=cp.spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{input,encoding:"utf8",windowsHide:true,timeout:12000,maxBuffer:65536});
 if(r.error||r.status!==0)throw Error("LOCAL_DPAPI_OPERATION_FAILED");
 return r.stdout.trim();
}
function dpapiDecrypt(cipher){return ps(decryptCmd,cipher);}
function dpapiEncrypt(value){return ps(encryptCmd,value);}
function saveNew(pathname,data){fs.writeFileSync(pathname,data,{encoding:"utf8",flag:"wx",mode:0o600});}
function recipient(){
 fs.mkdirSync(keyDir,{recursive:true,mode:0o700});
 const complete=[privatePath,publicPath,passPath].map(f=>fs.existsSync(f));
 if(complete.some(Boolean)&&!complete.every(Boolean))throw Error("BACKUP_RECIPIENT_INCOMPLETE_DO_NOT_OVERWRITE");
 if(!complete.every(Boolean)){
  const passphrase=crypto.randomBytes(48).toString("base64url");
  const keys=crypto.generateKeyPairSync("rsa",{modulusLength:3072,
   publicKeyEncoding:{format:"pem",type:"spki"},
   privateKeyEncoding:{format:"pem",type:"pkcs8",cipher:"aes-256-cbc",passphrase}});
  const protectedPass=dpapiEncrypt(passphrase);
  saveNew(privatePath,keys.privateKey);
  saveNew(publicPath,keys.publicKey);
  saveNew(passPath,protectedPass+"\n");
  process.stdout.write("BACKUP_RECIPIENT_NEW=ENCRYPTED_PRIVATE_KEY_LOCAL_ONLY\n");
 }
 const passphrase=dpapiDecrypt(fs.readFileSync(passPath,"utf8"));
 const encryptedPrivate=fs.readFileSync(privatePath,"utf8");
 const publicKey=fs.readFileSync(publicPath,"utf8");
 const priv=crypto.createPrivateKey({key:encryptedPrivate,passphrase});
 const publicSpki=crypto.createPublicKey(priv).export({type:"spki",format:"pem"});
 if(publicSpki.trim()!==publicKey.trim())throw Error("RECIPIENT_KEYPAIR_MISMATCH");
 return{publicKey,encryptedPrivate,passphrase};
}
async function http(pathname,options={}){
 return fetch(URL_ROOT+pathname,{redirect:"error",signal:AbortSignal.timeout(17000),...options});
}
async function main(){
 if(process.platform!=="win32")throw Error("WINDOWS_DPAPI_REQUIRED");
 if(!fs.existsSync(reviewerDpapi))throw Error("LOCAL_REVIEWER_PASSWORD_NOT_FOUND");
 const keys=recipient();
 const reviewerPass=dpapiDecrypt(fs.readFileSync(reviewerDpapi,"utf8"));
 const h=await http("/health");
 if(h.status!==200)throw Error("STAGING_HEALTH_NOT_READY");
 const check=await h.json();
 if(check.service!=="pentagon-marketing-rc1"||check.scheduler!=="disabled"||check.database!=="not-connected")
  throw Error("WRONG_RAILWAY_SERVICE");
 const login=await http("/api/whitelist-review/login",{method:"POST",headers:{Origin:URL_ROOT,"content-type":"application/json"},body:JSON.stringify({password:reviewerPass})});
 if(login.status!==200)throw Error("STAGING_REVIEW_LOGIN_FAILED_"+login.status);
 const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
 const data=await login.json();
 if(!cookie.startsWith("__Host-pentagon_review=")||typeof data.csrf!=="string")throw Error("REVIEW_SESSION_INVALID");
 try{
  const res=await http("/api/whitelist-review/backup",{method:"POST",headers:{
   Origin:URL_ROOT,Cookie:cookie,"content-type":"application/json","x-csrf-token":data.csrf
  },body:JSON.stringify({purpose:"encrypted-backup",recipientPublicKey:keys.publicKey})});
  if(res.status!==200)throw Error("BACKUP_ENDPOINT_NOT_READY_"+res.status);
  const raw=await res.text();
  if(raw.length>MAX_BACKUP_RESPONSE_BYTES)throw Error("BACKUP_RESPONSE_TOO_LARGE");
  const envelope=JSON.parse(raw);
  const opened=openSealedBackup(envelope,keys.encryptedPrivate,keys.passphrase);
  // Decrypt/checksums validated IN MEMORY. Never persist plaintext lead data.
  const stamp=new Date().toISOString().replace(/[:.]/g,"-");
  const file=path.join(keyDir,"pentagon-rc1-"+stamp+"-"+crypto.randomBytes(4).toString("hex")+".encrypted.json");
  saveNew(file,JSON.stringify(envelope,null,2)+"\n");
  const stored=fs.readFileSync(file);
  const digest=crypto.createHash("sha256").update(stored).digest("hex");
  process.stdout.write("STAGING_WHITELIST_ENCRYPTED_BACKUP=PASS\n");
  process.stdout.write("ENCRYPTED_FILE="+file+"\n");
  process.stdout.write("ENCRYPTED_BYTES="+stored.length+"\n");
  process.stdout.write("ENCRYPTED_SHA256="+digest+"\n");
  process.stdout.write("SOURCE_REQUEST_COUNT="+opened.counts["requests.jsonl"]+"\n");
  process.stdout.write("SOURCE_REVIEW_EVENT_COUNT="+opened.counts["review-audit.jsonl"]+"\n");
  process.stdout.write("ROUNDTRIP_DECRYPT_CHECKSUM=PASS\n");
  process.stdout.write("PRODUCTION_MODIFIED=NO\n");
 }finally{
  try{await http("/api/whitelist-review/logout",{method:"POST",headers:{Origin:URL_ROOT,Cookie:cookie,"x-csrf-token":data.csrf,"content-type":"application/json"},body:"{}"});}
  catch{/* Staging reviewer session expires automatically in four hours. */}
 }
}
main().catch(e=>{process.stderr.write("STAGING_BACKUP_FAILED="+e.message+"\n");process.exitCode=1});
