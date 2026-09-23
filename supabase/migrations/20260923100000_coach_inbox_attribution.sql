-- Coach attribution on the athlete message and data-rights queues.
--
-- contact_messages and data_requests are created and written by the athlete
-- portal (20260826060000_contact_messages.sql, 20260827230000_data_requests.sql).
-- The coaches dashboard now marks messages read and acknowledges / completes
-- data requests through the coach-authenticated api/athletes.js actions. The
-- timestamps already exist; this adds WHO did it, so the 30-day data-rights
-- commitment has a named owner for every step.
--
-- Additive and idempotent. No grants to anon/authenticated; RLS stays on with
-- no policies, so only the service role (server routes) can touch these rows.
-- The dashboard tolerates these columns being absent (server/coach-operations.js
-- drops them and retries), so deploy order does not matter.

alter table if exists public.contact_messages
  add column if not exists read_by text;

alter table if exists public.data_requests
  add column if not exists acknowledged_by text,
  add column if not exists completed_by text;

comment on column public.contact_messages.read_by is
  'Coach who marked the note read (dashboard). Null when unread or read before attribution existed.';
comment on column public.data_requests.acknowledged_by is
  'Coach who acknowledged the request (dashboard).';
comment on column public.data_requests.completed_by is
  'Coach who marked the request completed (dashboard).';

do $$
begin
  if to_regclass('public.contact_messages') is not null and not exists (
    select 1 from pg_constraint
    where conname = 'contact_messages_read_by_length'
      and conrelid = 'public.contact_messages'::regclass
  ) then
    alter table public.contact_messages
      add constraint contact_messages_read_by_length
      check (read_by is null or char_length(read_by) <= 80);
  end if;
  if to_regclass('public.data_requests') is not null and not exists (
    select 1 from pg_constraint
    where conname = 'data_requests_attribution_length'
      and conrelid = 'public.data_requests'::regclass
  ) then
    alter table public.data_requests
      add constraint data_requests_attribution_length
      check (
        (acknowledged_by is null or char_length(acknowledged_by) <= 80)
        and (completed_by is null or char_length(completed_by) <= 80)
      );
  end if;
end
$$;

grant select, update on table public.contact_messages to service_role;
grant select, update on table public.data_requests to service_role;
