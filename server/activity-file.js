import { Decoder, Stream } from '@garmin/fitsdk';
import { XMLParser } from 'fast-xml-parser';

export const MAX_ACTIVITY_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_STREAM_POINTS = 2400;

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true,
  allowBooleanAttributes: false,
  processEntities: false,
};

function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function finite(value) {
  if (value === '' || value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function first(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '') ?? null;
}

function clampRound(value, decimals = 2) {
  const n = finite(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function semicirclesToDegrees(value) {
  const n = finite(value);
  return n === null ? null : n * (180 / 2147483648);
}

function haversineMetres(a, b) {
  if (a?.lat == null || a?.lng == null || b?.lat == null || b?.lng == null) return 0;
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function getBySuffix(object, suffixes) {
  if (!object || typeof object !== 'object') return null;
  const wanted = suffixes.map(value => String(value).toLowerCase());
  const queue = [object];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      const plain = key.toLowerCase().split(':').pop();
      if (wanted.includes(plain) && (typeof value !== 'object' || value instanceof Date)) return value;
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function deriveDistance(points) {
  let cumulative = 0;
  let previous = null;
  return points.map(point => {
    const output = { ...point };
    if (output.d == null) {
      cumulative += previous ? haversineMetres(previous, output) : 0;
      output.d = clampRound(cumulative, 1);
    } else {
      cumulative = Math.max(cumulative, output.d);
    }
    previous = output;
    return output;
  });
}

function deriveTimes(points) {
  const startMs = points.map(point => Date.parse(point.time || '')).find(Number.isFinite);
  return points.map((point, index) => {
    const absolute = Date.parse(point.time || '');
    return {
      ...point,
      t: point.t != null
        ? clampRound(point.t, 1)
        : (Number.isFinite(absolute) && Number.isFinite(startMs) ? clampRound((absolute - startMs) / 1000, 1) : index),
    };
  });
}

function cleanPoint(point) {
  const entries = Object.entries(point).filter(([, value]) => value !== null && value !== undefined && value !== '');
  return Object.fromEntries(entries);
}

export function downsample(points, limit = MAX_STREAM_POINTS) {
  if (points.length <= limit) return points;
  const result = [];
  for (let i = 0; i < limit; i += 1) {
    result.push(points[Math.round(i * (points.length - 1) / (limit - 1))]);
  }
  return result;
}

function average(points, key) {
  const values = points.map(point => finite(point[key])).filter(value => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function maximum(points, key) {
  const values = points.map(point => finite(point[key])).filter(value => value !== null);
  return values.length ? Math.max(...values) : null;
}

function elevationGain(points) {
  let gain = 0;
  let previous = null;
  for (const point of points) {
    const current = finite(point.elev);
    if (current !== null && previous !== null && current > previous) gain += current - previous;
    if (current !== null) previous = current;
  }
  return gain;
}

function pointDuration(points) {
  if (points.length < 2) return null;
  const firstTime = finite(points[0].t);
  const lastTime = finite(points.at(-1).t);
  return firstTime !== null && lastTime !== null ? Math.max(0, lastTime - firstTime) : null;
}

function speedFromPoints(points) {
  const duration = pointDuration(points);
  const distance = finite(points.at(-1)?.d);
  return duration && distance !== null ? distance / duration : null;
}

function metricSplits(points) {
  const totalDistance = finite(points.at(-1)?.d) || 0;
  if (totalDistance < 250) return [];
  const rows = [];
  let startIndex = 0;
  for (let marker = 1000; marker < totalDistance + 1000; marker += 1000) {
    let endIndex = points.findIndex((point, index) => index > startIndex && finite(point.d) >= Math.min(marker, totalDistance));
    if (endIndex < 0) endIndex = points.length - 1;
    if (endIndex <= startIndex) continue;
    const segment = points.slice(startIndex, endIndex + 1);
    const start = segment[0];
    const end = segment.at(-1);
    const distanceM = Math.max(0, (finite(end.d) || 0) - (finite(start.d) || 0));
    const elapsedTimeS = Math.max(0, (finite(end.t) || 0) - (finite(start.t) || 0));
    if (distanceM > 0) {
      rows.push({
        split: rows.length + 1,
        distanceM: clampRound(distanceM, 1),
        elapsedTimeS: clampRound(elapsedTimeS, 1),
        avgSpeedMps: elapsedTimeS > 0 ? clampRound(distanceM / elapsedTimeS, 4) : null,
        avgHr: clampRound(average(segment, 'hr'), 0),
        maxHr: clampRound(maximum(segment, 'hr'), 0),
        elevationDifferenceM: clampRound((finite(end.elev) || 0) - (finite(start.elev) || 0), 1),
        avgCadence: clampRound(average(segment, 'cad'), 0),
        avgPower: clampRound(average(segment, 'power'), 0),
      });
    }
    startIndex = endIndex;
    if (endIndex === points.length - 1) break;
  }
  return rows;
}

function normaliseLap(source, index, points = []) {
  const distanceM = finite(first(source.totalDistance, source.DistanceMeters, points.at(-1)?.d));
  const elapsedTimeS = finite(first(source.totalElapsedTime, source.totalTimerTime, source.TotalTimeSeconds, pointDuration(points)));
  return {
    lap: index + 1,
    startTime: iso(first(source.startTime, source['@_StartTime'], points[0]?.time)),
    distanceM: clampRound(distanceM, 1),
    elapsedTimeS: clampRound(elapsedTimeS, 1),
    movingTimeS: clampRound(first(source.totalTimerTime, elapsedTimeS), 1),
    avgSpeedMps: clampRound(first(source.avgSpeed, source.averageSpeed, distanceM && elapsedTimeS ? distanceM / elapsedTimeS : null), 4),
    maxSpeedMps: clampRound(first(source.maxSpeed, source.MaximumSpeed), 4),
    avgHr: clampRound(first(source.avgHeartRate, source.AverageHeartRateBpm?.Value), 0),
    maxHr: clampRound(first(source.maxHeartRate, source.MaximumHeartRateBpm?.Value), 0),
    ascentM: clampRound(first(source.totalAscent, elevationGain(points)), 1),
    descentM: clampRound(source.totalDescent, 1),
    avgCadence: clampRound(first(source.avgCadence, source.Cadence), 0),
    maxCadence: clampRound(first(source.maxCadence, getBySuffix(source, ['maxbikecadence'])), 0),
    avgPower: clampRound(first(source.avgPower, getBySuffix(source, ['avgwatts'])), 0),
    maxPower: clampRound(first(source.maxPower, getBySuffix(source, ['maxwatts'])), 0),
    calories: clampRound(first(source.totalCalories, source.Calories), 0),
  };
}

function finalise({ format, name, sportType, startTime, deviceName, points, laps = [], summary = {}, warnings = [] }) {
  const timed = deriveTimes(deriveDistance(points.map(cleanPoint)));
  const distanceM = finite(first(summary.distanceM, timed.at(-1)?.d));
  const elapsedTimeS = finite(first(summary.elapsedTimeS, pointDuration(timed)));
  const movingTimeS = finite(first(summary.movingTimeS, elapsedTimeS));
  const cleanSummary = {
    distanceM: clampRound(distanceM, 1),
    movingTimeS: clampRound(movingTimeS, 1),
    elapsedTimeS: clampRound(elapsedTimeS, 1),
    avgSpeedMps: clampRound(first(summary.avgSpeedMps, distanceM && movingTimeS ? distanceM / movingTimeS : speedFromPoints(timed)), 4),
    maxSpeedMps: clampRound(first(summary.maxSpeedMps, maximum(timed, 'speed')), 4),
    avgHr: clampRound(first(summary.avgHr, average(timed, 'hr')), 0),
    maxHr: clampRound(first(summary.maxHr, maximum(timed, 'hr')), 0),
    totalElevationGainM: clampRound(first(summary.totalElevationGainM, elevationGain(timed)), 1),
    avgCadence: clampRound(first(summary.avgCadence, average(timed, 'cad')), 0),
    maxCadence: clampRound(first(summary.maxCadence, maximum(timed, 'cad')), 0),
    avgPower: clampRound(first(summary.avgPower, average(timed, 'power')), 0),
    maxPower: clampRound(first(summary.maxPower, maximum(timed, 'power')), 0),
    calories: clampRound(summary.calories, 0),
    temperatureC: clampRound(first(summary.temperatureC, average(timed, 'temp')), 1),
    recordCount: timed.length,
    storedStreamPoints: Math.min(timed.length, MAX_STREAM_POINTS),
    hasGps: timed.some(point => point.lat != null && point.lng != null),
    hasHeartRate: timed.some(point => point.hr != null),
    hasCadence: timed.some(point => point.cad != null),
    hasPower: timed.some(point => point.power != null),
  };
  return {
    sourceFormat: format,
    activityName: String(name || `${sportType || 'Workout'} activity`).slice(0, 240),
    sportType: String(sportType || 'Activity').slice(0, 80),
    startTime: iso(first(startTime, timed[0]?.time)),
    activityDate: iso(first(startTime, timed[0]?.time))?.slice(0, 10) || null,
    deviceName: deviceName ? String(deviceName).slice(0, 160) : null,
    summary: cleanSummary,
    laps: laps.filter(lap => lap.distanceM || lap.elapsedTimeS),
    splits: metricSplits(timed),
    streams: downsample(timed).map(point => {
      const { time, ...stored } = point;
      return stored;
    }),
    warnings: warnings.map(value => String(value).slice(0, 300)).slice(0, 20),
  };
}

function parseFit(buffer, fallbackName) {
  const stream = Stream.fromBuffer(buffer);
  if (!Decoder.isFIT(stream)) throw new Error('The selected file is not a valid FIT file');
  const decoder = new Decoder(stream);
  const { messages, errors } = decoder.read({ includeUnknownData: false, mergeHeartRates: true });
  const session = list(messages.sessionMesgs)[0] || {};
  const records = list(messages.recordMesgs).map(record => ({
    time: iso(record.timestamp),
    d: clampRound(record.distance, 1),
    lat: clampRound(semicirclesToDegrees(record.positionLat), 6),
    lng: clampRound(semicirclesToDegrees(record.positionLong), 6),
    elev: clampRound(first(record.enhancedAltitude, record.altitude), 1),
    hr: clampRound(record.heartRate, 0),
    cad: clampRound(record.cadence, 0),
    power: clampRound(record.power, 0),
    temp: clampRound(record.temperature, 1),
    speed: clampRound(first(record.enhancedSpeed, record.speed), 4),
  }));
  const laps = list(messages.lapMesgs).map((lap, index) => normaliseLap(lap, index));
  return finalise({
    format: 'fit',
    name: first(session.name, fallbackName.replace(/\.fit$/i, '')),
    sportType: first(session.subSport, session.sport, 'Activity'),
    startTime: first(session.startTime, session.timestamp, records[0]?.time),
    deviceName: first(list(messages.deviceInfoMesgs).at(-1)?.productName, list(messages.fileIdMesgs)[0]?.productName),
    points: records,
    laps,
    warnings: errors,
    summary: {
      distanceM: session.totalDistance,
      movingTimeS: session.totalTimerTime,
      elapsedTimeS: session.totalElapsedTime,
      avgSpeedMps: first(session.enhancedAvgSpeed, session.avgSpeed),
      maxSpeedMps: first(session.enhancedMaxSpeed, session.maxSpeed),
      avgHr: session.avgHeartRate,
      maxHr: session.maxHeartRate,
      totalElevationGainM: session.totalAscent,
      avgCadence: session.avgCadence,
      maxCadence: session.maxCadence,
      avgPower: session.avgPower,
      maxPower: session.maxPower,
      calories: session.totalCalories,
      temperatureC: session.avgTemperature,
    },
  });
}

function tcxTrackpoints(lap) {
  return list(lap.Track).flatMap(track => list(track.Trackpoint)).map(point => ({
    time: iso(point.Time),
    d: clampRound(point.DistanceMeters, 1),
    lat: clampRound(point.Position?.LatitudeDegrees, 6),
    lng: clampRound(point.Position?.LongitudeDegrees, 6),
    elev: clampRound(point.AltitudeMeters, 1),
    hr: clampRound(point.HeartRateBpm?.Value, 0),
    cad: clampRound(first(point.Cadence, getBySuffix(point.Extensions, ['runcadence', 'cadence'])), 0),
    power: clampRound(getBySuffix(point.Extensions, ['watts', 'power']), 0),
    speed: clampRound(getBySuffix(point.Extensions, ['speed']), 4),
    temp: clampRound(getBySuffix(point.Extensions, ['temp', 'temperature']), 1),
  }));
}

function parseTcx(xml, fallbackName) {
  const root = new XMLParser(XML_OPTIONS).parse(xml);
  const activity = list(root?.TrainingCenterDatabase?.Activities?.Activity)[0];
  if (!activity) throw new Error('No activity was found in the TCX file');
  const sourceLaps = list(activity.Lap);
  const lapPoints = sourceLaps.map(tcxTrackpoints);
  const points = lapPoints.flat();
  return finalise({
    format: 'tcx',
    name: first(activity.Notes, fallbackName.replace(/\.tcx$/i, '')),
    sportType: first(activity['@_Sport'], 'Activity'),
    startTime: first(sourceLaps[0]?.['@_StartTime'], activity.Id, points[0]?.time),
    deviceName: first(getBySuffix(activity.Creator, ['name']), getBySuffix(activity.Creator, ['productid'])),
    points,
    laps: sourceLaps.map((lap, index) => normaliseLap(lap, index, deriveTimes(deriveDistance(lapPoints[index])))),
    summary: {
      distanceM: sourceLaps.reduce((sum, lap) => sum + (finite(lap.DistanceMeters) || 0), 0) || null,
      movingTimeS: sourceLaps.reduce((sum, lap) => sum + (finite(lap.TotalTimeSeconds) || 0), 0) || null,
      elapsedTimeS: sourceLaps.reduce((sum, lap) => sum + (finite(lap.TotalTimeSeconds) || 0), 0) || null,
      calories: sourceLaps.reduce((sum, lap) => sum + (finite(lap.Calories) || 0), 0) || null,
      avgHr: average(sourceLaps.map(lap => ({ value: finite(lap.AverageHeartRateBpm?.Value) })), 'value'),
      maxHr: Math.max(...sourceLaps.map(lap => finite(lap.MaximumHeartRateBpm?.Value)).filter(value => value !== null), 0) || null,
    },
  });
}

function gpxTrackpoints(root) {
  return list(root?.gpx?.trk).flatMap(track => list(track.trkseg)).flatMap(segment => list(segment.trkpt));
}

function parseGpx(xml, fallbackName) {
  const root = new XMLParser(XML_OPTIONS).parse(xml);
  const rawPoints = gpxTrackpoints(root);
  if (!rawPoints.length) throw new Error('No track points were found in the GPX file');
  const points = rawPoints.map(point => ({
    time: iso(point.time),
    lat: clampRound(point['@_lat'], 6),
    lng: clampRound(point['@_lon'], 6),
    elev: clampRound(point.ele, 1),
    hr: clampRound(getBySuffix(point.extensions, ['hr', 'heartrate']), 0),
    cad: clampRound(getBySuffix(point.extensions, ['cad', 'cadence']), 0),
    power: clampRound(getBySuffix(point.extensions, ['power', 'watts']), 0),
    temp: clampRound(getBySuffix(point.extensions, ['atemp', 'temp', 'temperature']), 1),
    speed: clampRound(getBySuffix(point.extensions, ['speed']), 4),
  }));
  const track = list(root.gpx.trk)[0] || {};
  return finalise({
    format: 'gpx',
    name: first(track.name, root.gpx.metadata?.name, fallbackName.replace(/\.gpx$/i, '')),
    sportType: first(track.type, 'Run'),
    startTime: first(points[0]?.time, root.gpx.metadata?.time),
    points,
    warnings: rawPoints.length > MAX_STREAM_POINTS
      ? [`Stored ${MAX_STREAM_POINTS} representative points from ${rawPoints.length} original track points.`]
      : [],
  });
}

export function activityFormat(fileName, mimeType = '') {
  const extension = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (['fit', 'tcx', 'gpx'].includes(extension)) return extension;
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('gpx')) return 'gpx';
  if (mime.includes('tcx')) return 'tcx';
  if (mime.includes('fit') || mime === 'application/octet-stream') return 'fit';
  return null;
}

export function decodeBase64File(value) {
  const raw = String(value || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('The activity file could not be decoded');
  if (raw.length > Math.ceil(MAX_ACTIVITY_FILE_BYTES * 4 / 3) + 4) {
    throw new Error('Activity files must be 3 MB or smaller');
  }
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new Error('The activity file is empty');
  if (buffer.length > MAX_ACTIVITY_FILE_BYTES) throw new Error('Activity files must be 3 MB or smaller');
  return buffer;
}

export function parseActivityFile({ buffer, fileName, mimeType }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Activity file data is required');
  if (buffer.length > MAX_ACTIVITY_FILE_BYTES) throw new Error('Activity files must be 3 MB or smaller');
  const safeName = String(fileName || 'activity').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  const format = activityFormat(safeName, mimeType);
  if (!format) throw new Error('Choose a FIT, TCX or GPX activity file');
  if (format === 'fit') return parseFit(buffer, safeName);
  const xml = buffer.toString('utf8');
  return format === 'tcx' ? parseTcx(xml, safeName) : parseGpx(xml, safeName);
}
