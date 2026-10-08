const express = require("express");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");\nconst { once } = require("events");
const { pool } = require("./db");
const { ensureNodeTable } = require("./nodeRoutes");
const { ensureTaskTable, enqueueNodeTask, waitForNodeTask } = require("./agentPollRoutes");

const router = express.Router();
const SOURCE_URL = "https://trustpositif.komdigi.go.id/assets/db/domains_isp";
const CACHE_PATH = process.env.TRUSTPOSITIF_CACHE_PATH || path.join(os.tmpdir(), "pentagon-domains_isp.txt");
const CACHE_TTL_MS = Number(process.env.TRUSTPOSITIF_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
let cacheDownloadPromise = null;

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function normalizeDomainList(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/);
  return [...new Set(raw.map(normalizeDomain).filter(Boolean))].slice(0, 50);
}

function cacheInfo() {
  try {
    const stat = fs.statSync(CACHE_PATH);
    return {
      exists: true,
      bytes: stat.size,
      mtime_ms: stat.mtimeMs,
      age_ms: Date.now() - stat.mtimeMs,
      fresh: Date.now() - stat.mtimeMs < CACHE_TTL_MS
    };
  } catch (_) {
    return { exists: false, bytes: 0, mtime_ms: 0, age_ms: null, fresh: false };
  }
}

function bucketId(domain) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < domain.length; i += 1) {
    hash ^= domain.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0xff;
}

function bucketPath(id, base = INDEX_DIR) {
  return path.join(base, id.toString(16).padStart(2, "0") + ".txt");
}

function readIndexMeta() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_META_PATH, "utf8"));
  } catch (_) {
    return null;
  }
}

function indexInfo() {
  const meta = readIndexMeta();
  if (!meta) return { ready: false, entry_count: 0, built_at: null, buckets: INDEX_BUCKETS };
  return {
    ready: true,
    entry_count: Number(meta.entry_count || 0),
    built_at: meta.built_at || null,
    source_mtime_ms: Number(meta.source_mtime_ms || 0),
    buckets: Number(meta.buckets || INDEX_BUCKETS)
  };
}

function indexMatchesCache() {
  try {
    const stat = fs.statSync(CACHE_PATH);
    const meta = readIndexMeta();
    return Boolean(meta)
      && Number(meta.buckets) === INDEX_BUCKETS
      && Math.abs(Number(meta.source_mtime_ms || 0) - stat.mtimeMs) < 2;
  } catch (_) {
    return false;
  }
}

async function buildIndexFromCache() {
  if (indexBuildPromise) return indexBuildPromise;
  indexBuildPromise = (async () => {
    const stat = fs.statSync(CACHE_PATH);
    const tmpDir = `${INDEX_DIR}.tmp-${process.pid}-${Date.now()}`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const streams = Array.from({ length: INDEX_BUCKETS }, (_, id) =>
      fs.createWriteStream(bucketPath(id, tmpDir), { encoding: "utf8" })
    );

    let entryCount = 0;
    try {
      const input = fs.createReadStream(CACHE_PATH, { encoding: "utf8" });
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of rl) {
        const value = normalizeDomain(line);
        if (!value) continue;
        entryCount += 1;
        const stream = streams[bucketId(value)];
        if (!stream.write(value + "\n")) await once(stream, "drain");
      }
      await Promise.all(streams.map(stream => new Promise((resolve, reject) => {
        stream.on("error", reject);
        stream.end(resolve);
      })));

      fs.writeFileSync(path.join(tmpDir, "meta.json"), JSON.stringify({
        source_mtime_ms: stat.mtimeMs,
        source_bytes: stat.size,
        entry_count: entryCount,
        buckets: INDEX_BUCKETS,
        built_at: new Date().toISOString()
      }));

      fs.rmSync(INDEX_DIR, { recursive: true, force: true });
      fs.renameSync(tmpDir, INDEX_DIR);
      bucketCache.clear();
      return indexInfo();
    } catch (err) {
      for (const stream of streams) {
        try { stream.destroy(); } catch (_) {}
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    } finally {
      indexBuildPromise = null;
    }
  })();
  return indexBuildPromise;
}

async function ensureIndexForCache() {
  if (indexMatchesCache()) return { ...indexInfo(), built: false };
  return { ...(await buildIndexFromCache()), built: true };
}

function loadBucket(id) {
  if (bucketCache.has(id)) {
    const hit = bucketCache.get(id);
    bucketCache.delete(id);
    bucketCache.set(id, hit);
    return hit;
  }

  let values = new Set();
  try {
    values = new Set(
      fs.readFileSync(bucketPath(id), "utf8")
        .split(/\r?\n/)
        .map(v => v.trim())
        .filter(Boolean)
    );
  } catch (_) {}

  bucketCache.set(id, values);
  while (bucketCache.size > INDEX_BUCKET_CACHE_LIMIT) {
    const oldest = bucketCache.keys().next().value;
    bucketCache.delete(oldest);
  }
  return values;
}

async function lookupIndexedDomains(domains = []) {
  const targets = normalizeDomainList(domains);
  const matches = {};
  const groups = new Map();

  for (const domain of targets) {
    matches[domain] = false;
    const id = bucketId(domain);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(domain);
  }

  for (const [id, group] of groups) {
    const values = loadBucket(id);
    for (const domain of group) matches[domain] = values.has(domain);
  }

  const meta = readIndexMeta();
  return { entryCount: Number(meta?.entry_count || 0), matches };
}

async function probeOfficialSource() {
  const started = Date.now();
  try {
    const response = await axios.head(SOURCE_URL, {
      timeout: Number(process.env.TRUSTPOSITIF_PROBE_TIMEOUT_MS || 20000),
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { "User-Agent": "PentagonTrustPositif/1.0", "Accept": "*/*" }
    });
    const payloadBytes = Number(response.headers?.["content-length"] || 0);
    const ok = response.status >= 200 && response.status < 300 && payloadBytes > 1000;
    return {
      ok,
      status: ok ? "available" : "unavailable",
      source_url: SOURCE_URL,
      http_status: response.status,
      latency_ms: Date.now() - started,
      payload_bytes: payloadBytes,
      entry_count: 0,
      content_type: String(response.headers?.["content-type"] || ""),
      fetched_at: new Date().toISOString(),
      probe_only: true,
      reason: ok ? "SOURCE_AVAILABLE" : `SOURCE_UNAVAILABLE_HTTP_${response.status}`
    };
  } catch (err) {
    return {
      ok: false, status: "unavailable", source_url: SOURCE_URL,
      http_status: err.response?.status || null, latency_ms: Date.now() - started,
      payload_bytes: 0, entry_count: 0, content_type: "",
      fetched_at: new Date().toISOString(), probe_only: true,
      reason: `SOURCE_UNAVAILABLE: ${err.code || err.message}`
    };
  }
}

async function downloadSourceCache() {
  if (cacheDownloadPromise) return cacheDownloadPromise;
  cacheDownloadPromise = (async () => {
    const started = Date.now();
    const tmp = `${CACHE_PATH}.tmp-${process.pid}-${Date.now()}`;
    try {
      const response = await axios.get(SOURCE_URL, {
        timeout: Number(process.env.TRUSTPOSITIF_DOWNLOAD_TIMEOUT_MS || 240000),
        maxRedirects: 5,
        responseType: "stream",
        validateStatus: () => true,
        headers: { "User-Agent": "PentagonTrustPositif/1.0", "Accept": "application/octet-stream,*/*" }
      });
      if (response.status < 200 || response.status >= 300) {
        response.data?.destroy?.();
        throw new Error(`HTTP ${response.status}`);
      }
      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmp);
        response.data.on("error", reject);
        writer.on("error", reject);
        writer.on("finish", resolve);
        response.data.pipe(writer);
      });
      fs.renameSync(tmp, CACHE_PATH);
      const stat = fs.statSync(CACHE_PATH);
      return {
        ok: stat.size > 1000,
        downloaded: true,
        source_url: SOURCE_URL,
        http_status: response.status,
        latency_ms: Date.now() - started,
        payload_bytes: stat.size,
        content_type: String(response.headers?.["content-type"] || ""),
        fetched_at: new Date().toISOString()
      };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    } finally {
      cacheDownloadPromise = null;
    }
  })();
  return cacheDownloadPromise;
}

async function ensureSourceCache() {
  const info = cacheInfo();
  if (info.fresh) {
    return {
      ok: true, downloaded: false, source_url: SOURCE_URL, http_status: 200,
      latency_ms: 0, payload_bytes: info.bytes,
      fetched_at: new Date(info.mtime_ms).toISOString()
    };
  }
  return downloadSourceCache();
}

async function ensureIndexedCache() {
  const source = await ensureSourceCache();
  const index = await ensureIndexForCache();
  return { ...source, index };
}

async function ensureTrustPositifTable() {
  await ensureNodeTable();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trustpositif_checks (
      id BIGSERIAL PRIMARY KEY,
      tenant TEXT NOT NULL DEFAULT 'admin',
      mode TEXT NOT NULL,
      node_id INT REFERENCES provider_nodes(id) ON DELETE SET NULL,
      provider_name TEXT DEFAULT '',
      source_url TEXT NOT NULL,
      ok BOOLEAN DEFAULT FALSE,
      http_status INT,
      latency_ms INT,
      payload_bytes BIGINT DEFAULT 0,
      entry_count INT DEFAULT 0,
      reason TEXT DEFAULT '',
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_trustpositif_checks_tenant_created ON trustpositif_checks(tenant, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_trustpositif_checks_node_created ON trustpositif_checks(node_id, created_at DESC)");
}

async function recordCheck(tenant, mode, result, node = null) {
  await ensureTrustPositifTable();
  const details = { ...result };
  await pool.query(
    `INSERT INTO trustpositif_checks
      (tenant, mode, node_id, provider_name, source_url, ok, http_status, latency_ms, payload_bytes, entry_count, reason, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      tenant || "admin", mode, node?.id || null, node?.provider_name || result.provider_name || "",
      result.source_url || SOURCE_URL, Boolean(result.ok), result.http_status || null,
      result.latency_ms || null, Number(result.payload_bytes || 0), Number(result.entry_count || 0),
      String(result.reason || ""), JSON.stringify(details)
    ]
  );
}

router.get("/trustpositif/status", async (req, res, next) => {
  try {
    await ensureNodeTable();
    await ensureTaskTable();
    await ensureTrustPositifTable();
    const tenant = req.tenant || "admin";

    const { rows: directRows } = await pool.query(
      `SELECT id, mode, source_url, ok, http_status, latency_ms, payload_bytes, entry_count, reason, details, created_at
       FROM trustpositif_checks
       WHERE tenant=$1 AND mode='direct'
       ORDER BY created_at DESC LIMIT 1`,
      [tenant]
    );

    const { rows: nodeRows } = await pool.query(
      `SELECT n.id, n.name, n.provider_name, n.network_type, n.endpoint_url, n.is_active,
              n.last_health_status, n.last_health_reason, n.last_ping_at,
              t.network_operator, t.network_type_label, t.cellular_available,
              t.subscription_id, t.subscription_reason, t.last_seen_at,
              c.ok AS trust_ok, c.http_status AS trust_http_status,
              c.latency_ms AS trust_latency_ms, c.payload_bytes AS trust_payload_bytes,
              c.entry_count AS trust_entry_count, c.reason AS trust_reason,
              c.details AS trust_details, c.created_at AS trust_checked_at
       FROM provider_nodes n
       LEFT JOIN node_telemetry t ON t.node_id=n.id
       LEFT JOIN LATERAL (
         SELECT ok, http_status, latency_ms, payload_bytes, entry_count, reason, details, created_at
         FROM trustpositif_checks
         WHERE tenant=$1 AND node_id=n.id AND mode='node'
         ORDER BY created_at DESC LIMIT 1
       ) c ON TRUE
       WHERE n.tenant=$1
       ORDER BY n.id DESC`,
      [tenant]
    );

    res.json({
      source_url: SOURCE_URL,
      direct: directRows[0] || null,
      cache: cacheInfo(),
      nodes: nodeRows,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    next(err);
  }
});

router.post("/trustpositif/source/test", async (req, res, next) => {
  try {
    const tenant = req.tenant || "admin";
    const result = await probeOfficialSource();
    await recordCheck(tenant, "direct", result);
    res.json({ ...result, cache: cacheInfo() });
  } catch (err) {
    next(err);
  }
});

router.post("/trustpositif/check", async (req, res, next) => {
  try {
    const tenant = req.tenant || "admin";
    const domains = normalizeDomainList(req.body?.domains || req.body?.domain || []);
    if (!domains.length) return res.status(400).json({ error: "domain required" });

    const started = Date.now();
    let cacheResult;
    try {
      cacheResult = await ensureIndexedCache();
    } catch (err) {
      const result = {
        ok: false, status: "unavailable", source_url: SOURCE_URL,
        http_status: err.response?.status || null, latency_ms: Date.now() - started,
        payload_bytes: 0, entry_count: 0, matches: {},
        reason: `SOURCE_UNAVAILABLE: ${err.code || err.message}`
      };
      await recordCheck(tenant, "direct", result);
      return res.json({ ...result, domains: domains.map(domain => ({ domain, listed: false, status: "Unknown" })) });
    }

    const scan = await lookupIndexedDomains(domains);
    const result = {
      ...cacheResult,
      ok: true,
      status: "available",
      latency_ms: Date.now() - started,
      entry_count: scan.entryCount,
      matches: scan.matches,
      cache: cacheInfo(),
      reason: cacheResult.downloaded
        ? "SOURCE_CACHE_DOWNLOADED_INDEXED"
        : (cacheResult.index?.built ? "SOURCE_CACHE_INDEX_BUILT" : "SOURCE_CACHE_INDEX_HIT")
    };
    await recordCheck(tenant, "direct", result);

    res.json({
      ...result,
      domains: domains.map((domain) => ({
        domain,
        listed: Boolean(scan.matches?.[domain]),
        status: scan.matches?.[domain] ? "Ada" : "Tidak Ada"
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.post("/trustpositif/nodes/:id/test", async (req, res, next) => {
  try {
    await ensureTaskTable();
    await ensureTrustPositifTable();
    const tenant = req.tenant || "admin";
    const domains = normalizeDomainList(req.body?.domains || []);
    const { rows } = await pool.query(
      "SELECT id, name, provider_name, network_type, endpoint_url, is_active FROM provider_nodes WHERE id=$1 AND tenant=$2 LIMIT 1",
      [req.params.id, tenant]
    );
    const node = rows[0];
    if (!node) return res.status(404).json({ error: "Node not found" });
    if (node.is_active === false) return res.status(400).json({ error: "Node is disabled" });

    const taskId = await enqueueNodeTask(node, "trustpositif.komdigi.go.id", {
      task_type: "trustpositif_fetch",
      payload: { source_url: SOURCE_URL, domains }
    });

    const raw = await waitForNodeTask(taskId, Number(process.env.TRUSTPOSITIF_NODE_TIMEOUT_MS || 55000));
    let result;

    if (raw?.trustpositif_fetch === true) {
      result = {
        ...raw,
        ok: Boolean(raw.ok),
        status: raw.ok ? "available" : "unavailable",
        source_url: raw.source_url || SOURCE_URL
      };
    } else if (raw?.__polling_state === "timeout") {
      result = {
        ok: false,
        status: "unavailable",
        source_url: SOURCE_URL,
        http_status: null,
        latency_ms: null,
        payload_bytes: 0,
        entry_count: 0,
        matches: {},
        reason: "NODE_TIMEOUT: no response from device agent"
      };
    } else {
      result = {
        ok: false,
        status: "unsupported",
        source_url: SOURCE_URL,
        http_status: raw?.http_status || null,
        latency_ms: raw?.latency_ms || null,
        payload_bytes: 0,
        entry_count: 0,
        matches: {},
        reason: "AGENT_UPDATE_REQUIRED: node agent does not support trustpositif_fetch"
      };
    }

    result.node_id = node.id;
    result.node_name = node.name;
    result.provider_name = node.provider_name;
    result.task_id = taskId;
    await recordCheck(tenant, "node", result, node);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/trustpositif/history", async (req, res, next) => {
  try {
    await ensureTrustPositifTable();
    const tenant = req.tenant || "admin";
    const { rows } = await pool.query(
      `SELECT id, mode, node_id, provider_name, source_url, ok, http_status, latency_ms,
              payload_bytes, entry_count, reason, details, created_at
       FROM trustpositif_checks
       WHERE tenant=$1
       ORDER BY created_at DESC LIMIT 100`,
      [tenant]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
