"use strict";
function createResendSender({apiKey,from,baseUrl="https://pentagon.quest",fetchImpl=fetch}={}){
 if(typeof apiKey!=="string"||apiKey.length<20||!/^[-\w.+]+@(?:[a-z0-9-]+\.)+pentagon\.quest$/i.test(from||"")&&!/^[-\w.+]+@pentagon\.quest$/i.test(from||""))
  throw new Error("EMAIL_DELIVERY_NOT_CONFIGURED");
 const allowed=new URL(baseUrl);
 if(allowed.protocol!=="https:"||allowed.pathname!=="/"||allowed.search||allowed.hash)throw new Error("INVALID_SIGNUP_BASE_URL");
 return async({to,kind,url})=>{
  const u=new URL(url);
  if(u.origin!==allowed.origin||!["/signup/verify/","/signup/complete/"].includes(u.pathname)||
    u.searchParams.size!==1||!u.searchParams.has("code")||
    !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(to||"")||
    !["verify_email","set_password"].includes(kind))throw new Error("INVALID_MAIL_REQUEST");
  const title=kind==="verify_email"?"Verify your merchant email":"Activate your merchant account";
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),10000);
  try{
   const response=await fetchImpl("https://api.resend.com/emails",{
    method:"POST",signal:abort.signal,
    headers:{"Content-Type":"application/json",Authorization:"Bearer "+apiKey},
    body:JSON.stringify({from,to:[to],subject:"Pentagon | "+title,
      text:title+": "+url+"\n\nThe private link expires soon. Ignore if unexpected.",
      html:"<h2>Pentagon</h2><p>"+title+"</p><p><a href=\""+url+"\">Continue securely</a></p><p>Do not share your link.</p>"})
   });
   if(!response.ok)throw new Error("MAIL_PROVIDER_REJECTED");
   return true;
  }catch{throw new Error("EMAIL_DELIVERY_UNAVAILABLE");}
  finally{clearTimeout(timeout);}
 };
}
module.exports={createResendSender};
