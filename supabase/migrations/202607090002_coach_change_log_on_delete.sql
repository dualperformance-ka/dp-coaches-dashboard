-- Log coach-side DELETEs (e.g. removing a session from an athlete's week) to
-- coach_change_log, so athletes get a "Coach update" push for removals too.
-- Applied to production 2026-07-09 via Supabase MCP.

create or replace function public.log_coach_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  src text := tg_argv[0];
  excluded text[] := string_to_array(coalesce(tg_argv[1], ''), ',');
  old_j jsonb; new_j jsonb; col text; code text;
begin
  if tg_op = 'DELETE' then
    code := to_jsonb(old)->>'athlete_code';
    if code is not null and code <> '' then
      insert into public.coach_change_log (athlete_code, source) values (code, src);
    end if;
    return old;
  end if;
  new_j := to_jsonb(new);
  code := new_j->>'athlete_code';
  if code is null or code = '' then return new; end if;
  if tg_op = 'UPDATE' then
    old_j := to_jsonb(old);
    foreach col in array excluded loop
      old_j := old_j - col; new_j := new_j - col;
    end loop;
    if old_j = new_j then return new; end if;
  end if;
  insert into public.coach_change_log (athlete_code, source) values (code, src);
  return new;
end $function$;

drop trigger if exists trg_log_planned_sessions on public.planned_sessions;
create trigger trg_log_planned_sessions
  after insert or update or delete on public.planned_sessions
  for each row execute function log_coach_change('training', 'status,updated_at,created_at');

drop trigger if exists trg_log_nutrition_plans on public.nutrition_plans;
create trigger trg_log_nutrition_plans
  after insert or update or delete on public.nutrition_plans
  for each row execute function log_coach_change('nutrition', 'completed_km,updated_at,created_at');

drop trigger if exists trg_log_workout_splits on public.workout_splits;
create trigger trg_log_workout_splits
  after insert or update or delete on public.workout_splits
  for each row execute function log_coach_change('gym plan', 'updated_at,created_at');
