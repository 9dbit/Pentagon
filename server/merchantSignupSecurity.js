"use strict";
const crypto=require("node:crypto");
const {promisify}=require("node:util");
const scrypt=promisify(crypto.scrypt);
const WORK=Object.freeze({N:32768,r:8,p:1,maxmem:64*1024*1024});
const EMAIL=/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,63}$/i;
function normalizeEmail(v){if(typeof v!=="string")return null;const x=v.trim().toLowerCase();return x.length<=254&&EMAIL.test(x)?x:null;}
function normalizeCompany(v){if(typeof v!=="string")return null;const x=v.trim().replace(/\s+/g," ");return x.length>=2&&x.length<=120&&!/[<>\r\n]/.test(x)?x:null;}
function validPassword(v){return typeof v==="string"&&v.length>=12&&v.length<=128&&Buffer.byteLength(v,"utf8")<=256&&!/[\x00-\x1f]/.test(v);}
async function hashPassword(v){if(!validPassword(v))throw Object.assign(new Error("INVALID_PASSWORD_POLICY"),{code:"INVALID_PASSWORD_POLICY"});const salt=crypto.randomBytes(24);const hash=await scrypt(v,salt,64,WORK);return "scrypt-v1$"+salt.toString("base64url")+"$"+hash.toString("base64url");}
async function verifyPassword(v,stored){if(!validPassword(v)||typeof stored!=="string")return false;const parts=stored.split("$");if(parts.length!==3||parts[0]!=="scrypt-v1")return false;try{const salt=Buffer.from(parts[1],"base64url"),expected=Buffer.from(parts[2],"base64url");if(salt.length!==24||expected.length!==64)return false;const candidate=await scrypt(v,salt,64,WORK);return crypto.timingSafeEqual(candidate,expected);}catch{return false;}}
function generateOneTimeToken(){return crypto.randomBytes(32).toString("base64url");}
function hashToken(v){return typeof v==="string"&&/^[A-Za-z0-9_-]{43}$/.test(v)?crypto.createHash("sha256").update(v).digest("hex"):null;}
function tenantSlug(company){
 let prefix=String(company||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,38);
 if(!/^[a-z]/.test(prefix)||/^(admin|demo|test|staging|sandbox|sample)(-|$)/.test(prefix))prefix="merchant";
 return prefix+"-"+crypto.randomBytes(8).toString("hex");
}
function checkSameOrigin(origin,host,allowedOrigins=[]){
 if(!origin||!host)return false;
 try{const u=new URL(origin);if(u.origin!==origin||u.username||u.password||u.pathname!=="/")return false;return u.host===host&&allowedOrigins.includes(origin);}catch{return false;}
}
module.exports={normalizeEmail,normalizeCompany,validPassword,hashPassword,verifyPassword,generateOneTimeToken,hashToken,tenantSlug,checkSameOrigin};
