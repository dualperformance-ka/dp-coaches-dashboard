alter table public.coach_actions
  add column if not exists updated_by text,
  add column if not exists completed_by text;

update public.coach_actions
set updated_by = coalesce(updated_by, created_by, owner)
where updated_by is null;

update public.coach_actions
set completed_by = coalesce(completed_by, updated_by, created_by, owner)
where status = 'done'
  and completed_by is null;

comment on column public.coach_actions.updated_by is
  'Authenticated dashboard coach who most recently changed this action.';

comment on column public.coach_actions.completed_by is
  'Authenticated dashboard coach who most recently completed this action.';
