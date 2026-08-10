# DP strength tracker - progressive overload build

Four files, no external dependencies. Everything reads the data the portal
already has (the `Exercise Log` strings and the split `repRange` / `workingSets`),
so nothing new needs to be stored.

## The files

- `progressive-overload.js` - the engine. Reads history, returns a decision per
  exercise (target weight/reps + a `status`, `lever`, `headline`, `coaching`).
- `overload-adapter.js` - maps the portal's existing strength logs and session
  dates into the history shape expected by the engine.
- `dp-strength-card.js` - the UI. Renders each exercise as a compact row that
  expands into the coaching card, wired to the engine's output.
- `dp-strength-demo.html` - a self-contained, interactive mobile demo. Open it on
  a phone to feel the collapsed/expanded behaviour and tick sets. No build step.

Look at the demo first. It is the reference for how the real thing should behave.

## Wiring the card into the portal

```html
<div id="session"></div>
<script type="module">
  import { mountSession, injectStrengthCardStyles } from './dp-strength-card.js';

  injectStrengthCardStyles(); // once per page (or paste the CSS into styles.css)

  mountSession(document.getElementById('session'), {
    day: 'Push day',
    exercises: [
      {
        // from the workout split row:
        prescription: { exercise: 'Rear delt fly', workingSets: '2', repRange: '8-12', rest: '90s' },
        // the athlete's session history array (same objects the portal already loads):
        sessions: athleteSessions,
        pbKg: 39,        // optional, shows PB inside the open card
        open: true,      // optional, start expanded (use for the first unfinished lift)
        lastRpe: 8       // optional, only if the logger captures per-exercise RPE
      },
      // ...one entry per prescribed exercise
    ]
  });
</script>
```

That is the whole integration. `mountSession` renders the rows and handles
tap-to-expand and set ticking. If you would rather drive the DOM yourself, call
`renderExerciseCard(prescription, sessions, opts)` for the HTML string of a single
card and wire the events your own way.

## How a decision becomes a state

The engine returns a `status`; the card maps it to a colour, an arrow, and a
ladder position. Colour and arrow both carry the meaning, so it still reads for a
colour-blind athlete.

| status          | row shows        | ladder      | what the client does                    |
|-----------------|------------------|-------------|-----------------------------------------|
| `progress_load` | green, up arrow  | Add load    | Owned the full range, so go heavier.    |
| `progress_reps` | blue, right arrow| Own reps    | Same weight, chase one more rep.         |
| `hold`          | blue, right arrow| Own reps    | Hit reps but near-max, repeat and clean. |
| `stalled`       | amber, reset     | Reset       | Stuck for weeks, deload and rebuild.     |
| `first_time`    | neutral, no arrow| (hidden)    | New lift, find a controlled start weight.|

## The teaching layer (and keeping it uncluttered)

The progression ladder and the tip line only render inside an open card, so a full
day of 6 to 8 exercises stays one line each. The ladder teaches the double
progression method the client should internalise: own the reps, add load, new
base, repeat. Suggested rule for when to auto-expand vs stay collapsed:

- Expand the first unfinished exercise automatically.
- Expand every card for a client's first few strength sessions, then collapse by
  default once they have seen the pattern (store a per-athlete `seenCount`).
- Expand on a level-up (`status === 'progress_load'`) for a small win moment.

## The four levers

The Healthline model lists four ways to overload: resistance, reps, endurance
(volume), and tempo. Your split fields already carry all four: weight = resistance,
`repRange` = reps, `workingSets` = volume, RPE/rest = tempo. The engine currently
drives resistance and reps (the safe default). Tempo/rest is the one lever not yet
nudged; it is the natural next state for weeks where load cannot go up.

## Tuning

Every threshold lives in `DEFAULT_CONFIG` in `progressive-overload.js`
(plate increment, jump sizing, the 10% safety cap, RPE hold point, stall length).
Override per athlete by passing `{ config: {...} }` in the options.

## Copy style

No em dashes anywhere in client-facing copy. All coaching strings use plain
sentences or hyphens.
