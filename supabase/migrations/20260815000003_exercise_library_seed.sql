-- Coach-only programming system — seed the exercise library.
--
-- Read-only against everything that already exists. It writes to
-- exercise_library and nothing else, and is safe to run more than once.
--
-- Without this, the "+ Add Exercise" search (spec §16) opens empty on day one
-- and every coach has to type every exercise by hand before the builder is
-- usable. Seeding from the coach's own 16 workout splits means the library
-- arrives already knowing the DP vocabulary.
--
-- Rollback: rollback/20260815000003_exercise_library_seed_down.sql

begin;

-- Every exercise name the system already knows about, from three sources:
--   1. the primary "exercise" of each row in workout_splits.exercises
--   2. the athlete-selectable "alts" on those rows
--   3. the "leftRightExercises" unilateral variants
-- plus anything athletes have actually logged, which catches swaps a coach
-- never programmed but the squad clearly uses.
with split_exercises as (
  select jsonb_array_elements(exercises) as e
  from public.workout_splits
),
candidate_names as (
  select e->>'exercise' as name from split_exercises
  union
  select jsonb_array_elements_text(coalesce(e->'alts', '[]'::jsonb)) from split_exercises
  union
  select jsonb_array_elements_text(coalesce(e->'leftRightExercises', '[]'::jsonb)) from split_exercises
  union
  select programmed_exercise from public.training_session_logs where programmed_exercise is not null
  union
  select exercise_name from public.training_session_logs where exercise_name is not null
),
cleaned as (
  select
    btrim(name) as name,
    -- Must match the portal's priorityMatchKey():
    --   String(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
    -- so a library lookup and a portal lookup agree on identity.
    btrim(regexp_replace(lower(btrim(name)), '[^a-z0-9]+', ' ', 'g')) as match_key
  from candidate_names
  where name is not null and btrim(name) <> ''
),
-- Where several spellings collapse to one match_key, keep the longest name:
-- "Barbell Romanian Deadlift" beats "barbell romanian deadlift".
deduped as (
  select distinct on (match_key) match_key, name
  from cleaned
  where match_key <> ''
  order by match_key, length(name) desc, name asc
),
-- Muscle groups the portal has already classified while logging. Only 24 of the
-- ~117 exercises are covered; the rest stay null for a coach to fill in from the
-- library editor. Seeding a guess would be worse than seeding nothing.
observed_groups as (
  select distinct on (mk) mk, muscle_group
  from (
    select btrim(regexp_replace(lower(btrim(coalesce(programmed_exercise, exercise_name))), '[^a-z0-9]+', ' ', 'g')) as mk,
           muscle_group,
           count(*) over (partition by btrim(regexp_replace(lower(btrim(coalesce(programmed_exercise, exercise_name))), '[^a-z0-9]+', ' ', 'g')), muscle_group) as freq
    from public.training_session_logs
    where muscle_group is not null and muscle_group <> ''
      and coalesce(programmed_exercise, exercise_name) is not null
  ) t
  order by mk, freq desc
)
insert into public.exercise_library (name, match_key, muscle_group, created_by)
select d.name, d.match_key, g.muscle_group, 'seed'
from deduped d
left join observed_groups g on g.mk = d.match_key
on conflict (match_key) do nothing;

-- Link the seeded library back to the split rows that referenced each exercise,
-- so the builder can show equipment/cues immediately once a coach fills them in.
-- Nothing depends on this being complete.
update public.exercise_library el
set equipment = case
      when el.match_key like 'barbell %' or el.match_key like '% barbell%' then 'Barbell'
      when el.match_key like 'dumbbell %' or el.match_key like '% dumbbell%' then 'Dumbbell'
      when el.match_key like 'cable %'    or el.match_key like '% cable%'    then 'Cable'
      when el.match_key like 'machine %'  or el.match_key like '% machine%'  then 'Machine'
      when el.match_key like 'smith %'                                       then 'Smith machine'
      when el.match_key like 'banded %'   or el.match_key like '% band%'     then 'Band'
      else el.equipment
    end
where el.created_by = 'seed' and el.equipment is null;

commit;
