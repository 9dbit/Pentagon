"use strict";

const dns = require("node:dns").promises;
const https = require("node:https");
const axios = require("axios");

// Never probe a tenant-supplied IP or redirect target. Use only the already-
// registered domain, resolve publicly-routable IPv4 and pin DNS for the socket.
function publicIpv4(ip) {
  if (typeof ip !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
  const octets=ip.split(".").map(Number);
  if (octets.some(n=>n<0||n>255)) return false;
  const [a,b,c]=octets;
  if (a===0||a===10||a===127||a>=224) return false;
  if (a===100&&b>=64&&b<=127) return false;
  if (a===169&&b===254) return false;
  if (a===172&&b>=16&&b<=31) return false;
  if (a===192&&(b===168||b===0||b===88&&c===99)) return false;
  if (a===198&&(b===18||b===19||b===51&&c===100)) return false;
  if (a===203&&b===0&&c===113) return false;
  if (a===255) return false;
  return true;
}

async function checkDirectOwnedDomain(domain) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
      domain.length>253) throw Object.assign(new Error("INVALID_DOMAIN"),{status:400});
  const started=Date.now();
  let ips;
  try {ips=await dns.resolve4(domain,{ttl:false});}
  catch(e){
    return {checker_type:"direct",provider_name:"Direct",status:"warning",http_status:null,
      latency_ms:Date.now()-started,reason:"DNS_UNAVAILABLE"};
  }
  if (!Array.isArray(ips)||!ips.length||ips.some(ip=>!publicIpv4(ip))){
    throw Object.assign(new Error("DIRECT_TARGET_NOT_PUBLIC"),{status:422});
  }
  // Only one validated address is used. Redirects are forbidden to prevent
  // internal-network or alternate-host requests through a registered domain.
  const ip=ips[0];
  const agent=new https.Agent({
    keepAlive:false,
    lookup:(_hostname,_options,callback)=>callback(null,ip,4)
  });
  try{
    const response=await axios.head("https://"+domain+"/",{
      httpsAgent:agent,proxy:false,maxRedirects:0,timeout:12000,
      maxContentLength:0,validateStatus:()=>true,
      headers:{"User-Agent":"PentagonMerchantDirectChecker/1.0"}
    });
    const statusCode=response.status;
    const status=statusCode>=200&&statusCode<400?"working":"warning";
    return {checker_type:"direct",provider_name:"Direct",status,http_status:statusCode,
      latency_ms:Date.now()-started,reason:status==="working"?"HTTP_REACHABLE":"HTTP_RESPONSE_"+statusCode};
  }catch(e){
    return {checker_type:"direct",provider_name:"Direct",status:"warning",
      http_status:e.response?.status||null,latency_ms:Date.now()-started,
      reason:"DIRECT_UNAVAILABLE"};
  }finally{agent.destroy();}
}

module.exports={publicIpv4,checkDirectOwnedDomain};
