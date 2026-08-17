# Coach-owned weekly sport targets

## Source of truth

`public.weekly_sport_targets` owns coach prescriptions for running, cycling,
and swimming. A row is keyed by `athlete_code`, canonical
`athlete_programme_weeks.id`, and `sport`.

- Distance is stored as whole metres. The coach UI displays running/cycling in
  kilometres and swimming in metres.
- Draft rows and soft-removed rows are not athlete-visible.
- Published rows are authoritative, including `distance_target_metres = 0`.
- Removal sets `removed_at` and returns the row to draft. Direct deletion is
  rejected by a database trigger.
- `updated_by` references `coaches.id`; a database trigger resolves the coach
  handle and records every target change in `programme_change_log`.

## Coach API

All operations reuse `/api/athletes` and require the existing dashboard key,
an enabled `coaches` row, and coach-to-athlete scope.

- `GET /api/athletes?action=weekly_sport_targets&code=JORDAN`
- `POST { "action": "weekly_sport_target_week_ensure", ... }`
- `POST { "action": "weekly_sport_target_save", ... }`
- `POST { "action": "weekly_sport_target_remove", ... }`

Save payload fields are `athlete_code`, `programme_week_id`, `sport`,
`distance_target_metres`, optional `session_target`, optional
`duration_target_minutes`, optional `coach_note`, and `publish_state`.
`updated_by`, timestamps, and publication timestamps are server/database owned.

## Coach workflow

Sport targets appear in three clearly labelled **Running**, **Cycling**, and
**Swimming** columns in each Nutrition week. Every sport remains visible to the
coach, including an explicit "Set target" state when unused. Selecting any sport
cell opens one editor for that exact canonical programme week and highlights the
selected sport.

When no coach-owned running row exists, the cell still shows the distance
calculated from that week's planned running sessions. This is labelled **From
plan · publish** and is only a suggestion until the coach publishes it. Opening
the editor pre-fills that distance and selects Published, allowing the coach to
make it the athlete's locked prescription with one action.

Nutrition saves no longer write `nutrition_plans.weekly_km_target`. Legacy
values remain preserved for the first-release compatibility period, while all
new sport-target edits use `weekly_sport_targets`.

## Athlete read contract

`GET /api/my-logs?resource=weekly-sport-targets` requires an athlete bearer
session. Any client-supplied athlete code is ignored; the server derives the
code through `auth.users.id -> athletes.auth_user_id -> athletes.code` or the
signed legacy portal session.

```json
{
  "ok": true,
  "targets": [
    {
      "sport": "running",
      "weekIdentifier": "canonical-programme-week-uuid",
      "distanceTargetMetres": 0,
      "sessionTarget": 0,
      "durationTargetMinutes": 0,
      "coachNote": "Recovery week",
      "source": "coach",
      "locked": true,
      "publishedAt": "2026-08-17T01:00:00Z",
      "updatedAt": "2026-08-17T01:00:00Z"
    }
  ]
}
```

Only rows with `publish_state = 'published'` and `removed_at is null` are
returned.

## Permission model

RLS is enabled. `PUBLIC`, `anon`, and `authenticated` have no privileges on the
table. `service_role` receives only `SELECT`, `INSERT`, and `UPDATE`; it does not
receive `DELETE`. The service-role key remains server-only.

## Legacy running targets

The migration leaves `nutrition_plans.weekly_km_target` unchanged. It adopts
each non-negative legacy value into the canonical programme hierarchy and
inserts a published running target in metres. Conflict handling is `DO NOTHING`,
so rerunning the migration neither duplicates nor overwrites a target created in
the new editor.

## Portal follow-up

The athlete portal still needs to call the read contract, treat every returned
row (including zero) as locked, hide drafts by relying on the endpoint, and
offer athlete-created fallback targets only when the response has no coach row
for that exact programme week and sport. Athlete fallback writes are not part of
this release.
