const express = require("express");
const { pool } = require("./db");
const { requireAuthenticatedScope } = require("./migrationSafety");

const router = express.Router();
// The staging schema and server scope must be verified before reading/writing projects.
router.use(requireAuthenticatedScope);

let _tableReady = false;

async function ensureProjectTable() {
  if (_tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS projects_name_lower_idx
      ON projects (LOWER(name))
    `);
  } catch (idxErr) {
    console.warn(
      "[projects] Could not create case-insensitive unique index (pre-existing duplicates likely):",
      idxErr.message
    );
  }
  _tableReady = true;
}

router.get("/", async (req, res, next) => {
  try {
    await ensureProjectTable();
    const { tenant, fleet } = req.migrationScope;
    const { rows } = await pool.query(`
      SELECT
        COALESCE(p.name, d.project_name, 'No Project') AS project_name,
        MIN(p.id) AS id,
        COALESCE(MAX(p.notes), '') AS notes,
        COUNT(d.id)::int AS total,
        COUNT(d.id) FILTER (WHERE d.global_status='working')::int AS working,
        COUNT(d.id) FILTER (WHERE d.global_status='warning')::int AS warning,
        COUNT(d.id) FILTER (WHERE d.global_status='blocked')::int AS blocked
      FROM (SELECT * FROM projects WHERE tenant=$1 AND fleet=$2) p
      FULL OUTER JOIN (SELECT * FROM domains WHERE tenant=$1 AND fleet=$2) d ON d.project_name = p.name
      GROUP BY COALESCE(p.name, d.project_name, 'No Project')
      ORDER BY total DESC, project_name ASC
    `, [tenant, fleet]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    await ensureProjectTable();
    const name = String(req.body.name || "").trim();
    const notes = String(req.body.notes || "").trim();
    if (!name) return res.status(400).json({ error: "Project name required" });
    const existing = await pool.query("SELECT name FROM projects WHERE LOWER(name)=LOWER($1) AND tenant=$2 AND fleet=$3", [name, req.migrationScope.tenant, req.migrationScope.fleet]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: `A project named "${existing.rows[0].name}" already exists` });
    }
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO projects (name, notes, tenant, fleet) VALUES ($1,$2,$3,$4) RETURNING *`,
        [name, notes, req.migrationScope.tenant, req.migrationScope.fleet]
      ));
    } catch (insertErr) {
      if (insertErr.code === "23505") {
        return res.status(409).json({ error: `A project named "${name}" already exists` });
      }
      throw insertErr;
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Renames/deletes cascade into some historical tables that lack tenant/fleet.
// Until reviewed schema migrations and mapping cover those tables, fail closed.
router.patch("/:name", (req, res) => res.status(503).json({
  error: "Project rename disabled until all dependent tables support tenant/fleet scope"
}));
router.delete("/:name", (req, res) => res.status(503).json({
  error: "Project delete disabled until all dependent tables support tenant/fleet scope"
}));

module.exports = router;
