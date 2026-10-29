"use strict";

const express = require("express");
const { pool } = require("./db");
const { requireMerchantAdmin } = require("./customerViewerAuth");
const { serializeMerchantNodes } = require("./merchantNodeTelemetry");
const { createMerchantOperationsRouter } = require("./merchantOperationsRoutes");

// Merchant administration is intentionally separate from /api/domains, /api/rank,
// /api/nodes and other platform-admin routes. The server session owns tenant identity.
function createMerchantAdminRouter(db = pool) {
  const router = express.Router();
  router.use(requireMerchantAdmin);
  router.use(createMerchantOperationsRouter(db));
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });

  function safely(handler) {
    return async (req, res) => {
      try { await handler(req, res); }
      catch (error) {
        if (error.code === "23505") return res.status(409).json({ error: "ALREADY_EXISTS" });
        console.warn("[Merchant Admin] request unavailable", String(error.code || "QUERY_FAILURE").slice(0, 24));
        return res.status(503).json({ error: "MERCHANT_DATA_UNAVAILABLE" });
      }
    };
  }
  function id(value) {
    return /^[1-9][0-9]{0,9}$/.test(String(value || "")) ? Number(value) : null;
  }
  function text(value, max) {
    const result = String(value || "").trim();
    return result.length <= max ? result : null;
  }
  function domainName(value) {
    const v = String(value || "").trim().toLowerCase();
    if (v.length > 253 || v.length < 4 || !/^[a-z0-9.-]+$/.test(v)) return null;
    const parts = v.split(".");
    if (parts.length < 2 || parts.some(x => !x || x.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x))) return null;
    if (!/^[a-z]{2,63}$/.test(parts[parts.length - 1])) return null;
    return v;
  }
  function ownTenant(req) {
    // Re-read the verified grant for every request; never use query/body tenant.
    return req.merchantTenant;
  }

  router.get("/profile", (req, res) => res.json({
    tenant: ownTenant(req), role: "merchant_admin", read_only: false,
    capabilities: ["domains", "keywords", "whitelist", "alerts", "node_health_read"]
  }));

  router.get("/domains", safely(async (req, res) => {
    const { rows } = await db.query(
      "SELECT id, domain, project_name, label, is_active, global_status, last_checked_at, created_at " +
      "FROM domains WHERE tenant=$1 ORDER BY CASE WHEN label='ms' THEN 0 ELSE 1 END, id DESC LIMIT 500",
      [ownTenant(req)]
    );
    return res.json(rows);
  }));

  router.post("/domains", safely(async (req, res) => {
    const domain = domainName(req.body?.domain);
    const project = text(req.body?.project_name, 120);
    const label = text(req.body?.label || "landing_page", 30);
    if (!domain || project === null || !["ms", "landing_page"].includes(label)) {
      return res.status(400).json({ error: "INVALID_DOMAIN" });
    }
    const { rows } = await db.query(
      "INSERT INTO domains (domain, project_name, label, tenant, is_active) " +
      "VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (domain) DO NOTHING " +
      "RETURNING id, domain, project_name, label, is_active, global_status",
      [domain, project, label, ownTenant(req)]
    );
    if (!rows.length) return res.status(409).json({ error: "DOMAIN_ALREADY_REGISTERED" });
    return res.status(201).json(rows[0]);
  }));

  router.patch("/domains/:id", safely(async (req, res) => {
    const domainId = id(req.params.id);
    if (!domainId) return res.status(400).json({ error: "INVALID_ID" });
    const body = req.body || {};
    const fields = [], args = [];
    if (Object.prototype.hasOwnProperty.call(body, "project_name")) {
      const value = text(body.project_name, 120);
      if (value === null) return res.status(400).json({ error: "INVALID_PROJECT" });
      args.push(value); fields.push("project_name=$" + args.length);
    }
    if (Object.prototype.hasOwnProperty.call(body, "label")) {
      if (!["ms", "landing_page"].includes(body.label)) return res.status(400).json({ error: "INVALID_LABEL" });
      args.push(body.label); fields.push("label=$" + args.length);
    }
    if (Object.prototype.hasOwnProperty.call(body, "is_active")) {
      if (typeof body.is_active !== "boolean") return res.status(400).json({ error: "INVALID_STATUS" });
      args.push(body.is_active); fields.push("is_active=$" + args.length);
    }
    if (!fields.length) return res.status(400).json({ error: "NO_EDITABLE_FIELDS" });
    args.push(domainId, ownTenant(req));
    const { rows } = await db.query(
      "UPDATE domains SET " + fields.join(", ") + " WHERE id=$" + (args.length-1) +
      " AND tenant=$" + args.length +
      " RETURNING id,domain,project_name,label,is_active,global_status,last_checked_at", args
    );
    if (!rows.length) return res.status(404).json({ error: "DOMAIN_NOT_FOUND" });
    return res.json(rows[0]);
  }));

  router.get("/keywords", safely(async (req, res) => {
    const { rows } = await db.query(
      "SELECT g.id, g.keyword, g.project_name, g.is_active, g.last_checked_at, " +
      "COALESCE(json_agg(json_build_object('domain',d.domain, " +
      "'last_position',k.last_position,'last_page',k.last_page, " +
      "'last_status',k.last_status,'last_checked_at',k.last_checked_at) ORDER BY d.domain) " +
      "FILTER (WHERE d.domain IS NOT NULL AND k.is_whitelisted=TRUE), '[]'::json) AS whitelist " +
      "FROM rank_keyword_groups g " +
      "LEFT JOIN rank_keyword_domains k ON k.group_id=g.id AND k.is_whitelisted=TRUE " +
      "LEFT JOIN domains d ON LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain)) AND d.tenant=g.tenant " +
      "WHERE g.tenant=$1 GROUP BY g.id ORDER BY g.id DESC LIMIT 200",
      [ownTenant(req)]
    );
    return res.json(rows);
  }));

  router.post("/keywords", safely(async (req, res) => {
    const keyword = text(req.body?.keyword, 120);
    const project = text(req.body?.project_name, 120);
    if (!keyword || project === null) return res.status(400).json({ error: "INVALID_KEYWORD" });
    const { rows } = await db.query(
      "INSERT INTO rank_keyword_groups (keyword,keyword_lc,project_name,tenant,is_active) " +
      "VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (keyword_lc,tenant) DO NOTHING " +
      "RETURNING id,keyword,project_name,is_active",
      [keyword, keyword.toLowerCase(), project, ownTenant(req)]
    );
    if (!rows.length) return res.status(409).json({ error: "KEYWORD_ALREADY_REGISTERED" });
    return res.status(201).json(rows[0]);
  }));

  router.patch("/keywords/:id", safely(async (req, res) => {
    const groupId = id(req.params.id);
    if (!groupId) return res.status(400).json({ error: "INVALID_ID" });
    const body = req.body || {};
    const fields = [], args = [];
    if (Object.prototype.hasOwnProperty.call(body, "keyword")) {
      const keyword = text(body.keyword, 120);
      if (!keyword) return res.status(400).json({ error: "INVALID_KEYWORD" });
      args.push(keyword); fields.push("keyword=$" + args.length);
      args.push(keyword.toLowerCase()); fields.push("keyword_lc=$" + args.length);
    }
    if (Object.prototype.hasOwnProperty.call(body, "project_name")) {
      const project = text(body.project_name, 120);
      if (project === null) return res.status(400).json({ error: "INVALID_PROJECT" });
      args.push(project); fields.push("project_name=$" + args.length);
    }
    if (Object.prototype.hasOwnProperty.call(body, "is_active")) {
      if (typeof body.is_active !== "boolean") return res.status(400).json({ error: "INVALID_STATUS" });
      args.push(body.is_active); fields.push("is_active=$" + args.length);
    }
    if (!fields.length) return res.status(400).json({ error: "NO_EDITABLE_FIELDS" });
    args.push(groupId, ownTenant(req));
    const { rows } = await db.query(
      "UPDATE rank_keyword_groups SET " + fields.join(", ") +
      " WHERE id=$" + (args.length-1) + " AND tenant=$" + args.length +
      " RETURNING id,keyword,project_name,is_active", args
    );
    if (!rows.length) return res.status(404).json({ error: "KEYWORD_NOT_FOUND" });
    return res.json(rows[0]);
  }));

  router.post("/keywords/:id/whitelist", safely(async (req, res) => {
    const groupId = id(req.params.id);
    const domain = domainName(req.body?.domain);
    if (!groupId || !domain) return res.status(400).json({ error: "INVALID_LINK" });
    const { rows } = await db.query(
      "INSERT INTO rank_keyword_domains (group_id, domain, is_whitelisted) " +
      "SELECT g.id, d.domain, TRUE FROM rank_keyword_groups g " +
      "INNER JOIN domains d ON d.tenant=g.tenant AND d.domain=$3 AND d.is_active=TRUE " +
      "WHERE g.id=$1 AND g.tenant=$2 " +
      "ON CONFLICT (group_id,domain) DO UPDATE SET is_whitelisted=TRUE " +
      "RETURNING group_id,domain,is_whitelisted",
      [groupId, ownTenant(req), domain]
    );
    if (!rows.length) return res.status(404).json({ error: "OWN_DOMAIN_OR_KEYWORD_NOT_FOUND" });
    return res.status(201).json(rows[0]);
  }));

  router.delete("/keywords/:id/whitelist/:domain", safely(async (req, res) => {
    const groupId = id(req.params.id);
    const domain = domainName(req.params.domain);
    if (!groupId || !domain) return res.status(400).json({ error: "INVALID_LINK" });
    const { rows } = await db.query(
      "UPDATE rank_keyword_domains k SET is_whitelisted=FALSE " +
      "FROM rank_keyword_groups g, domains d WHERE k.group_id=g.id AND g.id=$1 " +
      "AND g.tenant=$2 AND d.tenant=g.tenant AND d.domain=$3 " +
      "AND k.domain=d.domain RETURNING k.id",
      [groupId, ownTenant(req), domain]
    );
    if (!rows.length) return res.status(404).json({ error: "LINK_NOT_FOUND" });
    return res.json({ ok: true });
  }));

  // Each checker is a sanitized read-only card, scoped to shared/own nodes.
  // Do not return node IDs, secrets, device nicknames, SIM, IP, endpoint or raw data.
  router.get("/node-health", safely(async (req, res) => {
    const { rows } = await db.query(
      "SELECT n.provider_name, n.network_type, n.is_active, n.last_health_status, " +
      "t.signal_level, t.signal_percent, t.signal_dbm, " +
      "t.battery_percent, t.is_charging, t.network_type_label, " +
      "t.last_seen_at AS telemetry_last_seen_at " +
      "FROM provider_nodes n LEFT JOIN node_telemetry t ON t.node_id=n.id " +
      "WHERE n.tenant IN ('admin',$1) " +
      "ORDER BY LOWER(n.provider_name), n.id LIMIT 80",
      [ownTenant(req)]
    );
    const now = Date.now();
    return res.json({
      as_of: new Date(now).toISOString(),
      nodes: serializeMerchantNodes(rows, now)
    });
  }));

  router.all("/node-health", (req, res) => res.status(405).json({ error: "READ_ONLY" }));

  router.get("/nodes", safely(async (req, res) => {
    // Shared infrastructure is summary-only: no endpoint, secret, device ID,
    // subscriber ID, IP, precise location or controls may leave this endpoint.
    const { rows } = await db.query(
      "SELECT n.provider_name, COUNT(*)::int AS total, " +
      "COUNT(*) FILTER (WHERE n.is_active=TRUE)::int AS active, " +
      "COUNT(*) FILTER (WHERE n.is_active=TRUE AND " +
      "COALESCE(t.last_seen_at,n.last_ping_at) >= NOW()-INTERVAL '5 minutes')::int AS fresh, " +
      "MAX(COALESCE(t.last_seen_at,n.last_ping_at)) AS last_seen_at " +
      "FROM provider_nodes n LEFT JOIN node_telemetry t ON t.node_id=n.id " +
      "WHERE n.tenant IN ('admin',$1) GROUP BY n.provider_name ORDER BY n.provider_name LIMIT 40",
      [ownTenant(req)]
    );
    return res.json(rows.map(row => ({
      provider_name: row.provider_name, total: row.total, active: row.active,
      fresh: row.fresh, waiting: Math.max(0, row.active - row.fresh),
      last_seen_at: row.last_seen_at
    })));
  }));

  router.get("/history", safely(async (req, res) => {
    const { rows } = await db.query(
      "SELECT d.domain, r.provider_name, r.checker_type, r.status, " +
      "r.checked_at, r.latency_ms FROM check_results r " +
      "JOIN domains d ON d.id=r.domain_id WHERE d.tenant=$1 " +
      "ORDER BY r.checked_at DESC LIMIT 100",
      [ownTenant(req)]
    );
    return res.json(rows);
  }));

  return router;
}

module.exports = { createMerchantAdminRouter };
