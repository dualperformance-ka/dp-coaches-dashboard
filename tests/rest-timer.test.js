import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');
const timerSource = source.slice(0, source.indexOf('function addSet'));

function timerContext() {
  const stored = new Map();
  const notifications = [];
  const toasts = [];
  const vibrations = [];
  const timer = { style: {}, getAttribute: () => '90' };
  const count = { textContent: '' };
  const fill = { style: {} };
  const wrongCard = { querySelector: () => ({ textContent: 'Dumbbell Bicep Curl' }) };
  function Notification(title, options) { notifications.push({ title, options }); }
  Notification.permission = 'granted';
  const context = {
    athlete: { code: 'TEST' },
    console,
    Date,
    JSON,
    Math,
    Notification,
    location: { pathname: '/portal', search: '' },
    navigator: { vibrate: (pattern) => vibrations.push(pattern) },
    showToast: (message) => toasts.push(message),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (callback) => callback(),
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key)
    },
    document: {
      visibilityState: 'visible',
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => wrongCard,
      getElementById: (id) => id === 'rest_0_1' ? timer : (id === 'rtc_0_1' ? count : (id === 'rtf_0_1' ? fill : null))
    },
    window: { addEventListener: () => {}, Notification }
  };
  vm.createContext(context);
  vm.runInContext(timerSource, context);
  return { context, notifications, stored, toasts, vibrations };
}

test('visible rest timer finishes with an exact in-app cue for the right exercise', () => {
  const { context, notifications, stored, toasts, vibrations } = timerContext();

  context.startRest(0, 1, 'Lat Pulldown');
  const saved = JSON.parse(stored.get('dp_rest_timer_TEST'));
  assert.equal(saved.exerciseName, 'Lat Pulldown');

  context._rest.deadline = Date.now();
  context.finishRest(0, 1);
  assert.equal(notifications.length, 0);
  assert.deepEqual(toasts, ['Rest complete · Lat Pulldown']);
  assert.deepEqual(Array.from(vibrations[0]), [180, 90, 180]);
});

test('backgrounded rest timer sends one system notification three seconds early', () => {
  const { context, notifications, stored } = timerContext();
  context.document.visibilityState = 'hidden';
  context.startRest(0, 1, 'Lat Pulldown');
  context._rest.deadline = Date.now() + 3000;
  const saved = JSON.parse(stored.get('dp_rest_timer_TEST'));
  saved.deadline = context._rest.deadline;
  stored.set('dp_rest_timer_TEST', JSON.stringify(saved));

  context.renderRestTimer(0, 1);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Rest nearly complete');
  assert.equal(notifications[0].options.body, 'Rest finishes in 3 seconds — get ready for Lat Pulldown.');
  assert.equal(JSON.parse(stored.get('dp_rest_timer_TEST')).notified, true);
});

test('restored timer uses its persisted exercise instead of the first card', () => {
  const { context, notifications, stored } = timerContext();
  context.document.visibilityState = 'hidden';
  stored.set('dp_rest_timer_TEST', JSON.stringify({
    key: '0_1', i: 0, ei: 1, total: 90,
    deadline: Date.now() - 1000,
    exerciseName: 'Rear Delt Fly'
  }));

  context.restoreRestTimer();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.body, 'Rest finished — time for Rear Delt Fly.');
});
