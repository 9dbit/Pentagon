const express = require("express");
const { pool } = require("./db");

const router = express.Router();

async function ensureAnalyticsCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_cache (
      id SERIAL PRIMARY KEY,
      cache_key TEXT NOT NULL UNIQUE,
      result JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  const col = (await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='analytics_cache' AND column_name='result'`
  )).rows;
  if (!col.length) {
    await pool.query(`DROP TABLE analytics_cache`);
    await pool.query(`
      CREATE TABLE analytics_cache (
        id SERIAL PRIMARY KEY,
        cache_key TEXT NOT NULL UNIQUE,
        result JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }
}

async function ensureSeoScoreHistory() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seo_score_history (
      id SERIAL PRIMARY KEY,
      project_name TEXT NOT NULL,
      seo_score INTEGER NOT NULL,
      score_breakdown JSONB,
      generated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function ensureSuggestionCompletions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suggestion_completions (
      id SERIAL PRIMARY KEY,
      domain TEXT NOT NULL,
      project_name TEXT NOT NULL DEFAULT '',
      suggestion_key TEXT NOT NULL,
      marked_done BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(domain, suggestion_key)
    )
  `);
}

async function buildGlobalContext() {
  const domains = (await pool.query("SELECT global_status, project_name FROM domains")).rows;
  const total = domains.length;
  const working = domains.filter((d) => d.global_status === "working").length;
  const warning = domains.filter((d) => d.global_status === "warning").length;
  const blocked = domains.filter((d) => d.global_status === "blocked").length;
  const unknown = domains.filter((d) => !["working","warning","blocked"].includes(d.global_status)).length;
  const projects = [...new Set(domains.map((d) => d.project_name || "No Project"))].sort();

  let reasons = [];
  try {
    reasons = (await pool.query(`
      SELECT reason_type, COUNT(*)::int AS count
      FROM check_results
      WHERE checked_at > NOW() - INTERVAL '7 days'
      GROUP BY reason_type ORDER BY count DESC LIMIT 10
    `)).rows;
  } catch (_) {}

  let recentAlerts = [];
  try {
    recentAlerts = (await pool.query(`
      SELECT a.old_status, a.new_status, d.domain, d.project_name, a.created_at
      FROM alerts a LEFT JOIN domains d ON d.id = a.domain_id
      ORDER BY a.created_at DESC LIMIT 20
    `)).rows;
  } catch (_) {}

  let rankGroups = [];
  try {
    rankGroups = (await pool.query(`
      SELECT g.keyword, g.project_name, g.last_checked_at,
        COUNT(DISTINCT kd.id)::int AS domain_count,
        COUNT(DISTINCT CASE WHEN sr.classification='suspicious' THEN sr.id END)::int AS suspicious_count
      FROM rank_keyword_groups g
      LEFT JOIN rank_keyword_domains kd ON kd.group_id = g.id
      LEFT JOIN rank_scan_results sr ON sr.group_id = g.id AND sr.checked_at > NOW() - INTERVAL '7 days'
      GROUP BY g.id, g.keyword, g.project_name, g.last_checked_at
      ORDER BY g.id DESC LIMIT 20
    `)).rows;
  } catch (_) {}

  const totalSuspicious = rankGroups.reduce((a, g) => a + (g.suspicious_count || 0), 0);

  return {
    domain_summary: { total, working, warning, blocked, unknown },
    projects,
    top_reasons: reasons,
    recent_alerts: recentAlerts.slice(0, 10),
    rank_groups: rankGroups,
    total_suspicious_rank: totalSuspicious,
  };
}

async function buildProjectSeoContext(projectName) {
  const isAll = !projectName || projectName === "all";
  const domainRows = isAll
    ? (await pool.query("SELECT domain, global_status, last_checked_at FROM domains ORDER BY domain")).rows
    : (await pool.query("SELECT domain, global_status, last_checked_at FROM domains WHERE project_name=$1 ORDER BY domain", [projectName])).rows;

  const total = domainRows.length;
  const working = domainRows.filter(d => d.global_status === "working").length;
  const warning = domainRows.filter(d => d.global_status === "warning").length;
  const blocked = domainRows.filter(d => d.global_status === "blocked").length;

  let rankKeywords = [];
  try {
    const q = isAll
      ? `SELECT g.keyword, g.project_name,
           COUNT(DISTINCT kd.id)::int AS domain_count,
           COUNT(DISTINCT CASE WHEN sr.classification='suspicious' THEN sr.id END)::int AS suspicious_count
         FROM rank_keyword_groups g
         LEFT JOIN rank_keyword_domains kd ON kd.group_id = g.id
         LEFT JOIN rank_scan_results sr ON sr.group_id = g.id AND sr.checked_at > NOW() - INTERVAL '7 days'
         GROUP BY g.id, g.keyword, g.project_name ORDER BY g.id DESC LIMIT 30`
      : `SELECT g.keyword, g.project_name,
           COUNT(DISTINCT kd.id)::int AS domain_count,
           COUNT(DISTINCT CASE WHEN sr.classification='suspicious' THEN sr.id END)::int AS suspicious_count
         FROM rank_keyword_groups g
         LEFT JOIN rank_keyword_domains kd ON kd.group_id = g.id
         LEFT JOIN rank_scan_results sr ON sr.group_id = g.id AND sr.checked_at > NOW() - INTERVAL '7 days'
         WHERE g.project_name=$1
         GROUP BY g.id, g.keyword, g.project_name ORDER BY g.id DESC LIMIT 30`;
    rankKeywords = (await pool.query(q, isAll ? [] : [projectName])).rows;
  } catch (_) {}

  let recentReasons = [];
  try {
    const domainList = domainRows.map(d => d.domain);
    if (domainList.length > 0) {
      recentReasons = (await pool.query(
        `SELECT reason_type, COUNT(*)::int AS count
         FROM check_results cr
         JOIN domains d ON d.id = cr.domain_id
         WHERE d.domain = ANY($1) AND cr.checked_at > NOW() - INTERVAL '7 days'
         GROUP BY reason_type ORDER BY count DESC LIMIT 10`,
        [domainList]
      )).rows;
    }
  } catch (_) {}

  const totalSuspicious = rankKeywords.reduce((a, k) => a + (k.suspicious_count || 0), 0);

  return {
    project_name: isAll ? "All Projects" : projectName,
    domains: domainRows,
    domain_summary: { total, working, warning, blocked },
    rank_keywords: rankKeywords,
    recent_reasons: recentReasons,
    total_suspicious: totalSuspicious,
  };
}

function buildSeoPrompt(ctx, prevAudit, confirmedCompletions) {
  const domainSample = ctx.domains.slice(0, 20).map(d =>
    `  - ${d.domain} (status: ${d.global_status || "unknown"})`
  ).join("\n") || "  No domains";

  const keywordSample = ctx.rank_keywords.slice(0, 15).map(k =>
    `  - Keyword: "${k.keyword}" | Domains: ${k.domain_count} | Suspicious SERP: ${k.suspicious_count}`
  ).join("\n") || "  No keywords tracked";

  const reasonSample = ctx.recent_reasons.map(r =>
    `  - ${r.reason_type}: ${r.count}x`
  ).join("\n") || "  No recent issues";

  let prevSection = "";
  if (prevAudit && prevAudit.score_breakdown) {
    const prevDate = prevAudit.generated_at
      ? new Date(prevAudit.generated_at).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })
      : "previous audit";
    const prevDomains = (prevAudit.domain_audits || []).map(d => {
      const parts = [
        d.title_suggestion    && `title_suggestion: "${d.title_suggestion}"`,
        d.meta_suggestion     && `meta_suggestion: "${d.meta_suggestion}"`,
        d.priority_action     && `priority_action: "${d.priority_action}"`,
        d.internal_link_suggestion && `internal_link_suggestion: "${d.internal_link_suggestion}"`,
      ].filter(Boolean).join(" | ");
      return `  - ${d.domain} [seo_score: ${d.seo_score ?? "?"}]: ${parts || "no suggestions recorded"}`;
    }).join("\n") || "  (no domain data)";

    let confirmedSection = "";
    if (confirmedCompletions && confirmedCompletions.length > 0) {
      const lines = confirmedCompletions
        .filter(c => c.marked_done)
        .map(c => `  - USER CONFIRMED: ${c.suggestion_key} implemented on ${c.domain}`)
        .join("\n");
      if (lines) {
        confirmedSection = `
USER-CONFIRMED IMPLEMENTATIONS (GROUND TRUTH — treat as facts, not guesses):
${lines}
For each confirmed item above: set likely_implemented=true in suggestions_status, and the relevant score dimension MUST be >= its previous value.
`;
      }
    }

    prevSection = `
═══ PREVIOUS AUDIT (${prevDate}) — CONSISTENCY ANCHOR ═══
Previous project score_breakdown: ${JSON.stringify(prevAudit.score_breakdown)}

Previous suggestions given to the user per domain:
${prevDomains}
${confirmedSection}
CONSISTENCY RULES (MANDATORY):
1. For every domain listed above, evaluate whether each suggestion was likely implemented.
2. Add "suggestions_status" array to each matching domain_audit entry.
3. If a suggestion appears implemented → likely_implemented: true → that domain's relevant score dimension MUST be >= its previous value. NEVER lower it just because of re-interpretation.
4. Only lower a score dimension if there is NEW concrete negative evidence (e.g., domain now blocked, new spam patterns, SSL revoked). Re-reading old data differently is NOT grounds to lower a score.
5. Project-level score_breakdown: do not lower any dimension that has no new negative signal.
═══════════════════════════════════════════════════════════
`;
  }

  return `You are a senior SEO strategist and domain monitoring expert. Apply the exact rubrics below to score this project. Be strictly deterministic — same inputs must always produce the same scores.

PROJECT: ${ctx.project_name}
DOMAIN HEALTH: ${ctx.domain_summary.total} total | ${ctx.domain_summary.working} working | ${ctx.domain_summary.warning} warning | ${ctx.domain_summary.blocked} blocked
SUSPICIOUS SERP THREATS: ${ctx.total_suspicious}

MONITORED DOMAINS:
${domainSample}

TRACKED KEYWORDS (SERP Defense):
${keywordSample}

RECENT FAILURE REASONS (7 days):
${reasonSample}
${prevSection}
═══ SCORING RUBRICS — Apply these EXACTLY. No deviation. ═══

1. keyword_intent (max 10):
   0–3: No clear keyword, or intent completely mismatched (e.g., blog post for transactional query)
   4–6: Keyword present but intent loosely matched or targeting too broad/generic
   7–10: Clear primary keyword, intent fully matched, consistent across monitored pages

2. content_depth (max 15):
   0–5: Thin content (<500 words), no structure, no subtopics, no data or examples
   6–10: Moderate — has headings and covers main topic, but misses key subtopics
   11–15: Comprehensive — data-backed, full subtopic coverage, clear hierarchy, real examples/stats

3. uniqueness (max 10):
   0–3: Generic or duplicated — no original angle vs competitors
   4–6: Some original perspective but largely similar to existing top-10 results
   7–10: Distinctly original — proprietary data, unique methodology, or perspective not found elsewhere

4. eeat (max 10):
   0–3: Anonymous — no About/Team/Contact page, no author attribution
   4–6: Basic contact info visible, some brand signals, but no author credentials
   7–10: Named authors with credentials, detailed About/Team page, external trust signals (media, awards)

5. on_page_seo (max 10):
   0–3: Missing or duplicate title tag, no meta description, H1 absent or misused
   4–6: Title and meta present but not optimized (keyword not at start, exceeds char limits)
   7–10: Keyword-first title ≤60 chars, compelling meta ≤160 chars, clean URL, H1 matches keyword, schema markup present

6. internal_linking (max 10):
   0–3: Orphan pages, no clear linking structure, missing or random internal links
   4–6: Some links exist but no pillar-cluster strategy, generic anchor text
   7–10: Clear pillar-cluster architecture, keyword-rich descriptive anchors, no orphan pages

7. entity_coverage (max 10):
   0–3: No brand footprint — no Google Business, unverified or absent social profiles
   4–6: Partial — some social profiles, inconsistent NAP across directories
   7–10: Google Business verified, consistent NAP everywhere, Wikidata/Wikipedia presence, verified socials

8. technical_seo (max 10):
   0–3: No HTTPS, blocked/inaccessible, or critical crawl errors detected
   4–6: HTTPS present but missing sitemap, slow load, or minor crawl issues
   7–10: HTTPS, fast (LCP <2.5s), sitemap in GSC, clean robots.txt, no broken links

9. serp_gap (max 10):
   0–3: Major SERP topics completely uncovered, no gap analysis apparent
   4–6: Covers some competitor topics but significant gaps in format or depth remain
   7–10: Systematically covers all major topics from top-10 results, multiple content formats present

10. spam_risk (max 5):
    0–1: Clear spam signals — doorway pages, keyword stuffing, manipulative link patterns
    2–3: Minor risk signals — some thin content or borderline optimization
    4–5: Clean — natural link acquisition, quality content, no spam signals

═══ CRITICAL RULES ═══
A. seo_score at top level: set to 0 — the server computes it from score_breakdown. Do not waste tokens calculating it.
B. Every domain_audit suggestion (title_suggestion, meta_suggestion, priority_action, internal_link_suggestion) MUST represent an improvement that would INCREASE the relevant score. Score dimensions as if the suggestion is NOT YET implemented.
C. Strictly follow the rubrics above. Do not improvise or soften/harden scores based on general impressions.
══════════════════════

Respond ONLY with this exact JSON structure:
{
  "seo_score": 0,
  "score_breakdown": {
    "keyword_intent": <0-10>,
    "content_depth": <0-15>,
    "uniqueness": <0-10>,
    "eeat": <0-10>,
    "on_page_seo": <0-10>,
    "internal_linking": <0-10>,
    "entity_coverage": <0-10>,
    "technical_seo": <0-10>,
    "serp_gap": <0-10>,
    "spam_risk": <0-5>
  },
  "overall_assessment": "<2-3 sentence summary>",
  "serp_threat_level": <"low"|"medium"|"high"|"critical">,
  "domain_audits": [
    {
      "domain": "<domain>",
      "target_keyword": "<most likely target keyword>",
      "search_intent": <"informational"|"commercial"|"transactional"|"navigational">,
      "seo_score": 0,
      "main_problems": ["<problem 1>", "<problem 2>"],
      "content_gap": ["<gap 1>"],
      "entity_gap": ["<gap 1>"],
      "title_suggestion": "<suggested title tag>",
      "meta_suggestion": "<suggested meta description>",
      "internal_link_suggestion": "<suggestion>",
      "priority_action": "<single most important action>",
      "estimated_impact": <"High"|"Medium"|"Low">,
      "suggestions_status": [
        {"suggestion": "title_suggestion", "likely_implemented": <true|false>, "reasoning": "<brief evidence>"},
        {"suggestion": "meta_suggestion", "likely_implemented": <true|false>, "reasoning": "<brief evidence>"},
        {"suggestion": "priority_action", "likely_implemented": <true|false>, "reasoning": "<brief evidence>"}
      ]
    }
  ],
  "topical_cluster_advice": "<paragraph>",
  "brand_entity_advice": "<paragraph>",
  "quick_wins": ["<win 1>", "<win 2>", "<win 3>", "<win 4>"],
  "serp_strategy": "<paragraph>",
  "keyword_recommendations": ["<cluster 1>", "<cluster 2>", "<cluster 3>"]
}

Note: Include "suggestions_status" only when previous audit data was provided above. Omit it entirely for domains with no previous data.
Important: Only include up to 5 domains in domain_audits. Prioritize blocked/warning domains first.`;
}

router.get("/summary", async (req, res, next) => {
  try {
    await ensureAnalyticsCache();
    const cacheKey = "ai_summary_v1";
    const cached = (await pool.query(
      "SELECT result, created_at FROM analytics_cache WHERE cache_key=$1 AND created_at > NOW() - INTERVAL '6 hours'",
      [cacheKey]
    )).rows[0];
    if (cached) return res.json({ ...cached.result, cached: true, cached_at: cached.created_at });

    const ctx = await buildGlobalContext();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY not configured" });

    const OpenAI = require("openai");
    const openai = new OpenAI({ apiKey });

    const prompt = `You are a domain monitoring analyst AI. Analyze the following monitoring data and provide a concise, actionable summary in JSON format.

Domain Monitoring Data:
- Total domains: ${ctx.domain_summary.total}
- Working (normal): ${ctx.domain_summary.working}
- Warning: ${ctx.domain_summary.warning}
- Blocked: ${ctx.domain_summary.blocked}
- Projects monitored: ${ctx.projects.join(", ") || "None"}

Top failure reasons (last 7 days):
${ctx.top_reasons.map((r) => `  ${r.reason_type}: ${r.count} times`).join("\n") || "  No data"}

Recent status change alerts:
${ctx.recent_alerts.map((a) => `  ${a.domain || "unknown"} (${a.project_name || "-"}): ${a.old_status} → ${a.new_status}`).join("\n") || "  No alerts"}

Google Rank Defense:
- Total keyword groups: ${ctx.rank_groups.length}
- Total suspicious SERP results: ${ctx.total_suspicious_rank}

Respond ONLY with a JSON object:
{
  "health_score": <number 0-100>,
  "overall_status": <"healthy"|"warning"|"critical">,
  "summary": "<2-3 sentence overall summary>",
  "key_findings": ["<finding 1>", "<finding 2>", "<finding 3>"],
  "risk_areas": ["<risk 1>", "<risk 2>"],
  "recommendations": ["<action 1>", "<action 2>", "<action 3>"],
  "rank_defense_note": "<1 sentence about SERP/brand threats>"
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 800,
      temperature: 0.3,
    });

    let analysis = {};
    try { analysis = JSON.parse(completion.choices[0]?.message?.content || "{}"); }
    catch (_) { analysis = { summary: completion.choices[0]?.message?.content || "Analysis unavailable." }; }

    const result = { ...analysis, context: ctx, generated_at: new Date().toISOString() };
    await pool.query(
      `INSERT INTO analytics_cache (cache_key, result) VALUES ($1, $2::jsonb)
       ON CONFLICT (cache_key) DO UPDATE SET result=EXCLUDED.result, created_at=NOW()`,
      [cacheKey, JSON.stringify(result)]
    );
    res.json({ ...result, cached: false });
  } catch (err) { next(err); }
});

router.delete("/cache", async (req, res, next) => {
  try {
    await ensureAnalyticsCache();
    await pool.query("DELETE FROM analytics_cache WHERE cache_key='ai_summary_v1'");
    res.json({ ok: true });
  } catch (err) { next(err); }
});

const SCORE_MAXES = { keyword_intent: 10, content_depth: 15, uniqueness: 10, eeat: 10, on_page_seo: 10, internal_linking: 10, entity_coverage: 10, technical_seo: 10, serp_gap: 10, spam_risk: 5 };

function validateAndComputeScore(analysis) {
  const breakdown = analysis.score_breakdown || {};
  const validated = {};
  for (const [key, max] of Object.entries(SCORE_MAXES)) {
    const raw = typeof breakdown[key] === "number" ? breakdown[key] : 0;
    validated[key] = Math.max(0, Math.min(max, Math.round(raw)));
  }
  const total = Object.values(validated).reduce((a, b) => a + b, 0);
  return { validated, total };
}

router.get("/suggestion-completion", async (req, res, next) => {
  try {
    await ensureSuggestionCompletions();
    const { domain, project_name } = req.query;
    if (!domain) return res.status(400).json({ error: "domain required" });
    const rows = (await pool.query(
      "SELECT suggestion_key, marked_done FROM suggestion_completions WHERE domain=$1",
      [domain]
    )).rows;
    res.json({ completions: rows });
  } catch (err) { next(err); }
});

router.post("/suggestion-completion", async (req, res, next) => {
  try {
    await ensureSuggestionCompletions();
    const { domain, project_name = "", suggestion_key, marked_done } = req.body || {};
    if (!domain || !suggestion_key) return res.status(400).json({ error: "domain and suggestion_key required" });
    await pool.query(
      `INSERT INTO suggestion_completions (domain, project_name, suggestion_key, marked_done, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (domain, suggestion_key) DO UPDATE SET marked_done=$4, project_name=$2, updated_at=NOW()`,
      [domain, project_name, suggestion_key, !!marked_done]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/seo-audit", async (req, res, next) => {
  try {
    await ensureAnalyticsCache();
    const projectName = req.body?.project_name || "all";
    const cacheKeyV3 = `seo_audit_v3_${projectName}`;
    const cacheKeyV2 = `seo_audit_v2_${projectName}`;

    // Load previous audit (any age, v3 first then v2) for consistency context
    const prevRow = (await pool.query(
      `SELECT result FROM analytics_cache
       WHERE cache_key = ANY($1::text[])
       ORDER BY created_at DESC LIMIT 1`,
      [[cacheKeyV3, cacheKeyV2]]
    )).rows[0];
    const prevAudit = prevRow?.result || null;

    // Serve v3 fresh cache if within 24h
    const cached = (await pool.query(
      "SELECT result, created_at FROM analytics_cache WHERE cache_key=$1 AND created_at > NOW() - INTERVAL '24 hours'",
      [cacheKeyV3]
    )).rows[0];
    if (cached) return res.json({ ...cached.result, cached: true, cached_at: cached.created_at });

    const ctx = await buildProjectSeoContext(projectName);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY not configured. Add it in Replit Secrets." });

    // Load user-confirmed completions for the domains in this project
    let confirmedCompletions = [];
    try {
      await ensureSuggestionCompletions();
      const domainList = ctx.domains.map(d => d.domain);
      if (domainList.length > 0) {
        confirmedCompletions = (await pool.query(
          "SELECT domain, suggestion_key, marked_done FROM suggestion_completions WHERE domain = ANY($1) AND marked_done = true",
          [domainList]
        )).rows;
      }
    } catch (_) {}

    let completion;
    try {
      const OpenAI = require("openai");
      const openai = new OpenAI({ apiKey });
      completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: buildSeoPrompt(ctx, prevAudit, confirmedCompletions) }],
        response_format: { type: "json_object" },
        max_tokens: 2500,
        temperature: 0,
        seed: 42,
      });
    } catch (aiErr) {
      const status = aiErr?.status || aiErr?.statusCode || 500;
      let msg;
      if (status === 429) {
        const code = aiErr?.error?.code;
        if (code === "insufficient_quota") {
          msg = "OpenAI quota exceeded — your API key has no remaining credits. Add billing at platform.openai.com/account/billing.";
        } else {
          msg = "OpenAI rate limit hit — too many requests. Wait a minute and try again.";
        }
      } else if (status === 401) {
        msg = "Invalid OpenAI API key. Check your OPENAI_API_KEY secret.";
      } else {
        msg = aiErr?.error?.message || aiErr?.message || "OpenAI request failed.";
      }
      console.error("[SEO-AUDIT] OpenAI error:", status, msg);
      return res.status(502).json({ error: msg });
    }

    let analysis = {};
    try { analysis = JSON.parse(completion.choices[0]?.message?.content || "{}"); }
    catch (_) { analysis = { overall_assessment: "Analysis unavailable.", seo_score: 0 }; }

    // Server-side: validate breakdown, compute seo_score mathematically
    const { validated, total } = validateAndComputeScore(analysis);
    analysis.score_breakdown = validated;
    analysis.seo_score = total;

    // Clamp per-domain seo_score to valid range
    if (Array.isArray(analysis.domain_audits)) {
      analysis.domain_audits = analysis.domain_audits.map(d => ({
        ...d,
        seo_score: typeof d.seo_score === "number"
          ? Math.max(0, Math.min(100, Math.round(d.seo_score)))
          : total,
      }));
    }

    const result = { ...analysis, context: ctx, generated_at: new Date().toISOString() };
    await pool.query(
      `INSERT INTO analytics_cache (cache_key, result) VALUES ($1, $2::jsonb)
       ON CONFLICT (cache_key) DO UPDATE SET result=EXCLUDED.result, created_at=NOW()`,
      [cacheKeyV3, JSON.stringify(result)]
    );

    // Append to score history (never overwrites — one row per audit run)
    try {
      await ensureSeoScoreHistory();
      await pool.query(
        `INSERT INTO seo_score_history (project_name, seo_score, score_breakdown, generated_at)
         VALUES ($1, $2, $3::jsonb, NOW())`,
        [projectName, analysis.seo_score, JSON.stringify(analysis.score_breakdown || {})]
      );
    } catch (histErr) {
      console.error("[SEO-AUDIT] history insert error:", histErr?.message);
    }

    res.json({ ...result, cached: false });
  } catch (err) {
    console.error("[SEO-AUDIT] unexpected error:", err?.message);
    next(err);
  }
});

router.get("/seo-audit-cache", async (req, res, next) => {
  try {
    await ensureAnalyticsCache();
    const projectName = req.query?.project_name || "all";
    const cacheKey = `seo_audit_v3_${projectName}`;
    const cached = (await pool.query(
      "SELECT result, created_at FROM analytics_cache WHERE cache_key=$1 AND created_at > NOW() - INTERVAL '24 hours'",
      [cacheKey]
    )).rows[0];
    if (!cached) return res.status(204).end();
    res.json({ ...cached.result, cached: true, cached_at: cached.created_at });
  } catch (err) { next(err); }
});

router.get("/seo-score-history", async (req, res, next) => {
  try {
    await ensureSeoScoreHistory();
    const projectName = req.query?.project_name || "all";
    const limit = Math.min(parseInt(req.query?.limit || "10", 10), 50);
    const rows = (await pool.query(
      `SELECT id, seo_score, score_breakdown, generated_at
       FROM seo_score_history
       WHERE project_name = $1
       ORDER BY generated_at DESC
       LIMIT $2`,
      [projectName, limit]
    )).rows;
    res.json({ history: rows.reverse() });
  } catch (err) { next(err); }
});

router.delete("/seo-audit-cache", async (req, res, next) => {
  try {
    await ensureAnalyticsCache();
    const projectName = req.query?.project_name || req.body?.project_name || "all";
    await pool.query(
      "DELETE FROM analytics_cache WHERE cache_key = ANY($1::text[])",
      [[`seo_audit_v3_${projectName}`, `seo_audit_v2_${projectName}`]]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
