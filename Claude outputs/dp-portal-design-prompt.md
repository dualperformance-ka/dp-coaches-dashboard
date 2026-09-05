# DP Athlete Portal — Premium Redesign Prompts

Two prompts. Run Prompt 1 in Claude (Design canvas). Pick a direction. Then run Prompt 2 in Claude Code on the repo.

---

## PROMPT 1 — Visual exploration (paste into Claude, ask for a design canvas)

You are a senior product designer who has shipped premium consumer health and performance apps. Think Whoop, Oura, Linear, Tracksmith, On Running, Equinox. Your job is to redesign the visual system of an athlete coaching portal so it looks and feels worth $5,000 per month.

### The product

Dual Performance is a premium 2:1 hybrid coaching business out of Adelaide. Two coaches, one athlete: Karl runs endurance, Alex runs strength and body composition. The Athlete Portal is a mobile-first PWA at portal.dualperformance.au. It is the only place an athlete touches their coaching, so it carries the entire perceived value of the price tag.

The athlete is a serious amateur, 25 to 45, training 8 to 9 sessions a week toward a marathon or a hybrid goal. They open this app multiple times a day, usually one-handed, usually before or after training, often in low light.

### Existing surfaces (real, in production)

1. **Home** — hero with athlete name, current week number, week pills, a daily cue, and priority nudge strips (check-in due, session not logged)
2. **Training** — the week's sessions, run and strength, session detail with intervals and rest, session logging
3. **Weekly** — week overview, volume-by-week strip showing real km run plus over/under versus plan
4. **Check-in** — body check-in and weekly check-in forms, all draft-saving locally
5. **Nutrition** — nutrition log and plan
6. **Progress** — PBs, trends, gauges, Strava km progress rings, streaks measured in weeks
7. **Goals** — intent and priority areas, including the lean strength baseline
8. **Handbook** — education content and guides
9. **Comms** — private one-way note composer to coaches, plus notification inbox
10. **Calls** — DOES NOT EXIST YET. Design it. Athletes need to see upcoming coaching calls, book and reschedule, see prep notes, and see what came out of the last call.

### Brand and non-negotiables

- **Baby blue #92D2ED stays.** It is the brand. Every direction must be built around it.
- Current system is called **Carbon Ice**: near-black #040506 background, baby blue accent, Inter for UI, DM Mono for labels and data, Anton and Barlow Semi Condensed used in the brand's printed documents.
- A light variant of Carbon Ice already exists for printed athlete check-in docs: white paper, black ink, baby blue accent, amber for watch points.
- Dual Performance logo files exist and can be supplied. Assume a baby blue mark and a one-line wordmark.
- Mobile-first. Bottom dock navigation. Must work as an installed PWA with a dark status bar.
- Accent colours already carrying meaning that must survive: Strava orange #FC4C02, amber #F0AD4E for warnings and watch points, green #22C55E for done and submitted states, purple #A78BFA for PBs, teal #2DD4BF for very big PBs.

### What "premium at $5,000 a month" actually means

Do not answer this with more decoration. Premium here means:

- **Restraint.** One accent doing real work. Fewer borders, fewer boxes, more space carrying the hierarchy.
- **Typographic authority.** A real type scale with a genuine display voice. Numbers that read like instrumentation, not like form fields.
- **Data as craft.** Charts, rings, gauges and split tables that look designed, not plotted. Weight given to the number the athlete actually came here for.
- **Material honesty.** If surfaces are dark, they should feel like anodised metal or matte glass, not like grey boxes. Elevation earned through light, not through drop shadows stacked on drop shadows.
- **Motion discipline.** Short, physical, purposeful. State changes that confirm. No decorative animation.
- **Density that respects the user.** This app is used mid-training. Thumb reach, one-handed, glanceable in three seconds.

Explicitly avoid: generic SaaS dashboard look, purple gradients, glassmorphism for its own sake, emoji as iconography, cards inside cards inside cards, ten competing accent colours, hero images of stock athletes.

### What I want from you

Produce **four distinct visual directions**, on one canvas, each one anchored on baby blue #92D2ED. Suggested lanes, push back if you have better:

1. **Carbon Ice Refined** — evolve what exists. Deeper true blacks, tighter type scale, single accent, precision-instrument restraint. The safe, correct answer, executed at a much higher level.
2. **Frost** — light-first. White or bone paper, black ink, baby blue as the working accent, dark mode as the alternate rather than the default. Borrows from the existing printed check-in doc variant.
3. **Editorial** — magazine-grade. Large condensed display type in Anton or similar, hard grid, generous rules and margins, blue used as ink and not as glow. Feels like a training publication, not an app.
4. **Instrument** — warm graphite instead of pure black, tactile surfaces, mechanical numerals, baby blue as the single readout colour. Closest to premium hardware companion apps.

For **each direction**, deliver:

- A **token sheet**: background layers, surface layers, borders, text tiers, accent and semantic colours as hex, type scale, radii, spacing scale, elevation rules. Name the tokens so they can drop straight into a CSS `:root`.
- **Three artboards at 390x844** (iPhone): Home, Training week plus session detail, and Progress.
- **One artboard** of the new Calls surface.
- **One desktop artboard at 1440 wide** showing how the direction scales to the coach-visible rail layout.
- **Two to four sentences** on why this direction reads as premium and what it costs, honestly, in legibility, build effort, or brand fit.

Then finish with a **recommendation**: which direction you would ship, which one you would ship if I wanted the biggest perceived jump in value, and what the single highest-leverage change is regardless of which direction I pick.

Design mobile artboards first. Real content, real numbers, real session names. No lorem ipsum, no placeholder rectangles.

---

## PROMPT 2 — Implementation (paste into Claude Code, run in the dp-athlete-portal repo)

Only run this after picking a direction from Prompt 1. Paste the chosen direction's token sheet in where marked.

---

You are working in the dp-athlete-portal repo, a mobile-first PWA at portal.dualperformance.au. Vanilla JS, no framework, no build step. Read these before you touch anything: `public/styles.css` (the `:root` token block at the top), `public/desktop.css`, `public/index.html`, `public/js/01-core.js` through `10-boot.js`, and `scripts/check-portal.mjs`.

I have chosen this visual direction for a premium redesign:

> [PASTE THE CHOSEN DIRECTION'S TOKEN SHEET AND A SCREENSHOT OF ITS ARTBOARDS HERE]

### Task

Implement it as a **token-level redesign**, not a rewrite.

**Phase 1 — tokens.** Rewrite the `:root` block in `public/styles.css` to the new system. Keep every existing token name that is referenced elsewhere so nothing breaks, add new ones where the direction needs them, and map old names to new values rather than renaming and chasing references. Show me the before and after of the token block only, first, and stop there for approval.

**Phase 2 — components.** Once tokens are approved, work through the component layers in this order, one commit-sized chunk at a time, pausing after each: header and dock, hero and nudge strips, training week and session cards, forms and inputs, progress charts and gauges, then everything else.

**Phase 3 — Calls surface.** Add the new booking surface as its own tab, matching the design. Front end only, stub the data layer behind a clearly marked function I can wire to the real booking backend.

### Repo rules, do not break these

- Versioned assets need `?v=` bumped in `index.html` and `sw.js` plus `CACHE_NAME`, then run `node scripts/check-portal.mjs --update-versions`.
- `check-portal.mjs` asserts the home DOM layout, so any reordering happens in JS at runtime, not in the HTML.
- `api/` stays under 24 files. New server behaviour prefers the existing `/api/portal-data` route.
- **No reformatting.** Most tests assert source as text.
- **No new npm dependencies.**
- Run the test suite and `node scripts/check-portal.mjs` before telling me anything is done.

### How to deliver

Give me exact find-and-replace pairs where the change is surgical, and full file blocks only where a file is being substantially rewritten. Include the GitHub PR title and description with every batch, since I upload through the GitHub web UI rather than pushing from a local checkout.

Do not touch application logic, Supabase queries, Strava matching, the service worker beyond version bumps, or any of the notification code.
