"use strict";

const { normalizeEmail } = require("./authAllowlist");

// Explicit server-owned authorization mapping, separate from the existing
// salted password-hash list. Never inferred from URL, body, user metadata
// or a demo tenant's project names.
const MAX_BYTES = 8192;
const MAX_VIEWERS = 24;
const VIEWER_PATHS = new Set([
  "GET /api/auth/me", "POST /api/auth/logout", "GET /api/health",
  "GET /api/customer/overview", "GET /api/customer/domains",
  "GET /api/customer/keywords", "GET /api/customer/alerts"
]);

function isEligibleCustomerTenant(value) {
  const tenant = String(value || "");
  return /^[a-z][a-z0-9_-]{0,63}$/.test(tenant) &&
    !/^(demo|test|staging|sandbox|sample)(?:[-_]|$)/i.test(tenant);
}

function readCustomerViewers(raw = process.env.PENTAGON_CUSTOMER_VIEWERS_JSON || "") {
  if (typeof raw !== "string" || !raw.trim() ||
      Buffer.byteLength(raw, "utf8") > MAX_BYTES) return [];
  try {
    const input = JSON.parse(raw);
    if (!Array.isArray(input) || input.length > MAX_VIEWERS) return [];
    const seen = new Set(), out = [];
    for (const row of input) {
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          row.role !== "customer_viewer" || "password" in row ||
          "hash" in row || "salt" in row) return [];
      const email = normalizeEmail(row.email);
      const tenant = String(row.tenant || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          email.length > 254 || seen.has(email) ||
          !isEligibleCustomerTenant(tenant)) return [];
      seen.add(email);
      out.push({ email, tenant });
    }
    return out;
  } catch (_) {
    return []; // Fail closed. Never log an email, mapping or credential.
  }
}

function customerTenantForEmail(email, raw) {
  const normalized = normalizeEmail(email);
  return readCustomerViewers(raw).find(item => item.email === normalized)?.tenant || null;
}

function currentViewerTenant(session) {
  if (!session || session.isCustomerViewer !== true ||
      session.isAdmin === true || session.isDemo === true) return null;
  const tenant = customerTenantForEmail(session.adminEmail);
  return tenant && tenant === session.tenant ? tenant : null;
}

// Guards ALL APIs, including provider-node and rank routes mounted before
// the standard admin middleware. An allowlist is safer than blocking known
// writes: otherwise newly added endpoints could leak customer or node data.
function customerViewerFirewall(req, res, next) {
  if (!req.session?.isCustomerViewer) return next();
  if (!VIEWER_PATHS.has(req.method + " " + req.path)) {
    return res.status(403).json({ error: "CUSTOMER_VIEW_ONLY" });
  }
  if (req.path !== "/api/auth/me" &&
      req.path !== "/api/auth/logout" &&
      !currentViewerTenant(req.session)) {
    return res.status(403).json({ error: "CUSTOMER_ACCESS_REVOKED" });
  }
  next();
}

function requireCustomerViewer(req, res, next) {
  if (req.method !== "GET") return res.status(405).json({ error: "READ_ONLY" });
  if (!req.session?.isCustomerViewer) return res.status(401).json({ error: "LOGIN_REQUIRED" });
  const tenant = currentViewerTenant(req.session);
  if (!tenant) return res.status(403).json({ error: "CUSTOMER_ACCESS_REVOKED" });
  req.viewerTenant = tenant;
  next();
}

module.exports = {
  readCustomerViewers, customerTenantForEmail, currentViewerTenant,
  customerViewerFirewall, requireCustomerViewer, isEligibleCustomerTenant
};
