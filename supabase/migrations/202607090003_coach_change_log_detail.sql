-- Record WHAT changed, not just the area: coach_change_log.detail holds
-- {action: added|updated|removed, item: <title/week/split name>, date: <planned_date>}
-- so the push notification can name the change.
-- Applied to production 2026-07-09 via Supabase MCP.

alter table public.coach_change_log add column if not exists detail jsonb;

create or replace function public.log_coach_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  src text := tg_argv[0];
  excluded text[] := string_to_array(coalesce(tg_argv[1], ''), ',');
  label_col text := tg_argv[2]; -- column naming the item (title / week_label / name)
  date_col  text := tg_argv[3]; -- optional date column (planned_date)
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

create or replace function public.log_override_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare code text; ttl text; dt text;
begin
  select athlete_code, title, planned_date::text into code, ttl, dt
    from public.planned_sessions where notion_page_id = new.notion_page_id limit 1;
  if code is not null then
    insert into public.coach_change_log (athlete_code, source, detail)
    values (code, 'training', jsonb_strip_nulls(jsonb_build_object(
      'action', 'updated', 'item', coalesce(nullif(new.name, ''), ttl), 'date', dt)));
  end if;
  return new;
end $function$;

drop trigger if exists trg_log_planned_sessions on public.planned_sessions;
create trigger trg_log_planned_sessions
  after insert or update or delete on public.planned_sessions
  for each row execute function log_coach_change('training', 'status,updated_at,created_at', 'title', 'planned_date');

drop trigger if exists trg_log_nutrition_plans on public.nutrition_plans;
create trigger trg_log_nutrition_plans
  after insert or update or delete on public.nutrition_plans
  for each row execute function log_coach_change('nutrition', 'completed_km,updated_at,created_at', 'week_label');

drop trigger if exists trg_log_workout_splits on public.workout_splits;
create trigger trg_log_workout_splits
  after insert or update or delete on public.workout_splits
  for each row execute function log_coach_change('gym plan', 'updated_at,created_at', 'name');
