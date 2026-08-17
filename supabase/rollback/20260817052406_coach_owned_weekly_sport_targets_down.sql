begin;

drop table if exists public.weekly_sport_targets;
drop function if exists public.reject_weekly_sport_target_delete();
drop function if exists public.audit_weekly_sport_target_change();
drop function if exists public.validate_weekly_sport_target_owner();

-- Legacy nutrition values are never changed by the up migration. Canonical
-- programme/week rows created during adoption are intentionally retained on
-- rollback because planned sessions may now reference them.

commit;
