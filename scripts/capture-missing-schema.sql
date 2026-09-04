-- Captures the DDL for the tables that exist only in the live database.
--
-- public.athletes and public.applications have NO `create table` anywhere in
-- supabase/migrations/. athletes is the roster — the identity boundary every
-- other table's athlete_code refers to — so a rebuild from migrations produces a
-- database that cannot function.
--
-- These cannot be reconstructed by reading the application code without guessing
-- at column types, defaults, constraints and indexes. Run this in the Supabase
-- SQL editor, export the single text column, and save it as a new migration:
--     supabase/migrations/<timestamp>_reconcile_roster_tables.sql
--
-- Guarded with `create table if not exists`, so applying it to production is a
-- no-op and it only does work on a fresh rebuild.

with cols as (
  select
    c.relname as table_name,
    string_agg(
      format('  %I %s%s%s',
        a.attname,
        format_type(a.atttypid, a.atttypmod),
        case when a.attnotnull then ' not null' else '' end,
        case when d.adbin is not null
             then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end),
      e',\n' order by a.attnum) as column_lines
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relname in ('athletes', 'applications')
  group by c.relname
),
constraints as (
  select c.relname as table_name,
         string_agg(format('alter table public.%I add constraint %I %s;',
           c.relname, con.conname, pg_get_constraintdef(con.oid)), e'\n') as lines
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('athletes', 'applications')
  group by c.relname
),
indexes as (
  select tablename as table_name, string_agg(indexdef || ';', e'\n') as lines
  from pg_indexes
  where schemaname = 'public' and tablename in ('athletes', 'applications')
  group by tablename
)
select string_agg(block, e'\n\n' order by block) as migration_sql
from (
  select format(
    e'create table if not exists public.%I (\n%s\n);\n\n-- constraints\n%s\n\n-- indexes\n%s',
    cols.table_name, cols.column_lines,
    coalesce(constraints.lines, '-- none'),
    coalesce(indexes.lines, '-- none')
  ) as block
  from cols
  left join constraints using (table_name)
  left join indexes using (table_name)
) blocks;

-- Also worth capturing while you are here — RLS state on those two tables,
-- which this script does not emit:
--   select tablename, rowsecurity from pg_tables
--    where schemaname='public' and tablename in ('athletes','applications');
--   select tablename, policyname, roles, cmd, qual, with_check from pg_policies
--    where schemaname='public' and tablename in ('athletes','applications');
