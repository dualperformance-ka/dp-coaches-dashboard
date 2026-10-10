-- Verifies 20261010000001_strava_activity_reviews.sql. Run after applying it:
--   psql "$DATABASE_URL" -f supabase/tests/strava-activity-reviews.verify.sql
-- Rolls back everything it writes.

begin;

do $$
declare
  t text;
begin
  foreach t in array array['strava_activity_reviews'] loop
    if to_regclass('public.' || t) is null then
      raise exception '% table is missing', t;
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity
    ) then
      raise exception 'RLS is not enabled on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update') then
      raise exception 'client roles must not reach % directly', t;
    end if;
    if not has_table_privilege('service_role', 'public.' || t, 'select,insert,update,delete') then
      raise exception 'service_role is missing privileges on %', t;
    end if;
  end loop;
end $$;

-- Behaviour, against a throwaway athlete.
insert into public.athletes (code, name, active, coach, auth_mode, notifications_managed)
values ('ZZVERIFY', 'Verify Athlete', true, 'Karl', 'code', true)
on conflict (code) do nothing;

do $$
begin
  -- One activity can confirm only one session.
  insert into public.strava_activity_reviews (athlete_code, strava_activity_id, session_key, decision, decided_by)
  values ('ZZVERIFY', 101, 'session-a', 'confirmed', 'KARL');
  begin
    insert into public.strava_activity_reviews (athlete_code, strava_activity_id, session_key, decision, decided_by)
    values ('ZZVERIFY', 101, 'session-b', 'confirmed', 'KARL');
    raise exception 'one activity confirmed two sessions';
  exception when unique_violation then null;
  end;

  -- One session can be confirmed by only one activity.
  begin
    insert into public.strava_activity_reviews (athlete_code, strava_activity_id, session_key, decision, decided_by)
    values ('ZZVERIFY', 202, 'session-a', 'confirmed', 'KARL');
    raise exception 'one session was confirmed by two activities';
  exception when unique_violation then null;
  end;

  -- Rejections are not limited.
  insert into public.strava_activity_reviews (athlete_code, strava_activity_id, session_key, decision, decided_by)
  values ('ZZVERIFY', 101, 'session-b', 'rejected', 'KARL'),
         ('ZZVERIFY', 101, 'session-c', 'rejected', 'KARL');
end $$;

rollback;
