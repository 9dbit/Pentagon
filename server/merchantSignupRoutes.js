"use strict";
const {checkSameOrigin}=require("./merchantSignupSecurity");
function createMerchantSignupRoutes(express,lifecycle,{enabled=false,baseUrl="https://pentagon.quest"}={}){
 const publicRouter=express.Router(),adminRouter=express.Router();
 const allowed=[new URL(baseUrl).origin,"https://pentagon.quest","https://www.pentagon.quest"];
 function sendError(res,e){
  const code=String(e?.code||"UNAVAILABLE");
  const statuses={INVALID_SIGNUP_DETAILS:422,INVALID_PASSWORD_POLICY:422,
    INVALID_OR_EXPIRED_LINK:400,APPLICATION_NOT_PENDING:409,
    APPLICATION_NOT_APPROVED:409,APPLICATION_NOT_REVIEWABLE:409,
    TOO_MANY_REQUESTS:429};
  const status=statuses[code]||503;
  return res.status(status).json({error:statuses[code]?code:"SIGNUP_TEMPORARILY_UNAVAILABLE"});
 }
 const guard=(fn,{admin=false,safeGet=false}={})=>async(req,res)=>{
  res.set("Cache-Control","no-store");res.set("X-Content-Type-Options","nosniff");
  if(!enabled||!lifecycle)return res.status(503).json({error:"SIGNUP_NOT_ENABLED"});
  if(admin && (req.session?.isAdmin!==true||req.session?.isDemo===true||req.session?.isCustomerViewer===true))
   return res.status(403).json({error:"SUPER_ADMIN_ONLY"});
  const origin=req.get("origin");
  if(origin || !safeGet){
   if(!checkSameOrigin(origin,req.get("host"),allowed))
    return res.status(403).json({error:"INVALID_ORIGIN"});
  }
  if(Number(req.get("content-length")||0)>8192)return res.status(413).json({error:"BODY_TOO_LARGE"});
  try{return await fn(req,res);}catch(e){return sendError(res,e);}
 };
 publicRouter.post("/",guard(async(req,res)=>{
  const b=req.body||{};
  return res.status(202).json(await lifecycle.start({email:b.email,company:b.company,
   consent:b.consent,ip:req.ip,honeypot:b.websiteCheck}));
 }));
 publicRouter.post("/verify-email",guard(async(req,res)=>
  res.json(await lifecycle.verifyEmail(req.body?.token))));
 publicRouter.post("/complete",guard(async(req,res)=>{
  const outcome=await lifecycle.complete({token:req.body?.token,password:req.body?.password});
  return res.status(201).json({ok:true,status:outcome.status});
 }));
 adminRouter.get("/pending",guard(async(req,res)=>res.json({applications:await lifecycle.listReview()}),{admin:true,safeGet:true}));
 adminRouter.post("/approve",guard(async(req,res)=>{
  const id=Number(req.body?.requestId);
  if(!Number.isSafeInteger(id)||id<=0)return res.status(422).json({error:"INVALID_REQUEST"});
  return res.json(await lifecycle.approve({requestId:id,reviewerId:req.session.adminEmail||"super-admin"}));
 },{admin:true}));
 adminRouter.post("/reissue",guard(async(req,res)=>{
  const id=Number(req.body?.requestId);
  if(!Number.isSafeInteger(id)||id<=0)return res.status(422).json({error:"INVALID_REQUEST"});
  return res.json(await lifecycle.reissue({requestId:id,reviewerId:req.session.adminEmail||"super-admin"}));
 },{admin:true}));
 return {publicRouter,adminRouter};
}
function createMerchantAccountHydrator(lifecycle){
 return async(req,res,next)=>{
  if(!req.session?.merchantAccountId)return next();
  try{
   const a=await lifecycle.validateSession(req.session.merchantAccountId);
   if(!a||req.session.tenant!==a.tenant||req.session.adminEmail!==a.email||
      req.session.isAdmin!==false||req.session.isDemo!==false||
      req.session.isCustomerViewer!==true){
    return req.session.destroy(()=>{res.clearCookie("domain_radar_sid",{path:"/"});res.status(401).json({error:"SESSION_REVOKED"});});
   }
   req.pentagonMerchantGrant=a;
   return next();
  }catch{return res.status(503).json({error:"AUTH_BACKEND_UNAVAILABLE"});}
 };
}
module.exports={createMerchantSignupRoutes,createMerchantAccountHydrator};
