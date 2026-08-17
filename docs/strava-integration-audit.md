# Strava integration audit — what we use, what we're leaving on the table

Reviewed 17 Aug 2026 against `api/strava.js`, `api/strava-callback-fixed.js`,
`public/js/strava-match.js`, `public/index.html`, `docs/strava-prompts.md` and
the current Strava API docs.

Short answer: no, not fully. The plumbing is good and the matching logic is
better than most commercial tools. But we are pulling rich per-activity data and
then throwing away almost everything that would change a coaching decision. Four
of the highest-value endpoints are never called at all, a token-handling bug will
silently disconnect athletes, and the intensity check you shipped in Prompt 1b
has never once fired in production.

---

## 1. What we actually use today

| Endpoint | Called? | What we do with it |
| --- | --- | --- |
| `POST /oauth/token` | Yes | Auth + refresh with a 5-min expiry buffer |
| `GET /athlete/activities` | Yes | Paged since programme start; weekly km, run counts, week history, days-since-last-run |
| `GET /activities/{id}` | Yes | Selected week only (max 20). Merged into ~45 fields |
| `GET /activities/{id}/zones` | Yes | HR bucket distribution, selected week only |
| `GET /athlete/zones` | **No** | — |
| `GET /activities/{id}/streams` | **No** | — |
| `GET /athlete/stats` | **No** | — |
| `GET /gear/{id}` | **No** | — |
| `GET /athlete` (profile) | **No** | — |
| Webhook subscription | **No** | Still polling |
| `PUT /activities/{id}` | **No** | (needs `activity:write`) |

Scope requested: `activity:read_all` only.

### The bigger gap: data we fetch and display but never act on

`mergeActivityDetail()` captures ~45 fields and the session detail view in
`index.html` renders most of them faithfully. The gap is not display. It is that
none of it is aggregated across time, trended, or turned into a flag:

| Field | Status | What's missing |
| --- | --- | --- |
| `laps`, `splits_metric` | Rendered | No rep-consistency or pace-decay analysis |
| `best_efforts` + `pr_rank` | Rendered per activity | No PB detection or alerting |
| `perceived_exertion` | Rendered | Never cross-checked against portal RPE |
| `gear` | Shoe name shown | No cumulative mileage, no retirement warning |
| `hr_zones` | Rendered per activity | Never summed across a week or a block |
| `average_grade_adjusted_speed` | Captured | Not used as the progression metric |
| `suffer_score` | Captured | Read under the wrong field name downstream (see B) |

Every row in that table is a coaching insight sitting one aggregation away from
existing, and none of them need a new API call. That is the cheapest work in this
document.

---

## 2. Fix these first (they are breaking things now)

### A. We drop rotated refresh tokens — athletes will silently disconnect

`api/strava.js` line ~314:

```js
const refreshed = await doRefreshToken(refresh_token);
access_token = refreshed.access_token;
await updateTokens(athleteCode, access_token, refreshed.expires_at, tokens);
```

`updateTokens()` spreads the **old** token object and overwrites only
`access_token` and `expires_at`. `refreshed.refresh_token` is discarded.

Strava's auth docs are explicit: *"Applications should persist the refresh token
contained in the response, and always use the most recent refresh token for
subsequent requests."* When Strava rotates a refresh token, that athlete's next
refresh fails, `/api/strava` returns `connected: false`, and the dashboard reads
it as "never connected" rather than "broken". You would not notice until their
weekly km silently flatlined.

One-line fix. Do it today.

### B. The intensity check is dead in production

`classifyExecutedIntensity()` in `public/js/strava-match.js` reads
`activity.relative_effort`. **There is no such field in the Strava API.** The
field is called `suffer_score` — "Relative Effort" is only the name Strava uses
in its own UI. Confirmed against the SummaryActivity model in the API reference,
and `api/strava.js` itself maps `suffer_score` correctly on line 179 and never
aliases it.

So `Number(undefined)` is `NaN`, the guard returns `null`, and the entire Prompt
1b intensity check never fires. Every prescribed-quality session auto-completes
regardless of how easy it was run — exactly the behaviour that change was written
to prevent. The tests pass because they inject a synthetic `relative_effort`
property that production data never contains.

Two things to fix, not one:

1. Read `suffer_score`, not `relative_effort`.
2. `suffer_score` only reliably appears on the **detailed** activity and only when
   the run has heart rate. The summary list the matcher runs against mostly will
   not have it. So even after the rename, the check only works on the ≤20
   enriched activities in the selected week. If you want it on every session, it
   has to come from the `strava_activities` cache, which is another reason to
   build that first.

Also worth noting: the reference table in `docs/strava-prompts.md` claims
relative effort "is already present in the activity summary payload that
`/api/strava` returns." That is the assumption the bug came from. Correct the doc
too, or the next build prompt will reproduce it.

### C. Athlete code casing mismatch between write and read

`strava.js` uppercases: `(req.query.code || req.query.athlete).trim().toUpperCase()`.
`strava-callback-fixed.js` stores under `decodeURIComponent(state)` verbatim.
PostgREST `athlete_code=eq.` is case-sensitive. Any athlete whose connect link
carried a lowercase or mixed-case state is stored under a key the coach endpoint
can never find.

### D. `api/strava-callback-fixed.js` is broken and occupying a function slot

It uses `module.exports` in a package with `"type": "module"`, so it throws on
invocation. It also sits at `/api/strava-callback-fixed`, not the
`/api/strava-callback` path the portal's redirect_uri points at. It is either
dead weight or dead code. Deleting it frees the slot you need for a webhook
endpoint.

While you're there: the README says `api/` has 11 files with one slot free. It
has 16. Reconcile that before planning anything around the 12-function budget.

### E. The detail fan-out will exhaust the shared read quota

Strava's default read limit is **100 requests per 15 minutes and 1,000 per day,
app-wide across every athlete**.

One coach opening one athlete's week view costs:

```
1  activities list
20 activity details       (activitiesInLocalDateRange limit 20)
20 activity zones         (one per has_heartrate activity)
-----
41 requests
```

That is roughly **2 athlete-week views per 15 minutes** and **24 per day** for
the entire squad and every coach combined. The 15-min `dp_strava_summaries`
localStorage cache and the 10-min CDN `s-maxage` protect the squad overview, but
neither protects the detail view — the URL changes per week, so every week a
coach clicks is a fresh 41 requests.

Two mitigations, both already in your own spec and neither built: the
`strava_activities` summary cache, and permanent lazy caching of lap/zone detail.
Laps for a past activity never change. Cache them once, forever.

### F. Scope drift

The fallback connect URL in `public/js/10-boot.js` still requests
`scope=activity:read_all` with an empty `state`. You decided to add
`profile:read_all` to unlock HR and pace zones. That is not in this repo. Check
whether the portal's server-generated `connectUrl` has it, because `/athlete/zones`
will 401 without it.

Also worth a conscious decision: `activity:read_all` includes privacy-zone data
and activities the athlete set to "Only You". Athletes generally do not realise
that. And per your own stated rule — coaches see the confirmed portal log, not the
raw Strava feed — `/api/strava` is a coach endpoint returning enriched raw
activities. Worth re-checking that against the Strava API agreement.

---

## 3. Ideas, ranked by coaching value

### Tier 1 — these change how you coach an athlete

**1. Aerobic decoupling (HR drift) per long run.**
The single best objective marker of whether an athlete's aerobic base is actually
building. Split the run in half, compare pace-per-heartbeat in H1 vs H2. Under 5%
drift means the base is there. Over 5% means they are not yet aerobically ready
for the volume, no matter what their pace says.

Needs `GET /activities/{id}/streams?keys=time,heartrate,velocity_smooth,distance,grade_smooth`.
One call per activity, cache permanently, only run it on long runs. Plot the
trend across an 18-week block and you have a base-building line that pace and RPE
cannot give you. Nothing else in this list is worth more.

**2. Zone distribution across the block — the 80/20 audit.**
You already fetch and render per-activity HR bucket distributions. You just never
add them up across time. Aggregate across the week and the block: "82% easy, 18% hard." The most
common failure in amateur endurance athletes is the grey zone — every easy run a
bit too hard, every hard run a bit too soft, and no adaptation from either.

This is a weekly coaching conversation with a number attached, and it needs
**zero new API calls**. Cache what you already fetch and sum it. Highest
value-to-effort ratio in the document.

**3. The athlete's real zones, in their own numbers.**
`GET /athlete/zones` returns their configured HR and pace zones. Right now you
prescribe "easy" and hope. With this you prescribe "Z2, 142–156 bpm for you" and
the intensity-check threshold in `strava-match.js` stops being a hardcoded 3.0
seed and becomes personal — which is exactly the per-athlete calibration your own
comment says to build later. Needs `profile:read_all`. One call per athlete,
cache for a month.

**4. Executed-vs-prescribed at rep level.**
You pull `laps` and `splits_metric` and render them in the session detail view,
but nothing analyses them. For a
prescribed 4×1500m: were the reps even, or did rep 4 fall off 8s/km? What was
avg HR per rep, and did it climb while pace fell? That is the difference between
"did the session" and "executed the session", and it is triage row 5 from your
own spec, still unbuilt.

Coach-only, as your spec correctly says. Athletes seeing pace-decay charts
produces anxiety, not adherence.

**5. Grade-adjusted pace as the progression metric.**
`average_grade_adjusted_speed` is already in the payload. An athlete who moves
from flat routes to hilly ones looks like they are getting slower on raw pace.
GAP is the honest line. Swap it in anywhere you currently trend pace.

**6. Automatic PB detection.**
`best_efforts` gives you 400m / 1k / 1 mile / 5k / 10k bests per run with
`pr_rank`. You already render them per activity via `bestEffortsHtml()`, which
means a coach only sees a PB if they happen to open that exact session. Promote
it to a flag: "Jaydon set a 5k PB inside Sunday's long run." You would never spot
that by browsing, the athlete often does not either, and it is retention gold and
free content for the channel.

**7. Shoe mileage.**
You already show the shoe name on a session. What you cannot see is the running
total. `detail.gear` comes free on the detail call, and one `/gear/{id}` per shoe
(cached) gives you the odometer. Shoes past ~700km are a real injury vector.
"Benny's Vaporflys are at 640km" is a one-line card that prevents an injury and
reads as genuinely attentive coaching.

**8. Stop asking for RPE twice.**
Strava's detailed activity carries `perceived_exertion` — the athlete's own RPE,
which you already capture and display but never reconcile. Backfill it where the portal RPE is empty,
and where both exist and disagree by 3+, flag it. Athletes who rate a session 4
in Strava and 8 in the portal are telling you something.

### Tier 2 — foundation that unlocks all of the above

**9. Webhook subscription.** Replaces polling entirely, which is the real fix for
the quota problem — you stop asking and Strava tells you. It also delivers
**deauthorization events**, so an athlete who revokes access shows as
disconnected instead of quietly going stale. One subscription covers every
athlete. Callback must return 200 within 2 seconds, so queue the work and
respond immediately. Costs one function slot — take it from
`strava-callback-fixed.js`.

**10. `strava_activities` Supabase cache.** Your own spec, still unbuilt, and it
blocks triage rows 2 and 5.

**11. Read Strava's rate-limit headers.** Every response carries
`X-RateLimit-Usage` and `X-ReadRateLimit-Usage`. Store the latest, and degrade
gracefully *before* you hit 429 rather than after. Right now the first sign of
trouble is a failure.

### Tier 3 — worth doing eventually

**12. `GET /athlete/stats`** — one call gives a new athlete's YTD and all-time run
totals and recent 4-week averages. Onboarding baseline without an intake question.

**13. `PUT /activities/{id}`** — stamp the prescription into the Strava activity
title: "DP W6D3 — Tempo 4×1500m". Branded on every athlete's public feed, makes
matching trivial, and quietly markets the squad. Needs `activity:write` and
another re-consent, so bundle it with the `profile:read_all` re-consent rather
than asking twice.

**14. Club endpoint** — squad leaderboard, if you want the social layer.

---

## 4. Suggested order

1. Fix the refresh-token rotation bug. Today, one line.
2. Rename `relative_effort` to `suffer_score` in `strava-match.js` and fix the
   claim in `docs/strava-prompts.md`. A feature you already shipped starts
   working.
3. Fix the casing mismatch, delete the broken callback file, reconcile the
   function count.
4. Build the `strava_activities` cache + permanent lap/zone detail cache. Nothing
   above scales without it.
5. Ship the zone-distribution audit (idea 2). No new API calls, immediate
   coaching value, proves the cache.
6. Add `profile:read_all`, pull `/athlete/zones`, personalise the intensity
   threshold (idea 3).
7. Webhook subscription (idea 9), then streams-based decoupling (idea 1).
8. Rep-level execution analysis and PB detection (ideas 4 and 6).

Ideas 2, 4, 5, 6, 7 and 8 all run on data you are **already paying the quota
for**. Do those before spending a single new API call.
