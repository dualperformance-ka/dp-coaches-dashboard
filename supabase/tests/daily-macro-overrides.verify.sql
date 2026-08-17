-- Apply after the programming migrations and
-- 202608180001_coach_owned_daily_macro_overrides.sql.

do $$
declare
  required_constraint text;
  required_trigger text;
begin
  if to_regclass('public.daily_macro_overrides') is null then
    raise exception 'FAIL: daily_macro_overrides table is missing';
  end if;

  foreach required_constraint in array array[
    'daily_macro_overrides_identity_key',
    'daily_macro_overrides_calories_nonnegative',
    'daily_macro_overrides_protein_nonnegative',
    'daily_macro_overrides_carbs_nonnegative',
    'daily_macro_overrides_fats_nonnegative',
    'daily_macro_overrides_fibre_nonnegative',
    'daily_macro_overrides_calories_ceiling',
    'daily_macro_overrides_protein_ceiling',
    'daily_macro_overrides_carbs_ceiling',
    'daily_macro_overrides_fats_ceiling',
    'daily_macro_overrides_fibre_ceiling',
    'daily_macro_overrides_day_label_length',
    'daily_macro_overrides_coach_note_length',
    'daily_macro_overrides_published_macros',
    'daily_macro_overrides_published_timestamp',
    'daily_macro_overrides_removed_is_draft'
  ] loop
    if not exists (
      select 1 from pg_constraint
       where conrelid = 'public.daily_macro_overrides'::regclass
         and conname = required_constraint
    ) then
      raise exception 'FAIL: constraint % is missing', required_constraint;
    end if;
  end loop;

  foreach required_trigger in array array[
    'trg_validate_daily_macro_override_owner',
    'trg_audit_daily_macro_overrides',
    'trg_reject_daily_macro_override_delete',
    'trg_touch_daily_macro_overrides'
  ] loop
    if not exists (
      select 1 from pg_trigger
       where tgrelid = 'public.daily_macro_overrides'::regclass
         and tgname = required_trigger
         and not tgisinternal
    ) then
      raise exception 'FAIL: trigger % is missing', required_trigger;
    end if;
  end loop;

  if not exists (
    select 1 from pg_class
     where oid = 'public.daily_macro_overrides'::regclass
       and relrowsecurity
  ) then
    raise exception 'FAIL: RLS is not enabled';
  end if;

  if has_table_privilege('anon', 'public.daily_macro_overrides', 'select')
     or has_table_privilege('anon', 'public.daily_macro_overrides', 'insert')
     or has_table_privilege('authenticated', 'public.daily_macro_overrides', 'select')
     or has_table_privilege('authenticated', 'public.daily_macro_overrides', 'update')
     or has_table_privilege('authenticated', 'public.daily_macro_overrides', 'delete') then
    raise exception 'FAIL: a browser role has direct daily_macro_overrides privileges';
  end if;

  if not has_table_privilege('service_role', 'public.daily_macro_overrides', 'select')
     or not has_table_privilege('service_role', 'public.daily_macro_overrides', 'insert')
     or not has_table_privilege('service_role', 'public.daily_macro_overrides', 'update')
     or has_table_privilege('service_role', 'public.daily_macro_overrides', 'delete') then
    raise exception 'FAIL: service_role privilege set is not select/insert/update only';
  end if;

  if to_regclass('public.daily_macro_overrides_published_athlete_idx') is null
     or to_regclass('public.daily_macro_overrides_week_idx') is null then
    raise exception 'FAIL: one or more daily macro indexes are missing';
  end if;

  raise notice 'PASS daily macro overrides: constraints, triggers, RLS, grants, and indexes';
end
$$;
