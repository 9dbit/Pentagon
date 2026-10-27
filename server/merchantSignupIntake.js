"use strict";
const express = require("express");
const crypto = require("node:crypto");

function createMerchantSignupIntake(pool, options = {}) {
  const router = express.Router();
  const hits = new Map();
  const enabled = options.enabled ?? (process.env.PENTAGON_MERCHANT_SIGNUP_ENABLED === "true");
  router.post("/", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!enabled) return res.status(503).json({error:"SIGNUP_NOT_ENABLED"});
    // Do not grant any role, create sessions, or accept passwords here.
    const origin = req.get("origin");
    const expected = `${req.protocol}://${req.get("host")}`;
    if (!origin || origin !== expected) return res.status(403).json({error:"INVALID_ORIGIN"});
    const ip = req.ip || "unknown", now = Date.now();
    const prior = (hits.get(ip) || []).filter(t => now - t < 3600000);
    if (prior.length >= 5) return res.status(429).json({error:"RATE_LIMIT"});
    prior.push(now); hits.set(ip, prior);
    if (hits.size > 3000) hits.clear();

    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) return res.status(400).json({error:"INVALID_REQUEST"});
    if (body.websiteCheck) return res.status(202).json({ok:true,status:"pending"});
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const company = typeof body.company === "string" ? body.company.trim() : "";
    if (!/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,63}$/i.test(email) || email.length > 254 ||
        company.length < 2 || company.length > 120 || /[<>\r\n]/.test(company) || body.consent !== true) {
      return res.status(422).json({error:"INVALID_SIGNUP_DETAILS"});
    }
    try {
      // No role, tenant, credentials, or access grant is ever written.
      const fingerprint = crypto.createHash("sha256").update(email).digest("hex");
      await pool.query(
        `INSERT INTO merchant_signup_requests (email, email_fingerprint, company, status, consent_at, source)
         VALUES ($1,$2,$3,'pending',NOW(),'landing')
         ON CONFLICT (email_fingerprint) DO NOTHING`,
        [email, fingerprint, company]
      );
      return res.status(202).json({ok:true,status:"pending"});
    } catch (_) {
      return res.status(503).json({error:"SIGNUP_TEMPORARILY_UNAVAILABLE"});
    }
  });
  return router;
}
module.exports = {createMerchantSignupIntake};
