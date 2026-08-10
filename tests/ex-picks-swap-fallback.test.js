import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The portal build that sends programmed_exercise has not reached every athlete
// yet, so swapped lifts still arrive with the column null. ex_picks — the
// athlete's current substitution map — is the stand-in that lets the dashboard
// put those lifts back in the slot they filled, instead of flagging the slot
// "Not done" and stacking the substitute at the bottom as an unplanned extra.
//
// It is current state rather than per-session history, so the guards matter as
// much as the mapping: it must never overwrite row-level swap data, and never
// reassign a slot the athlete logged under its own name.

function loadSwapResolution() {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function useSessionStateRows(');
  assert.ok(start > 0, 'useSessionStateRows should exist in index.html');
  const marker = '\n// Athlete tapped the checkbox';
  const end = html.indexOf(marker, start);
  assert.ok(end > start, 'useSessionStateRows should be followed by the tick helpers');

  const picksStart = html.indexOf('// The programmed slot an athlete');
  const picksEnd = html.indexOf('\n// Athlete tapped the checkbox', picksStart);
  assert.ok(picksStart > 0 && picksEnd > picksStart, 'swap helpers should exist in index.html');

  const context = { console };
  vm.createContext(context);
  vm.runInContext(
    'let _tickedMap = new Map();\n' +
    'let _loggedMap = new Map();\n' +
    'let _exPicksMap = new Map();\n' +
    'function nid(s){return String(s==null?"":s).trim().toUpperCase();}\n' +
    'function _logHasRealData(){return true;}\n' +
    html.slice(start, picksEnd) +
    '\nthis.useSessionStateRows=useSessionStateRows;' +
    '\nthis.applyExPickSwaps=applyExPickSwaps;' +
    '\nthis.programmedSlotFor=programmedSlotFor;',
    context
  );
  return context;
}

const { useSessionStateRows, applyExPickSwaps, programmedSlotFor } = loadSwapResolution();

// ALVIN's live ex_picks record, verbatim.
const alvinPicks = {
  athlete_code: 'ALVIN',
  key: 'ex_picks',
  value: {
    'Pec Dec': 'Pec Dec',
    'Lat Pulldown': 'Iso-Lateral Pulldown',
    'Machine Dips': 'Cable Pushdown (bar)',
    'Low Machine Row': 'Iso-Lateral Row',
    'Dumbbell Hammer Curl': 'Dumbbell Bicep Curl',
    'Wide Grip Machine Row': 'Wide Grip Cable Row',
    'Cable Abdominal Crunch': 'Crunch machine',
    'Incline Dumbbell Press': 'Barbell Bench Press',
    'Lateral Dumbbell Raise': 'Seated Lateral Raise',
    'Machine Shoulder Press': 'Dumbbell shoulder press',
  },
};

function session(lines, swaps) {
  return { _exercises: lines, _swaps: swaps || {} };
}

test('an identity pick is not treated as a swap', () => {
  useSessionStateRows([alvinPicks]);
  assert.equal(programmedSlotFor('ALVIN', 'Pec Dec'), null);
});

test('a substituted lift resolves to the slot it filled', () => {
  useSessionStateRows([alvinPicks]);
  assert.equal(programmedSlotFor('ALVIN', 'Iso-Lateral Row'), 'Low Machine Row');
  assert.equal(programmedSlotFor('ALVIN', 'Barbell Bench Press'), 'Incline Dumbbell Press');
  // Case and spacing come from free text, so lookups must not be brittle.
  assert.equal(programmedSlotFor('ALVIN', '  dumbbell SHOULDER press '), 'Machine Shoulder Press');
});

test("ALVIN's Upper A resolves every swap he actually performed", () => {
  useSessionStateRows([alvinPicks]);
  const s = session([
    'Iso-Lateral Row: Set 1: 20kg × 15reps | Set 2: 25kg × 14reps',
    'Dumbbell shoulder press: Set 1: 25kg × 12reps',
    'Cable Pushdown (bar): Set 1: 18kg × 15reps',
    'Iso-Lateral Pulldown: Set 1: 14kg × 35reps',
    'Barbell Bench Press: Set 1: 100kg × 5reps',
    'Pec Dec: Set 1: 50kg × 12reps',
    'Wide Grip Cable Row: Set 1: 53kg × 14reps',
    'Seated Lateral Raise: Set 1: 8kg × 14reps',
    'Dumbbell Bicep Curl: Set 1: 8kg × 15reps',
    'Tricep Rope Extension: Set 1: 17kg × 10reps',
    'Crunch machine: Set 1: 40kg × 10reps',
  ]);
  applyExPickSwaps(s, 'ALVIN');

  assert.equal(s._swaps['iso-lateral row'].programmed, 'Low Machine Row');
  assert.equal(s._swaps['barbell bench press'].programmed, 'Incline Dumbbell Press');
  assert.equal(s._swaps['iso-lateral pulldown'].programmed, 'Lat Pulldown');
  assert.equal(s._swaps['cable pushdown (bar)'].programmed, 'Machine Dips');
  assert.equal(s._swaps['dumbbell shoulder press'].programmed, 'Machine Shoulder Press');
  assert.equal(s._swaps['dumbbell bicep curl'].programmed, 'Dumbbell Hammer Curl');
  assert.equal(s._swaps['seated lateral raise'].programmed, 'Lateral Dumbbell Raise');
  assert.equal(s._swaps['crunch machine'].programmed, 'Cable Abdominal Crunch');
  assert.equal(s._swaps['wide grip cable row'].programmed, 'Wide Grip Machine Row');
  // Trained under their programmed names — nothing to resolve.
  assert.ok(!s._swaps['pec dec']);
  assert.ok(!s._swaps['tricep rope extension']);
});

test('row-level swap data is never overwritten by the pick map', () => {
  useSessionStateRows([alvinPicks]);
  const s = session(
    ['Iso-Lateral Row: Set 1: 20kg × 15reps'],
    { 'iso-lateral row': { performed: 'Iso-Lateral Row', programmed: 'Mid Machine Row', muscleGroup: 'Upper back' } }
  );
  applyExPickSwaps(s, 'ALVIN');
  assert.equal(s._swaps['iso-lateral row'].programmed, 'Mid Machine Row');
  assert.equal(s._swaps['iso-lateral row'].muscleGroup, 'Upper back');
});

test('a slot logged under its own name is not reassigned', () => {
  useSessionStateRows([alvinPicks]);
  // He swapped later, but on this day he trained the programmed lift itself as
  // well. Claiming the slot for the substitute would hide one of the two.
  const s = session([
    'Low Machine Row: Set 1: 45kg × 10reps',
    'Iso-Lateral Row: Set 1: 20kg × 15reps',
  ]);
  applyExPickSwaps(s, 'ALVIN');
  assert.ok(!s._swaps['iso-lateral row'], 'the programmed lift was performed, so the slot is already filled');
});

test('an athlete with no pick map is left completely untouched', () => {
  useSessionStateRows([alvinPicks]);
  const s = session(['Lat Pulldown: Set 1: 60kg × 10reps']);
  applyExPickSwaps(s, 'THOMAS');
  assert.deepEqual(s._swaps, {});
});

test('lines that are not exercise logs are ignored', () => {
  useSessionStateRows([alvinPicks]);
  const s = session([
    'Matched from Strava | Distance: 10.2km | Moving time: 62.3min',
    'Iso-Lateral Row: Set 1: 20kg × 15reps',
  ]);
  applyExPickSwaps(s, 'ALVIN');
  assert.equal(Object.keys(s._swaps).length, 1);
  assert.equal(s._swaps['iso-lateral row'].programmed, 'Low Machine Row');
});

test('a stale pick map cannot invent a swap for an exercise never substituted', () => {
  useSessionStateRows([alvinPicks]);
  const s = session(['Machine Lat Pulldown: Set 1: 60kg × 15reps']);
  applyExPickSwaps(s, 'ALVIN');
  assert.deepEqual(s._swaps, {}, 'only exact performed-name matches resolve');
});
