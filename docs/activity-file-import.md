# Athlete activity-file import

Athletes can open `/activity-upload.html`, authenticate with their existing portal session or access code, and upload an original `.fit`, `.tcx`, or `.gpx` workout file.

## Deployment

1. Apply `supabase/migrations/20260823040355_athlete_activity_uploads.sql`.
2. Deploy the application so the updated `/api/ingest` and `/api/coach-data` functions are live.
3. Send athletes the `/activity-upload.html` link when full laps or sensor data are needed.

The migration creates a private Storage bucket and a server-only table. Do not add browser policies for either resource; athlete identity is resolved by `/api/ingest`, and coach reads are protected by `/api/coach-data`.

## Captured fields

- Original file retained privately for future reprocessing
- Activity date/name/type and recording device
- Distance, moving/elapsed time, pace/speed and calories
- Device laps and derived kilometre splits
- GPS, elevation, heart rate, cadence, power, temperature and speed streams when present
- Athlete note and explicit coach-access consent timestamp

Streams are reduced to at most 2,400 representative points per activity for dashboard performance. The original file remains available server-side if a higher-resolution analysis is added later.
