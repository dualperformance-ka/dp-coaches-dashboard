# Strava integration implementation status

Updated 21 Aug 2026 against the canonical local implementation.

## Implemented

- A hard server-side block on coach reads of raw Strava activity data.
- Athlete-authenticated portal reads that derive the athlete code server-side.
- Short-lived HMAC-signed OAuth state; no bare athlete code is accepted by the callback.
- Server-generated authorisation URLs and environment-owned client/redirect configuration.
- Rotating refresh-token persistence and form-encoded OAuth exchanges.
- Athlete-initiated deauthorization using Strava's current Basic-auth revoke flow.
- Permanent Supabase activity summary/detail/zone/stream cache behind RLS and `service_role` only.
- Lazy activity detail, HR-zone, lap, best-effort and long-run stream enrichment.
- Durable webhook inbox, fast acknowledgement, activity invalidation/deletion and deauthorization handling.
- Per-request Strava rate-limit tracking and stale-cache fallback for the athlete view.
- Connection health: granted scopes, last sync/change, cache/detail/HR coverage and reconnect warnings.
- Athlete-facing insights for 80/20 distribution, aerobic decoupling, rep decay, PBs, GAP progression and shoe mileage.
- Athlete matching against prescribed sessions without exposing Strava tokens to either browser.

## Operational checks before release

1. Confirm `STRAVA_STATE_SECRET`, `STRAVA_REDIRECT_URI`, client credentials and webhook variables in the deployment environment.
2. Apply both Strava migrations in `supabase/migrations/` if the target database does not already contain the cache and webhook inbox.
3. Reconnect any athlete whose scope health reports `limited`.
4. Verify OAuth connect, callback, first sync, activity detail, forced sync, webhook delivery and disconnect in a preview deployment.
5. Monitor read-rate headers and Strava app athlete capacity; request Strava review before exceeding approved limits.

## Deliberate boundaries

- Tokens and raw cache tables are server-only.
- Coaches cannot impersonate an athlete's OAuth consent or view raw Strava data; coaching uses athlete-submitted Dual Performance logs.
- The dashboard provides coaching signals, not medical diagnosis or automatic programme changes.
- Cached Strava history remains after disconnect for coaching record continuity; remove it separately only under the agreed data-retention process.
