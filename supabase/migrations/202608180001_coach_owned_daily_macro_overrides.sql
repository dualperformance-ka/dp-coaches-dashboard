-- Coach-owned daily macro prescriptions.
--
-- Weekly nutrition_plans remain the fallback. This table stores day-level
-- replacements only, with drafts hidden from athletes and hard deletion
-- rejected so prescription history and audit attribution survive.

begin;

create table if not exists public.daily_macro_overrides (
  id                uuid primary key default gen_random_uuid(),
  athlete_code      text not null references public.athletes(code) on update cascade on delete restrict,
  programme_week_id uuid not null references public.athlete_programme_weeks(id) on update cascade on delete restrict,
  override_date     date not null,
  calories          integer,
  protein_g         integer,
  carbs_g           integer,
  fats_g            integer,
  fibre_g           integer,
  day_label         text,
  coach_note        text,
  publish_state     text not null default 'draft' check (publish_state in ('draft', 'published')),
  published_at      timestamptz,
  removed_at        timestamptz,
  updated_by        uuid not null references public.coaches(id) on update cascade on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint daily_macro_overrides_identity_key unique (athlete_code, override_date),
  constraint daily_macro_overrides_calories_nonnegative check (calories is null or calories >= 0),
  constraint daily_macro_overrides_protein_nonnegative check (protein_g is null or protein_g >= 0),
  constraint daily_macro_overrides_carbs_nonnegative check (carbs_g is null or carbs_g >= 0),
  constraint daily_macro_overrides_fats_nonnegative check (fats_g is null or fats_g >= 0),
  constraint daily_macro_overrides_fibre_nonnegative check (fibre_g is null or fibre_g >= 0),
  constraint daily_macro_overrides_calories_ceiling check (calories is null or calories <= 12000),
  constraint daily_macro_overrides_protein_ceiling check (protein_g is null or protein_g <= 2000),
  constraint daily_macro_overrides_carbs_ceiling check (carbs_g is null or carbs_g <= 2000),
  constraint daily_macro_overrides_fats_ceiling check (fats_g is null or fats_g <= 2000),
  constraint daily_macro_overrides_fibre_ceiling check (fibre_g is null or fibre_g <= 2000),
  constraint daily_macro_overrides_day_label_length check (day_label is null or char_length(day_label) <= 60),
  constraint daily_macro_overrides_coach_note_length check (coach_note is null or char_length(coach_note) <= 2000),
  constraint daily_macro_overrides_published_macros
    check (publish_state = 'draft' or (calories is not null and protein_g is not null)),
  constraint daily_macro_overrides_published_timestamp
    check ((publish_state = 'published') = (published_at is not null)),
  constraint daily_macro_overrides_removed_is_draft
    check (removed_at is null or publish_state = 'draft')
);

comment on table public.daily_macro_overrides is
  'Coach-owned day-level macro replacements. Athletes read published rows only through their scoped server endpoint.';
comment on column public.daily_macro_overrides.day_label is
  'Free-text day intent such as Long run, Race day, or Rest; reserved as the future preset hook.';
comment on column public.daily_macro_overrides.removed_at is
  'Soft-removal marker. Hard deletion is rejected to preserve prescription and audit history.';

create index if not exists daily_macro_overrides_published_athlete_idx
  on public.daily_macro_overrides (athlete_code, override_date)
  where publish_state = 'published' and removed_at is null;
create index if not exists daily_macro_overrides_week_idx
  on public.daily_macro_overrides (programme_week_id);

create or replace function public.validate_daily_macro_override_owner()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  week_athlete text;
  week_start date;
begin
  select ap.athlete_code, apw.start_date
    into week_athlete, week_start
    from public.athlete_programme_weeks apw
    join public.athlete_programmes ap on ap.id = apw.programme_id
   where apw.id = new.programme_week_id;

  if week_athlete is null or week_athlete <> new.athlete_code then
    raise exception 'Programme week does not belong to athlete'
      using errcode = '23514';
  end if;
  if week_start is not null
     and (new.override_date < week_start or new.override_date > week_start + 6) then
    raise exception 'Override date does not fall within programme week'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_validate_daily_macro_override_owner on public.daily_macro_overrides;
create trigger trg_validate_daily_macro_override_owner
  before insert or update of athlete_code, programme_week_id, override_date
  on public.daily_macro_overrides
  for each row execute function public.validate_daily_macro_override_owner();

create or replace function public.audit_daily_macro_override_change()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  coach_handle text;
  audit_action text;
  programme uuid;
begin
  select handle into coach_handle from public.coaches where id = new.updated_by;
  select programme_id into programme
    from public.athlete_programme_weeks
   where id = new.programme_week_id;

  if tg_op = 'INSERT' then
    audit_action := case when new.publish_state = 'published' then 'published' else 'created' end;
  elsif new.removed_at is not null and old.removed_at is null then
    audit_action := 'removed';
  elsif old.publish_state = 'draft' and new.publish_state = 'published' then
    audit_action := 'published';
  elsif old.publish_state = 'published' and new.publish_state = 'draft' then
    audit_action := 'unpublished';
  else
    audit_action := 'updated';
  end if;

  insert into public.programme_change_log (
    programme_id, athlete_code, changed_by, entity_type, entity_id,
    action, scope, old_value, new_value, summary
  ) values (
    programme,
    new.athlete_code,
    coach_handle,
    'daily_macro_override',
    new.id,
    audit_action,
    'day',
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new),
    'Daily macros ' || to_char(new.override_date, 'Dy DD Mon') || ' ' || audit_action
  );
  return new;
end
$function$;

drop trigger if exists trg_audit_daily_macro_overrides on public.daily_macro_overrides;
create trigger trg_audit_daily_macro_overrides
  after insert or update on public.daily_macro_overrides
  for each row execute function public.audit_daily_macro_override_change();

create or replace function public.reject_daily_macro_override_delete()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'Daily macro overrides must be soft-removed'
    using errcode = 'check_violation';
end
$function$;

drop trigger if exists trg_reject_daily_macro_override_delete on public.daily_macro_overrides;
create trigger trg_reject_daily_macro_override_delete
  before delete on public.daily_macro_overrides
  for each row execute function public.reject_daily_macro_override_delete();

drop trigger if exists trg_touch_daily_macro_overrides on public.daily_macro_overrides;
create trigger trg_touch_daily_macro_overrides
  before update on public.daily_macro_overrides
  for each row execute function public.touch_updated_at();

alter table public.daily_macro_overrides enable row level security;
revoke all on table public.daily_macro_overrides from public, anon, authenticated;
revoke all on table public.daily_macro_overrides from service_role;
grant select, insert, update on table public.daily_macro_overrides to service_role;

commit;
