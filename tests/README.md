# Tests

`npm test` runs `node --test`, which discovers `*.test.js` in this directory.

## `*.portal-test.js` — parked, not discovered

Four files here are **athlete portal** tests that ended up in the coaches
dashboard repo. They import modules this repo does not contain and can never
pass here, so they were failing on every run and masking real regressions:

| File | Imports that do not exist here |
| --- | --- |
| `bootstrap.portal-test.js` | `bootstrapRead` from `api/write.js` |
| `checkin-nudge.portal-test.js` | `bookingRead`, `bookingSync`, `stateRead` from `api/write.js` |
| `performance.portal-test.js` | `sessionLibrary` from `api/write.js` |
| `logout-visibility.portal-test.js` | asserts athlete-portal markup (`coachLogoutBtn`) against `public/index.html`, which in this repo is the coaches dashboard |

This repo's `api/write.js` exports only a default Vercel handler. The named
exports above belong to the athlete portal's own `api/write.js`.

They are renamed rather than deleted so the assertions survive: move them to the
athlete portal repo, where they should pass, and delete them from here. Do not
"fix" them by stubbing the imports — that would test nothing.

## Dependencies

`activity-file-import.test.js` and `ingest-swap-columns.test.js` need
`@garmin/fitsdk`. Run `npm install` before `npm test` or they fail with
`ERR_MODULE_NOT_FOUND`.

## Skipped subtest

`rescheduling.test.js` → *"cloud hydration restores reschedules and the API
returns the whole programme"* is skipped for the same reason: it asserts against
the athlete portal's `api/write.js`. The file's other three subtests read
`public/js/` modules that do live here and still run.
