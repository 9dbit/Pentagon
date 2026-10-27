"use strict";

// Telegram display name is independent from the immutable @bot_username.
// This affects only bot branding, never group IDs, merchant tenant identity,
// webhook routing, bot permissions, report preferences or existing messages.
const DISPLAY_NAME="Pentagon";
const LANGUAGES=["","id","en"];

async function ensureTelegramBotBrand(tgCall) {
  if(typeof tgCall!=="function")throw Object.assign(new Error("TELEGRAM_CALL_MISSING"),{code:"TELEGRAM_CALL_MISSING"});
  let updated=0;
  for(const language_code of LANGUAGES){
    const params={language_code};
    const before=await tgCall("getMyName",params);
    if(String(before?.name||"")===DISPLAY_NAME)continue;
    const ok=await tgCall("setMyName",{name:DISPLAY_NAME,language_code});
    if(ok!==true)throw Object.assign(new Error("TELEGRAM_BOT_NAME_UPDATE_REJECTED"),{code:"TELEGRAM_BOT_NAME_UPDATE_REJECTED"});
    const after=await tgCall("getMyName",params);
    if(String(after?.name||"")!==DISPLAY_NAME)
      throw Object.assign(new Error("TELEGRAM_BOT_NAME_VERIFICATION_FAILED"),{code:"TELEGRAM_BOT_NAME_VERIFICATION_FAILED"});
    updated++;
  }
  return {name:DISPLAY_NAME,updated,verified:LANGUAGES.length};
}

module.exports={ensureTelegramBotBrand,DISPLAY_NAME};
