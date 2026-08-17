-- Minimal reproduction of the live schema that the programming migrations
-- depend on. Column lists taken from information_schema on the production
-- project so the migrations are exercised against a faithful shape.

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I', r);
    end if;
  end loop;
end $$;

create extension if not exists pgcrypto;

create table public.athletes (
  code text primary key,
  name text not null,
  active boolean not null default true,
  coach text not null default 'karl',
  start_date date,
  race_target text,
  ghl_contact_id text,
  notes text,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  email text,
  auth_user_id uuid,
  auth_mode text not null default 'code',
  invited_at timestamptz,
  email_verified_at timestamptz
);

create table public.planned_sessions (
  id uuid primary key default gen_random_uuid(),
  notion_page_id text unique,
  athlete_code text not null,
  title text not null,
  session_type text,
  planned_date date,
  week_label text,
  status text not null default 'Planned',
  library_id uuid,
  run_details text,
  intensity text,
  distance_km numeric,
  target_pace text,
  warm_up text,
  intervals text,
  working_pace text,
  rest text,
  cool_down text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workout_splits (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  athlete_code text,
  exercises jsonb not null default '[]'::jsonb,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, athlete_code)
);

create table public.session_library (
  id uuid primary key default gen_random_uuid(),
  notion_page_id text unique,
  name text not null,
  session_type text,
  description text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.training_session_logs (
  id uuid primary key default gen_random_uuid(),
  client_write_id text unique,
  athlete_code text not null,
  session_name text,
  session_date date,
  exercise_log text,
  notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw_sets jsonb,
  exercise_name text,
  programmed_exercise text,
  muscle_group text,
  is_swap boolean not null default false,
  rep_mode text
);

create table public.nutrition_plans (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  week_label text not null,
  completed_km numeric,
  weekly_km_target numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.coach_change_log (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  source text not null,
  changed_at timestamptz not null default now(),
  detail jsonb
);

-- Verbatim from supabase/migrations/202607090003_coach_change_log_detail.sql
create or replace function public.log_coach_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  src text := tg_argv[0];
  excluded text[] := string_to_array(coalesce(tg_argv[1], ''), ',');
  label_col text := tg_argv[2];
  date_col  text := tg_argv[3];
  old_j jsonb; new_j jsonb; col text; code text; row_j jsonb; act text; det jsonb;
begin
  if tg_op = 'DELETE' then
    row_j := to_jsonb(old); act := 'removed';
  else
    row_j := to_jsonb(new);
    act := case tg_op when 'INSERT' then 'added' else 'updated' end;
  end if;

  code := row_j->>'athlete_code';
  if code is null or code = '' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    old_j := to_jsonb(old); new_j := to_jsonb(new);
    foreach col in array excluded loop
      old_j := old_j - col; new_j := new_j - col;
    end loop;
    if old_j = new_j then return new; end if;
  end if;

  det := jsonb_strip_nulls(jsonb_build_object(
    'action', act,
    'item',   case when label_col is not null then row_j->>label_col end,
    'date',   case when date_col  is not null then row_j->>date_col  end
  ));

  insert into public.coach_change_log (athlete_code, source, detail) values (code, src, det);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;

create trigger trg_log_planned_sessions
  after insert or update or delete on public.planned_sessions
  for each row execute function log_coach_change('training', 'status,updated_at,created_at', 'title', 'planned_date');

create trigger trg_log_workout_splits
  after insert or update or delete on public.workout_splits
  for each row execute function log_coach_change('gym plan', 'updated_at,created_at', 'name');

-- Sample data mirroring production shapes.
insert into public.athletes (code, name, coach, auth_mode) values
  ('JORDAN', 'Jordan Tan', 'karl', 'both'),
  ('NATE',   'Nate Tuazon', 'karl', 'both');

insert into public.workout_splits (name, athlete_code, exercises) values
('Upper A', null, '[
  {"exercise":"Bench Press","sets":"4","reps":"6","repRange":"6-8","rest":"180s","warmupSets":"2","workingSets":"4","notes":"RIR 2,1,0","alts":["Dumbbell Bench Press"]},
  {"exercise":"Lat Pulldown","sets":"3","reps":"8","repRange":"8-10","rest":"120s","warmupSets":"0","workingSets":"3","alts":[]}
]'::jsonb),
('Glute A Female', null, '[
  {"exercise":"Barbell Hip Thrust","sets":"5","reps":"10","repRange":"8-12","rest":"150s","warmupSets":"1","workingSets":"4","alts":["Machine Hip Thrust"]},
  {"exercise":"Bulgarian Split Squat","sets":"3","reps":"10","repRange":"8-12","rest":"90s","warmupSets":"0","workingSets":"3","repMode":"left_right","alts":["Reverse Lunge"],"leftRightExercises":["Bulgarian Split Squat","Reverse Lunge"]}
]'::jsonb);

insert into public.planned_sessions (athlete_code, title, session_type, planned_date, week_label, status) values
  ('JORDAN', 'Upper A',       'Strength', current_date,     'Week 4', 'Planned'),
  ('JORDAN', 'Threshold Run', 'Tempo',    current_date + 1, 'Week 4', 'Planned'),
  ('NATE',   'Upper A',       'Strength', current_date,     'Week 4', 'Planned');

insert into public.training_session_logs (athlete_code, session_name, session_date, programmed_exercise, exercise_name, muscle_group)
values ('JORDAN', 'Upper A', current_date - 7, 'Bench Press', 'Bench Press', 'Chest'),
       ('JORDAN', 'Upper A', current_date - 7, 'Lat Pulldown', 'Assisted Pull Up', 'Vertical pull');

insert into public.nutrition_plans (athlete_code, week_label, weekly_km_target)
values ('JORDAN', 'Week 4', 0);
