# Garmin + COROS API applications — draft copy and submission notes

Prepared 17 Aug 2026. Companion to `strava-integration-audit.md`.

Goal: pull measured daily energy expenditure (active + resting calories, steps,
intensity minutes) so nutrition targets are set against real output instead of
reported intake. See the energy-balance rationale at the end of this doc.

---

## 0. Fill these in before you send anything

Both applications ask for a real business identity. Do not send with blanks.

| Field | Value | Status |
| --- | --- | --- |
| Registered entity name | `Dual Performance Pty Ltd` (or your actual trading entity) | **CONFIRM** |
| ABN | | **FILL** |
| Country of operation | Australia | ok |
| Company website | https://dualperformance.au | ok |
| Product / platform name | Dual Performance Athlete Portal | ok |
| Product URL | https://portal.dualperformance.au | ok |
| Authorised technical representative | Karl Sexon, Co-founder | ok |
| Technical contact email | | **FILL** (use a domain address, not gmail — see note below) |
| Current active athletes | ~10 | **CONFIRM** |
| Projected 12-month users | | **FILL** |

**On the contact email:** use `karl@dualperformance.au` or similar if you have
domain mail. Both Garmin and COROS are verifying you are a business. A gmail
address on a B2B API application is the single most common reason a reviewer
downgrades an application to "hobbyist".

**On roster size:** do not inflate it. Garmin may ask, and ~10 paying athletes on
a platform you already built and shipped reads better than a vague large number
you cannot evidence. Your strength here is that the product exists and is in
production, not that it is big.

---

## 1. Garmin Connect Developer Program

### Where and how

Apply through the Garmin Connect Developer Program request form at
https://developer.garmin.com/gc-developer-program/. One application covers the
Health, Activity and Training APIs and you may use any or all of them in a single
integration.

**What to expect:** application status confirmed within two business days, then an
integration call to scope your needs, then typically 1 to 4 weeks of integration
work in their evaluation environment before production credentials.

**Fees:** there are no licensing or maintenance fees for program access, but it is
business use only. Note the Health API page separately states that commercial use
of some metrics requires a license fee payment. Raise this on the integration call
(see question list below) so you are not surprised later.

**Which APIs to request:** Health API and Activity API.

- **Health API** is the one that matters. Daily Summaries carry
  `activeKilocalories` and `bmrKilocalories`, which together give a complete
  measured daily TDEE per athlete.
- **Activity API** gives per-session detail and replaces your Strava dependency
  for Garmin-wearing athletes.
- **Do not request the Training API** in round one. It pushes structured workouts
  to the device, which is a genuinely great future feature but it widens the
  review scope and you have no immediate use for it. Add it later.

### Application narrative

> Dual Performance is a premium hybrid endurance and strength coaching business
> based in Adelaide, Australia, operating a 2:1 coaching model across running and
> body composition. We coach a roster of paying athletes through structured
> marathon, half-marathon and hybrid training blocks.
>
> We have built and operate our own athlete platform: the Dual Performance
> Athlete Portal, a progressive web app backed by Supabase and deployed on
> Vercel, with an accompanying coaches dashboard. Athletes log sessions,
> nutrition, body weight and subjective readiness in the portal. Coaches
> prescribe programming, review execution against prescription, and adjust
> training and nutrition blocks from the same system. The platform is in
> production today and already integrates Strava via OAuth 2.0.
>
> We are requesting Health API and Activity API access to solve a specific
> coaching problem. We currently set each athlete's calorie and macronutrient
> targets from their reported dietary intake and body weight trend, which gives us
> the input side of energy balance but not the output side. Without measured
> expenditure we cannot distinguish an athlete who has genuinely plateaued from
> one whose training volume dropped while intake held constant, and we cannot
> safely detect under-fuelling when training load increases.
>
> The Health API's Daily Summary resolves this directly. `activeKilocalories` and
> `bmrKilocalories` give us a measured total daily energy expenditure per athlete
> per day. Combined with the intake and body weight data already in our platform,
> this lets us prescribe an evidence-based deficit or surplus, phase nutrition
> across a training block, and cycle intake against training load rather than
> applying a flat daily target. Steps and intensity minutes let us account for
> non-exercise activity, which is the largest unmeasured variable in our current
> model.
>
> The Activity API gives us per-session data for the same athletes, letting us
> compare executed sessions against prescribed sessions inside our existing
> programming engine.
>
> Every athlete connects their own Garmin account through an explicit OAuth 2.0
> consent flow initiated from their own portal login. Data is used solely to
> deliver the coaching service that athlete is paying for, is visible only to that
> athlete and their assigned Dual Performance coach, and is never sold, shared
> with third parties, or used for advertising. Athletes can disconnect at any time
> from the portal, and we will honour deregistration and user permission change
> webhooks to purge data on revocation.

### Data justification

Have this ready for the integration call. Garmin reviewers respond well to a
specific per-endpoint justification and badly to "we want all the data".

| Endpoint | Why we need it |
| --- | --- |
| Daily Summaries | `activeKilocalories` + `bmrKilocalories` = measured TDEE, the core requirement. Steps and intensity minutes capture NEAT. |
| Activities | Executed vs prescribed session analysis in our existing programming engine. |
| Sleep Summaries | Recovery context when adjusting training load. Secondary. |
| Stress / Body Battery | Readiness cross-check against athlete-reported readiness scores. Secondary, drop if it complicates approval. |
| Deregistration + User Permission Change webhooks | Required for compliant data purge on revocation. |
| Body Composition | Only if athletes use Garmin Index scales. Optional. |

If they push back on scope, hold Daily Summaries and Activities and give up the
rest. Those two are the whole business case.

### Technical details to supply

- **OAuth redirect URI:** `https://portal.dualperformance.au/api/garmin-callback`
- **Webhook / ping endpoint:** `https://portal.dualperformance.au/api/garmin-webhook`
- **Auth:** OAuth 2.0 with PKCE (confirm the current Garmin flow on the
  integration call, they migrated off OAuth 1.0a)
- **Data storage:** Supabase (PostgreSQL) with row-level security, hosted in
  Australia if your project region allows, server-side access only via service
  role, no direct client access to raw provider payloads
- **Existing integrations:** Strava (OAuth 2.0, live in production)

### Ask these on the integration call

1. Which specific metrics attract a commercial license fee, and what is the fee
   structure at our scale? The Health API page mentions one, the Program FAQ says
   there are none.
2. Are there minimum device order commitments attached to any metric we have
   requested?
3. What are the rate limits and backfill limits per user and per app?
4. Is there any restriction on a coach viewing a consenting athlete's data, or on
   deriving and displaying nutrition targets from it?
5. What is the required data purge window after a deregistration event?

Question 4 matters. Strava's agreement restricts you to showing an athlete their
own data, which is why your coaches see the confirmed portal log rather than the
raw Strava feed. Garmin's program is explicitly built for B2B platforms where a
coach or clinician views consenting users' data, so this restriction likely does
not carry across. Get it confirmed in writing, because if it holds, the coaches
dashboard can show Garmin data directly and that is a materially better product
than what Strava allows.

---

## 2. COROS API

### Where and how

Email `api@coros.com` and complete the application form linked from
https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application

The process is: submit technical details, review and accept their API Terms of
Use, then receive Client ID and Secret after identity and security verification.
No published fee or timeline. Expect a thinner API surface and less documentation
than Garmin.

### Cover email

> **Subject:** API access application — Dual Performance Athlete Portal (Australia)
>
> Hi COROS API team,
>
> I am writing to apply for COROS API access on behalf of Dual Performance, a
> hybrid endurance and strength coaching business based in Adelaide, Australia.
>
> We operate our own athlete platform, the Dual Performance Athlete Portal, a
> progressive web app backed by Supabase and deployed on Vercel. Athletes log
> training, nutrition, body weight and readiness; coaches prescribe programming
> and review executed sessions against prescription. The platform is live in
> production and already integrates Strava via OAuth 2.0.
>
> A portion of our coached athletes train on COROS watches. We are requesting API
> access so those athletes can connect their COROS accounts and have their
> training and daily activity data flow into the same coaching system as the rest
> of our roster. Our specific need is daily energy expenditure and activity data,
> which we use alongside logged dietary intake and body weight trend to set
> evidence-based calorie and macronutrient targets across a training block.
>
> Every athlete connects their own account through an explicit OAuth 2.0 consent
> flow initiated from their own authenticated portal session. Data is used solely
> to deliver the coaching service that athlete is paying for, is visible only to
> that athlete and their assigned coach, is stored server-side in Supabase with
> row-level security and no direct client access, and is never sold or shared with
> third parties. Athletes can disconnect at any time and we will purge their data
> on revocation.
>
> Our technical details:
>
> - Company: [ENTITY NAME], ABN [ABN]
> - Country: Australia
> - Website: https://dualperformance.au
> - Platform: Dual Performance Athlete Portal, https://portal.dualperformance.au
> - Authorised technical representative: Karl Sexon, Co-founder
> - Technical contact: [EMAIL]
> - OAuth 2.0 redirect URI: https://portal.dualperformance.au/api/coros-callback
> - Webhook endpoint: https://portal.dualperformance.au/api/coros-webhook
> - Existing integrations: Strava (OAuth 2.0, production)
>
> I have attached the completed application form. Happy to provide any further
> detail on our security posture, data handling or use case.
>
> Thanks,
> Karl Sexon
> Co-founder, Dual Performance

### Form answers

Reuse the Garmin narrative, trimmed. The fields they ask for are company details,
authorised technical representative, technical contact, and OAuth 2.0 redirect
URIs. Their terms cover security requirements, data privacy compliance and rate
limits, so make sure your answer on data handling matches what you actually do:
server-side only, RLS enabled, service role access, no raw payloads to the
browser.

---

## 3. What these two applications do not solve

Your roster is mixed and includes Apple Watch. Garmin and COROS between them will
not cover those athletes, and there is no workaround inside your current
architecture:

**Apple Health is not readable from a progressive web app.** HealthKit is a native
iOS framework. No web API, no permission prompt, no exceptions. Your portal is a
PWA, so Apple Watch athletes cannot contribute expenditure data to it directly.

Three ways out, in order of cost:

1. **Strava as the fallback for Apple Watch athletes.** Their watch already syncs
   activities to Strava. You get session-level data but no resting calories, no
   steps, no NEAT. Partial, but free, and you already built it.
2. **An aggregator** (Terra, Spike, Rook, Junction, Open Wearables). One OAuth,
   one webhook, one normalised schema, and they ship the native iOS component that
   unlocks Apple Health. Priced per connected user per month. For a mixed roster
   this is the only option that covers everyone.
3. **Build a native iOS app.** Not worth it at your scale.

Submitting the Garmin and COROS applications is still correct regardless. They
cost nothing but calendar time, they cover the majority of your roster, and direct
access is better data and no per-user fee. But decide the Apple Watch question
separately, because it does not get solved by waiting for these approvals.

---

## 4. Build notes for after approval

**Do not build three bespoke pipelines.** Build one normalised layer and write
adapters into it:

```
athlete_energy_daily
  athlete_code    text
  date            date
  source          text     -- 'garmin' | 'coros' | 'strava' | 'manual'
  active_kcal     numeric  -- expenditure above resting
  bmr_kcal        numeric  -- null for Strava, which cannot provide it
  total_kcal      numeric  -- measured TDEE where available
  steps           integer
  moving_minutes  numeric
  load            numeric
  primary key (athlete_code, date, source)
```

Strava adapter first, since it already exists and proves the schema. Garmin and
COROS then drop in as adapters rather than rebuilds. If you later move to an
aggregator you replace one adapter instead of the nutrition engine.

**Watch the Vercel function budget.** Per the audit, `api/` already holds 16
files against a 12-function limit that needs reconciling. Garmin and COROS each
want a callback plus a webhook, so that is four more functions. Sort the function
count before approval lands, or combine the callbacks into a single
`/api/oauth-callback` with a provider query parameter.

**Always store net expenditure, never gross,** and keep `bmr_kcal` in its own
column. The failure mode when you merge Garmin's measured burn with a
formula-based maintenance figure is silent double counting, and the athlete
overeats while you both wonder why the deficit is not working.
