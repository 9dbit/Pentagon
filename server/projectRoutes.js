const express = require("express");
const { pool } = require("./db");

const router = express.Router();

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
    const tenant = req.tenant || 'admin';
    const { rows } = await pool.query(`
      SELECT
        COALESCE(p.name, d.project_name, 'No Project') AS project_name,
        MIN(p.id) AS id,
        COALESCE(MAX(p.notes), '') AS notes,
        COUNT(d.id)::int AS total,
        COUNT(d.id) FILTER (WHERE d.global_status='working')::int AS working,
        COUNT(d.id) FILTER (WHERE d.global_status='warning')::int AS warning,
        COUNT(d.id) FILTER (WHERE d.global_status='blocked')::int AS blocked
      FROM (SELECT * FROM projects WHERE tenant=$1) p
      FULL OUTER JOIN (SELECT * FROM domains WHERE tenant=$1) d ON d.project_name = p.name
      GROUP BY COALESCE(p.name, d.project_name, 'No Project')
      ORDER BY total DESC, project_name ASC
    `, [tenant]);
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
    const existing = await pool.query("SELECT name FROM projects WHERE LOWER(name)=LOWER($1)", [name]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: `A project named "${existing.rows[0].name}" already exists` });
    }
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO projects (name, notes, tenant) VALUES ($1,$2,$3) RETURNING *`,
        [name, notes, req.tenant || 'admin']
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

router.patch("/:name", async (req, res, next) => {
  try {
    await ensureProjectTable();
    const oldName = String(req.params.name || "").trim();
    const newName = String(req.body.name || "").trim();
    if (!oldName || !newName) return res.status(400).json({ error: "Old and new project names required" });
    if (oldName === newName) return res.json({ ok: true });

    const existing = await pool.query(
      "SELECT name FROM projects WHERE LOWER(name)=LOWER($1) AND LOWER(name)!=LOWER($2)",
      [newName, oldName]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: `A project named "${existing.rows[0].name}" already exists` });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      try {
        await client.query("UPDATE projects SET name=$1 WHERE name=$2", [newName, oldName]);
      } catch (updateErr) {
        await client.query("ROLLBACK");
        client.release();
        if (updateErr.code === "23505") {
          return res.status(409).json({ error: `A project named "${newName}" already exists` });
        }
        throw updateErr;
      }
      await client.query("UPDATE domains SET project_name=$1 WHERE project_name=$2", [newName, oldName]);

      try {
        await client.query("UPDATE seo_score_history SET project_name=$1 WHERE project_name=$2", [newName, oldName]);
      } catch (_) {}

      try {
        await client.query("UPDATE suggestion_completions SET project_name=$1 WHERE project_name=$2", [newName, oldName]);
      } catch (_) {}

      try {
        await client.query("UPDATE rank_keyword_groups SET project_name=$1 WHERE project_name=$2", [newName, oldName]);
      } catch (_) {}

      try {
        await client.query("UPDATE project_telegram_groups SET project_name=$1 WHERE project_name=$2", [newName, oldName]);
      } catch (_) {}

      try {
        await client.query(
          `UPDATE analytics_cache
           SET cache_key = REPLACE(cache_key, $1, $2)
           WHERE cache_key LIKE $3`,
          [oldName, newName, `%_${oldName}`]
        );
      } catch (_) {}

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:name", async (req, res, next) => {
  try {
    await ensureProjectTable();
    const name = String(req.params.name || "").trim();
    await pool.query("DELETE FROM projects WHERE name=$1", [name]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
