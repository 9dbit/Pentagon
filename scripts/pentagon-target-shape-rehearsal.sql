\set ON_ERROR_STOP on
-- OFFLINE TEST ONLY: target-like SQL shape based on the signed-off
-- 2026-10-13 target catalog. Does NOT import into Supabase and does NOT
-- recreate target extensions, defaults, triggers, RLS policies, or target rows.
-- PostgreSQL local endpoint must be 127.0.0.1:55432, db pentagon_restore_test.
-- All structures are created in one transaction and ROLLED BACK.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL statement_timeout='180s';
SET LOCAL lock_timeout='5s';
SET LOCAL TIME ZONE 'UTC';
DO $guard$
BEGIN
  IF current_database()<>'pentagon_restore_test'
    OR current_user<>'pentagon_restore'
    OR host(inet_server_addr())<>'127.0.0.1'
    OR inet_server_port()<>55432
    OR current_setting('transaction_isolation')<>'repeatable read'
    OR current_setting('transaction_read_only')<>'off'
    OR to_regnamespace('pentagon_target_shape_trial') IS NOT NULL THEN
    RAISE EXCEPTION 'ISOLATED_LOCAL_IDENTITY_GUARD_FAILED';
  END IF;
  IF (SELECT count(*) FROM public.domains)<>18
    OR (SELECT count(*) FROM public.check_results)<>84872
    OR (SELECT count(*) FROM public.provider_node_tasks)<>61483
    OR (SELECT count(*) FROM public.provider_node_task_events)<>37989 THEN
    RAISE EXCEPTION 'SOURCE_ARCHIVE_BASELINE_CHANGED';
  END IF;
END
$guard$;

CREATE SCHEMA pentagon_target_shape_trial;
-- Target domain shape from 13 October catalog.
CREATE TABLE pentagon_target_shape_trial.domains(
 id integer NOT NULL PRIMARY KEY,
 domain text NOT NULL,
 project_name text,
 is_active boolean,
 global_status text,
 last_status text,
 last_checked_at timestamp without time zone,
 created_at timestamp without time zone,
 label text,
 tenant text NOT NULL,
 CONSTRAINT domains_domain_key UNIQUE(domain)
);
-- An unmodified direct import must fail due to 9 duplicate domain names.
DO $expected$
DECLARE rejected boolean:=false;
BEGIN
 BEGIN
   INSERT INTO pentagon_target_shape_trial.domains
   (id,domain,project_name,is_active,global_status,last_status,
    last_checked_at,created_at,label,tenant)
   SELECT id,domain,project_name,is_active,global_status,last_status,
     last_checked_at,created_at,label,tenant FROM public.domains;
 EXCEPTION WHEN unique_violation THEN
   rejected:=true;
 END;
 IF NOT rejected THEN
   RAISE EXCEPTION 'TARGET_GLOBAL_DOMAIN_UNIQUE_DID_NOT_REJECT_SOURCE';
 END IF;
 IF (SELECT count(*) FROM pentagon_target_shape_trial.domains)<>0 THEN
   RAISE EXCEPTION 'FAILED_IMPORT_LEFT_ROWS';
 END IF;
END
$expected$;
\echo EXPECTED_GLOBAL_DOMAIN_UNIQUE_VIOLATION_CONFIRMED

-- Rehearse an approved *hypothetical* scoped shape on the EMPTY local clone.
-- This does NOT authorize production constraint changes.
ALTER TABLE pentagon_target_shape_trial.domains
 DROP CONSTRAINT domains_domain_key;
ALTER TABLE pentagon_target_shape_trial.domains ADD COLUMN fleet text;
ALTER TABLE pentagon_target_shape_trial.domains
 ALTER COLUMN fleet SET NOT NULL;
CREATE UNIQUE INDEX domains_scoped_rehearsal_key
 ON pentagon_target_shape_trial.domains
 (tenant,fleet,lower(btrim(domain)));
WITH inserted AS (
 INSERT INTO pentagon_target_shape_trial.domains
 (id,domain,project_name,is_active,global_status,last_status,
  last_checked_at,created_at,label,tenant,fleet)
 SELECT id,domain,project_name,is_active,global_status,last_status,
  last_checked_at,created_at,label,tenant,fleet FROM public.domains
 RETURNING id
)
SELECT 'DOMAIN_FIRST_INSERT' AS audit,count(*) AS count FROM inserted;
WITH inserted AS (
 INSERT INTO pentagon_target_shape_trial.domains
 (id,domain,project_name,is_active,global_status,last_status,
  last_checked_at,created_at,label,tenant,fleet)
 SELECT id,domain,project_name,is_active,global_status,last_status,
  last_checked_at,created_at,label,tenant,fleet FROM public.domains
 ON CONFLICT (id) DO NOTHING RETURNING id
)
SELECT 'DOMAIN_SECOND_INSERT' AS audit,count(*) AS count FROM inserted;

-- Target check_results shape from 13 October catalog (no tenant/fleet/reason_type,
-- checked_at without timezone).
CREATE TABLE pentagon_target_shape_trial.check_results(
 id integer NOT NULL PRIMARY KEY,
 domain_id integer REFERENCES pentagon_target_shape_trial.domains(id) ON DELETE CASCADE,
 checker_type text NOT NULL,
 provider_name text NOT NULL,
 status text NOT NULL,
 http_status integer,
 final_url text,
 dns_result text,
 latency_ms integer,
 reason text,
 checked_at timestamp without time zone
);
-- Local candidate compatibility changes before copying any rows.
ALTER TABLE pentagon_target_shape_trial.check_results
 ADD COLUMN tenant text,
 ADD COLUMN fleet text,
 ADD COLUMN reason_type text;
ALTER TABLE pentagon_target_shape_trial.check_results
 ALTER COLUMN checked_at TYPE timestamp with time zone
 USING checked_at AT TIME ZONE 'UTC';
WITH inserted AS (
 INSERT INTO pentagon_target_shape_trial.check_results
 (id,domain_id,checker_type,provider_name,status,http_status,final_url,
  dns_result,latency_ms,reason,checked_at,tenant,fleet,reason_type)
 SELECT c.id,c.domain_id,c.checker_type,c.provider_name,c.status,c.http_status,
  c.final_url,c.dns_result,c.latency_ms,c.reason,c.checked_at,
  c.tenant,c.fleet,c.reason_type
 FROM public.check_results c
 JOIN pentagon_target_shape_trial.domains d
  ON d.id=c.domain_id AND d.tenant=c.tenant AND d.fleet=c.fleet
 RETURNING id
)
SELECT 'CHECKS_FIRST_INSERT' AS audit,count(*) AS count FROM inserted;
WITH inserted AS (
 INSERT INTO pentagon_target_shape_trial.check_results
 (id,domain_id,checker_type,provider_name,status,http_status,final_url,
  dns_result,latency_ms,reason,checked_at,tenant,fleet,reason_type)
 SELECT c.id,c.domain_id,c.checker_type,c.provider_name,c.status,c.http_status,
  c.final_url,c.dns_result,c.latency_ms,c.reason,c.checked_at,
  c.tenant,c.fleet,c.reason_type
 FROM public.check_results c
 JOIN pentagon_target_shape_trial.domains d
  ON d.id=c.domain_id AND d.tenant=c.tenant AND d.fleet=c.fleet
 ON CONFLICT(id) DO NOTHING RETURNING id
)
SELECT 'CHECKS_SECOND_INSERT' AS audit,count(*) AS count FROM inserted;

-- Historical tasks are NEVER written into a live queue.
CREATE TABLE pentagon_target_shape_trial.task_history_quarantine(
 task_id text NOT NULL PRIMARY KEY,
 node_id integer,
 tenant text,
 fleet text,
 source_status text,
 execution_allowed boolean NOT NULL DEFAULT false
   CHECK (execution_allowed=false)
);
WITH inserted AS (
 INSERT INTO pentagon_target_shape_trial.task_history_quarantine
 (task_id,node_id,tenant,fleet,source_status,execution_allowed)
 SELECT id,node_id,tenant,fleet,status,false
 FROM public.provider_node_tasks RETURNING task_id
)
SELECT 'HISTORICAL_TASKS_FIRST_INSERT' AS audit,count(*) AS count FROM inserted;
WITH inserted AS (
 INSERT INTO pentagon_target_shape_trial.task_history_quarantine
 (task_id,node_id,tenant,fleet,source_status,execution_allowed)
 SELECT id,node_id,tenant,fleet,status,false
 FROM public.provider_node_tasks ON CONFLICT (task_id) DO NOTHING
 RETURNING task_id
)
SELECT 'HISTORICAL_TASKS_SECOND_INSERT' AS audit,count(*) AS count FROM inserted;

DO $assert$
DECLARE n bigint;
BEGIN
 IF (SELECT count(*) FROM pentagon_target_shape_trial.domains)<>18 OR
    (SELECT count(*) FROM pentagon_target_shape_trial.check_results)<>84872 OR
    (SELECT count(*) FROM pentagon_target_shape_trial.task_history_quarantine)<>61483 THEN
   RAISE EXCEPTION 'TRIAL_COPY_COUNT_MISMATCH';
 END IF;
 SELECT count(*) INTO n FROM public.domains s
 FULL JOIN pentagon_target_shape_trial.domains t USING(id)
 WHERE s.id IS NULL OR t.id IS NULL OR
 ROW(s.domain,s.tenant,s.fleet,s.project_name,s.is_active,s.global_status,
 s.last_status,s.last_checked_at,s.created_at,s.label) IS DISTINCT FROM
 ROW(t.domain,t.tenant,t.fleet,t.project_name,t.is_active,t.global_status,
 t.last_status,t.last_checked_at,t.created_at,t.label);
 IF n<>0 THEN RAISE EXCEPTION 'DOMAIN_FIELD_PARITY_FAILED';END IF;
 SELECT count(*) INTO n FROM public.check_results s
 FULL JOIN pentagon_target_shape_trial.check_results t USING(id)
 WHERE s.id IS NULL OR t.id IS NULL OR
 ROW(s.domain_id,s.checker_type,s.provider_name,s.status,s.http_status,
 s.final_url,s.dns_result,s.latency_ms,s.reason,s.checked_at,
 s.tenant,s.fleet,s.reason_type) IS DISTINCT FROM
 ROW(t.domain_id,t.checker_type,t.provider_name,t.status,t.http_status,
 t.final_url,t.dns_result,t.latency_ms,t.reason,t.checked_at,
 t.tenant,t.fleet,t.reason_type);
 IF n<>0 THEN RAISE EXCEPTION 'CHECK_RESULTS_FIELD_PARITY_FAILED';END IF;
 IF (SELECT count(*) FROM pentagon_target_shape_trial.task_history_quarantine
     WHERE source_status IN ('queued','claimed'))<>1164 OR
    (SELECT count(*) FROM pentagon_target_shape_trial.task_history_quarantine
     WHERE execution_allowed)<>0 THEN
   RAISE EXCEPTION 'HISTORICAL_REPLAY_NOT_BLOCKED';
 END IF;
 IF (SELECT count(*) FROM public.provider_node_tasks t
     JOIN public.provider_nodes n ON t.node_id=n.id
     WHERE t.tenant IS DISTINCT FROM n.tenant)<>35392 THEN
   RAISE EXCEPTION 'CROSS_TENANT_AUDIT_CHANGED';
 END IF;
END
$assert$;
SELECT 'OFFLINE_SHAPE_REHEARSAL_PASS' AS outcome,
 (SELECT count(*) FROM pentagon_target_shape_trial.domains) AS scoped_domains,
 (SELECT count(*) FROM pentagon_target_shape_trial.check_results) AS check_results,
 (SELECT count(*) FROM pentagon_target_shape_trial.task_history_quarantine) AS quarantined_tasks,
 (SELECT count(*) FROM pentagon_target_shape_trial.task_history_quarantine WHERE source_status IN ('queued','claimed')) AS pending_tasks,
 (SELECT count(*) FROM pentagon_target_shape_trial.task_history_quarantine WHERE execution_allowed) AS executable_tasks;
ROLLBACK;
SELECT CASE WHEN to_regnamespace('pentagon_target_shape_trial') IS NULL
 THEN 'ROLLBACK_CONFIRMED_NO_PERSISTENT_SCHEMA'
 ELSE 'ROLLBACK_FAILED_SCHEMA_STILL_EXISTS'
 END AS cleanup_verification;
