-- Coach-owned weekly multi-sport targets.
--
-- The programme week foreign key is the canonical week identity. athlete_code
-- is retained as the server scoping key, with a trigger enforcing that it owns
-- the referenced week. Browser roles receive no table privileges: coaches and
-- athletes use authenticated server routes, both backed by service_role.

begin;

create table if not exists public.weekly_sport_targets (
  id                       uuid primary key default gen_random_uuid(),
  athlete_code             text not null references public.athletes(code) on update cascade on delete restrict,
  programme_week_id        uuid not null references public.athlete_programme_weeks(id) on update cascade on delete restrict,
  sport                    text not null check (sport in ('running', 'cycling', 'swimming')),
  distance_target_metres   bigint,
  session_target           integer,
  duration_target_minutes  integer,
  coach_note               text,
  publish_state            text not null default 'draft' check (publish_state in ('draft', 'published')),
  published_at             timestamptz,
  removed_at               timestamptz,
  updated_by               uuid not null references public.coaches(id) on update cascade on delete restrict,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint weekly_sport_targets_identity_key
    unique (athlete_code, programme_week_id, sport),
  constraint weekly_sport_targets_distance_nonnegative
    check (distance_target_metres is null or distance_target_metres >= 0),
  constraint weekly_sport_targets_sessions_nonnegative
    check (session_target is null or session_target >= 0),
  constraint weekly_sport_targets_duration_nonnegative
    check (duration_target_minutes is null or duration_target_minutes >= 0),
  constraint weekly_sport_targets_published_distance
    check (publish_state = 'draft' or distance_target_metres is not null),
  constraint weekly_sport_targets_published_timestamp
    check ((publish_state = 'published') = (published_at is not null)),
  constraint weekly_sport_targets_removed_is_draft
    check (removed_at is null or publish_state = 'draft')
);

comment on table public.weekly_sport_targets is
  'Coach-owned weekly sport prescriptions. Athletes read published rows only through the scoped server endpoint.';
comment on column public.weekly_sport_targets.distance_target_metres is
  'Canonical distance storage. Dashboard renders running/cycling in km and swimming in m.';
comment on column public.weekly_sport_targets.removed_at is
  'Soft removal marker. Rows are never hard-deleted so audit and prescription history survive.';

create index if not exists weekly_sport_targets_published_athlete_idx
  on public.weekly_sport_targets (athlete_code, programme_week_id, sport)
  where publish_state = 'published' and removed_at is null;
create index if not exists weekly_sport_targets_week_idx
  on public.weekly_sport_targets (programme_week_id);

-- Defence in depth against a server bug or crafted request that combines one
-- athlete's code with another athlete's canonical programme week UUID.
create or replace function public.validate_weekly_sport_target_owner()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  week_athlete text;
begin
  select ap.athlete_code
    into week_athlete
    from public.athlete_programme_weeks apw
    join public.athlete_programmes ap on ap.id = apw.programme_id
   where apw.id = new.programme_week_id;

  if week_athlete is null or week_athlete <> new.athlete_code then
    raise exception 'Programme week does not belong to athlete'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_validate_weekly_sport_target_owner on public.weekly_sport_targets;
create trigger trg_validate_weekly_sport_target_owner
  before insert or update of athlete_code, programme_week_id
  on public.weekly_sport_targets
  for each row execute function public.validate_weekly_sport_target_owner();

-- All target changes are attributed from updated_by (a coaches FK) rather than
-- from a browser-supplied name or editable auth metadata. This is a database
-- trigger so the target write cannot silently omit the audit trail.
create or replace function public.audit_weekly_sport_target_change()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  actor_id uuid;
  coach_handle text;
  audit_action text;
  athlete text;
  target_id uuid;
  programme uuid;
begin
  actor_id := new.updated_by;
  athlete := new.athlete_code;
  target_id := new.id;

  select handle into coach_handle
    from public.coaches
   where id = actor_id;

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
    athlete,
    coach_handle,
    'weekly_sport_target',
    target_id,
    audit_action,
    'week',
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new),
    initcap(new.sport) || ' weekly target ' || audit_action
  );

  return new;
end
$function$;

drop trigger if exists trg_audit_weekly_sport_targets on public.weekly_sport_targets;
create trigger trg_audit_weekly_sport_targets
  after insert or update on public.weekly_sport_targets
  for each row execute function public.audit_weekly_sport_target_change();

-- Hard deletion is never part of the target lifecycle. Even a privileged
-- direct SQL caller must use removed_at so the row and its earlier log survive.
create or replace function public.reject_weekly_sport_target_delete()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'Weekly sport targets must be soft-removed'
    using errcode = 'check_violation';
end
$function$;

drop trigger if exists trg_reject_weekly_sport_target_delete on public.weekly_sport_targets;
create trigger trg_reject_weekly_sport_target_delete
  before delete on public.weekly_sport_targets
  for each row execute function public.reject_weekly_sport_target_delete();

drop trigger if exists trg_touch_weekly_sport_targets on public.weekly_sport_targets;
create trigger trg_touch_weekly_sport_targets
  before update on public.weekly_sport_targets
  for each row execute function public.touch_updated_at();

alter table public.weekly_sport_targets enable row level security;
revoke all on table public.weekly_sport_targets from public, anon, authenticated;
revoke all on table public.weekly_sport_targets from service_role;
grant select, insert, update on table public.weekly_sport_targets to service_role;

-- Legacy adoption -----------------------------------------------------------
-- nutrition_plans.weekly_km_target is the deployed coach-running-target source.
-- Keep it untouched. Where no structured active programme exists yet, create
-- one in the existing canonical hierarchy, then create/reuse its Week N rows.
-- Re-running this block is safe: all inserts are protected by existing unique
-- constraints and target conflicts deliberately keep the new model's value.

insert into public.athlete_programmes (
  athlete_code, coach_handle, name, type, status, created_by
)
select distinct
  np.athlete_code,
  upper(coalesce(nullif(a.coach, ''), 'KARL')),
  'Migrated coach programme',
  'combined',
  'active',
  'WEEKLY_TARGET_MIGRATION'
from public.nutrition_plans np
join public.athletes a on a.code = np.athlete_code
where np.weekly_km_target is not null
  and np.weekly_km_target >= 0
  and not exists (
    select 1 from public.athlete_programmes ap
     where ap.athlete_code = np.athlete_code and ap.status = 'active'
  )
on conflict do nothing;

with legacy_weeks as (
  select distinct
    np.athlete_code,
    case
      when np.week_label ~* 'discovery' then 0
      when substring(np.week_label from '(?i)(?:week[[:space:]]*)?([0-9]+)') is not null
        then substring(np.week_label from '(?i)(?:week[[:space:]]*)?([0-9]+)')::integer
      else null
    end as week_number,
    np.week_label
  from public.nutrition_plans np
  where np.weekly_km_target is not null and np.weekly_km_target >= 0
)
insert into public.athlete_programme_weeks (programme_id, week_number, week_label)
select ap.id, lw.week_number, coalesce(nullif(lw.week_label, ''), 'Week ' || lw.week_number)
from legacy_weeks lw
join public.athlete_programmes ap
  on ap.athlete_code = lw.athlete_code and ap.status = 'active'
where lw.week_number is not null
on conflict (programme_id, week_number) do nothing;

-- Link legacy planned sessions into the same canonical week rows. This only
-- fills null FKs and does not alter labels, dates, prescriptions, or history.
update public.planned_sessions ps
   set programme_week_id = apw.id
  from public.athlete_programmes ap
  join public.athlete_programme_weeks apw on apw.programme_id = ap.id
 where ps.programme_week_id is null
   and ap.athlete_code = ps.athlete_code
   and ap.status = 'active'
   and (
     apw.week_label = ps.week_label
     or (apw.week_number = 0 and ps.week_label ~* 'discovery')
     or apw.week_number = nullif(substring(ps.week_label from '([0-9]+)'), '')::integer
   );

insert into public.weekly_sport_targets (
  athlete_code, programme_week_id, sport, distance_target_metres,
  publish_state, published_at, updated_by, created_at, updated_at
)
select
  np.athlete_code,
  apw.id,
  'running',
  round(np.weekly_km_target * 1000)::bigint,
  'published',
  coalesce(np.updated_at, np.created_at, now()),
  migration_coach.id,
  coalesce(np.created_at, now()),
  coalesce(np.updated_at, np.created_at, now())
from public.nutrition_plans np
join public.athlete_programmes ap
  on ap.athlete_code = np.athlete_code and ap.status = 'active'
join public.athlete_programme_weeks apw
  on apw.programme_id = ap.id
 and (
   apw.week_label = np.week_label
   or (apw.week_number = 0 and np.week_label ~* 'discovery')
   or apw.week_number = nullif(substring(np.week_label from '([0-9]+)'), '')::integer
 )
cross join lateral (
  select id from public.coaches where enabled = true
  order by case when role = 'admin' then 0 else 1 end, created_at
  limit 1
) migration_coach
where np.weekly_km_target is not null and np.weekly_km_target >= 0
on conflict (athlete_code, programme_week_id, sport) do nothing;

commit;
