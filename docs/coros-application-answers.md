# COROS API application — field-by-field answer sheet

Form: https://coros-teams.feishu.cn/share/base/form/shrcnLqSduZsaNhbvDJTO2x0Vlf
Read live 17 Aug 2026. 24 fields, 21 of them required.

**Answer: yes, do both.** COROS's instructions say to email `api@coros.com` with your
platform details *and* submit this form. The email is where a human reads your use
case; the form is their intake record.

---

## Do these four things BEFORE you submit

**1. Stand up a support page.** Their terms state: *"We require that all partners
add a Login Portal and Support Page to their website or support center."* You have
the login portal. You do not have a public support page. A single page at
`dualperformance.au/support` with a contact email, a "how to connect your COROS
watch" section, and a disconnect instruction is enough. Submitting without it gives
them an easy reason to reject.

**2. Sort the callback domain first.** Your live portal is on a `vercel.app`
subdomain and the repo references a second variant of it, so confirm which is
actually live before you register anything:

- `https://dp-athleteportal.vercel.app` (currently serving)
- `https://dp-athlete-portal.vercel.app` (Vercel project name, in the repo)

Strong recommendation: put the portal on `portal.dualperformance.au` before you
submit either application. Both COROS and Garmin bake the callback domain into your
credentials, changing it later means going back through their support, and a
`vercel.app` address on a partner application reads as a side project rather than a
business.

**3. Download the API Reference Guide.** Linked from the form intro. Question 13
explicitly references section 5.3 for the Workout Summary Data Push Service, so you
need it open while filling this in.

**4. Read the COROS API Agreement PDF before ticking Q21.** Linked at question 21.
Check specifically whether a coach may view a consenting athlete's data. This is the
same question that constrains you on Strava, where you can only show an athlete
their own data. If COROS permits coach visibility, your coaches dashboard can show
COROS data directly.

**Good news:** *"There is no fee associated with integration when partnering with
COROS."* Confirmed in the form intro.

---

## The honest risk

The form intro states they cannot accept everyone and that they weigh *"current
market size, how the data will be used, and other factors."*

At question 9 you will select **0-150** active users, the smallest bracket. That is
your weak point and there is no way to dress it up. What you have going for you:
the platform is built and in production, the use case is specific and technically
literate, it is commercial, and you already run a live OAuth integration. Lean on
those in question 18 and in the cover email. Do not inflate the user number, they
will ask.

---

## Field-by-field

| # | Field | Answer |
| --- | --- | --- |
| 1 | Platform / Application Name | `Dual Performance Athlete Portal` |
| 2 | Company Name | **[REGISTERED ENTITY NAME]** |
| 3 | Primary Contact Email | **[karl@dualperformance.au]** — use a domain address, not gmail |
| 4 | Secondary Contact Email | **[Alex's domain address]** |
| 5 | Privacy Officer Email | **[privacy@dualperformance.au]** — a role alias reads better than a personal one |
| 6 | Company Owner Name and Title | `Karl Sexon, Co-founder` (add Alex if you are both listed owners) |
| 7 | Platform / Application URL | **[confirmed portal domain]** |
| 8 | Description (100 char limit) | see options below |
| 9 | Total Active Users | `0-150` |
| 10 | Primary Region | `Australia` |
| 11 | API function(s) needed | tick **Activity / Workout Data Sync (one way, COROS to your platform)** and **Access Daily Health Data**. Nothing else. |
| 12 | Authorized Callback Domain | **[confirmed portal domain]** — domain only, no path. They allow one or two, so list both the custom domain and the vercel one if you have both live. |
| 13 | Workout Data Receiving Endpoint | `https://[domain]/api/coros-webhook` — check §5.3 of the Reference Guide first |
| 14 | Service Status Check URL | `https://[domain]/api/status` — **you need to build this**, see note below |
| 15 | Bluetooth / ANT+ protocol link | `N/A` |
| 16 | Personal or public use | `Public` — it is used by your athletes, not only you |
| 17 | Commercial or non-commercial | `Commercial` |
| 18 | Intended use of data | see draft below |
| 19 | Expected Integration Launch Date | pick a real date 6-8 weeks out. They ask to be notified a week before go-live, so do not put something you will miss. |
| 20 | Agree to Application Terms | `Yes` |
| 21 | Agree to API Agreement | `Yes` — after reading the PDF |
| 22 | Your name | `Karl Sexon` |
| 23 | Submit Date | date you submit |
| 24 | Logo PNGs | attached, all four sizes generated |

### Question 8 — description options (100 char limit, customer-facing)

This appears on the COROS partner page, so it is marketing copy, not a technical
description.

| Chars | Option |
| --- | --- |
| 95 | `Premium hybrid run and strength coaching platform. Structured programming, nutrition, recovery.` |
| 96 | `Hybrid endurance and strength coaching platform for structured training, nutrition and recovery.` |
| 95 | `Coaching platform for hybrid endurance athletes: training, nutrition and recovery in one place.` |

First one is the pick. It leads with the positioning and it is the only one that
says "premium".

### Question 11 — why only those two

- **One-way activity sync** gives you executed sessions to compare against
  prescription. That is the existing programming engine.
- **Daily health data** is the whole reason you are applying. It is where daily
  energy expenditure lives.
- **Skip two-way sync and structured workout push.** Great future features, but they
  widen the review scope and require your platform to write into COROS, which you
  have no code for. Add later.
- **Skip GPX, Bluetooth, ANT+.** Not applicable.

### Question 14 — the status endpoint you don't have yet

They want a URL they can hit to check your service is alive. You do not have one.
It is about ten lines:

```js
// api/status.js
export default function handler(req, res) {
  res.status(200).json({ status: 'ok', service: 'dp-athlete-portal', ts: Date.now() });
}
```

Build it and deploy before submitting, because they may check it during review.
Watch the Vercel function count noted in the Strava audit.

### Question 18 — intended use of data

> Dual Performance is a hybrid endurance and strength coaching business based in
> Adelaide, Australia. Athletes we coach connect their COROS account through an
> explicit OAuth 2.0 consent flow, initiated by the athlete from their own
> authenticated session in our portal.
>
> We use two categories of data. Activity data lets us compare an athlete's executed
> sessions against the sessions their coach prescribed, so coaching adjustments are
> based on what was actually run rather than what was planned. Daily health data,
> specifically energy expenditure, steps and activity duration, lets us set each
> athlete's calorie and macronutrient targets against measured output rather than
> reported dietary intake alone. This is the core reason for our application. It
> allows us to prescribe an appropriate deficit or surplus, phase nutrition across a
> training block, and detect under-fuelling when training load increases.
>
> Data is transmitted over TLS and stored server-side in Supabase (PostgreSQL) with
> row-level security enabled and access restricted to a service role. Raw COROS
> payloads are never exposed to the browser. Each athlete's data is visible only to
> that athlete and their assigned Dual Performance coach. We do not sell, share or
> license user data to any third party, and we do not use it for advertising,
> profiling or model training.
>
> Athletes can disconnect at any time from within the portal, and we purge stored
> COROS data on revocation.

---

## Logo files

Generated from your existing portal icon at all four sizes COROS requires. The form
states applications cannot be approved without them.

- `dual-performance-logo-144x144.png` — required
- `dual-performance-logo-102x102.png` — required
- `dual-performance-logo-120x120.png` — required only for workout/training plan sync
- `dual-performance-logo-300x300.png` — required only for workout/training plan sync

I generated all four even though you are not requesting workout sync in round one.
Upload all of them, it costs nothing and removes an ambiguity about whether one-way
activity sync counts as "workout sync" for their purposes.

If you would rather use the wordmark or a different mark than the blue "DP" app
icon, say so and I will regenerate from that source instead.

---

## Submission order

1. Deploy the support page and the `/api/status` endpoint.
2. Confirm or set up the portal domain.
3. Download the API Reference Guide, read §5.3, read the API Agreement PDF.
4. Send the cover email to `api@coros.com` (draft in `wearable-api-applications.md`).
5. Submit this form, referencing the email in question 18 if there is room.
