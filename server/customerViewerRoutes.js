"use strict";

const express = require("express");
const { pool } = require("./db");
const { requireCustomerViewer } = require("./customerViewerAuth");

// Read-only, parameterized endpoints. No table changes or checker invocations.
// Never trust tenant, domain IDs or customer account roles from query/body.
// Database access is via the backend only, with a session-bound tenant check.
function createCustomerViewerRouter(db = pool) {
  const router = express.Router();
  router.use(requireCustomerViewer);
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });

  function safely(handler) {
    return async (req, res) => {
      try { await handler(req, res); }
      catch (error) {
        // No SQL/error detail, tenant metadata, credentials or connection URLs.
        console.warn("[Customer Viewer] read unavailable", String(error.code || "QUERY_FAILURE").slice(0,32));
        res.status(503).json({ error: "CUSTOMER_DATA_UNAVAILABLE" });
      }
    };
  }

  router.get("/overview", safely(async (req, res) => {
    const tenant = req.viewerTenant;
    const [domainCount, keywordCount, whitelistCount] = await Promise.all([
      db.query(
        "SELECT COUNT(*)::int AS total," +
        "COUNT(*) FILTER (WHERE is_active=TRUE)::int AS active," +
        "COUNT(*) FILTER (WHERE global_status='working' AND is_active=TRUE)::int AS healthy," +
        "COUNT(*) FILTER (WHERE global_status='warning' AND is_active=TRUE)::int AS warning," +
        "COUNT(*) FILTER (WHERE global_status='blocked' AND is_active=TRUE)::int AS blocked," +
        "COUNT(*) FILTER (WHERE COALESCE(global_status,'unknown')='unknown' AND is_active=TRUE)::int AS unknown," +
        "MAX(last_checked_at) AS last_checked_at FROM domains WHERE tenant=$1",
        [tenant]
      ),
      db.query("SELECT COUNT(*)::int AS total FROM rank_keyword_groups WHERE tenant=$1 AND is_active=TRUE", [tenant]),
      db.query(
        "SELECT COUNT(*)::int AS total FROM rank_keyword_domains k " +
        "JOIN rank_keyword_groups g ON g.id=k.group_id " +
        "JOIN domains d ON LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain)) " +
        "AND d.tenant=g.tenant AND d.is_active=TRUE " +
        "WHERE g.tenant=$1 AND g.is_active=TRUE AND k.is_whitelisted=TRUE",
        [tenant]
      )
    ]);
    res.json({
      ...domainCount.rows[0],
      keywords: keywordCount.rows[0].total,
      whitelist_links: whitelistCount.rows[0].total,
      tenant, read_only: true
    });
  }));

  router.get("/domains", safely(async (req, res) => {
    const { rows } = await db.query(
      "SELECT domain, project_name, label, is_active, global_status, " +
      "last_checked_at, created_at FROM domains WHERE tenant=$1 " +
      "ORDER BY CASE WHEN label='ms' THEN 0 WHEN label='landing_page' THEN 1 ELSE 2 END,domain LIMIT 500",
      [req.viewerTenant]
    );
    res.json(rows);
  }));

  router.get("/keywords", safely(async (req, res) => {
    const { rows } = await db.query(
      "SELECT g.keyword, g.project_name, g.last_checked_at," +
      "COUNT(DISTINCT d.domain)::int AS whitelisted_domains," +
      "COALESCE(STRING_AGG(DISTINCT d.domain, ', ' ORDER BY d.domain),'') AS domains, " +
      "COALESCE(json_agg(json_build_object('domain',d.domain, " +
      "'last_position',k.last_position,'last_page',k.last_page, " +
      "'last_status',k.last_status,'last_checked_at',k.last_checked_at) ORDER BY d.domain) " +
      "FILTER (WHERE d.domain IS NOT NULL), '[]'::json) AS whitelist " +
      "FROM rank_keyword_groups g " +
      "LEFT JOIN rank_keyword_domains k ON k.group_id=g.id AND k.is_whitelisted=TRUE " +
      "LEFT JOIN domains d ON LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain)) " +
      "AND d.tenant=g.tenant AND d.is_active=TRUE " +
      "WHERE g.tenant=$1 AND g.is_active=TRUE " +
      "GROUP BY g.id,g.keyword,g.project_name,g.last_checked_at " +
      "ORDER BY g.keyword LIMIT 200",
      [req.viewerTenant]
    );
    res.json(rows);
  }));

  router.get("/alerts", safely(async (req, res) => {
    const { rows } = await db.query(
      "SELECT a.id,a.created_at,a.old_status,a.new_status," +
      "d.domain,d.project_name FROM alerts a " +
      "JOIN domains d ON d.id=a.domain_id " +
      "WHERE d.tenant=$1 ORDER BY a.created_at DESC LIMIT 50",
      [req.viewerTenant]
    );
    res.json(rows);
  }));

  return router;
}

module.exports = { createCustomerViewerRouter };
