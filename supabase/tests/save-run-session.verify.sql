-- Behavioural verification of 20261106000001_save_run_session.sql.
-- Run after programming-schema.fixture.sql, the programming migrations,
-- 20261105000001 and 20261106000001. Each block raises if its guarantee fails.

\set ON_ERROR_STOP on

create or replace function pg_temp.steps(salt text) returns jsonb language sql as $$
  -- 10 min warm-up, 6 x (1 km @ 4:30-4:45 + 90 s), 10 min cool-down.
  select jsonb_build_array(
    jsonb_build_object('id', md5(salt||1)::uuid, 'step_order',0,'step_type','warmup','duration_sec',600),
    jsonb_build_object('id', md5(salt||2)::uuid, 'step_order',1,'step_type','repeat','repeat_count',6),
    jsonb_build_object('id', md5(salt||3)::uuid, 'parent_step_id', md5(salt||2)::uuid, 'step_order',0,'step_type','interval','distance_km',1,'intensity_type','pace_range','pace_min','4:30','pace_max','4:45'),
    jsonb_build_object('id', md5(salt||4)::uuid, 'parent_step_id', md5(salt||2)::uuid, 'step_order',1,'step_type','recovery','duration_sec',90),
    jsonb_build_object('id', md5(salt||5)::uuid, 'step_order',2,'step_type','cooldown','duration_sec',600)
  );
$$;

do $$
declare row jsonb; sid uuid; n int; txt text;
begin
  -- 1. A new session and its steps arrive together; publish state is the
  --    column default, exactly as plan_insert leaves it.
  row := public.save_run_session(null, 'srtest', jsonb_build_object(
    'title','6 x 1 km','session_type','Speed','planned_date', (current_date + 7)::text,
    'warm_up','10 min','intervals','6 × 1 km','working_pace','4:30–4:45 /km','rest','1 min 30 s','cool_down','10 min'),
    pg_temp.steps('a'));
  sid := (row->>'id')::uuid;
  select count(*) into n from public.run_steps where planned_session_id = sid;
  if n <> 5 then raise exception 'FAIL 1: % steps', n; end if;
  if row->>'athlete_code' <> 'SRTEST' then raise exception 'FAIL 1: athlete %', row->>'athlete_code'; end if;
  if row->>'prescription_mode' <> 'structured' then raise exception 'FAIL 1: mode %', row->>'prescription_mode'; end if;
  if row->>'intervals' <> '6 × 1 km' then raise exception 'FAIL 1: text %', row->>'intervals'; end if;
  -- Same publish state an ordinary insert gets (plan_insert sends none).
  insert into public.planned_sessions (athlete_code, title, planned_date) values ('SRTEST', 'Plain', current_date) returning publish_state into txt;
  if row->>'publish_state' <> txt then raise exception 'FAIL 1: publish_state % vs default %', row->>'publish_state', txt; end if;
  delete from public.planned_sessions where athlete_code = 'SRTEST' and title = 'Plain';
  raise notice 'PASS 1  new session row and its steps are written together';
end $$;

do $$
declare sid uuid; before jsonb; n int; txt text;
begin
  -- 2. A failing step save rolls back the session row change too.
  select id into sid from public.planned_sessions where athlete_code = 'SRTEST' limit 1;
  select to_jsonb(s) into before from public.planned_sessions s where id = sid;
  begin
    perform public.save_run_session(sid, null, jsonb_build_object('intervals', 'CHANGED', 'planned_date', (current_date + 9)::text),
      pg_temp.steps('b') || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'step_order', 9, 'step_type', 'bogus')));
    raise exception 'FAIL 2: an invalid step was accepted';
  exception when check_violation then null;
  end;
  select intervals into txt from public.planned_sessions where id = sid;
  select count(*) into n from public.run_steps where planned_session_id = sid;
  if txt <> '6 × 1 km' or n <> 5 then raise exception 'FAIL 2: row or steps changed (% / % rows)', txt, n; end if;
  if (select planned_date::text from public.planned_sessions where id = sid) <> before->>'planned_date' then
    raise exception 'FAIL 2: date changed';
  end if;

  -- A new session whose steps fail leaves no row behind.
  begin
    perform public.save_run_session(null, 'SRTEST', jsonb_build_object('title','Ghost','planned_date',(current_date+3)::text),
      jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'step_order', 0, 'step_type', 'repeat')));
    raise exception 'FAIL 2: repeat without count accepted';
  exception when check_violation then null;
  end;
  if exists (select 1 from public.planned_sessions where title = 'Ghost') then raise exception 'FAIL 2: orphan session left'; end if;
  raise notice 'PASS 2  a failed save changes neither the session nor its steps';
end $$;

do $$
declare sid uuid; r record;
begin
  -- 3. Edits: absent keys keep their value, present keys (even null) set it;
  --    publish_state, athlete and notion id are out of reach.
  select id into sid from public.planned_sessions where athlete_code = 'SRTEST' limit 1;
  update public.planned_sessions set publish_state = 'draft', notion_page_id = 'keepme', notes = 'keep' where id = sid;
  perform public.save_run_session(sid, 'OTHER', jsonb_build_object(
    'intervals', '5 × 1 km', 'rest', null, 'athlete_code', 'OTHER', 'publish_state', 'published',
    'notion_page_id', 'stolen', 'prescription_mode', 'legacy'), pg_temp.steps('c'));
  select * into r from public.planned_sessions where id = sid;
  if r.intervals <> '5 × 1 km' or r.rest is not null then raise exception 'FAIL 3: present keys not applied'; end if;
  if r.notes <> 'keep' or r.title <> '6 x 1 km' then raise exception 'FAIL 3: absent keys changed'; end if;
  if r.athlete_code <> 'SRTEST' or r.publish_state <> 'draft' or r.notion_page_id <> 'keepme' or r.prescription_mode <> 'structured' then
    raise exception 'FAIL 3: protected column changed: % % % %', r.athlete_code, r.publish_state, r.notion_page_id, r.prescription_mode;
  end if;
  raise notice 'PASS 3  edits patch only the listed columns; athlete, publish state and ids are protected';
end $$;

do $$
declare sid uuid;
begin
  -- 4. Completed sessions are refused, row included.
  insert into public.planned_sessions (athlete_code, title, session_type, planned_date, status)
  values ('SRTEST', 'Done', 'Speed', current_date - 1, 'Completed') returning id into sid;
  begin
    perform public.save_run_session(sid, null, jsonb_build_object('title', 'Rewritten'), pg_temp.steps('d'));
    raise exception 'FAIL 4: completed session accepted';
  exception when check_violation then null;
  end;
  if (select title from public.planned_sessions where id = sid) <> 'Done' then raise exception 'FAIL 4: title changed'; end if;
  begin
    perform public.save_run_session(gen_random_uuid(), null, '{}'::jsonb, pg_temp.steps('e'));
    raise exception 'FAIL 4: missing session accepted';
  exception when no_data_found then null;
  end;
  begin
    perform public.save_run_session(null, '', jsonb_build_object('planned_date', current_date::text), pg_temp.steps('f'));
    raise exception 'FAIL 4: new session without athlete accepted';
  exception when check_violation then null;
  end;
  -- Marking a run Completed in the same save stores the steps, then locks it.
  insert into public.planned_sessions (athlete_code, title, session_type, planned_date)
  values ('SRTEST', 'Finish', 'Speed', current_date) returning id into sid;
  perform public.save_run_session(sid, null, jsonb_build_object('status', 'Completed'), pg_temp.steps('g'));
  if (select locked_at is null or status <> 'Completed' from public.planned_sessions where id = sid)
     or (select count(*) from public.run_steps where planned_session_id = sid) <> 5 then
    raise exception 'FAIL 4: save-and-complete did not store steps then lock';
  end if;
  raise notice 'PASS 4  completed, missing and athlete-less sessions are refused; save-and-complete works';
end $$;

do $$
begin
  -- 5. No browser role can call it.
  if has_function_privilege('anon', 'public.save_run_session(uuid, text, jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.save_run_session(uuid, text, jsonb, jsonb)', 'execute') then
    raise exception 'FAIL 5: a browser role can execute save_run_session';
  end if;
  if not has_function_privilege('service_role', 'public.save_run_session(uuid, text, jsonb, jsonb)', 'execute') then
    raise exception 'FAIL 5: service_role cannot execute save_run_session';
  end if;
  raise notice 'PASS 5  service role only';
end $$;

delete from public.planned_sessions where athlete_code = 'SRTEST';
