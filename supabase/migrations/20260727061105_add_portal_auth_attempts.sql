create table if not exists public.portal_auth_attempts (
  id bigint generated always as identity primary key,
  fingerprint text not null,
  success boolean not null default false,
  attempted_at timestamptz not null default now()
);

alter table public.portal_auth_attempts enable row level security;
revoke all on table public.portal_auth_attempts from anon, authenticated;
revoke all on sequence public.portal_auth_attempts_id_seq from anon, authenticated;
grant select, insert, delete on table public.portal_auth_attempts to service_role;
grant usage, select on sequence public.portal_auth_attempts_id_seq to service_role;

create index if not exists portal_auth_attempts_fingerprint_attempted_idx
  on public.portal_auth_attempts (fingerprint, attempted_at desc);
create index if not exists portal_auth_attempts_attempted_idx
  on public.portal_auth_attempts (attempted_at);
