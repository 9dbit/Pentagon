-- Pentagon: trusted external registry snapshot bridge, audit-only.
-- Never changes domain status or emits BLOCKED/Telegram alerts.
CREATE TABLE IF NOT EXISTS public.trustpositif_registry_bridge_audit (
  id BIGSERIAL PRIMARY KEY,
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_url TEXT NOT NULL,
  source_bytes BIGINT NOT NULL CHECK (source_bytes>=10000000),
  source_entries BIGINT NOT NULL CHECK (source_entries>=100000),
  source_checked_at TIMESTAMPTZ NOT NULL,
  inventory_count INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL,
  listed_count INTEGER NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.trustpositif_registry_bridge_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trustpositif_registry_bridge_audit FROM anon,authenticated;
REVOKE ALL ON SEQUENCE public.trustpositif_registry_bridge_audit_id_seq FROM anon,authenticated;
CREATE INDEX IF NOT EXISTS idx_tp_bridge_imported_at
ON public.trustpositif_registry_bridge_audit(imported_at DESC);
