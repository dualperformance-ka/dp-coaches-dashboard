begin;

do $$
begin
  if to_regclass('public.athlete_activity_uploads') is null then
    raise exception 'athlete_activity_uploads table is missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'athlete_activity_uploads'
      and c.relrowsecurity = true
  ) then
    raise exception 'RLS is not enabled on athlete_activity_uploads';
  end if;

  if has_table_privilege('anon', 'public.athlete_activity_uploads', 'select')
     or has_table_privilege('authenticated', 'public.athlete_activity_uploads', 'select')
     or has_table_privilege('anon', 'public.athlete_activity_uploads', 'insert')
     or has_table_privilege('authenticated', 'public.athlete_activity_uploads', 'insert') then
    raise exception 'client roles must not access athlete_activity_uploads directly';
  end if;

  if not has_table_privilege('service_role', 'public.athlete_activity_uploads', 'select,insert,update,delete') then
    raise exception 'service_role is missing activity upload privileges';
  end if;

  if not exists (
    select 1 from storage.buckets
    where id = 'athlete-activity-files'
      and public = false
      and file_size_limit = 3145728
  ) then
    raise exception 'private athlete activity file bucket is missing or misconfigured';
  end if;
end
$$;

rollback;
