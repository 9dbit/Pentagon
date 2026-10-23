-- Pentagon legacy Replit vs Supabase schema inventory
-- SAFE: SELECT-only SQL. Run in Replit psql OR Supabase SQL Editor.
-- No credentials, node secret values, tokens, or user row contents returned.
--
-- One row per application table. Compare old/target schema; migrate through
-- staging, NOT by restoring a complete archive into Supabase production.

WITH public_tables AS (
  SELECT c.oid, c.relname AS table_name,
         c.relrowsecurity AS rls_enabled,
         c.relforcerowsecurity AS rls_forced
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
), columns_by_table AS (
  SELECT table_name,
         string_agg(
           format('%I:%s:%s:%s',
                  column_name,
                  CASE
                    WHEN data_type = 'USER-DEFINED' THEN udt_name
                    ELSE data_type
                  END,
                  CASE WHEN is_nullable = 'YES' THEN 'nullable' ELSE 'not_null' END,
                  CASE WHEN is_identity = 'YES' THEN 'identity' ELSE 'regular' END),
           ' | ' ORDER BY ordinal_position
         ) AS columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
  GROUP BY table_name
), constraints_by_table AS (
  SELECT conrelid,
         string_agg(
           CASE WHEN contype='p' THEN pg_get_constraintdef(oid) END,
           '; ' ORDER BY conname
         ) AS primary_keys,
         string_agg(
           CASE WHEN contype='f' THEN pg_get_constraintdef(oid) END,
           '; ' ORDER BY conname
         ) AS foreign_keys,
         count(*) FILTER (WHERE contype = 'f' AND NOT convalidated) AS invalid_foreign_keys
  FROM pg_constraint
  WHERE contype IN ('p','f')
  GROUP BY conrelid
)
SELECT t.table_name, t.rls_enabled, t.rls_forced,
       coalesce(c.columns,'') AS columns,
       coalesce(k.primary_keys,'') AS primary_keys,
       coalesce(k.foreign_keys,'') AS foreign_keys,
       coalesce(k.invalid_foreign_keys,0) AS invalid_foreign_keys
FROM public_tables AS t
LEFT JOIN columns_by_table AS c USING (table_name)
LEFT JOIN constraints_by_table AS k ON k.conrelid = t.oid
ORDER BY t.table_name;

-- Exact counts for tables known to exist in both source and destination.
-- These are NOT proof of parity without matching primary keys and row hashes.
SELECT 'alerts' AS table_name, count(*)::bigint AS rows FROM public.alerts
UNION ALL SELECT 'check_results', count(*) FROM public.check_results
UNION ALL SELECT 'domains', count(*) FROM public.domains
UNION ALL SELECT 'projects', count(*) FROM public.projects
UNION ALL SELECT 'provider_nodes', count(*) FROM public.provider_nodes
UNION ALL SELECT 'provider_node_tasks', count(*) FROM public.provider_node_tasks
UNION ALL SELECT 'rank_keyword_groups', count(*) FROM public.rank_keyword_groups
UNION ALL SELECT 'rank_scan_results', count(*) FROM public.rank_scan_results
ORDER BY table_name;

-- Count admin/demo for common tenant-scoped tables, without exposing any row.
SELECT 'domains' AS table_name, tenant, count(*) AS rows
FROM public.domains GROUP BY tenant
UNION ALL SELECT 'projects', tenant, count(*)
FROM public.projects GROUP BY tenant
UNION ALL SELECT 'provider_nodes', tenant, count(*)
FROM public.provider_nodes GROUP BY tenant
UNION ALL SELECT 'rank_keyword_groups', tenant, count(*)
FROM public.rank_keyword_groups GROUP BY tenant
ORDER BY table_name, tenant;

-- Preservation gate: all source history tables must exist or be explicitly
-- mapped into an alternative *durable* destination. A missing table is NOT
-- permission to discard its historical rows.
WITH expected(table_name, classification) AS (
  VALUES
    ('alerts', 'history'),
    ('check_results', 'history'),
    ('domains', 'business'),
    ('projects', 'business'),
    ('provider_node_tasks', 'history'),
    ('provider_node_task_events', 'history'),
    ('provider_nodes', 'business'),
    ('node_telemetry', 'history'),
    ('rank_keyword_groups', 'business'),
    ('rank_keyword_domains', 'business'),
    ('rank_scan_results', 'history'),
    ('shield_links', 'business'),
    ('pentagon_usage_logs', 'usage'),
    ('usage_logs', 'usage')
), present AS (
  SELECT c.oid, c.relname AS table_name
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind IN ('r','p')
), column_flags AS (
  SELECT table_name,
         bool_or(column_name='tenant') AS has_tenant,
         bool_or(column_name='fleet') AS has_fleet,
         max(udt_name) FILTER (WHERE column_name='id') AS id_type,
         bool_or(column_name='node_id') AS has_node_id,
         bool_or(column_name='domain_id') AS has_domain_id
  FROM information_schema.columns
  WHERE table_schema='public'
  GROUP BY table_name
)
SELECT e.table_name, e.classification,
       CASE WHEN p.oid IS NULL THEN 'MISSING_REQUIRES_MAPPING'
            ELSE 'PRESENT' END AS table_status,
       coalesce(c.has_tenant,false) AS has_tenant,
       coalesce(c.has_fleet,false) AS has_fleet,
       c.id_type,
       coalesce(c.has_node_id,false) AS has_node_id,
       coalesce(c.has_domain_id,false) AS has_domain_id
FROM expected e
LEFT JOIN present p USING (table_name)
LEFT JOIN column_flags c USING (table_name)
ORDER BY e.classification, e.table_name;

-- IDs in historical rows must be mapped consistently if old IDs collide
-- with rows already in Supabase. Inspect sequence ownership before any merge.
SELECT tbl.relname AS table_name,
       att.attname AS column_name,
       seq.relname AS owned_sequence
FROM pg_class seq
JOIN pg_depend dep ON dep.objid=seq.oid AND dep.deptype IN ('a','i')
JOIN pg_class tbl ON tbl.oid=dep.refobjid
JOIN pg_attribute att ON att.attrelid=tbl.oid AND att.attnum=dep.refobjsubid
JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
WHERE seq.relkind='S' AND ns.nspname='public'
ORDER BY tbl.relname, att.attname;
