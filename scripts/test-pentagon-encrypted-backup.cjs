#!/usr/bin/env node
"use strict";
// CI rehearsal: fake .example.test leads only; never load or restore a staging volume.
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createServer}=require("../server/marketingPreviewServer");
const {passwordHash}=require("../server/marketingWhitelistReview");
const backup=require("../server/marketingWhitelistBackup");
let count=0;
const check=(name,fn)=>{try{fn();count++;}catch(e){throw Error("BACKUP_REHEARSAL_"+name+": "+e.message)}};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"pentagon-marketing-backup-test-"));
const liveDir=path.join(temp,"fake-source");fs.mkdirSync(liveDir,{mode:0o700});
const requests=[
{email:"example-a@example.test",requestedAt:"2026-10-19T08:00:00.000Z",consent:true,status:"pending",source:"rc1"},
{email:"example-b@example.test",requestedAt:"2026-10-19T09:00:00.000Z",consent:true,status:"approved",reviewedAt:"2026-10-19T10:00:00.000Z",reviewSource:"manual"}
];
const audit=[{at:"2026-10-19T10:00:00.000Z",operation:"decision_approved",source:"pentagon-staging-whitelist-review"}];
const encodedReq=requests.map(x=>JSON.stringify(x)).join("\n")+"\n";
const encodedAudit=audit.map(x=>JSON.stringify(x)).join("\n")+"\n";
fs.writeFileSync(path.join(liveDir,"requests.jsonl"),encodedReq,{mode:0o600});
fs.writeFileSync(path.join(liveDir,"review-audit.jsonl"),encodedAudit,{mode:0o600});
const keypair=crypto.generateKeyPairSync("rsa",{modulusLength:3072,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem",cipher:"aes-256-cbc",passphrase:"unit-test-secret-only"}});
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const checksum=()=>backup.FILE_NAMES.map(n=>sha(fs.readFileSync(path.join(liveDir,n)))).join(":");
async function request(base,pathname,method="GET",body=null,headers={}){
 const init={method,headers:{...(body!==null?{"content-type":"application/json"}:{}),...headers}};
 if(body!==null)init.body=JSON.stringify(body);
 const res=await fetch(base+pathname,init);
 return{status:res.status,body:await res.text(),headers:res.headers};
}
(async()=>{
 try{
  const snapshot=backup.snapshotFromDirectory(liveDir,new Date("2026-10-19T11:00:00Z"));
  check("snapshot counts",()=>assert.deepEqual(snapshot.counts,{"requests.jsonl":2,"review-audit.jsonl":1}));
  const snapBuffers=backup.validateSnapshot(snapshot);
  check("source bytes unchanged",()=>{assert.equal(snapBuffers["requests.jsonl"].toString(),encodedReq);assert.equal(snapBuffers["review-audit.jsonl"].toString(),encodedAudit);});
  const originalHash=checksum();
  const envelope=backup.sealSnapshot(snapshot,keypair.publicKey);
  check("archive never leaks PII in plaintext",()=>{const json=JSON.stringify(envelope);assert.doesNotMatch(json,/example-a@example\.test|example-b@example\.test|decision_approved/);assert.equal(envelope.format,"pentagon-whitelist-backup-v1");});
  check("encrypted envelope has secure crypto markers",()=>{assert.equal(envelope.algorithm,"AES-256-GCM+RSA-OAEP-SHA256");assert.ok(envelope.recipientFingerprint.length===64);});
  const opened=backup.openSealedBackup(envelope,keypair.privateKey,"unit-test-secret-only");
  check("in-memory decrypt restores manifest",()=>{assert.deepEqual(opened,snapshot);assert.equal(checksum(),originalHash);});
  const target=path.join(temp,"isolated-restore");
  backup.restoreToNewDirectory(opened,target);
  check("offline recovered files byte exact",()=>{for(const n of backup.FILE_NAMES)assert.deepEqual(fs.readFileSync(path.join(target,n)),fs.readFileSync(path.join(liveDir,n)));});
  check("restore refuses to overwrite",()=>assert.throws(()=>backup.restoreToNewDirectory(opened,target),/DESTINATION_EXISTS/));
  check("wrong decryption key denied",()=>assert.throws(()=>backup.openSealedBackup(envelope,keypair.privateKey,"incorrect"),/PRIVATE_KEY_INVALID/));
  const tampered={...envelope,ciphertext:Buffer.from(envelope.ciphertext,"base64").map((v,i)=>i===3?v^1:v).toString("base64")};
  check("AEAD tampering detected",()=>assert.throws(()=>backup.openSealedBackup(tampered,keypair.privateKey,"unit-test-secret-only")));
  const changedStamp={...envelope,createdAt:"2026-10-19T11:01:00.000Z"};
  check("time header bound to ciphertext",()=>assert.throws(()=>backup.openSealedBackup(changedStamp,keypair.privateKey,"unit-test-secret-only")));
  const altered={...snapshot,files:{...snapshot.files,"requests.jsonl":{...snapshot.files["requests.jsonl"],sha256:"0".repeat(64)}}};
  check("file digest tampering detected",()=>assert.throws(()=>backup.validateSnapshot(altered),/CHECKSUM_MISMATCH/));
  check("recipient RSA key size enforced",()=>{
   const small=crypto.generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
   assert.throws(()=>backup.sealSnapshot(snapshot,small.publicKey),/RSA_KEY_SIZE_INVALID/);
  });
  const wrongDir=path.join(temp,"invalid");
  fs.mkdirSync(wrongDir);
  fs.writeFileSync(path.join(wrongDir,"requests.jsonl"),"invalid-json\n");
  check("invalid source rows fail closed",()=>assert.throws(()=>backup.snapshotFromDirectory(wrongDir),/INVALID_JSONL/));
  if(process.platform!=="win32"){
   const symlinkDir=path.join(temp,"symlink-source");fs.mkdirSync(symlinkDir);
   fs.symlinkSync(path.join(liveDir,"requests.jsonl"),path.join(symlinkDir,"requests.jsonl"));
   check("symlinked source refused",()=>assert.throws(()=>backup.snapshotFromDirectory(symlinkDir),/FILE_NOT_SAFE/));
  }
  const hash=passwordHash("test-only-reviewer-password-with-adequate-length");
  const server=createServer({whitelistEnabled:true,whitelistDataDir:liveDir,reviewEnabled:true,reviewPasswordHash:hash});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  try{
   const unauthorized=await request(base,"/api/whitelist-review/backup","POST",{purpose:"encrypted-backup",recipientPublicKey:keypair.publicKey},{origin:base});
   check("anonymous export forbidden",()=>assert.equal(unauthorized.status,401));
   const login=await request(base,"/api/whitelist-review/login","POST",{password:"test-only-reviewer-password-with-adequate-length"},{origin:base});
   const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
   const session=JSON.parse(login.body);
   check("authenticated reviewer session",()=>{assert.equal(login.status,200);assert.ok(session.csrf);assert.ok(cookie.startsWith("__Host-pentagon_review="));});
   const unauthToken=await request(base,"/api/whitelist-review/backup","POST",{purpose:"encrypted-backup",recipientPublicKey:keypair.publicKey},{origin:base,cookie});
   check("CSRF required",()=>assert.equal(unauthToken.status,403));
   const cross=await request(base,"/api/whitelist-review/backup","POST",{purpose:"encrypted-backup",recipientPublicKey:keypair.publicKey},{origin:"https://example.invalid",cookie,"x-csrf-token":session.csrf});
   check("origin mismatch denied",()=>assert.equal(cross.status,403));
   const invalidPub=await request(base,"/api/whitelist-review/backup","POST",{purpose:"encrypted-backup",recipientPublicKey:"not-a-pem"},{origin:base,cookie,"x-csrf-token":session.csrf});
   check("bad recipient fails closed",()=>assert.ok([422,503].includes(invalidPub.status)));
   const real=await request(base,"/api/whitelist-review/backup","POST",{purpose:"encrypted-backup",recipientPublicKey:keypair.publicKey},{origin:base,cookie,"x-csrf-token":session.csrf});
   check("encrypted authenticated export",()=>{assert.equal(real.status,200);assert.match(real.headers.get("content-disposition")||"",/attachment/);assert.doesNotMatch(real.body,/example-a@example\.test/);});
   const restored=backup.openSealedBackup(JSON.parse(real.body),keypair.privateKey,"unit-test-secret-only");
   check("HTTP backup content parity",()=>{assert.equal(restored.counts["requests.jsonl"],2);assert.equal(restored.counts["review-audit.jsonl"],1);assert.equal(checksum(),originalHash);});
   const nonPost=await request(base,"/api/whitelist-review/backup","GET",null,{cookie});
   check("GET backup denied",()=>assert.equal(nonPost.status,404));
   const appApi=await request(base,"/api/auth/me");
   check("production auth cannot leak",()=>assert.equal(appApi.status,404));
  }finally{await new Promise(resolve=>server.close(resolve));}
  console.log("PENTAGON_ENCRYPTED_BACKUP_REHEARSAL_PASS="+count);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error("PENTAGON_ENCRYPTED_BACKUP_TEST_FAILED="+e.message);process.exitCode=1});
