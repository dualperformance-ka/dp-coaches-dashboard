-- Apply after programming-schema.fixture.sql, the 20260815 programming
-- migrations, and 20260817052406_coach_owned_weekly_sport_targets.sql.
-- Re-apply the target migration once before this file to prove idempotency.

do $$
declare
  running_count integer;
  running_distance bigint;
  running_state text;
  target_id uuid;
  target_week uuid;
  coach_id uuid;
  audit_coach text;
  denied boolean := false;
begin
  select count(*), min(distance_target_metres), min(publish_state)
    into running_count, running_distance, running_state
    from public.weekly_sport_targets
   where athlete_code = 'JORDAN' and sport = 'running';

  if running_count <> 1 then
    raise exception 'FAIL: idempotent legacy migration produced % running rows', running_count;
  end if;
  if running_distance <> 0 or running_state <> 'published' then
    raise exception 'FAIL: legacy zero was not preserved as a published target';
  end if;
  if (select weekly_km_target from public.nutrition_plans where athlete_code = 'JORDAN' and week_label = 'Week 4') <> 0 then
    raise exception 'FAIL: migration changed the legacy nutrition value';
  end if;

  if has_table_privilege('anon', 'public.weekly_sport_targets', 'select')
     or has_table_privilege('anon', 'public.weekly_sport_targets', 'insert')
     or has_table_privilege('authenticated', 'public.weekly_sport_targets', 'update')
     or has_table_privilege('authenticated', 'public.weekly_sport_targets', 'delete') then
    raise exception 'FAIL: browser role has direct weekly_sport_targets privileges';
  end if;
  if not has_table_privilege('service_role', 'public.weekly_sport_targets', 'select')
     or not has_table_privilege('service_role', 'public.weekly_sport_targets', 'insert')
     or not has_table_privilege('service_role', 'public.weekly_sport_targets', 'update')
     or has_table_privilege('service_role', 'public.weekly_sport_targets', 'delete') then
    raise exception 'FAIL: service_role privilege set is not select/insert/update only';
  end if;

  select id, programme_week_id into target_id, target_week
    from public.weekly_sport_targets
   where athlete_code = 'JORDAN' and sport = 'running';
  select id into coach_id from public.coaches where handle = 'KARL';

  insert into public.weekly_sport_targets (
    athlete_code, programme_week_id, sport, distance_target_metres,
    session_target, duration_target_minutes, coach_note, publish_state,
    published_at, updated_by
  ) values (
    'JORDAN', target_week, 'cycling', 40000, 2, 90,
    'Aerobic only', 'published', now(), coach_id
  );
  insert into public.weekly_sport_targets (
    athlete_code, programme_week_id, sport, distance_target_metres,
    publish_state, published_at, updated_by
  ) values (
    'JORDAN', target_week, 'swimming', 1500, 'draft', null, coach_id
  );

  if (select count(*) from public.weekly_sport_targets where athlete_code = 'JORDAN' and programme_week_id = target_week) <> 3 then
    raise exception 'FAIL: athlete/week did not retain three separate sports';
  end if;
  if (select count(*) from public.weekly_sport_targets where athlete_code = 'JORDAN' and publish_state = 'published' and removed_at is null) <> 2 then
    raise exception 'FAIL: published reader predicate included a draft';
  end if;

  select changed_by into audit_coach
    from public.programme_change_log
   where entity_type = 'weekly_sport_target' and entity_id = target_id
   order by changed_at desc limit 1;
  if audit_coach <> 'KARL' then
    raise exception 'FAIL: target audit was not attributed to KARL';
  end if;

  begin
    delete from public.weekly_sport_targets where id = target_id;
  exception when check_violation then
    denied := true;
  end;
  if not denied then raise exception 'FAIL: hard delete was allowed'; end if;

  raise notice 'PASS weekly sport targets: canonical ownership, legacy zero, idempotency, RLS grants, sports, drafts, audit, soft removal';
end
$$;
