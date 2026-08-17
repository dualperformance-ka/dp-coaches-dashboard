function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function aggregateZoneDistribution(activities) {
  const seconds = [0, 0, 0, 0, 0];
  for (const activity of activities || []) {
    (activity?.hr_zones || []).slice(0, 5).forEach((bucket, index) => {
      seconds[index] += Math.max(0, finite(bucket?.time) || 0);
    });
  }
  const totalSeconds = seconds.reduce((sum, value) => sum + value, 0);
  if (!totalSeconds) return null;
  const percent = seconds.map(value => round(value / totalSeconds * 100));
  return {
    seconds,
    percent,
    totalSeconds,
    easyPercent: round((seconds[0] + seconds[1]) / totalSeconds * 100),
    greyPercent: round(seconds[2] / totalSeconds * 100),
    hardPercent: round((seconds[3] + seconds[4]) / totalSeconds * 100),
  };
}

export function analyseLapExecution(activity) {
  const laps = (activity?.laps || []).filter(lap => finite(lap?.average_speed) > 0);
  if (laps.length < 2) return null;
  const speeds = laps.map(lap => Number(lap.average_speed));
  const mean = speeds.reduce((sum, value) => sum + value, 0) / speeds.length;
  const variance = speeds.reduce((sum, value) => sum + (value - mean) ** 2, 0) / speeds.length;
  const midpoint = Math.ceil(speeds.length / 2);
  const first = speeds.slice(0, midpoint);
  const second = speeds.slice(midpoint);
  const firstMean = first.reduce((sum, value) => sum + value, 0) / first.length;
  const secondMean = second.length
    ? second.reduce((sum, value) => sum + value, 0) / second.length
    : firstMean;
  return {
    activityId: activity.id,
    lapCount: speeds.length,
    consistencyCvPercent: round(Math.sqrt(variance) / mean * 100),
    paceDecayPercent: round(Math.max(0, (firstMean - secondMean) / firstMean * 100)),
    fastestLap: speeds.indexOf(Math.max(...speeds)) + 1,
    slowestLap: speeds.indexOf(Math.min(...speeds)) + 1,
  };
}

export function detectPersonalBests(activities) {
  return (activities || []).flatMap(activity => (activity?.best_efforts || [])
    .filter(effort => Number(effort?.pr_rank) === 1)
    .map(effort => ({
      activityId: activity.id,
      activityName: activity.name || 'Run',
      date: String(activity.start_date_local || activity.start_date || '').slice(0, 10),
      effort: effort.name,
      movingTime: effort.moving_time,
    })));
}

export function gearMileage(activities) {
  const byId = new Map();
  for (const activity of activities || []) {
    const gear = activity?.gear;
    if (!gear?.id && !activity?.gear_id) continue;
    const id = String(gear?.id || activity.gear_id);
    const knownDistance = finite(gear?.distance);
    const current = byId.get(id) || { id, name: gear?.name || id, metres: 0, source: 'programme' };
    if (knownDistance != null && knownDistance > current.metres) {
      current.metres = knownDistance;
      current.source = 'strava_gear';
    } else if (current.source !== 'strava_gear') {
      current.metres += Math.max(0, finite(activity.distance) || 0);
    }
    byId.set(id, current);
  }
  return [...byId.values()].map(item => ({
    ...item,
    km: round(item.metres / 1000),
    retirementWarning: item.metres >= 650000,
  })).sort((a, b) => b.metres - a.metres);
}

function streamData(streams, key) {
  const value = streams?.[key];
  return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
}

export function aerobicDecoupling(streams) {
  const heartRate = streamData(streams, 'heartrate');
  const velocity = streamData(streams, 'velocity_smooth');
  if (heartRate.length < 20 || heartRate.length !== velocity.length) return null;
  const pairs = heartRate.map((hr, index) => ({ hr: finite(hr), speed: finite(velocity[index]) }))
    .filter(pair => pair.hr > 0 && pair.speed > 0);
  if (pairs.length < 20) return null;
  const midpoint = Math.floor(pairs.length / 2);
  const efficiency = values => values.reduce((sum, pair) => sum + pair.speed / pair.hr, 0) / values.length;
  const first = efficiency(pairs.slice(0, midpoint));
  const second = efficiency(pairs.slice(midpoint));
  return {
    percent: round((first - second) / first * 100),
    ready: (first - second) / first * 100 <= 5,
    sampleCount: pairs.length,
  };
}

export function buildCoachingInsights(activities) {
  const gapProgression = (activities || []).filter(activity => finite(activity?.average_grade_adjusted_speed) > 0)
    .map(activity => ({
      activityId: activity.id,
      date: String(activity.start_date_local || activity.start_date || '').slice(0, 10),
      speed: Number(activity.average_grade_adjusted_speed),
    })).sort((a, b) => a.date.localeCompare(b.date));
  return {
    zoneDistribution: aggregateZoneDistribution(activities),
    lapExecution: (activities || []).map(analyseLapExecution).filter(Boolean),
    personalBests: detectPersonalBests(activities),
    gear: gearMileage(activities),
    gapProgression,
    aerobicDecoupling: (activities || []).filter(activity => activity?.aerobic_decoupling).map(activity => ({
      activityId: activity.id,
      date: String(activity.start_date_local || activity.start_date || '').slice(0, 10),
      ...activity.aerobic_decoupling,
    })),
  };
}
