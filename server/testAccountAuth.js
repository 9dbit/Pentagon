"use strict";

const { scryptSync, timingSafeEqual } = require("node:crypto");
const { normalizeEmail } = require("./authAllowlist");

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const MAX_USERS = 12;
const MAX_CONFIG_BYTES = 16384;

function readTestUsers(raw = process.env.PENTAGON_TEST_USERS_JSON || "") {
  if (typeof raw !== "string" || !raw.trim()) return [];
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_USERS) return [];
    const seen = new Set();
    const users = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      // Only a hashed credential and an explicitly scoped demo role are permitted.
      if (item.role !== "demo" || "password" in item || "passwordHash" in item) return [];
      const email = normalizeEmail(item.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || seen.has(email)) return [];
      if (!/^[0-9a-f]{32}$/i.test(item.saltHex || "") ||
          !/^[0-9a-f]{128}$/i.test(item.hashHex || "")) return [];
      seen.add(email);
      users.push({ email, salt: Buffer.from(item.saltHex, "hex"), hash: Buffer.from(item.hashHex, "hex") });
    }
    return users;
  } catch (_) {
    // Fail closed and do not log credentials, email addresses, hashes or raw env.
    return [];
  }
}

function verifyTestUser(email, password, raw) {
  const userEmail = normalizeEmail(email);
  if (!userEmail || typeof password !== "string" || !password || password.length > 256) return null;
  const account = readTestUsers(raw).find(user => user.email === userEmail);
  if (!account) return null;
  try {
    const candidate = scryptSync(Buffer.from(password, "utf8"), account.salt, account.hash.length, SCRYPT);
    if (timingSafeEqual(candidate, account.hash)) return { email: account.email, tenant: "demo", isDemo: true };
  } catch (_) {
    // Invalid or resource-exhausting credentials must never be accepted.
  }
  return null;
}

module.exports = { readTestUsers, verifyTestUser };
