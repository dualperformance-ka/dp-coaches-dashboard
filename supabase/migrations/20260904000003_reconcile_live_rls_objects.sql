-- Reconciles into version control three objects that exist ONLY in the live
-- database. Verified against production on 2026-09-04 (see README-run-me.md).
--
-- Applying this to production is a no-op: every statement is guarded to create
-- only what is missing, so a correct live object is never replaced by this
-- file's reconstruction of it. Its purpose is to make a rebuild from migrations
-- reproduce the protection that production already has.
--
-- Why they were missing: 202606240001 created permissive `using (true)` policies
-- on these tables, 20260727085203 tried to drop them by names that were never
-- used, and someone later replaced them properly — without leaving a migration.
-- Anyone auditing from the files alone concludes these tables are wide open.
-- They are not.

-- ── public.current_athlete_code() ────────────────────────────────────────────
-- Resolves the signed-in user to their athlete code via auth.uid(), the JWT
-- subject, which a client cannot forge. Deliberately does NOT read user_metadata
-- (which a user can rewrite via supabase.auth.updateUser()).
--
-- NOTE: reconstructed from pg_get_functiondef + prosrc. The security_definer
-- flag, search_path, and body were read from production; `returns text`,
-- `language sql`, `stable` and the trailing `limit 1` are inferred from usage.
-- Because of the guard below this text is only ever used on a fresh rebuild.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'current_athlete_code'
  ) then
    execute $fn$
      create function public.current_athlete_code()
      returns text
      language sql
      stable
      security definer
      set search_path to 'public'
      as $body$
        select code from public.athletes where auth_user_id = auth.uid() limit 1
      $body$;
    $fn$;
    raise notice 'created public.current_athlete_code()';
  else
    raise notice 'public.current_athlete_code() already exists — left untouched';
  end if;
end $$;

revoke execute on function public.current_athlete_code() from public, anon;
grant execute on function public.current_athlete_code() to authenticated, service_role;

-- ── Row-scoped policies (verbatim from production) ───────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'athlete_data'
      and policyname = 'athlete syncs own data'
  ) then
    execute $p$
      create policy "athlete syncs own data" on public.athlete_data
        for all to authenticated
        using (athlete_code = current_athlete_code())
        with check (athlete_code = current_athlete_code() and key is not null);
    $p$;
    raise notice 'created policy "athlete syncs own data"';
  else
    raise notice 'policy "athlete syncs own data" already exists — left untouched';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_logs'
      and policyname = 'athlete syncs own session logs'
  ) then
    execute $p$
      create policy "athlete syncs own session logs" on public.session_logs
        for all to authenticated
        using (athlete_code = current_athlete_code())
        with check (athlete_code = current_athlete_code() and session_key is not null);
    $p$;
    raise notice 'created policy "athlete syncs own session logs"';
  else
    raise notice 'policy "athlete syncs own session logs" already exists — left untouched';
  end if;
end $$;

alter table public.athlete_data enable row level security;
alter table public.session_logs enable row level security;
