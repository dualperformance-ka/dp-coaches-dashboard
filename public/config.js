// ── CONFIG ────────────────────────────────────────────────────────────────────
// Public client configuration. These values are visible in the browser by design:
// - Supabase anon/publishable keys rely on RLS policies for access control.
// Keep write-capable secrets in Vercel env vars only (SUPABASE_SERVICE_KEY,
// CLOUDINARY_API_SECRET). The Notion integration was removed on 2026-07-20 —
// Supabase is the single source of truth for all portal data.
// Portal state, structured submissions, and progress media all pass through
// authenticated same-origin server routes.
const WEBHOOK = '/api/ingest';
const CHECKIN_WEBHOOK = '/api/ingest';
const DAILY_BODY_WEBHOOK = '/api/ingest';
const DAILY_NUT_WEBHOOK = '/api/ingest';
const GOALS_WEBHOOK = '/api/ingest';
const SUPABASE_URL = 'https://rugdupplsswxmpoudhpv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_KJU_GYqUOwthiLo5WQjfog_MLaVKw5R';
// Web Push (public VAPID key — the private key lives in Vercel env vars only)
const VAPID_PUBLIC_KEY = 'BC7jdUB_OT76fRWp-PgNKyKvErSx0NxH-F7eS-tyQbo7G6YxHJQDwrJ-WwH7WFXQv7WsEOTFcAdSuCPfwfJOWuM';
// Email OTP sign-in (migration to Supabase Auth). This flag only controls
// whether the "Sign in with email" toggle is VISIBLE on the login screen —
// actual code sends are gated server-side by the EMAIL_AUTH_ENABLED env var
// plus per-athlete enrolment (athletes.email + auth_mode). Legacy code login
// stays available regardless until migration is complete.
const EMAIL_AUTH_UI = true;
var GYM_KEYS = ['Upper A','Upper B','Lower A','Lower B']; // extended at runtime from Supabase workout_splits
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
