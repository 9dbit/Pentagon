"use strict";
// Physical private supergroups are created by a separately authorized
// Telegram USER service account via MTProto, never by the Bot API.
// The bridge is disabled until dedicated account credentials are provided.
const {pool}=require("./db");
const {ensureTables:activationTables,bridgeAvailable}=require("./telegramMerchantActivation");
const {ensurePermanentGroupTables,expectedTitle,groupForTenant}=require("./telegramPermanentGroups");
const {isProductionTenant}=require("./customerWhitelistSync");
const LOCK_ID=80826344;
let running=false;
let timer=null;
function safeCode(error){
  return String(error?.code||error?.message||"UNAVAILABLE").replace(/[^a-zA-Z0-9_]/g,"").slice(0,55);
}
async function bridge(action,payload){
  if(!bridgeAvailable())throw Object.assign(new Error("MT_BRIDGE_NOT_CONFIGURED"),
    {code:"MT_BRIDGE_NOT_CONFIGURED"});
  const url=new URL(process.env.PENTAGON_TELEGRAM_MT_BRIDGE_URL);
  if(!/^https:$/.test(url.protocol)&&
    !(url.protocol==="http:"&&url.hostname.endsWith(".railway.internal")))
    throw Object.assign(new Error("BRIDGE_URL_INVALID"),{code:"BRIDGE_URL_INVALID"});
  if(url.username||url.password||url.search||url.hash)
    throw Object.assign(new Error("BRIDGE_URL_INVALID"),{code:"BRIDGE_URL_INVALID"});
  const final=new URL(action,url.href.replace(/\/+$/,"")+"/");
  if(final.origin!==url.origin)throw Error("BRIDGE_ORIGIN_MISMATCH");
  const abort=new AbortController();
  const timeout=setTimeout(()=>abort.abort(),25000);
  try{
    const response=await fetch(final.href,{
      method:"POST",signal:abort.signal,
      headers:{"Content-Type":"application/json","Authorization":
        "Bearer "+process.env.PENTAGON_TELEGRAM_MT_BRIDGE_KEY},
      body:JSON.stringify(payload)
    });
    if(!response.ok)throw Object.assign(new Error("BRIDGE_FAILED"),
      {code:"MT_HTTP_"+response.status});
    return await response.json();
  }finally{clearTimeout(timeout);}
}
function validChatId(id){return /^-100[0-9]{6,18}$/.test(String(id||""));}
async function finalizeConnection(tenant,chatId,db=pool,{tg,opsChatId}={}){
  if(!validChatId(chatId)||String(chatId)===String(opsChatId||""))
    throw Object.assign(new Error("GROUP_ID_INVALID"),{code:"GROUP_ID_INVALID"});
  const [group,me]=await Promise.all([
    tg("getChat",{chat_id:chatId}),tg("getMe",{})
  ]);
  if(group?.type!=="supergroup" || group?.username ||
     String(group?.title||"")!==expectedTitle(tenant))
    throw Object.assign(new Error("GROUP_MISMATCH"),{code:"GROUP_MISMATCH"});
  const member=await tg("getChatMember",{chat_id:chatId,user_id:me.id});
  if(!["administrator","creator"].includes(member?.status) ||
    (member.status==="administrator"&&member.can_invite_users!==true))
    throw Object.assign(new Error("BOT_ADMIN_RIGHTS_MISSING"),{code:"BOT_ADMIN_RIGHTS_MISSING"});
  const tx=await db.connect();
  try{
    await tx.query("BEGIN");
    const {rows:linked}=await tx.query(
      "SELECT tenant,chat_id FROM telegram_merchant_groups WHERE tenant=$1 OR chat_id=$2 FOR UPDATE",
      [tenant,chatId]
    );
    if(linked.some(r=>r.tenant!==tenant||String(r.chat_id)!==chatId))
      throw Object.assign(new Error("GROUP_ALREADY_BOUND"),{code:"GROUP_ALREADY_BOUND"});
    const {rows:connection}=await tx.query(
      "SELECT tenant,chat_id FROM telegram_hub_connections WHERE tenant=$1 FOR UPDATE",
      [tenant]
    );
    if(connection[0]?.chat_id && String(connection[0].chat_id)!==chatId)
      throw Object.assign(new Error("EXISTING_MERCHANT_DESTINATION"),{code:"EXISTING_MERCHANT_DESTINATION"});
    const {rows:activation}=await tx.query(
      "SELECT telegram_user_id,verified_at FROM telegram_merchant_activations WHERE tenant=$1 FOR UPDATE",[tenant]);
    const verified=Boolean(activation[0]?.telegram_user_id&&activation[0]?.verified_at);
    await tx.query("INSERT INTO telegram_merchant_groups(tenant,chat_id,chat_title,provisioned_by) "+
      "VALUES($1,$2,$3,'pentagon-mtproto-service') ON CONFLICT(tenant) DO NOTHING",
      [tenant,chatId,expectedTitle(tenant)]
    );
    // Existing merchant report choices are not reset during provisioning.
    await tx.query(
      "INSERT INTO telegram_hub_connections(tenant,chat_id,telegram_user_id,chat_type,chat_title,"+
      "enabled,status,connected_at,next_report_at) "+
      "VALUES($1,$2,$3,'supergroup',$4,$5,$6,NOW(),NOW()+INTERVAL '60 minutes') "+
      "ON CONFLICT(tenant) DO UPDATE SET chat_id=EXCLUDED.chat_id,"+
      "telegram_user_id=EXCLUDED.telegram_user_id,chat_type='supergroup',"+
      "chat_title=EXCLUDED.chat_title,enabled=EXCLUDED.enabled,status=EXCLUDED.status,"+
      "connected_at=NOW(),next_report_at=NOW()+(telegram_hub_connections.interval_minutes*INTERVAL '1 minute'),updated_at=NOW()",
      [tenant,chatId,activation[0]?.telegram_user_id||null,expectedTitle(tenant),
        verified,verified?"connected":"disconnected"]
    );
    await tx.query(
      "UPDATE telegram_merchant_activations SET group_state='ready',group_error='',"+
      "created_group_chat_id=$2,updated_at=NOW() WHERE tenant=$1",[tenant,chatId]
    );
    await tx.query("COMMIT");
  }catch(e){await tx.query("ROLLBACK").catch(()=>{});throw e;}
  finally{tx.release();}
}
async function inviteVerifiedUser(tenant,db=pool,{tg}={}){
  const {rows}=await db.query(
    "SELECT a.telegram_user_id,g.chat_id FROM telegram_merchant_activations a "+
    "JOIN telegram_merchant_groups g ON g.tenant=a.tenant "+
    "WHERE a.tenant=$1 AND a.verified_at IS NOT NULL AND a.telegram_user_id IS NOT NULL",
    [tenant]
  );
  const row=rows[0];
  if(!row||!tg)return false;
  const invite=await tg("createChatInviteLink",{
    chat_id:row.chat_id,
    name:("Pentagon "+tenant+" owner").slice(0,32),
    member_limit:1,
    expire_date:Math.floor(Date.now()/1000)+600
  });
  if(!/^https:\/\/t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+$/.test(invite?.invite_link||""))
    return false;
  await tg("sendMessage",{chat_id:row.telegram_user_id,
    text:"Pentagon: report group "+expectedTitle(tenant)+" is ready. "+
      "Join using this one-time private invitation (10 minutes): "+invite.invite_link,
    disable_web_page_preview:true
  });
  return true;
}
async function activateAfterIdentity(tenant,db=pool,{tg}={}){
  const group=await groupForTenant(tenant,db);
  if(!group)return false;
  const result=await db.query(
    "UPDATE telegram_hub_connections c SET enabled=TRUE,status='connected',"+
    "telegram_user_id=a.telegram_user_id,connected_at=NOW(),updated_at=NOW() "+
    "FROM telegram_merchant_activations a "+
    "WHERE c.tenant=$1 AND a.tenant=c.tenant "+
    "AND a.verified_at IS NOT NULL AND c.chat_id=$2 RETURNING c.tenant",
    [tenant,group.chat_id]
  );
  if(result.rowCount&&tg)await inviteVerifiedUser(tenant,db,{tg}).catch(()=>{});
  return Boolean(result.rowCount);
}
async function runProvisioning(db=pool,{tg,opsChatId,adapter=bridge}={}){
  if(running)return {status:"already_running"};
  if(!bridgeAvailable()&&adapter===bridge)return {status:"service_account_not_configured"};
  running=true;let client,locked=false;
  try{
    await activationTables(db);await ensurePermanentGroupTables(db);
    client=await db.connect();
    const lock=await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked",[LOCK_ID]);
    if(lock.rows[0]?.locked!==true)return {status:"already_running_elsewhere"};
    locked=true;
    const {rows}=await client.query(
      "SELECT a.tenant,a.created_group_chat_id FROM telegram_merchant_activations a "+
      "LEFT JOIN telegram_merchant_groups g ON g.tenant=a.tenant "+
      "WHERE g.tenant IS NULL AND a.group_state IN ('queued','retry','creating','securing','needs_provisioner') "+
      "AND a.next_provision_at<=NOW() ORDER BY a.created_at LIMIT 1"
    );
    if(!rows.length)return {status:"idle"};
    const target=rows[0];
    if(!isProductionTenant(target.tenant))return {status:"invalid_tenant"};
    const tenant=target.tenant;
    await client.query("UPDATE telegram_merchant_activations SET group_state=$2,"+
      "group_attempts=group_attempts+1,next_provision_at=NOW()+INTERVAL '5 minutes',"+
      "updated_at=NOW() WHERE tenant=$1",[tenant,target.created_group_chat_id?"securing":"creating"]);
    try{
      let chatId=target.created_group_chat_id;
      if(!chatId){
        // Idempotency is enforced by the MTProto bridge, which must check
        // groups owned by its own service account before creating one.
        const created=await adapter("create",{tenant,title:expectedTitle(tenant)});
        chatId=String(created?.chat_id||"");
        if(!validChatId(chatId))throw Object.assign(new Error("CREATED_GROUP_ID_INVALID"),
          {code:"CREATED_GROUP_ID_INVALID"});
        await client.query(
          "UPDATE telegram_merchant_activations SET created_group_chat_id=$2,"+
          "group_state='securing',updated_at=NOW() WHERE tenant=$1",[tenant,chatId]);
      }
      const secured=await adapter("secure",{tenant,chat_id:chatId,title:expectedTitle(tenant)});
      if(secured?.ok!==true)throw Object.assign(new Error("BOT_SECURITY_UNVERIFIED"),
        {code:"BOT_SECURITY_UNVERIFIED"});
      await finalizeConnection(tenant,chatId,db,{tg,opsChatId});
      await inviteVerifiedUser(tenant,db,{tg}).catch(()=>{});
      return {status:"created",tenant};
    }catch(e){
      const code=safeCode(e);
      await client.query(
        "UPDATE telegram_merchant_activations SET group_state='retry',"+
        "group_error=$2,next_provision_at=NOW()+INTERVAL '30 minutes',updated_at=NOW() "+
        "WHERE tenant=$1",[tenant,code]);
      return {status:"retry",tenant,error_code:code};
    }
  }finally{
    if(client){
      if(locked)await client.query("SELECT pg_advisory_unlock($1::bigint)",[LOCK_ID]).catch(()=>{});
      client.release();
    }
    running=false;
  }
}
function startProvisioning({tg,opsChatId}={}){
  if(timer)return;
  const run=()=>runProvisioning(pool,{tg,opsChatId}).catch(e=>{
    console.warn("[Telegram auto groups] worker unavailable",safeCode(e));
  });
  const initial=setTimeout(run,15000);initial.unref?.();
  timer=setInterval(run,60000);timer.unref?.();
}
module.exports={
  runProvisioning,finalizeConnection,activateAfterIdentity,
  inviteVerifiedUser,startProvisioning,bridgeAvailable,validChatId
};
