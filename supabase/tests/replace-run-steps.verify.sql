-- Behavioural verification of 20261105000001_replace_run_steps_atomic.sql.
-- Run after programming-schema.fixture.sql and the programming migrations.
-- Each block raises if the guarantee it names does not hold.

\set ON_ERROR_STOP on

create or replace function pg_temp.sid(salt text, n int) returns text language sql as $$
  select md5(salt || ':' || n)::uuid::text;
$$;

create or replace function pg_temp.workout(parent_ref text default null, salt text default 'a') returns jsonb language sql as $$
  -- 10 min warm-up, 6 x (1 km @ 4:30-4:45 + 90 s jog), 10 min cool-down.
  -- Ids are per-salt, as the server generates fresh ids for every save.
  select jsonb_build_array(
    jsonb_build_object('id',pg_temp.sid(salt,1),'step_order',0,'step_type','warmup','duration_sec',600,'intensity_type','effort','effort','Easy'),
    jsonb_build_object('id',pg_temp.sid(salt,2),'step_order',1,'step_type','repeat','repeat_count',6),
    jsonb_build_object('id',pg_temp.sid(salt,3),'parent_step_id',coalesce(parent_ref,pg_temp.sid(salt,2)),'step_order',0,'step_type','interval','distance_km',1,'intensity_type','pace_range','pace_min','4:30','pace_max','4:45','coach_notes','private'),
    jsonb_build_object('id',pg_temp.sid(salt,4),'parent_step_id',pg_temp.sid(salt,2),'step_order',1,'step_type','recovery','duration_sec',90),
    jsonb_build_object('id',pg_temp.sid(salt,5),'step_order',2,'step_type','cooldown','duration_sec',600)
  );
$$;

do $$
declare sid uuid; n int; mode text; result jsonb;
begin
  -- 1. A published session gets the whole tree in one call, and a second call
  --    replaces it rather than appending.
  insert into public.planned_sessions (athlete_code, title, session_type, planned_date, publish_state)
  values ('RSTEST', 'Intervals', 'Speed', current_date + 7, 'published') returning id into sid;

  result := public.replace_run_steps(sid, pg_temp.workout(), null);
  select count(*) into n from public.run_steps where planned_session_id = sid;
  if n <> 5 then raise exception 'FAIL 1: expected 5 rows, found %', n; end if;
  select prescription_mode into mode from public.planned_sessions where id = sid;
  if mode <> 'structured' then raise exception 'FAIL 1: mode is %', mode; end if;

  -- Same ids again would collide if the delete had not happened first.
  perform public.replace_run_steps(sid, pg_temp.workout(), null);
  select count(*) into n from public.run_steps where planned_session_id = sid;
  if n <> 5 then raise exception 'FAIL 1: replace appended, found % rows', n; end if;
  if (result->>'steps')::int <> 5 then raise exception 'FAIL 1: result %', result; end if;
  raise notice 'PASS 1  published session swaps its whole tree in one call';
end $$;

do $$
declare sid uuid; before_rows int; n int;
begin
  -- 2. A failure part-way leaves the previous workout exactly as it was.
  select id into sid from public.planned_sessions where athlete_code = 'RSTEST' limit 1;
  select count(*) into before_rows from public.run_steps where planned_session_id = sid;
  begin
    perform public.replace_run_steps(sid,
      pg_temp.workout() || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'step_order', 9, 'step_type', 'repeat')),
      null);
    raise exception 'FAIL 2: a repeat with no count was accepted';
  exception when check_violation then null;
  end;
  select count(*) into n from public.run_steps where planned_session_id = sid;
  if n <> before_rows then raise exception 'FAIL 2: failed save changed % -> % rows', before_rows, n; end if;
  raise notice 'PASS 2  a failed save leaves the old workout intact';
end $$;

do $$
declare sid uuid; other uuid; n int;
begin
  -- 3. A nested step must hang off a repeat in the SAME session.
  select id into sid from public.planned_sessions where athlete_code = 'RSTEST' limit 1;
  insert into public.planned_sessions (athlete_code, title, session_type, planned_date, publish_state)
  values ('RSTEST2', 'Other', 'Run', current_date + 8, 'draft') returning id into other;
  insert into public.run_steps (id, planned_session_id, step_order, step_type, repeat_count)
  values ('00000000-0000-4000-8000-0000000000aa', other, 0, 'repeat', 2);

  begin
    perform public.replace_run_steps(sid, pg_temp.workout('00000000-0000-4000-8000-0000000000aa', 'b'), null);
    raise exception 'FAIL 3: parent from another session accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.replace_run_steps(sid, pg_temp.workout(pg_temp.sid('b',1), 'b'), null);
    raise exception 'FAIL 3: a warm-up accepted as a parent';
  exception when check_violation then null;
  end;
  select count(*) into n from public.run_steps where planned_session_id = sid;
  if n <> 5 then raise exception 'FAIL 3: rejected saves changed the workout (% rows)', n; end if;
  raise notice 'PASS 3  nested steps must sit in a repeat of the same session';
end $$;

do $$
declare sid uuid; before_n int; after_n int; state text;
begin
  -- 4. Draft edits are silent; publishing through the call logs exactly once.
  insert into public.planned_sessions (athlete_code, title, session_type, planned_date, publish_state)
  values ('RSDRAFT', 'Tempo', 'Tempo', current_date + 9, 'draft') returning id into sid;
  select count(*) into before_n from public.coach_change_log where athlete_code = 'RSDRAFT';

  perform public.replace_run_steps(sid, pg_temp.workout(null, 'd'), null);
  select count(*) into after_n from public.coach_change_log where athlete_code = 'RSDRAFT';
  if after_n <> before_n then raise exception 'FAIL 4: saving draft steps logged % rows', after_n - before_n; end if;

  perform public.replace_run_steps(sid, pg_temp.workout(null, 'e'), 'published');
  select count(*) into after_n from public.coach_change_log where athlete_code = 'RSDRAFT';
  select publish_state into state from public.planned_sessions where id = sid;
  if state <> 'published' then raise exception 'FAIL 4: not published (%)', state; end if;
  if after_n <> before_n + 1 then raise exception 'FAIL 4: publishing logged % rows, expected 1', after_n - before_n; end if;
  raise notice 'PASS 4  draft saves are silent, publish-with-save notifies once';
end $$;

do $$
declare sid uuid; big jsonb := '[]'::jsonb; i int;
begin
  -- 5. Completed sessions and oversized workouts are refused.
  -- status Completed: sync_session_lock() stamps locked_at for it.
  insert into public.planned_sessions (athlete_code, title, session_type, planned_date, publish_state, status)
  values ('RSLOCK', 'Done', 'Run', current_date - 1, 'published', 'Completed') returning id into sid;
  begin
    perform public.replace_run_steps(sid, pg_temp.workout(null, 'f'), null);
    raise exception 'FAIL 5: locked session accepted';
  exception when check_violation then null;
  end;

  for i in 1..101 loop
    big := big || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'step_order', i, 'step_type', 'run', 'duration_sec', 60));
  end loop;
  insert into public.planned_sessions (athlete_code, title, session_type, planned_date, publish_state)
  values ('RSLOCK', 'Open', 'Run', current_date + 3, 'draft') returning id into sid;
  begin
    perform public.replace_run_steps(sid, big, null);
    raise exception 'FAIL 5: 101 steps accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.replace_run_steps(sid, pg_temp.workout(null, 'g'), 'live');
    raise exception 'FAIL 5: bad publish state accepted';
  exception when check_violation then null;
  end;
  raise notice 'PASS 5  locked sessions, >100 steps and bad states are refused';
end $$;

do $$
declare sid uuid; n int; mode text;
begin
  -- 6. An empty array clears the steps and leaves the mode alone.
  select id into sid from public.planned_sessions where athlete_code = 'RSDRAFT' limit 1;
  perform public.replace_run_steps(sid, '[]'::jsonb, null);
  select count(*) into n from public.run_steps where planned_session_id = sid;
  select prescription_mode into mode from public.planned_sessions where id = sid;
  if n <> 0 or mode <> 'structured' then raise exception 'FAIL 6: % rows, mode %', n, mode; end if;
  raise notice 'PASS 6  clearing steps is explicit and keeps the mode';
end $$;

do $$
begin
  -- 7. No browser role can call it.
  if has_function_privilege('anon', 'public.replace_run_steps(uuid, jsonb, text)', 'execute')
     or has_function_privilege('authenticated', 'public.replace_run_steps(uuid, jsonb, text)', 'execute') then
    raise exception 'FAIL 7: a browser role can execute replace_run_steps';
  end if;
  if not has_function_privilege('service_role', 'public.replace_run_steps(uuid, jsonb, text)', 'execute') then
    raise exception 'FAIL 7: service_role cannot execute replace_run_steps';
  end if;
  raise notice 'PASS 7  service role only';
end $$;

delete from public.planned_sessions where athlete_code in ('RSTEST', 'RSTEST2', 'RSDRAFT', 'RSLOCK');
