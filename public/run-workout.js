/* Dual Performance — structured run workout rules.
 *
 * One file, two consumers: the coach builder in the browser (window.DPRunWorkout)
 * and the server save/publish path (server/programming.js imports it for the
 * side effect and reads globalThis.DPRunWorkout). Keeping a single copy is the
 * point: the builder can never call a workout valid that the server refuses.
 *
 * The rules mirror the athlete portal's Garmin converter,
 * dp-athlete-portal/api/_lib/garmin-workouts.js (Garmin Training API V2),
 * which is the integration contract:
 *   - a step ends on distance OR time; neither means a lap-button press
 *   - pace targets are m:ss per km, 1:30 to 30:00
 *   - heart-rate targets are Garmin zones 1 to 5
 *   - RPE and effort travel as step text, never as a watch target alert
 *   - repeats need 1 to 100 rounds and at least one step inside
 *   - nesting stops two levels deep, and the expanded workout is at most
 *     100 steps
 * If the converter changes, change this file and tests/run-workout.test.js.
 *
 * No DOM access and no network here, so the same functions run under node.
 */
(function (root) {
  'use strict';

  var STEP_TYPES = ['warmup', 'run', 'interval', 'recovery', 'rest', 'cooldown', 'repeat'];
  var LEAF_TYPES = STEP_TYPES.filter(function (type) { return type !== 'repeat'; });
  var LABELS = {
    warmup: 'Warm-up', run: 'Run', interval: 'Interval', recovery: 'Recovery',
    rest: 'Rest', cooldown: 'Cool-down', repeat: 'Repeat',
  };
  var ENDS = ['distance', 'time', 'lap'];
  var TARGETS = ['none', 'pace', 'hr', 'rpe', 'effort'];

  // Session types the portal will turn into a Garmin running workout. Must
  // match GARMIN_RUN_SESSION_TYPES in the portal's garmin-workouts.js. Mixed
  // sessions (Brick, Run + Strength) and admin rows (Optional, Weekly KM
  // Total) are deliberately absent: they are not one running workout.
  var GARMIN_RUN_SESSION_TYPES = [
    'run', 'running', 'easy', 'easy effort', 'recovery', 'long', 'long run',
    'tempo', 'threshold', 'speed', 'interval', 'intervals', 'vo2', 'fartlek',
    'hills', 'mp', 'race', 'time trial',
  ];

  var LIMITS = {
    rows: 100,            // portal reads at most 101 rows and refuses >100
    expanded: 100,        // Garmin steps after repeats are expanded
    depth: 2,             // converter throws once children sit 3 levels deep
    repeat: 100,
    paceMinSec: 90,       // 1:30 /km
    paceMaxSec: 1800,     // 30:00 /km
    maxDurationSec: 24 * 3600,
    maxDistanceKm: 500,
    description: 512,     // Garmin step description
    instructions: 500,
    effort: 60,
    coachNotes: 1000,
  };

  function text(value) { return String(value == null ? '' : value).trim(); }
  function isBlank(value) { return value === null || value === undefined || text(value) === ''; }
  function finite(value) {
    if (isBlank(value)) return null;
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  // ── Pace ────────────────────────────────────────────────────────────────
  // Same pattern the portal converter accepts: "4:30", "4:30/km", "4:30 min/km".
  var PACE = /^(\d{1,2}):([0-5]\d)(?:\s*(?:\/km|min\/km))?$/;

  function parsePace(value) {
    var match = PACE.exec(text(value));
    if (!match) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function formatPace(seconds) {
    var total = Math.round(Number(seconds));
    return Math.floor(total / 60) + ':' + ('0' + (total % 60)).slice(-2);
  }

  // ── Time ────────────────────────────────────────────────────────────────
  // Accepts h:mm:ss, mm:ss, "90s", "90 sec", "10 min", "10m", "1h". A bare
  // number is minutes, which is how coaches write warm-ups ("10").
  function parseDuration(value) {
    var raw = text(value).toLowerCase();
    if (!raw) return null;
    var hms = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(raw);
    if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    var ms = /^(\d{1,3}):([0-5]\d)$/.exec(raw);
    if (ms) return Number(ms[1]) * 60 + Number(ms[2]);
    var unit = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/.exec(raw);
    if (!unit) return NaN;
    var amount = Number(unit[1]);
    var suffix = unit[2] || 'min';
    var seconds = /^s/.test(suffix) ? amount : /^h/.test(suffix) ? amount * 3600 : amount * 60;
    return Math.round(seconds) === seconds ? seconds : NaN;
  }

  function formatDuration(seconds) {
    var total = Math.round(Number(seconds));
    if (!Number.isFinite(total) || total <= 0) return '';
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? h + ':' + ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2) : m + ':' + ('0' + s).slice(-2);
  }

  function humanDuration(seconds) {
    var total = Math.round(Number(seconds));
    if (!Number.isFinite(total) || total <= 0) return '';
    if (total < 60) return total + ' s';
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return [h ? h + ' h' : '', m ? m + ' min' : '', s ? s + ' s' : ''].filter(Boolean).join(' ');
  }

  function humanDistance(km) {
    var value = Number(km);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1) return Math.round(value * 1000) + ' m';
    return (Math.round(value * 100) / 100) + ' km';
  }

  function hrZone(value) {
    var match = /^(?:z(?:one)?\s*)?([1-5])$/i.exec(text(value));
    return match ? Number(match[1]) : null;
  }

  function sessionSendsToGarmin(session) {
    return GARMIN_RUN_SESSION_TYPES.indexOf(text(session && session.session_type).toLowerCase()) >= 0;
  }

  // ── Shapes ──────────────────────────────────────────────────────────────
  // Builder step: database columns plus two explicit choices the columns
  // cannot express on their own. `end` keeps "lap button" distinct from "I
  // forgot to type a distance"; `target` keeps one intensity per step, which
  // is all the converter reads.

  function fromRow(row) {
    var r = row || {};
    var type = text(r.step_type);
    var distance = finite(r.distance_km);
    var duration = finite(r.duration_sec);
    var intensity = text(r.intensity_type).toLowerCase();
    var target = intensity === 'pace' || intensity === 'pace_range' ? 'pace'
      : intensity === 'hr' || intensity === 'hr_zone' ? 'hr'
      : intensity === 'rpe' ? 'rpe'
      : intensity === 'effort' || intensity === 'text' ? 'effort'
      : 'none';
    var hasDistance = distance !== null && !Number.isNaN(distance);
    var hasDuration = duration !== null && !Number.isNaN(duration);
    var zone = hrZone(r.hr_zone);
    return {
      id: r.id ? String(r.id) : '',
      parent_step_id: r.parent_step_id ? String(r.parent_step_id) : null,
      step_order: Number(r.step_order) || 0,
      step_type: type,
      repeat_count: type === 'repeat' ? finite(r.repeat_count) : null,
      // Legacy rows can carry both; keep both so validation can say so rather
      // than quietly picking one.
      end: hasDistance && hasDuration ? 'both' : hasDistance ? 'distance' : hasDuration ? 'time' : 'lap',
      distance_km: hasDistance ? distance : null,
      duration_sec: hasDuration ? duration : null,
      durationText: hasDuration ? formatDuration(duration) : '',
      target: target,
      pace_fast: text(r.pace_min),
      pace_slow: text(r.pace_max),
      hr_zone: zone ? String(zone) : text(r.hr_zone),
      rpe: finite(r.rpe),
      effort: text(r.effort),
      instructions: text(r.instructions),
      coach_notes: text(r.coach_notes),
    };
  }

  // Whatever the browser sent, reduced to a builder step with known keys.
  // Nothing outside this list survives, so a request cannot smuggle columns.
  function fromInput(input) {
    var s = input || {};
    var type = STEP_TYPES.indexOf(text(s.step_type)) >= 0 ? text(s.step_type) : text(s.step_type) || '';
    var end = ENDS.indexOf(s.end) >= 0 ? s.end : 'lap';
    var target = TARGETS.indexOf(s.target) >= 0 ? s.target : 'none';
    var duration = s.durationText !== undefined && s.durationText !== null && text(s.durationText) !== ''
      ? parseDuration(s.durationText)
      : finite(s.duration_sec);
    return {
      id: text(s.id).slice(0, 64),
      parent_step_id: isBlank(s.parent_step_id) ? null : text(s.parent_step_id).slice(0, 64),
      step_order: Number.isFinite(Number(s.step_order)) ? Number(s.step_order) : 0,
      step_type: type,
      repeat_count: type === 'repeat' ? finite(s.repeat_count) : null,
      end: type === 'repeat' ? 'lap' : end,
      distance_km: end === 'distance' ? finite(s.distance_km) : null,
      duration_sec: end === 'time' ? duration : null,
      durationText: end === 'time' ? text(s.durationText) || (Number.isFinite(duration) && duration ? formatDuration(duration) : '') : '',
      target: type === 'repeat' ? 'none' : target,
      pace_fast: target === 'pace' ? text(s.pace_fast).slice(0, 20) : '',
      pace_slow: target === 'pace' ? text(s.pace_slow).slice(0, 20) : '',
      hr_zone: target === 'hr' ? text(s.hr_zone).slice(0, 10) : '',
      rpe: target === 'rpe' ? finite(s.rpe) : null,
      effort: target === 'effort' ? text(s.effort).slice(0, 200) : '',
      instructions: text(s.instructions).slice(0, 4000),
      coach_notes: text(s.coach_notes).slice(0, 4000),
    };
  }

  // A valid builder step → the run_steps row the portal reads. Only call
  // after validate() reports no errors.
  function toRow(step, sessionId, id, parentId, order) {
    var row = {
      id: id,
      planned_session_id: sessionId,
      parent_step_id: parentId || null,
      step_order: order,
      step_type: step.step_type,
      repeat_count: null,
      distance_km: null,
      duration_sec: null,
      intensity_type: null,
      pace_min: null,
      pace_max: null,
      hr_zone: null,
      rpe: null,
      effort: null,
      instructions: step.instructions ? step.instructions : null,
      coach_notes: step.coach_notes ? step.coach_notes : null,
    };
    if (step.step_type === 'repeat') {
      row.repeat_count = Number(step.repeat_count);
      row.instructions = null;
      return row;
    }
    if (step.end === 'distance') row.distance_km = Number(step.distance_km);
    if (step.end === 'time') row.duration_sec = Number(step.duration_sec);
    if (step.target === 'pace') {
      var a = parsePace(step.pace_fast);
      var b = isBlank(step.pace_slow) ? a : parsePace(step.pace_slow);
      // pace_min is the faster (smaller) number. The converter accepts either
      // order; storing one order keeps the portal display consistent.
      row.pace_min = formatPace(Math.min(a, b));
      row.pace_max = a === b ? null : formatPace(Math.max(a, b));
      row.intensity_type = row.pace_max ? 'pace_range' : 'pace';
    } else if (step.target === 'hr') {
      row.intensity_type = 'hr_zone';
      row.hr_zone = 'Z' + hrZone(step.hr_zone);
    } else if (step.target === 'rpe') {
      row.intensity_type = 'rpe';
      row.rpe = Number(step.rpe);
    } else if (step.target === 'effort') {
      row.intensity_type = 'effort';
      row.effort = step.effort;
    }
    return row;
  }

  // ── Tree helpers ────────────────────────────────────────────────────────

  function childrenOf(steps, parentId) {
    return steps
      .filter(function (step) { return (step.parent_step_id || null) === (parentId || null); })
      .sort(function (a, b) { return (a.step_order || 0) - (b.step_order || 0); });
  }

  // Human step numbers, "3" or "3.2", in the order the athlete runs them.
  function numbering(steps) {
    var out = {};
    function walk(parentId, prefix, depth) {
      if (depth > 6) return;
      childrenOf(steps, parentId).forEach(function (step, index) {
        if (out[step.id]) return;
        var label = (prefix ? prefix + '.' : '') + (index + 1);
        out[step.id] = label;
        if (step.step_type === 'repeat') walk(step.id, label, depth + 1);
      });
    }
    walk(null, '', 0);
    return out;
  }

  function stepName(step, numbers) {
    var label = LABELS[step.step_type] || 'Step';
    if (step.step_type === 'repeat' && Number.isFinite(Number(step.repeat_count))) label += ' ×' + Number(step.repeat_count);
    var number = numbers && numbers[step.id];
    return (number ? 'Step ' + number + ' (' + label + ')' : label);
  }

  // ── Validation ──────────────────────────────────────────────────────────
  // Returns plain-language problems. `errors` stop saving and publishing;
  // `blockers` mean the portal will not offer Send to Garmin for reasons that
  // are not step data; `notes` explain how Garmin will treat a valid step.

  function validate(session, inputSteps) {
    var steps = Array.isArray(inputSteps) ? inputSteps : [];
    var errors = [], blockers = [], notes = [];
    var numbers = numbering(steps);
    var byId = {};
    function err(step, message) {
      errors.push({ stepId: step ? step.id : null, message: (step ? stepName(step, numbers) + ': ' : '') + message });
    }

    if (steps.length > LIMITS.rows) {
      err(null, 'This workout has ' + steps.length + ' rows. Garmin accepts at most ' + LIMITS.rows + ' — remove or merge some steps.');
    }

    steps.forEach(function (step) {
      if (!step.id) err(step, 'is missing its reference. Remove it and add it again.');
      else if (byId[step.id]) err(step, 'appears twice. Remove the duplicate.');
      else byId[step.id] = step;
    });

    // Tree shape: every parent exists, is a repeat, and no step is its own
    // ancestor. Walking up from each step catches cycles of any length.
    steps.forEach(function (step) {
      if (!step.parent_step_id) return;
      var parent = byId[step.parent_step_id];
      if (!parent) { err(step, 'sits inside a repeat block that no longer exists. Move it out or delete it.'); return; }
      if (parent.step_type !== 'repeat') { err(step, 'is nested under a step that is not a repeat block.'); return; }
      var seen = {}, cursor = step, depth = 0;
      while (cursor && cursor.parent_step_id) {
        if (seen[cursor.id]) { err(step, 'is part of a loop of repeat blocks. Rebuild this repeat.'); return; }
        seen[cursor.id] = true;
        cursor = byId[cursor.parent_step_id];
        depth += 1;
      }
      if (depth > LIMITS.depth) err(step, 'is nested too deeply. Garmin supports a repeat inside a repeat, but no deeper.');
    });

    // Expanded size, counted the way the converter counts: every leaf, times
    // the product of the repeat counts above it.
    var expanded = 0, distanceKm = 0, durationSec = 0, lapSteps = 0, untimed = false;
    function multiplier(step) {
      var product = 1, cursor = step, guard = 0;
      while (cursor && cursor.parent_step_id && guard < 10) {
        cursor = byId[cursor.parent_step_id];
        if (!cursor) break;
        var count = Number(cursor.repeat_count);
        product *= Number.isInteger(count) && count > 0 ? count : 1;
        guard += 1;
      }
      return product;
    }

    steps.forEach(function (step) {
      var type = step.step_type;
      if (STEP_TYPES.indexOf(type) < 0) { err(step, 'has an unknown step type.'); return; }

      if (type === 'repeat') {
        var count = Number(step.repeat_count);
        if (isBlank(step.repeat_count) || !Number.isInteger(count) || count < 1 || count > LIMITS.repeat) {
          err(step, 'needs a whole number of rounds between 1 and ' + LIMITS.repeat + '.');
        }
        if (!childrenOf(steps, step.id).length) err(step, 'has no steps inside it. Add a step or delete the block.');
        return;
      }

      var times = multiplier(step);
      expanded += times;

      // End condition.
      if (step.end === 'both') {
        err(step, 'has both a distance and a time. Garmin ends a step on one of them — keep one.');
      } else if (step.end === 'distance') {
        var km = Number(step.distance_km);
        if (isBlank(step.distance_km) || Number.isNaN(Number(step.distance_km))) err(step, 'needs a distance in km, or choose “Lap button” to end it manually.');
        else if (!(km > 0)) err(step, 'distance must be more than 0 km.');
        else if (km > LIMITS.maxDistanceKm) err(step, 'distance looks wrong (' + km + ' km). Enter kilometres, e.g. 0.4 for 400 m.');
        else distanceKm += km * times;
      } else if (step.end === 'time') {
        var sec = Number(step.duration_sec);
        if (step.duration_sec === null || step.duration_sec === undefined) err(step, 'needs a time, e.g. 10:00 or 90s, or choose “Lap button”.');
        else if (Number.isNaN(sec)) err(step, 'time isn’t readable. Use minutes:seconds (10:00), or 90s / 10 min.');
        else if (!(sec > 0) || Math.round(sec) !== sec) err(step, 'time must be a whole number of seconds above 0.');
        else if (sec > LIMITS.maxDurationSec) err(step, 'time is longer than 24 hours.');
        else durationSec += sec * times;
      } else if (step.end === 'lap') {
        lapSteps += times;
        untimed = true;
      } else {
        err(step, 'needs an end: distance, time or lap button.');
      }

      // Target.
      var description = step.instructions || '';
      if (step.target === 'pace') {
        var fast = parsePace(step.pace_fast);
        var slow = isBlank(step.pace_slow) ? fast : parsePace(step.pace_slow);
        if (isBlank(step.pace_fast)) err(step, 'needs a pace, e.g. 4:30 (minutes:seconds per km).');
        else if (Number.isNaN(fast)) err(step, 'pace “' + text(step.pace_fast) + '” isn’t minutes:seconds per km, e.g. 4:30.');
        else if (Number.isNaN(slow)) err(step, 'pace “' + text(step.pace_slow) + '” isn’t minutes:seconds per km, e.g. 4:45.');
        else if ([fast, slow].some(function (v) { return v < LIMITS.paceMinSec || v > LIMITS.paceMaxSec; })) {
          err(step, 'pace must be between 1:30 and 30:00 per km.');
        }
      } else if (step.target === 'hr') {
        if (!hrZone(step.hr_zone)) err(step, 'needs a heart-rate zone from 1 to 5.');
      } else if (step.target === 'rpe') {
        var rpe = Number(step.rpe);
        if (isBlank(step.rpe) || Number.isNaN(rpe) || rpe < 1 || rpe > 10) err(step, 'needs an RPE from 1 to 10.');
        description = 'RPE ' + rpe + '/10. ' + description;
      } else if (step.target === 'effort') {
        if (!text(step.effort)) err(step, 'needs an effort description, e.g. “Easy, conversational”.');
        else if (text(step.effort).length > LIMITS.effort) err(step, 'effort is too long. Keep it under ' + LIMITS.effort + ' characters and use the instructions for detail.');
        description = text(step.effort) + ' ' + description;
      } else if (step.target !== 'none' && step.target) {
        err(step, 'has an unknown target type.');
      }

      if ((step.instructions || '').length > LIMITS.instructions) {
        err(step, 'instructions are too long. Keep them under ' + LIMITS.instructions + ' characters.');
      } else if (description.trim().length > LIMITS.description) {
        notes.push({ stepId: step.id, message: stepName(step, numbers) + ': Garmin shows the first ' + LIMITS.description + ' characters of the text on the watch.' });
      }
      if ((step.coach_notes || '').length > LIMITS.coachNotes) {
        err(step, 'coach note is too long. Keep it under ' + LIMITS.coachNotes + ' characters.');
      }
    });

    if (expanded > LIMITS.expanded) {
      errors.push({ stepId: null, message: 'Once repeats are expanded this workout is ' + expanded + ' Garmin steps. Garmin allows ' + LIMITS.expanded + ' — reduce the rounds or merge steps.' });
    }

    if (!steps.length) blockers.push('Add at least one step. The portal only sends structured runs to Garmin.');
    if (session && !sessionSendsToGarmin(session)) {
      blockers.push(session.session_type
        ? 'Session type “' + session.session_type + '” is not a running type, so the portal will not offer Send to Garmin. Use a run type such as Run, Easy Effort, Tempo or Long Run.'
        : 'This session has no type. Set a running type (Run, Easy Effort, Tempo…) in Plan Session so the portal offers Send to Garmin.');
    }

    if (steps.some(function (s) { return s.target === 'rpe' || s.target === 'effort'; })) {
      notes.push({ stepId: null, message: 'RPE and effort steps reach the watch as text on screen. Garmin gives them an open target, so there is no pace or heart-rate alert for them.' });
    }
    if (lapSteps) {
      notes.push({ stepId: null, message: lapSteps + ' step' + (lapSteps === 1 ? '' : 's') + ' end' + (lapSteps === 1 ? 's' : '') + ' when the athlete presses the lap button.' });
    }

    return {
      errors: errors,
      blockers: blockers,
      notes: notes,
      valid: errors.length === 0,
      garminReady: errors.length === 0 && blockers.length === 0,
      rows: steps.length,
      expandedSteps: expanded,
      totals: { distanceKm: Math.round(distanceKm * 100) / 100, durationSec: durationSec, lapSteps: lapSteps, partial: untimed },
    };
  }

  // ── Readable description ────────────────────────────────────────────────

  function targetText(step) {
    if (step.target === 'pace') {
      var fast = parsePace(step.pace_fast);
      var slow = isBlank(step.pace_slow) ? fast : parsePace(step.pace_slow);
      if (Number.isNaN(fast) || Number.isNaN(slow)) return 'pace ?';
      var lo = Math.min(fast, slow), hi = Math.max(fast, slow);
      return (lo === hi ? formatPace(lo) : formatPace(lo) + '–' + formatPace(hi)) + ' /km';
    }
    if (step.target === 'hr') return hrZone(step.hr_zone) ? 'HR zone ' + hrZone(step.hr_zone) : 'HR zone ?';
    if (step.target === 'rpe') return isBlank(step.rpe) ? 'RPE ?' : 'RPE ' + Number(step.rpe) + '/10';
    if (step.target === 'effort') return text(step.effort) || 'effort ?';
    return '';
  }

  function endText(step) {
    if (step.end === 'distance') return humanDistance(step.distance_km) || 'distance ?';
    if (step.end === 'time') return humanDuration(step.duration_sec) || 'time ?';
    if (step.end === 'both') return humanDistance(step.distance_km) + ' and ' + humanDuration(step.duration_sec);
    return 'until lap button';
  }

  function describe(step) {
    if (step.step_type === 'repeat') return 'Repeat ' + (Number(step.repeat_count) || '?') + ' times';
    return [LABELS[step.step_type] || 'Step', endText(step), targetText(step)].filter(Boolean).join(' · ');
  }

  // Nested, ordered view for previews: [{step, label, children:[...]}].
  function tree(steps) {
    var list = Array.isArray(steps) ? steps : [];
    var guard = {};
    function walk(parentId, depth) {
      if (depth > 6) return [];
      return childrenOf(list, parentId).filter(function (step) {
        if (guard[step.id]) return false;
        guard[step.id] = true;
        return true;
      }).map(function (step) {
        return { step: step, label: describe(step), children: step.step_type === 'repeat' ? walk(step.id, depth + 1) : [] };
      });
    }
    return walk(null, 0);
  }

  function summary(report) {
    var t = report.totals;
    var parts = [];
    if (t.distanceKm) parts.push(humanDistance(t.distanceKm));
    if (t.durationSec) parts.push(humanDuration(t.durationSec));
    if (t.lapSteps) parts.push(t.lapSteps + ' lap-button step' + (t.lapSteps === 1 ? '' : 's'));
    return parts.join(' + ');
  }

  var api = {
    STEP_TYPES: STEP_TYPES,
    LEAF_TYPES: LEAF_TYPES,
    LABELS: LABELS,
    GARMIN_RUN_SESSION_TYPES: GARMIN_RUN_SESSION_TYPES,
    LIMITS: LIMITS,
    parsePace: parsePace,
    formatPace: formatPace,
    parseDuration: parseDuration,
    formatDuration: formatDuration,
    humanDuration: humanDuration,
    humanDistance: humanDistance,
    hrZone: hrZone,
    sessionSendsToGarmin: sessionSendsToGarmin,
    fromRow: fromRow,
    fromInput: fromInput,
    toRow: toRow,
    childrenOf: childrenOf,
    numbering: numbering,
    validate: validate,
    describe: describe,
    tree: tree,
    summary: summary,
  };

  root.DPRunWorkout = api;
})(typeof window !== 'undefined' ? window : globalThis);
