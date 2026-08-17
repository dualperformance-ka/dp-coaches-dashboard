begin;

drop table if exists public.daily_macro_overrides;
drop function if exists public.reject_daily_macro_override_delete();
drop function if exists public.audit_daily_macro_override_change();
drop function if exists public.validate_daily_macro_override_owner();

commit;
