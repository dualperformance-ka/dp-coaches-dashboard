import test from 'node:test';
import assert from 'node:assert/strict';
import { Encoder, Profile, Utils } from '@garmin/fitsdk';
import { parseActivityFile } from '../server/activity-file.js';
import { persistActivityFile } from '../api/ingest.js';
import { mapActivityUpload } from '../api/coach-data.js';

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="DP test" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Threshold Run</name><type>Run</type><trkseg>
    ${Array.from({ length: 13 }, (_, index) => `<trkpt lat="-34.9000" lon="${(138.6000 + index * 0.001).toFixed(4)}"><ele>${40 + index}</ele><time>2026-08-20T06:${String(index).padStart(2, '0')}:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${140 + index}</gpxtpx:hr><gpxtpx:cad>${80 + index}</gpxtpx:cad></gpxtpx:TrackPointExtension><power>${240 + index}</power></extensions></trkpt>`).join('')}
  </trkseg></trk>
</gpx>`;

const TCX = `<?xml version="1.0"?>
<TrainingCenterDatabase><Activities><Activity Sport="Running"><Id>2026-08-21T06:00:00Z</Id>
  <Lap StartTime="2026-08-21T06:00:00Z"><TotalTimeSeconds>300</TotalTimeSeconds><DistanceMeters>1000</DistanceMeters><Calories>70</Calories><AverageHeartRateBpm><Value>155</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>170</Value></MaximumHeartRateBpm><Track>
    <Trackpoint><Time>2026-08-21T06:00:00Z</Time><Position><LatitudeDegrees>-34.9</LatitudeDegrees><LongitudeDegrees>138.6</LongitudeDegrees></Position><AltitudeMeters>40</AltitudeMeters><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>145</Value></HeartRateBpm><Cadence>82</Cadence></Trackpoint>
    <Trackpoint><Time>2026-08-21T06:05:00Z</Time><Position><LatitudeDegrees>-34.9</LatitudeDegrees><LongitudeDegrees>138.61</LongitudeDegrees></Position><AltitudeMeters>48</AltitudeMeters><DistanceMeters>1000</DistanceMeters><HeartRateBpm><Value>165</Value></HeartRateBpm><Cadence>88</Cadence></Trackpoint>
  </Track></Lap>
</Activity></Activities></TrainingCenterDatabase>`;

function fitFixture() {
  const start = Utils.convertDateToDateTime(new Date('2026-08-22T06:00:00Z'));
  const messages = [
    { mesgNum: Profile.MesgNum.FILE_ID, type: 'activity', manufacturer: 'development', product: 0, timeCreated: start, serialNumber: 1234 },
    { mesgNum: Profile.MesgNum.DEVICE_INFO, deviceIndex: 'creator', manufacturer: 'development', product: 0, productName: 'DP Test Watch', serialNumber: 1234, timestamp: start },
    { mesgNum: Profile.MesgNum.EVENT, timestamp: start, event: 'timer', eventType: 'start' },
    ...Array.from({ length: 12 }, (_, index) => ({ mesgNum: Profile.MesgNum.RECORD, timestamp: start + index * 30, distance: index * 100, enhancedSpeed: 3.33, heartRate: 145 + index, cadence: 82 + index % 3, power: 235 + index, enhancedAltitude: 40 + index, positionLat: -416372193, positionLong: 1653562405 + index * 10717 })),
    { mesgNum: Profile.MesgNum.LAP, messageIndex: 0, timestamp: start + 330, startTime: start, totalElapsedTime: 330, totalTimerTime: 330, totalDistance: 1100, avgHeartRate: 151, maxHeartRate: 156, avgPower: 240 },
    { mesgNum: Profile.MesgNum.SESSION, messageIndex: 0, timestamp: start + 330, startTime: start, totalElapsedTime: 330, totalTimerTime: 330, totalDistance: 1100, sport: 'running', subSport: 'generic', firstLapIndex: 0, numLaps: 1, avgHeartRate: 151, maxHeartRate: 156, avgPower: 240 },
    { mesgNum: Profile.MesgNum.ACTIVITY, timestamp: start + 330, numSessions: 1, localTimestamp: start + 330, totalTimerTime: 330 },
  ];
  const encoder = new Encoder();
  messages.forEach(message => encoder.writeMesg(message));
  return Buffer.from(encoder.close());
}

test('GPX import retains GPS and sensor streams and derives kilometre splits', () => {
  const parsed = parseActivityFile({ buffer: Buffer.from(GPX), fileName: 'threshold.gpx', mimeType: 'application/gpx+xml' });
  assert.equal(parsed.sourceFormat, 'gpx');
  assert.equal(parsed.activityName, 'Threshold Run');
  assert.equal(parsed.activityDate, '2026-08-20');
  assert.equal(parsed.summary.hasGps, true);
  assert.equal(parsed.summary.hasHeartRate, true);
  assert.equal(parsed.summary.hasCadence, true);
  assert.equal(parsed.summary.hasPower, true);
  assert.equal(parsed.streams.length, 13);
  assert.ok(parsed.summary.distanceM > 1000);
  assert.ok(parsed.splits.length >= 1);
});

test('TCX import keeps lap distance, time and heart rate', () => {
  const parsed = parseActivityFile({ buffer: Buffer.from(TCX), fileName: 'interval.tcx', mimeType: 'application/xml' });
  assert.equal(parsed.sourceFormat, 'tcx');
  assert.equal(parsed.sportType, 'Running');
  assert.equal(parsed.activityDate, '2026-08-21');
  assert.equal(parsed.laps.length, 1);
  assert.equal(parsed.laps[0].distanceM, 1000);
  assert.equal(parsed.laps[0].elapsedTimeS, 300);
  assert.equal(parsed.laps[0].avgHr, 155);
  assert.equal(parsed.summary.calories, 70);
});

test('official Garmin FIT SDK path retains laps, GPS and device sensors', () => {
  const parsed = parseActivityFile({ buffer: fitFixture(), fileName: 'watch.fit', mimeType: 'application/vnd.ant.fit' });
  assert.equal(parsed.sourceFormat, 'fit');
  assert.equal(parsed.activityDate, '2026-08-22');
  assert.equal(parsed.sportType, 'generic');
  assert.equal(parsed.deviceName, 'DP Test Watch');
  assert.equal(parsed.summary.distanceM, 1100);
  assert.equal(parsed.summary.hasGps, true);
  assert.equal(parsed.summary.hasHeartRate, true);
  assert.equal(parsed.summary.hasPower, true);
  assert.equal(parsed.laps.length, 1);
  assert.equal(parsed.laps[0].avgPower, 240);
});

test('authenticated upload preparation stores the original privately and writes parsed data', async () => {
  let stored;
  let written;
  const result = await persistActivityFile({
    type: 'activity_file_import',
    athleteCode: 'NATE',
    athleteName: 'Nate',
    fileName: '../threshold.gpx',
    mimeType: 'application/gpx+xml',
    fileBase64: Buffer.from(GPX).toString('base64'),
    coachAccessConsent: true,
  }, async (table, row, conflict) => {
    written = { table, row, conflict };
    return [row];
  }, async input => { stored = input; });

  assert.equal(written.table, 'athlete_activity_uploads');
  assert.equal(written.conflict, 'athlete_code,content_hash');
  assert.equal(written.row.athlete_code, 'NATE');
  assert.match(written.row.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(written.row.original_filename, '.._threshold.gpx');
  assert.equal(stored.path, written.row.raw_file_path);
  assert.ok(stored.buffer.length > 0);
  assert.equal(result.activity.sourceFormat, 'gpx');
  assert.ok(result.activity.storedStreamPoints > 0);
});

test('coach mapping excludes private storage path and original filename', () => {
  const mapped = mapActivityUpload({
    athlete_code: 'NATE',
    activity_date: '2026-08-20',
    activity_name: 'Threshold Run',
    summary: { distanceM: 1000 },
    laps: [{ lap: 1 }],
    splits: [{ split: 1 }],
    streams: [{ t: 0, hr: 140 }],
    raw_file_path: 'NATE/private.fit',
    original_filename: 'private.fit',
  });
  assert.equal(mapped.AthleteID, 'NATE');
  assert.equal(mapped.summary.distanceM, 1000);
  assert.equal('rawFilePath' in mapped, false);
  assert.equal('originalFilename' in mapped, false);
});

test('upload requires explicit coach access consent', async () => {
  await assert.rejects(() => persistActivityFile({ athleteCode: 'NATE' }, async () => [], async () => {}), /consent/i);
});
