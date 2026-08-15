-- Categorise the exercise library so the coach picker can be browsed by muscle
-- group instead of typed into.
--
-- Rules are ORDERED and the first match wins, so the sequence below is the
-- specification — read it top to bottom. Ordering carries real weight:
--   "Leg Press Calf Raise"  must hit Calves before Quads
--   "Single Leg Curl"       must hit Hamstrings before Biceps
--   "Cable Pull Through"    must hit Glutes before Back's "pull up"
--   "Chest Supported Row"   must hit Back before Chest
--   "Reverse Pec Dec"       must hit Shoulders before Chest's "pec dec"
--
-- Pattern-based rather than a fixed list of 117 names so anything a coach adds
-- later is classified the same way, by re-running this file.
--
-- Rollback: rollback/20260815000006_exercise_categories_down.sql

begin;

create or replace function public.classify_exercise(match_key text)
returns text
language sql
immutable
as $function$
  select case
    -- Running-specific work first: these would otherwise be swallowed by the
    -- broader lower-body rules below.
    when match_key ~ 'tibialis|hip flexor|copenhagen'                      then 'Running Strength'
    when match_key ~ 'calf'                                                then 'Calves'

    -- Hamstrings before Biceps, so "Single Leg Curl" is not an arm exercise.
    when match_key ~ 'hamstring|leg curl|nordic|romanian|rdl|dead ?lift'   then 'Hamstrings'

    -- Glutes before Quads and Back: hip thrusts, kickbacks, abduction work and
    -- "Cable Pull Through" all belong here.
    when match_key ~ 'hip thrust|kickback|abduct|adduct|pull through|lateral walk|glute|swing'
                                                                            then 'Glutes'

    when match_key ~ 'squat|leg press|leg extension|lunge|step up|step down|hack'
                                                                            then 'Quads'

    when match_key ~ 'crunch|sit up|knee raise|leg raise|plank|abdominal'   then 'Core'

    -- Only reached once every leg curl has been claimed above.
    when match_key ~ 'curl'                                                then 'Biceps'
    when match_key ~ 'tricep|pushdown|skull|overhead rope|overhead extension'
                                                                            then 'Triceps'

    -- Rear-delt work before Chest, or "Reverse Pec Dec" lands in the wrong place.
    when match_key ~ 'delt|lateral.*raise|raise.*lateral|shoulder press|face pull|reverse pec|seated barbell press|overhead press'
                                                                            then 'Shoulders'

    when match_key ~ 'row|pulldown|pull ?up|back extension|pullover|shrug'  then 'Back'
    when match_key ~ 'bench|chest|pec|fly|dip|press'                        then 'Chest'
    else 'General'
  end
$function$;

update public.exercise_library
   set category     = public.classify_exercise(match_key),
       -- muscle_group is what the portal already records against logged sets.
       -- Keep anything it observed; fill the rest from the category.
       muscle_group = coalesce(muscle_group, public.classify_exercise(match_key));

commit;
