-- Push notification subscriptions for athlete reminders.
-- Service-key access only (RLS enabled, no anon policies) — all reads/writes
-- go through /api/reminders on Vercel.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  prefs jsonb not null default '{}'::jsonb,
  user_agent text,
  last_sent jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create index if not exists push_subscriptions_athlete_code_idx
  on public.push_subscriptions (athlete_code);
