const axios = require("axios");
const { getRuntimeSettings } = require("./runtimeSettings");
const { pool } = require("./db");

const TELEGRAM_MAX_MESSAGE_LENGTH = Number(process.env.TELEGRAM_MAX_MESSAGE_LENGTH || 3900);

function getTelegramConfig() {
  const settings = getRuntimeSettings();
  return {
    token: settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN,
    chatId: settings.telegram_chat_id || process.env.TELEGRAM_CHAT_ID
  };
}

// Closes any HTML tags left open by a hard truncation cut, so Telegram's
// HTML parser doesn't reject the whole message over one dangling <pre>/<b>/<i>.
function closeUnbalancedTags(text) {
  const tagRegex = /<(\/?)([a-zA-Z]+)[^>]*>/g;
  const stack = [];
  let match;
  while ((match = tagRegex.exec(text))) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (!closing) {
      stack.push(tag);
    } else {
      const idx = stack.lastIndexOf(tag);
      if (idx !== -1) stack.splice(idx, 1);
    }
  }
  let result = text;
  for (let i = stack.length - 1; i >= 0; i--) {
    result += `</${stack[i]}>`;
  }
  return result;
}

// Last-resort safety net: hard-caps any outgoing Telegram message so a
// message that grew past Telegram's 4096-char limit still gets delivered
// (trimmed) instead of failing outright with "message is too long".
function capMessageLength(message, maxLen = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const text = String(message ?? "");
  if (text.length <= maxLen) return text;

  const notice = "\n\n⚠️ <i>Pesan dipotong karena melebihi batas panjang Telegram.</i>";
  const budget = Math.max(0, maxLen - notice.length);
  let cut = text.slice(0, budget);

  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > budget * 0.5) {
    cut = cut.slice(0, lastNewline);
  }

  cut = closeUnbalancedTags(cut);
  return `${cut}${notice}`;
}

async function sendTelegram(message, extra = {}) {
  const { token, chatId } = getTelegramConfig();
  if (!token || !chatId) return false;

  const text = capMessageLength(message);
  if (text.length !== String(message ?? "").length) {
    console.warn(`[Telegram] message truncated from ${String(message ?? "").length} to ${text.length} chars`);
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    });
    return true;
  } catch (err) {
    console.error("Telegram error:", err.response?.data || err.message);
    return false;
  }
}

async function answerCallbackQuery(callbackQueryId, text = "Noted") {
  const { token } = getTelegramConfig();
  if (!token || !callbackQueryId) return false;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    });
    return true;
  } catch (err) {
    console.error("Telegram callback answer error:", err.response?.data || err.message);
    return false;
  }
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup = null) {
  const { token } = getTelegramConfig();
  if (!token || !chatId || !messageId) return false;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup
    });
    return true;
  } catch (err) {
    console.error("Telegram edit markup error:", err.response?.data || err.message);
    return false;
  }
}

async function sendTelegramToProject(projectName, message, extra = {}) {
  const { token } = getTelegramConfig();
  if (!token) return false;
  let chatId = null;
  try {
    const { rows } = await pool.query(
      "SELECT telegram_chat_id FROM project_telegram_groups WHERE project_name=$1",
      [projectName || ""]
    );
    if (rows[0]) chatId = rows[0].telegram_chat_id;
  } catch (_) {}
  if (!chatId) return sendTelegram(message, extra);

  const text = capMessageLength(message);
  if (text.length !== String(message ?? "").length) {
    console.warn(`[Telegram] project message truncated from ${String(message ?? "").length} to ${text.length} chars`);
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    });
    return true;
  } catch (err) {
    console.error("Telegram error:", err.response?.data || err.message);
    return false;
  }
}

module.exports = { sendTelegram, sendTelegramToProject, answerCallbackQuery, editMessageReplyMarkup, getTelegramConfig };
