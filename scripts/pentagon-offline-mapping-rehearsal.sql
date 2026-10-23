\set ON_ERROR_STOP on
-- OFFLINE rehearsal only. Requires a verified localhost restore on port 55432.
-- Does not connect to Supabase, Replit, Railway, or live provider nodes.
-- Only TEMP tables are created, and the transaction is ROLLED BACK.
BEGIN;
DO $guard$
BEGIN
  IF current_database()<>'pentagon_restore_test'
     OR current_user<>'pentagon_restore'
     OR host(inet_server_addr())<>'127.0.0.1'
     OR inet_server_port()<>55432 THEN
    RAISE EXCEPTION 'WRONG_DATABASE_STOP_NO_REHEARSAL';
  END IF;
  IF EXISTS (SELECT 1 FROM public.domains
      WHERE tenant IS NULL OR btrim(tenant)='' OR fleet IS NULL OR btrim(fleet)=''
        OR domain IS NULL OR btrim(domain)='') THEN
    RAISE EXCEPTION 'EMPTY_SCOPE_KEY_STOP';
  END IF;
END
$guard$;
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='5s';
SET LOCAL TIME ZONE 'UTC';

CREATE TEMP TABLE _pentagon_domain_map (
  legacy_domain_id integer PRIMARY KEY,
  tenant text NOT NULL,
  fleet text NOT NULL,
  normalized_domain text NOT NULL,
  UNIQUE (tenant, fleet, normalized_domain)
) ON COMMIT DROP;

-- First and second source->scope mapping passes: only source domain IDs.
WITH inserted AS (
  INSERT INTO _pentagon_domain_map(legacy_domain_id,tenant,fleet,normalized_domain)
  SELECT id,tenant,fleet,lower(btrim(domain)) FROM public.domains
  ON CONFLICT (legacy_domain_id) DO NOTHING
  RETURNING legacy_domain_id
)
SELECT count(*) AS domain_first_pass_inserts FROM inserted;
WITH inserted AS (
  INSERT INTO _pentagon_domain_map(legacy_domain_id,tenant,fleet,normalized_domain)
  SELECT id,tenant,fleet,lower(btrim(domain)) FROM public.domains
  ON CONFLICT (legacy_domain_id) DO NOTHING
  RETURNING legacy_domain_id
)
SELECT count(*) AS domain_second_pass_inserts FROM inserted;

CREATE TEMP TABLE _pentagon_historical_task_quarantine (
  legacy_task_id text PRIMARY KEY,
  node_id integer,
  task_tenant text,
  task_fleet text,
  source_status text,
  requires_tenant_review boolean NOT NULL,
  requires_fleet_review boolean NOT NULL,
  execution_allowed boolean NOT NULL DEFAULT false CHECK (execution_allowed = false)
) ON COMMIT DROP;

-- No live queue, provider-agent commands, or notifications.
WITH inserted AS (
  INSERT INTO _pentagon_historical_task_quarantine
      (legacy_task_id,node_id,task_tenant,task_fleet,source_status,
       requires_tenant_review,requires_fleet_review,execution_allowed)
  SELECT t.id,t.node_id,t.tenant,t.fleet,t.status,
         t.tenant IS DISTINCT FROM n.tenant,
         t.fleet IS DISTINCT FROM n.fleet,
         false
  FROM public.provider_node_tasks t
  LEFT JOIN public.provider_nodes n ON n.id=t.node_id
  ON CONFLICT (legacy_task_id) DO NOTHING
  RETURNING legacy_task_id
)
SELECT count(*) AS task_first_pass_inserts FROM inserted;
WITH inserted AS (
  INSERT INTO _pentagon_historical_task_quarantine
      (legacy_task_id,node_id,task_tenant,task_fleet,source_status,
       requires_tenant_review,requires_fleet_review,execution_allowed)
  SELECT t.id,t.node_id,t.tenant,t.fleet,t.status,
         t.tenant IS DISTINCT FROM n.tenant,
         t.fleet IS DISTINCT FROM n.fleet,
         false
  FROM public.provider_node_tasks t
  LEFT JOIN public.provider_nodes n ON n.id=t.node_id
  ON CONFLICT (legacy_task_id) DO NOTHING
  RETURNING legacy_task_id
)
SELECT count(*) AS task_second_pass_inserts FROM inserted;

DO $assert$
BEGIN
  IF (SELECT count(*) FROM _pentagon_domain_map)<>18 THEN
    RAISE EXCEPTION 'DOMAIN_MAP_COUNT_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM _pentagon_historical_task_quarantine)<>61483 THEN
    RAISE EXCEPTION 'TASK_QUARANTINE_COUNT_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM _pentagon_historical_task_quarantine
      WHERE requires_tenant_review)<>35392 THEN
    RAISE EXCEPTION 'TENANT_MISMATCH_REHEARSAL_BASELINE_CHANGED';
  END IF;
  IF (SELECT count(*) FROM _pentagon_historical_task_quarantine
      WHERE source_status IN ('queued','claimed'))<>1164 THEN
    RAISE EXCEPTION 'PENDING_TASK_REHEARSAL_BASELINE_CHANGED';
  END IF;
  IF EXISTS(SELECT 1 FROM _pentagon_historical_task_quarantine WHERE execution_allowed) THEN
    RAISE EXCEPTION 'TASK_REPLAY_NOT_QUARANTINED';
  END IF;
END
$assert$;

SELECT 'LOCAL_MAPPING_REHEARSAL_PASS' AS result,
       (SELECT count(*) FROM _pentagon_domain_map) AS domain_source_keys,
       (SELECT count(*) FROM _pentagon_historical_task_quarantine) AS historical_task_ids,
       (SELECT count(*) FROM _pentagon_historical_task_quarantine
        WHERE requires_tenant_review) AS cross_tenant_review_required,
       (SELECT count(*) FROM _pentagon_historical_task_quarantine
        WHERE requires_fleet_review) AS cross_fleet_review_required,
       (SELECT count(*) FROM _pentagon_historical_task_quarantine
        WHERE source_status IN ('queued','claimed')) AS pending_historical_tasks,
       (SELECT count(*) FROM _pentagon_historical_task_quarantine
        WHERE execution_allowed) AS executable_tasks;
ROLLBACK;
-- This is NOT a target mapping and NOT a dry-run against Supabase.
