"use strict";
// Offline-only decrypt/verification helper. Never connects to Railway or
// replaces a live volume. By default performs an in-memory validation.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto"),cp=require("node:child_process");
const {openSealedBackup,restoreToNewDirectory}=require("./marketingWhitelistBackup");
const root=path.join(process.env.USERPROFILE||os.homedir(),"Pentagon-Secure-Backups","Pentagon-Marketing-Whitelist-Backup");
const privatePath=path.join(root,"recipient-private.encrypted.pem");
const passPath=path.join(root,"recipient-passphrase.dpapi");
const decryptCmd="$ErrorActionPreference='Stop';$secret=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim());$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secret.Dispose()}";
function decryptSecret(cipher){
 const r=cp.spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",decryptCmd],{input:cipher,encoding:"utf8",windowsHide:true,timeout:12000,maxBuffer:65536});
 if(r.error||r.status!==0)throw Error("LOCAL_DPAPI_RECOVERY_UNAVAILABLE");
 return r.stdout.trim();
}
function ensureUnder(dir,ancestor){
 const rel=path.relative(ancestor,dir);
 return rel&&!rel.startsWith("..")&&!path.isAbsolute(rel);
}
function main(){
 if(process.platform!=="win32")throw Error("OFFLINE_WINDOWS_RECOVERY_ONLY");
 const args=process.argv.slice(2);
 const archive=args[0]?path.resolve(args[0]):null;
 if(!archive||!fs.existsSync(archive)||!archive.endsWith(".encrypted.json"))throw Error("ENCRYPTED_ARCHIVE_FILE_REQUIRED");
 if(!ensureUnder(archive,root))throw Error("ONLY_OWNED_STAGING_BACKUP_ARCHIVES_ACCEPTED");
 const raw=fs.readFileSync(archive);
 if(raw.length>12*1024*1024)throw Error("ARCHIVE_TOO_LARGE");
 const envelope=JSON.parse(raw.toString("utf8"));
 const priv=fs.readFileSync(privatePath,"utf8");
 const pass=decryptSecret(fs.readFileSync(passPath,"utf8"));
 const snapshot=openSealedBackup(envelope,priv,pass);
 process.stdout.write("OFFLINE_ENCRYPTED_BACKUP_VERIFY=PASS\n");
 process.stdout.write("ARCHIVE_SHA256="+crypto.createHash("sha256").update(raw).digest("hex")+"\n");
 process.stdout.write("REQUEST_COUNT="+snapshot.counts["requests.jsonl"]+"\n");
 process.stdout.write("AUDIT_EVENT_COUNT="+snapshot.counts["review-audit.jsonl"]+"\n");
 if(args[1]==="--restore-offline"){
  // Requires explicit opt-in and a NEW user-owned recovery path. Never use on
  // Railway, the live source folder or an existing destination.
  const requested=args[2]?path.resolve(args[2]):null;
  const allowedRoot=path.join(root,"Offline-Recovery");
  if(!requested||!ensureUnder(requested,allowedRoot))throw Error("OFFLINE_RECOVERY_DESTINATION_MUST_BE_NEW_SUBDIRECTORY");
  fs.mkdirSync(allowedRoot,{recursive:true,mode:0o700});
  const result=restoreToNewDirectory(snapshot,requested);
  process.stdout.write("OFFLINE_ONLY_RESTORE=PASS\n");
  process.stdout.write("LOCAL_RECOVERY_DIRECTORY="+result.directory+"\n");
  process.stdout.write("WARNING=RECOVERED_PLAINTEXT_PERSONAL_DATA_PROTECT_AND_REMOVE_WHEN_FINISHED\n");
 }
}
try{main();}catch(e){process.stderr.write("OFFLINE_BACKUP_VERIFY_FAILED="+e.message+"\n");process.exitCode=1;}
