const { pool } = require("./db");
const { ensureRankTables } = require("./rankRoutes");

async function seedDemoData() {
  try {
    await ensureRankTables();
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM rank_keyword_groups WHERE tenant='demo' LIMIT 1"
    );
    if (existing.length > 0) {
      console.log("[demo] Demo sandbox already present, skipping seed.");
      return;
    }
    console.log("[demo] Seeding demo sandbox data...");

    await pool.query(
      `INSERT INTO projects (name, notes, tenant)
       VALUES
         ('Alpha Gaming',    'Demo — brand monitoring for Alpha Gaming',  'demo'),
         ('BetaSlot Online', 'Demo — brand defense for BetaSlot Online', 'demo')
       ON CONFLICT (name) DO NOTHING`
    );

    await pool.query(`
      INSERT INTO domains (domain, project_name, global_status, last_status, last_checked_at, is_active, tenant)
      VALUES
        ('alphagaming88.com',   'Alpha Gaming',    'working', 'working', NOW() - INTERVAL '5 minutes',  true, 'demo'),
        ('alphagaming88.net',   'Alpha Gaming',    'working', 'working', NOW() - INTERVAL '7 minutes',  true, 'demo'),
        ('alphagaming88.org',   'Alpha Gaming',    'warning', 'warning', NOW() - INTERVAL '12 minutes', true, 'demo'),
        ('alphagaming-vip.com', 'Alpha Gaming',    'blocked', 'blocked', NOW() - INTERVAL '3 minutes',  true, 'demo'),
        ('betaslot.com',        'BetaSlot Online', 'working', 'working', NOW() - INTERVAL '8 minutes',  true, 'demo'),
        ('betaslot.net',        'BetaSlot Online', 'working', 'working', NOW() - INTERVAL '9 minutes',  true, 'demo'),
        ('betaslot99.com',      'BetaSlot Online', 'warning', 'warning', NOW() - INTERVAL '15 minutes', true, 'demo'),
        ('betaslot-login.com',  'BetaSlot Online', 'unknown', 'unknown', NOW() - INTERVAL '20 minutes', true, 'demo')
      ON CONFLICT (domain) DO NOTHING
    `);

    const g1 = await pool.query(`
      INSERT INTO rank_keyword_groups (project_name, keyword, keyword_lc, tenant, last_checked_at, is_active)
      VALUES ('Alpha Gaming', 'alphagaming88', 'alphagaming88', 'demo', NOW() - INTERVAL '30 minutes', true)
      ON CONFLICT (keyword_lc, tenant) DO NOTHING
      RETURNING id
    `);
    const g2 = await pool.query(`
      INSERT INTO rank_keyword_groups (project_name, keyword, keyword_lc, tenant, last_checked_at, is_active)
      VALUES ('BetaSlot Online', 'betaslot online', 'betaslot online', 'demo', NOW() - INTERVAL '45 minutes', true)
      ON CONFLICT (keyword_lc, tenant) DO NOTHING
      RETURNING id
    `);

    const alphaId = g1.rows[0]?.id;
    const betaId = g2.rows[0]?.id;

    if (alphaId) {
      await pool.query(`
        INSERT INTO rank_keyword_domains (group_id, domain, is_whitelisted, last_position, last_page, last_status)
        VALUES
          ($1, 'alphagaming88.com', true,  3,    1, 'found'),
          ($1, 'alphagaming88.net', true,  11,   2, 'found'),
          ($1, 'alphagaming88.org', true,  NULL, NULL, 'not_found')
        ON CONFLICT (group_id, domain) DO NOTHING
      `, [alphaId]);
      await pool.query(`
        INSERT INTO rank_scan_results (group_id, keyword, position, page, title, link, host, classification, reason)
        VALUES
          ($1, 'alphagaming88', 1, 1, 'AlphaGaming88 — Official Site',     'https://alphagaming88.com',             'alphagaming88.com',         'whitelisted',  'Matched monitored whitelist domain'),
          ($1, 'alphagaming88', 2, 1, 'AlphaGaming88 — Login',             'https://alphagaming88.net/login',        'alphagaming88.net',         'whitelisted',  'Matched monitored whitelist domain'),
          ($1, 'alphagaming88', 4, 1, 'Alpha88 Slot Hack Free Download',   'https://alpha88-hacks.info/slot',        'alpha88-hacks.info',        'suspicious',   'Non-whitelisted result contains brand/keyword signal'),
          ($1, 'alphagaming88', 5, 1, 'AlphaGaming Review 2024',           'https://casinoreview.io/alphagaming',    'casinoreview.io',           'external_safe','Matched allowed external platform'),
          ($1, 'alphagaming88', 7, 1, 'Mirror Alphagaming Terbaru',        'https://alpha-gaming-mirror.pages.dev', 'alpha-gaming-mirror.pages.dev','suspicious', 'Non-whitelisted result contains brand/keyword signal'),
          ($1, 'alphagaming88', 9, 1, 'AlphaGaming on YouTube',            'https://youtube.com/watch?v=abc123demo','youtube.com',               'external_safe','Matched allowed external platform')
      `, [alphaId]);
    }

    if (betaId) {
      await pool.query(`
        INSERT INTO rank_keyword_domains (group_id, domain, is_whitelisted, last_position, last_page, last_status)
        VALUES
          ($1, 'betaslot.com',   true,  1,    1,    'found'),
          ($1, 'betaslot.net',   true,  7,    1,    'found'),
          ($1, 'betaslot99.com', true,  NULL, NULL, 'not_found')
        ON CONFLICT (group_id, domain) DO NOTHING
      `, [betaId]);
      await pool.query(`
        INSERT INTO rank_scan_results (group_id, keyword, position, page, title, link, host, classification, reason)
        VALUES
          ($1, 'betaslot online', 1, 1, 'BetaSlot — Official Slot Games',     'https://betaslot.com',                  'betaslot.com',         'whitelisted',  'Matched monitored whitelist domain'),
          ($1, 'betaslot online', 3, 1, 'BetaSlot Phishing Login Page',        'https://betaslot-login.xyz/daftar',      'betaslot-login.xyz',   'suspicious',   'Non-whitelisted result contains brand/keyword signal'),
          ($1, 'betaslot online', 5, 1, 'betaslot online gratis no deposit',   'https://betaslot-bonus.top',             'betaslot-bonus.top',   'suspicious',   'Non-whitelisted result contains brand/keyword signal'),
          ($1, 'betaslot online', 6, 1, 'Play BetaSlot on YouTube',            'https://youtube.com/watch?v=betademo',   'youtube.com',          'external_safe','Matched allowed external platform'),
          ($1, 'betaslot online', 7, 1, 'BetaSlot.net — Alternatif Link',      'https://betaslot.net',                   'betaslot.net',         'whitelisted',  'Matched monitored whitelist domain')
      `, [betaId]);
    }

    console.log("[demo] Demo sandbox seeded successfully.");
  } catch (err) {
    console.error("[demo] Seed error:", err.message);
  }
}

module.exports = { seedDemoData };
