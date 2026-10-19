"use strict";
// Pentagon Marketing RC1: encrypted, read-only, reviewer-authorized snapshot.
// No cloud upload, cron, admin grants or restoration on the running staging volume.
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const FORMAT="pentagon-whitelist-backup-v1";
const AAD_PREFIX="pentagon-whitelist-backup:v1:";
const FILE_NAMES=Object.freeze(["requests.jsonl","review-audit.jsonl"]);
const MAX_FILE_BYTES=2*1024*1024;
const MAX_TOTAL_BYTES=4*1024*1024;
function sha256(buf){return crypto.createHash("sha256").update(buf).digest("hex");}
function parseJsonLines(bytes,kind){
 const rows=bytes.toString("utf8").split("\n").filter(Boolean);
 if(rows.length>10000)throw Error("BACKUP_TOO_MANY_RECORDS");
 const seen=new Set();
 for(const line of rows){
  let item;
  try{item=JSON.parse(line);}catch{throw Error("BACKUP_INVALID_JSONL");}
  if(!item||typeof item!=="object"||Array.isArray(item))throw Error("BACKUP_INVALID_RECORD");
  if(kind==="requests.jsonl"){
   if(typeof item.email!=="string"||item.email.length>254||!item.email.includes("@")||
      !["pending","approved","rejected"].includes(item.status)||item.consent!==true||
      !Number.isFinite(Date.parse(item.requestedAt)))throw Error("BACKUP_INVALID_REQUEST");
   const email=item.email.toLowerCase();
   if(seen.has(email))throw Error("BACKUP_DUPLICATE_REQUEST");
   seen.add(email);
  }else{
   if(typeof item.at!=="string"||!Number.isFinite(Date.parse(item.at))||
      typeof item.operation!=="string")throw Error("BACKUP_INVALID_AUDIT");
  }
 }
 return rows.length;
}
function readAllowedFile(dir,name){
 if(!FILE_NAMES.includes(name))throw Error("BACKUP_UNEXPECTED_FILE");
 const filename=path.join(dir,name);
 let stat;
 try{stat=fs.lstatSync(filename);}
 catch(e){if(e.code==="ENOENT")return Buffer.alloc(0);throw e;}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE_BYTES)throw Error("BACKUP_FILE_NOT_SAFE");
 const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0);
 const fd=fs.openSync(filename,flags);
 try{
  const fstat=fs.fstatSync(fd);
  if(!fstat.isFile()||fstat.size>MAX_FILE_BYTES)throw Error("BACKUP_FILE_NOT_SAFE");
  const bytes=fs.readFileSync(fd);
  if(bytes.length>MAX_FILE_BYTES)throw Error("BACKUP_FILE_TOO_LARGE");
  return bytes;
 }finally{fs.closeSync(fd);}
}
function snapshotFromDirectory(dir,now=new Date()){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error("BACKUP_DATE_INVALID");
 const data={};
 const counts={};
 let total=0;
 for(const name of FILE_NAMES){
  const bytes=readAllowedFile(dir,name);
  total+=bytes.length;
  if(total>MAX_TOTAL_BYTES)throw Error("BACKUP_TOTAL_TOO_LARGE");
  counts[name]=parseJsonLines(bytes,name);
  data[name]={size:bytes.length,sha256:sha256(bytes),base64:bytes.toString("base64")};
 }
 return {format:FORMAT,createdAt:now.toISOString(),source:"pentagon-marketing-rc1-staging",files:data,counts};
}
function validateSnapshot(snapshot){
 if(!snapshot||snapshot.format!==FORMAT||snapshot.source!=="pentagon-marketing-rc1-staging"||
    !Number.isFinite(Date.parse(snapshot.createdAt))||!snapshot.files)throw Error("BACKUP_MANIFEST_INVALID");
 const decoded={};
 let total=0;
 for(const name of FILE_NAMES){
  const ent=snapshot.files[name];
  if(!ent||typeof ent.base64!=="string"||typeof ent.sha256!=="string"||
     !Number.isSafeInteger(ent.size)||ent.size<0||ent.size>MAX_FILE_BYTES)throw Error("BACKUP_FILE_MANIFEST_INVALID");
  const buf=Buffer.from(ent.base64,"base64");
  if(buf.length!==ent.size||sha256(buf)!==ent.sha256)throw Error("BACKUP_CHECKSUM_MISMATCH");
  total+=buf.length;
  if(total>MAX_TOTAL_BYTES)throw Error("BACKUP_TOTAL_TOO_LARGE");
  const count=parseJsonLines(buf,name);
  if(!snapshot.counts||snapshot.counts[name]!==count)throw Error("BACKUP_RECORD_COUNT_MISMATCH");
  decoded[name]=buf;
 }
 if(Object.keys(snapshot.files).sort().join(",")!==[...FILE_NAMES].sort().join(","))
  throw Error("BACKUP_UNEXPECTED_FILE_MANIFEST");
 return decoded;
}
function parseRecipient(recipientPublicKey){
 if(typeof recipientPublicKey!=="string"||recipientPublicKey.length>4600||
    !recipientPublicKey.includes("-----BEGIN PUBLIC KEY-----"))throw Error("BACKUP_PUBLIC_KEY_INVALID");
 let key;
 try{key=crypto.createPublicKey(recipientPublicKey);}catch{throw Error("BACKUP_PUBLIC_KEY_INVALID");}
 const bits=key.asymmetricKeyDetails?.modulusLength;
 if(key.asymmetricKeyType!=="rsa"||bits<3072||bits>4096)throw Error("BACKUP_RSA_KEY_SIZE_INVALID");
 return key;
}
function sealSnapshot(snapshot,recipientPublicKey){
 validateSnapshot(snapshot);
 const recipient=parseRecipient(recipientPublicKey);
 const key=crypto.randomBytes(32);
 try{
  const nonce=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(Buffer.from(AAD_PREFIX+snapshot.createdAt,"utf8"));
  const plaintext=Buffer.from(JSON.stringify(snapshot),"utf8");
  const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const wrapped=crypto.publicEncrypt({key:recipient,oaepHash:"sha256",padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key);
  return{format:FORMAT,createdAt:snapshot.createdAt,algorithm:"AES-256-GCM+RSA-OAEP-SHA256",
   recipientFingerprint:sha256(Buffer.from(recipient.export({type:"spki",format:"der"}))),
   nonce:nonce.toString("base64"),wrappedKey:wrapped.toString("base64"),
   authTag:cipher.getAuthTag().toString("base64"),ciphertext:encrypted.toString("base64")};
 }finally{key.fill(0);}
}
function openSealedBackup(envelope,privateKey,passphrase){
 if(!envelope||envelope.format!==FORMAT||envelope.algorithm!=="AES-256-GCM+RSA-OAEP-SHA256"||
    !Number.isFinite(Date.parse(envelope.createdAt)))throw Error("BACKUP_ENVELOPE_INVALID");
 for(const [name,min,max] of [["nonce",16,24],["authTag",20,30],["wrappedKey",400,800],["ciphertext",100,MAX_TOTAL_BYTES*3]]){
  if(typeof envelope[name]!=="string"||envelope[name].length<min||envelope[name].length>max)
   throw Error("BACKUP_ENVELOPE_FIELD_INVALID_"+name);
 }
 let priv;
 try{priv=crypto.createPrivateKey(passphrase?{key:privateKey,passphrase}:privateKey);}
 catch{throw Error("BACKUP_PRIVATE_KEY_INVALID");}
 const recipient=crypto.createPublicKey(priv);
 if(sha256(Buffer.from(recipient.export({type:"spki",format:"der"})))!==envelope.recipientFingerprint)
  throw Error("BACKUP_RECIPIENT_MISMATCH");
 let key;
 try{
  key=crypto.privateDecrypt({key:priv,oaepHash:"sha256",padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(envelope.wrappedKey,"base64"));
  if(key.length!==32)throw Error("BACKUP_KEY_INVALID");
  const nonce=Buffer.from(envelope.nonce,"base64");
  const tag=Buffer.from(envelope.authTag,"base64");
  if(nonce.length!==12||tag.length!==16)throw Error("BACKUP_CIPHER_PARAMS_INVALID");
  const cipher=crypto.createDecipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(Buffer.from(AAD_PREFIX+envelope.createdAt,"utf8"));
  cipher.setAuthTag(tag);
  const plain=Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext,"base64")),cipher.final()]);
  const snap=JSON.parse(plain.toString("utf8"));
  if(snap.createdAt!==envelope.createdAt)throw Error("BACKUP_TIMESTAMP_MISMATCH");
  validateSnapshot(snap);
  return snap;
 }finally{if(key)key.fill(0);}
}
function restoreToNewDirectory(snapshot,destination){
 // Restore is STRICTLY offline, to a new directory only. No API for production restore.
 const files=validateSnapshot(snapshot);
 if(fs.existsSync(destination))throw Error("BACKUP_RESTORE_DESTINATION_EXISTS");
 const parent=path.dirname(destination);
 if(!fs.existsSync(parent))throw Error("BACKUP_RESTORE_PARENT_MISSING");
 const staging=path.join(parent,".pentagon-recovery-"+crypto.randomBytes(9).toString("hex"));
 try{
  fs.mkdirSync(staging,{mode:0o700});
  for(const name of FILE_NAMES){
   const fd=fs.openSync(path.join(staging,name),"wx",0o600);
   try{fs.writeFileSync(fd,files[name]);fs.fsyncSync(fd);}
   finally{fs.closeSync(fd);}
  }
  fs.renameSync(staging,destination);
  return{directory:destination,count:snapshot.counts};
 }finally{if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});}
}
module.exports={FORMAT,FILE_NAMES,snapshotFromDirectory,validateSnapshot,sealSnapshot,openSealedBackup,restoreToNewDirectory};
