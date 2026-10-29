ALTER TABLE check_results ADD COLUMN IF NOT EXISTS node_id INTEGER;
CREATE INDEX IF NOT EXISTS check_results_domain_node_recent_idx
  ON check_results(domain_id,node_id,checked_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS shield_links (
  id UUID PRIMARY KEY,
  tenant TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE CHECK(slug ~ '^[a-zA-Z0-9_-]{8,40}$'),
  label TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  primary_url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  redirect_count BIGINT NOT NULL DEFAULT 0,
  last_redirect_at TIMESTAMPTZ,
  last_target_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shield_links_tenant_idx ON shield_links(tenant);
CREATE TABLE IF NOT EXISTS shield_link_domains (
  id UUID PRIMARY KEY,
  link_id UUID NOT NULL REFERENCES shield_links(id) ON DELETE CASCADE,
  domain_url TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1 CHECK(priority BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(link_id,domain_url)
);
CREATE INDEX IF NOT EXISTS shield_link_domains_order_idx ON shield_link_domains(link_id,priority,created_at);
ALTER TABLE shield_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_link_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON shield_links,shield_link_domains FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON shield_links,shield_link_domains FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON shield_links,shield_link_domains FROM authenticated;
  END IF;
END $$;
