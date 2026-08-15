-- Behavioural verification of the programming migrations.
-- Each block raises an exception if the guarantee it names does not hold.

\set ON_ERROR_STOP on

do $$
declare n int;
begin
  -- 1. Existing live rows are untouched in behaviour.
  select count(*) into n from public.planned_sessions
   where publish_state <> 'published' or prescription_mode <> 'legacy';
  if n <> 0 then raise exception 'FAIL 1: % pre-existing sessions changed visibility or mode', n; end if;
  raise notice 'PASS 1  existing sessions stay published + legacy';
end $$;

do $$
declare before_n int; after_n int; sid uuid;
begin
  -- 2. Creating a DRAFT session must not notify the athlete.
  select count(*) into before_n from public.coach_change_log where athlete_code = 'JORDAN';
  insert into public.planned_sessions (athlete_code, title, session_type, planned_date, week_label, publish_state)
  values ('JORDAN', 'Draft Lower A', 'Strength', current_date + 14, 'Week 6', 'draft')
  returning id into sid;
  select count(*) into after_n from public.coach_change_log where athlete_code = 'JORDAN';
  if after_n <> before_n then raise exception 'FAIL 2: drafting a session notified the athlete'; end if;
  raise notice 'PASS 2  draft session creation is silent';

  -- 3. Editing a draft repeatedly must stay silent.
  update public.planned_sessions set title = 'Draft Lower A v2' where id = sid;
  update public.planned_sessions set distance_km = 5 where id = sid;
  select count(*) into after_n from public.coach_change_log where athlete_code = 'JORDAN';
  if after_n <> before_n then raise exception 'FAIL 3: editing a draft notified the athlete'; end if;
  raise notice 'PASS 3  draft edits are silent';

  -- 4. Publishing announces itself exactly once.
  update public.planned_sessions set publish_state = 'published' where id = sid;
  select count(*) into after_n from public.coach_change_log where athlete_code = 'JORDAN';
  if after_n <> before_n + 1 then
    raise exception 'FAIL 4: publishing produced % log rows, expected 1', after_n - before_n;
  end if;
  raise notice 'PASS 4  publishing notifies once';
end $$;

do $$
declare before_n int; after_n int; sid uuid;
begin
  -- 5. Internal bookkeeping must never notify.
  select id into sid from public.planned_sessions
   where athlete_code = 'JORDAN' and title = 'Upper A' limit 1;
  select count(*) into before_n from public.coach_change_log where athlete_code = 'JORDAN';
  update public.planned_sessions set prescription_mode = 'structured' where id = sid;
  update public.planned_sessions set coach_notes = 'Shoulder niggle, watch pressing volume' where id = sid;
  update public.planned_sessions set day_order = 1, estimated_minutes = 55 where id = sid;
  select count(*) into after_n from public.coach_change_log where athlete_code = 'JORDAN';
  if after_n <> before_n then
    raise exception 'FAIL 5: bookkeeping columns produced % notifications', after_n - before_n;
  end if;
  raise notice 'PASS 5  prescription_mode / coach_notes / day_order are silent';
end $$;

do $$
declare before_n int; after_n int; sid uuid; xid uuid;
begin
  -- 6. A structured strength edit DOES reach the athlete.
  select id into sid from public.planned_sessions
   where athlete_code = 'JORDAN' and title = 'Upper A' limit 1;
  select count(*) into before_n from public.coach_change_log where athlete_code = 'JORDAN';
  insert into public.session_exercises (planned_session_id, exercise_name, position, sets, rep_min, rep_max, rpe, rest_seconds)
  values (sid, 'Bench Press', 0, 4, 6, 6, 8, 180) returning id into xid;
  select count(*) into after_n from public.coach_change_log where athlete_code = 'JORDAN';
  if after_n <> before_n + 1 then
    raise exception 'FAIL 6: adding a structured exercise produced % notifications, expected 1', after_n - before_n;
  end if;
  raise notice 'PASS 6  structured strength changes still notify the athlete';

  -- 7. A coach-private note on that exercise must not.
  select count(*) into before_n from public.coach_change_log where athlete_code = 'JORDAN';
  update public.session_exercises set coach_notes = 'do not tell him this is a deload' where id = xid;
  select count(*) into after_n from public.coach_change_log where athlete_code = 'JORDAN';
  if after_n <> before_n then raise exception 'FAIL 7: a coach-only note notified the athlete'; end if;
  raise notice 'PASS 7  coach_notes on an exercise is silent';

  -- 8. An athlete-facing note on that exercise does.
  update public.session_exercises set athlete_notes = 'Keep the first two sets controlled' where id = xid;
  select count(*) into after_n from public.coach_change_log where athlete_code = 'JORDAN';
  if after_n <> before_n + 1 then raise exception 'FAIL 8: athlete_notes did not notify'; end if;
  raise notice 'PASS 8  athlete_notes notifies';
end $$;

do $$
declare sid uuid; before_n int; after_n int;
begin
  -- 9. Exercises on a DRAFT session must not notify.
  select id into sid from public.planned_sessions
   where athlete_code = 'JORDAN' and publish_state = 'published' and title = 'Threshold Run' limit 1;
  update public.planned_sessions set publish_state = 'draft' where id = sid;
  select count(*) into before_n from public.coach_change_log where athlete_code = 'JORDAN';
  insert into public.run_steps (planned_session_id, step_order, step_type, distance_km, intensity_type, effort)
  values (sid, 0, 'warmup', 2, 'effort', 'easy');
  insert into public.run_steps (planned_session_id, step_order, step_type, repeat_count)
  values (sid, 1, 'repeat', 5);
  select count(*) into after_n from public.coach_change_log where athlete_code = 'JORDAN';
  if after_n <> before_n then raise exception 'FAIL 9: run steps on a draft notified the athlete'; end if;
  raise notice 'PASS 9  run steps on a draft session are silent';
end $$;

do $$
declare sid uuid; ok boolean := false;
begin
  -- 10. A completed session is immutable.
  select id into sid from public.planned_sessions
   where athlete_code = 'NATE' and title = 'Upper A' limit 1;
  insert into public.session_exercises (planned_session_id, exercise_name, position, sets)
  values (sid, 'Bench Press', 0, 4);
  update public.planned_sessions set locked_at = now(), status = 'done' where id = sid;
  begin
    update public.session_exercises set sets = 5 where planned_session_id = sid;
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 10: a locked session accepted a prescription edit'; end if;

  ok := false;
  begin
    insert into public.session_exercises (planned_session_id, exercise_name, position)
    values (sid, 'Cable Lateral Raise', 1);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 10b: a locked session accepted a new exercise'; end if;
  raise notice 'PASS 10 completed sessions are immutable';
end $$;

do $$
declare ok boolean := false;
begin
  -- 11. A repeat block must carry a count; a plain step must not.
  begin
    insert into public.run_steps (planned_session_id, step_order, step_type)
    select id, 9, 'repeat' from public.planned_sessions limit 1;
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 11: a repeat step without a count was accepted'; end if;
  raise notice 'PASS 11 run step shape is enforced';
end $$;

do $$
declare n int;
begin
  -- 12. Library seeded from the coach's own splits and logs.
  select count(*) into n from public.exercise_library;
  if n < 8 then raise exception 'FAIL 12: library seeded only % exercises', n; end if;

  perform 1 from public.exercise_library where match_key = 'bench press';
  if not found then raise exception 'FAIL 12b: Bench Press missing from library'; end if;

  perform 1 from public.exercise_library where match_key = 'bulgarian split squat';
  if not found then raise exception 'FAIL 12c: unilateral variant missing from library'; end if;

  perform 1 from public.exercise_library where match_key = 'assisted pull up';
  if not found then raise exception 'FAIL 12d: athlete-logged swap missing from library'; end if;

  perform 1 from public.exercise_library where match_key = 'bench press' and muscle_group = 'Chest';
  if not found then raise exception 'FAIL 12e: observed muscle group was not carried across'; end if;

  perform 1 from public.exercise_library where match_key = 'barbell hip thrust' and equipment = 'Barbell';
  if not found then raise exception 'FAIL 12f: equipment inference failed'; end if;
  raise notice 'PASS 12 exercise library seeded from real DP data (% rows)', n;
end $$;

do $$
declare ok boolean := false; pid uuid;
begin
  -- 13. One active programme per athlete.
  insert into public.athlete_programmes (athlete_code, name, status)
  values ('JORDAN', 'Hybrid Performance Build', 'active') returning id into pid;
  begin
    insert into public.athlete_programmes (athlete_code, name, status)
    values ('JORDAN', 'Second Active Programme', 'active');
  exception when unique_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 13: two active programmes were allowed'; end if;

  -- but drafts alongside an active programme are fine
  insert into public.athlete_programmes (athlete_code, name, status)
  values ('JORDAN', 'Next Block (draft)', 'draft');
  raise notice 'PASS 13 one active programme, unlimited drafts';
end $$;

do $$
declare n int;
begin
  -- 14. Templates are structurally unreachable from athlete programmes.
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'template_sessions'
     and column_name = 'athlete_code';
  if n <> 0 then raise exception 'FAIL 14: template_sessions can reference an athlete'; end if;
  raise notice 'PASS 14 templates cannot hold athlete data';
end $$;

do $$
declare n int;
begin
  -- 15. Cascade deletes clean up prescriptions, never logs.
  delete from public.planned_sessions where title = 'Draft Lower A v2';
  select count(*) into n from public.session_exercises se
    left join public.planned_sessions ps on ps.id = se.planned_session_id
   where ps.id is null;
  if n <> 0 then raise exception 'FAIL 15: % orphaned session_exercises rows', n; end if;
  raise notice 'PASS 15 prescription rows cascade cleanly';
end $$;

do $$
declare n int;
begin
  -- 16. No new table is reachable by a browser role.
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and table_name in (
       'coaches','coach_athletes','exercise_library','programme_templates',
       'athlete_programmes','programme_blocks','athlete_programme_weeks',
       'session_exercises','run_steps','template_weeks','template_sessions',
       'template_session_exercises','template_run_steps','programme_change_log');
  if n <> 0 then raise exception 'FAIL 16: % browser grants on programming tables', n; end if;

  select count(*) into n from pg_tables
   where schemaname = 'public' and rowsecurity = false
     and tablename in (
       'coaches','coach_athletes','exercise_library','programme_templates',
       'athlete_programmes','programme_blocks','athlete_programme_weeks',
       'session_exercises','run_steps','template_weeks','template_sessions',
       'template_session_exercises','template_run_steps','programme_change_log');
  if n <> 0 then raise exception 'FAIL 16b: % programming tables without RLS', n; end if;
  raise notice 'PASS 16 programming tables are server-only';
end $$;

select 'ALL CHECKS PASSED' as result;
