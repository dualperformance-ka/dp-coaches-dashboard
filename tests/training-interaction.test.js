import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');

test('Strava match controls stay inside the opened session, not the Home card', () => {
  const buildCardStart=source.indexOf('function buildCard');
  const buildCardEnd=source.indexOf('function resolveRunDisplay',buildCardStart);
  const homeStart=source.indexOf('function renderTodaySection');
  const homeEnd=source.indexOf('// Readiness is strictly',homeStart);
  const buildCardSource=source.slice(buildCardStart,buildCardEnd);
  const homeSource=source.slice(homeStart,homeEnd);
  assert.match(buildCardSource,/class="scb"[\s\S]*stravaMatchHtml\(s,i,'session'\)[\s\S]*buildBody\(s,i,type\)/);
  assert.doesNotMatch(homeSource,/stravaMatchHtml/);
  assert.doesNotMatch(homeSource,/strava-complete/);
});

function classList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !classes.has(name) : force;
      if (enabled) classes.add(name);
      else classes.delete(name);
      return enabled;
    }
  };
}

test('completing an exercise collapses it without opening the next exercise', () => {
  const nextCard = { classList: classList(['exc']) };
  const card = {
    classList: classList(['exc', 'open']),
    nextElementSibling: nextCard,
    getAttribute: () => 'Upper A'
  };
  const button = {
    classList: classList(),
    style: {},
    setAttribute: () => {},
    closest: () => card
  };
  const context = {
    console,
    Date,
    Math,
    Intl,
    setTimeout: (callback) => callback(),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      addEventListener: () => {},
      getElementById: (id) => id === 'st_0_0_0' ? button : null,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false })
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.draftGym = () => {};
  context.refreshStrengthExerciseState = () => {};
  context.strengthExerciseIsComplete = () => true;
  context.startRest = () => {};

  context.togSet(0, 0, 0);

  assert.equal(card.classList.contains('open'), false);
  assert.equal(nextCard.classList.contains('open'), false);
});

test('set auto-completion only waits for RPE while RPE logging is enabled', () => {
  let rpePreference = null;
  const fields = {
    'input[id^="w_"]': { value: '80' },
    'input[id^="r_"]': { value: '8' },
    'input[id^="rpe_"]': { value: '' }
  };
  const row = { querySelector: (selector) => fields[selector] || null };
  const button = { classList: classList() };
  const context = {
    console,
    Date,
    Math,
    Intl,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      addEventListener: () => {},
      getElementById: (id) => id.startsWith('sr_') ? row : button,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false })
    },
    localStorage: {
      getItem: (key) => key === 'dp_strength_rpe_enabled' ? rpePreference : null,
      setItem: (key, value) => { if (key === 'dp_strength_rpe_enabled') rpePreference = value; }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  let completions = 0;
  context.togSet = () => { completions += 1; };

  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(completions, 0, 'weight and reps alone must keep the set open');

  rpePreference = 'false';
  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(completions, 1, 'weight and reps complete the set when RPE logging is off');

  rpePreference = null;
  fields['input[id^="rpe_"]'].value = '8';
  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(completions, 2, 'the set completes after RPE is entered');
});

test('an already-ticked set collapses only after its final required column is filled', () => {
  const fields = {
    'input[id^="w_"]': { value: '80' },
    'input[id^="r_"]': { value: '8' },
    'input[id^="rpe_"]': { value: '8' }
  };
  const row = { querySelector: (selector) => fields[selector] || null };
  const card = {
    classList: classList(['exc', 'open']),
    querySelectorAll: () => [row],
    querySelector: () => null,
    getAttribute: () => ''
  };
  const button = {
    classList: classList(['on']),
    closest: () => card
  };
  row.querySelector = (selector) => selector === '.st' ? button : (fields[selector] || null);
  const context = {
    console,
    Date,
    Math,
    Intl,
    setTimeout: (callback) => callback(),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      addEventListener: () => {},
      getElementById: (id) => id.startsWith('sr_') ? row : button,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false })
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.refreshStrengthExerciseState = () => {};

  fields['input[id^="rpe_"]'].value = '';
  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(card.classList.contains('open'), true, 'missing RPE keeps the exercise open');

  fields['input[id^="rpe_"]'].value = '8';
  context.autoCompleteStrengthSet(0, 0, 0);
  assert.equal(card.classList.contains('open'), false, 'the final required value collapses the exercise');
});

test('submitted exercises cannot bypass enabled column requirements', () => {
  const refreshStart = source.indexOf('function refreshStrengthExerciseState');
  const refreshEnd = source.indexOf('function refreshStrengthExerciseStates', refreshStart);
  const refreshSource = source.slice(refreshStart, refreshEnd);
  assert.doesNotMatch(refreshSource, /strengthExerciseWasSubmitted|isSessionLogged/);
  assert.match(source, /renderedRows\.every\(function\(set\)\{return !!set\.done&&strengthSavedSetHasRequiredInputs/);
});
