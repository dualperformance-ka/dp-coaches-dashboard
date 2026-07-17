create table if not exists public.coach_actions (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null references public.athletes(code) on update cascade on delete restrict,
  title text not null check (char_length(title) between 1 and 180),
  category text not null default 'coaching',
  priority text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting', 'done', 'cancelled')),
  owner text,
  due_at date,
  source text not null default 'manual',
  source_key text,
  notes text,
  outcome text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists coach_actions_status_due_idx
  on public.coach_actions (status, due_at, created_at desc);
create index if not exists coach_actions_athlete_idx
  on public.coach_actions (athlete_code, created_at desc);
create unique index if not exists coach_actions_source_key_idx
  on public.coach_actions (athlete_code, source_key)
  where source_key is not null;

alter table public.coach_actions enable row level security;
revoke all on table public.coach_actions from anon, authenticated;
grant all on table public.coach_actions to service_role;

comment on table public.coach_actions is
  'Server-managed coaching workflow. No browser-direct access; use authenticated dashboard APIs.';
