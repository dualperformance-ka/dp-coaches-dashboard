-- RELEASE ORDER MATTERS:
-- Apply only after portal v80 (authenticated /api/portal-data gateway) and any
-- coach-dashboard server gateway are live. Applying this first will correctly
-- block every legacy anonymous browser query.

begin;

-- Athlete-owned compatibility data: retain the existing authenticated
-- ownership policies, remove every anonymous/public bypass.
drop policy if exists "Anon insert athlete_data" on public.athlete_data;
drop policy if exists "Anon read athlete_data" on public.athlete_data;
drop policy if exists "Anon update athlete_data" on public.athlete_data;
drop policy if exists "legacy anon client can sync athlete data" on public.athlete_data;

drop policy if exists "Anon insert session_logs" on public.session_logs;
drop policy if exists "Anon read session_logs" on public.session_logs;
drop policy if exists "legacy anon client can sync session logs" on public.session_logs;

revoke all on public.athlete_data from anon;
revoke all on public.session_logs from anon;
grant select, insert, update on public.athlete_data to authenticated;
grant select, insert, update on public.session_logs to authenticated;

-- Coach-authored programme data is now served through scoped server routes.
-- Browsers no longer require table grants or permissive RLS policies.
drop policy if exists "public_delete" on public.planned_sessions;
drop policy if exists "public_read" on public.planned_sessions;
drop policy if exists "public_update" on public.planned_sessions;
drop policy if exists "public_write" on public.planned_sessions;

drop policy if exists "public_delete" on public.nutrition_plans;
drop policy if exists "public_read" on public.nutrition_plans;
drop policy if exists "public_update" on public.nutrition_plans;
drop policy if exists "public_write" on public.nutrition_plans;

drop policy if exists "public_delete" on public.session_library;
drop policy if exists "public_read" on public.session_library;
drop policy if exists "public_update" on public.session_library;
drop policy if exists "public_write" on public.session_library;

drop policy if exists "public_delete" on public.session_overrides;
drop policy if exists "public_read" on public.session_overrides;
drop policy if exists "public_update" on public.session_overrides;
drop policy if exists "public_write" on public.session_overrides;

drop policy if exists "public_delete" on public.workout_splits;
drop policy if exists "public_read" on public.workout_splits;
drop policy if exists "public_update" on public.workout_splits;
drop policy if exists "public_write" on public.workout_splits;

revoke all on public.planned_sessions from anon, authenticated;
revoke all on public.nutrition_plans from anon, authenticated;
revoke all on public.session_library from anon, authenticated;
revoke all on public.session_overrides from anon, authenticated;
revoke all on public.workout_splits from anon, authenticated;

-- Administrative SECURITY DEFINER RPCs must never be callable through a
-- browser token. Coach/server operations use the service role.
revoke execute on function public.archive_athlete(text) from public, anon, authenticated;
revoke execute on function public.restore_athlete(text) from public, anon, authenticated;
revoke execute on function public.provision_athlete(text, text, text, date) from public, anon, authenticated;
revoke execute on function public.reconcile_active_athletes(boolean) from public, anon, authenticated;
grant execute on function public.archive_athlete(text) to service_role;
grant execute on function public.restore_athlete(text) to service_role;
grant execute on function public.provision_athlete(text, text, text, date) to service_role;
grant execute on function public.reconcile_active_athletes(boolean) to service_role;

-- The ownership helper is required by authenticated RLS policies, but not anon.
revoke execute on function public.current_athlete_code() from public, anon;
grant execute on function public.current_athlete_code() to authenticated, service_role;

-- Ensure the status view enforces the querying role's permissions.
alter view if exists public.notify_status set (security_invoker = true);

commit;
