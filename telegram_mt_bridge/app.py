"""Private MTProto provisioner for Pentagon.

This service MUST run as a separate, non-public Railway service with a
dedicated, consensually authorized Telegram USER account (not a bot).
Never put its StringSession in a frontend bundle, repository, log or chat.
"""
import asyncio
import os
import secrets
import re

from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from telethon import TelegramClient, functions, types, utils
from telethon.sessions import StringSession
from telethon.errors import UserAlreadyParticipantError

app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
lock = asyncio.Lock()
client = None

def valid_title(tenant, title):
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", tenant):
        return False
    return title == f"PENTAGON | {tenant.upper()} | REPORTS"

def authorized(auth):
    key = os.getenv("PENTAGON_TELEGRAM_MT_BRIDGE_KEY", "")
    if not key or not auth or not auth.startswith("Bearer "):
        raise HTTPException(403, "unauthorized")
    if not secrets.compare_digest(auth[7:], key):
        raise HTTPException(403, "unauthorized")

async def get_client():
    global client
    if client is None:
        api_id = os.getenv("TELEGRAM_API_ID", "")
        api_hash = os.getenv("TELEGRAM_API_HASH", "")
        session = os.getenv("TELEGRAM_MT_USER_SESSION", "")
        if not api_id.isdecimal() or not api_hash or not session:
            raise HTTPException(503, "telegram_user_session_not_configured")
        client = TelegramClient(StringSession(session), int(api_id), api_hash)
        await client.connect()
        if not await client.is_user_authorized():
            await client.disconnect()
            client = None
            raise HTTPException(503, "telegram_user_session_not_authorized")
        me = await client.get_me()
        if me.bot:
            await client.disconnect()
            client = None
            raise HTTPException(503, "telegram_user_account_required")
    return client

class CreateRequest(BaseModel):
    tenant: str
    title: str

class SecureRequest(CreateRequest):
    chat_id: str

async def owned_group(c, title):
    """Recover after a lost HTTP response to prevent accidental duplicates."""
    async for dialog in c.iter_dialogs(limit=500):
        e = dialog.entity
        if (getattr(e, "megagroup", False) and
            getattr(e, "creator", False) and
            getattr(e, "title", "") == title):
            return e
    return None

@app.get("/health")
async def health():
    return {"ok": True, "configured": bool(os.getenv("TELEGRAM_MT_USER_SESSION"))}

@app.post("/create")
async def create(req: CreateRequest, authorization: str = Header(default="")):
    authorized(authorization)
    if not valid_title(req.tenant, req.title):
        raise HTTPException(400, "invalid_group_title")
    async with lock:
        c = await get_client()
        group = await owned_group(c, req.title)
        if group is None:
            try:
                result = await c(functions.channels.CreateChannelRequest(
                    title=req.title,
                    about="Private, automated Pentagon reporting group for tenant " + req.tenant,
                    megagroup=True
                ))
                group = next((chat for chat in result.chats
                    if getattr(chat, "megagroup", False)), None)
            except Exception:
                raise HTTPException(503, "mtproto_group_creation_unavailable")
        if group is None:
            raise HTTPException(503, "group_not_created")
        return {"chat_id": str(utils.get_peer_id(group)), "status": "created"}

@app.post("/secure")
async def secure(req: SecureRequest, authorization: str = Header(default="")):
    authorized(authorization)
    if not valid_title(req.tenant, req.title):
        raise HTTPException(400, "invalid_group_title")
    if not re.fullmatch(r"-100[0-9]{6,18}", req.chat_id):
        raise HTTPException(400, "invalid_chat_id")
    async with lock:
        c = await get_client()
        try:
            channel = await c.get_entity(int(req.chat_id))
            if (not getattr(channel, "megagroup", False) or
                not getattr(channel, "creator", False) or
                getattr(channel, "username", None) or
                channel.title != req.title):
                raise HTTPException(409, "group_identity_mismatch")
            bot_name = os.getenv("PENTAGON_TELEGRAM_BOT_USERNAME", "DomainRadarAi_Bot")
            bot = await c.get_entity(bot_name)
            if not getattr(bot, "bot", False):
                raise HTTPException(409, "reporting_bot_identity_invalid")
            try:
                await c(functions.channels.InviteToChannelRequest(channel=channel, users=[bot]))
            except UserAlreadyParticipantError:
                pass
            # Require only the privileges needed for report delivery and
            # one-time, expiring invitations. No admin promotion rights.
            rights = types.ChatAdminRights(
                change_info=False, post_messages=False, edit_messages=False,
                delete_messages=False, ban_users=False, invite_users=True,
                pin_messages=False, add_admins=False, anonymous=False,
                manage_call=False, other=True, manage_topics=False)
            await c(functions.channels.EditAdminRequest(
                channel=channel, user_id=bot, admin_rights=rights, rank="Pentagon Report"))
            return {"ok": True, "chat_id": req.chat_id}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "mtproto_bot_administration_unavailable")
