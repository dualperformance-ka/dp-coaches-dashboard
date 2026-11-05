/* Dual Performance — structured run builder (Garmin-compatible).
 *
 * Renders inside the prescription drawer (programming.js) for running
 * sessions. It edits a local copy of the session's run_steps and saves the
 * whole tree in one request; nothing reaches the athlete until a save, and a
 * save on a published session lands in one database transaction.
 *
 * Rules come from run-workout.js (window.DPRunWorkout), shared with the
 * server, which mirrors the athlete portal's Garmin converter.
 *
 * What this deliberately does NOT do:
 *   - send anything to Garmin. The athlete reviews the run in the portal and
 *     taps Send to Garmin; "compatible" here never means "sent".
 *   - parse a text prescription into steps. Converting a legacy session
 *     starts from an empty builder with the text shown for reference.
 */
(function () {
  'use strict';

  var R = window.DPRunWorkout;
  var TYPE_ORDER = ['warmup', 'run', 'interval', 'recovery', 'rest', 'cooldown'];
  var END_LABELS = { distance: 'Distance', time: 'Time', lap: 'Lap button' };
  var TARGET_LABELS = { none: 'No target', pace: 'Pace (min/km)', hr: 'Heart-rate zone', rpe: 'RPE', effort: 'Effort' };

  // Sensible starting values for a new step. Visible and editable — nothing
  // here is inferred from an existing prescription.
  var DEFAULTS = {
    warmup:   { end: 'time', duration_sec: 600, target: 'effort', effort: 'Easy' },
    run:      { end: 'distance', distance_km: 5, target: 'none' },
    interval: { end: 'distance', distance_km: 1, target: 'pace' },
    recovery: { end: 'time', duration_sec: 90, target: 'effort', effort: 'Easy jog' },
    rest:     { end: 'time', duration_sec: 60, target: 'none' },
    cooldown: { end: 'time', duration_sec: 600, target: 'effort', effort: 'Easy' },
  };

  var state = {
    sessionId: null,
    session: null,
    steps: [],
    saved: '[]',          // serialised steps as last loaded/saved
    legacyRun: [],
    garmin: { delivery: 'none' },
    converting: false,
    ctx: null,
    saving: false,
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function newId() { return 'new-' + Math.random().toString(36).slice(2, 10); }

  function serialise(steps) {
    return JSON.stringify(steps.map(function (s) {
      return [s.id, s.parent_step_id, s.step_order, s.step_type, s.repeat_count, s.end, s.distance_km,
        s.end === 'time' ? (s.durationText || s.duration_sec) : null, s.target, s.pace_fast, s.pace_slow,
        s.hr_zone, s.rpe, s.effort, s.instructions, s.coach_notes];
    }));
  }

  function isDirty() { return state.sessionId !== null && serialise(state.steps) !== state.saved; }
  function report() { return R.validate(state.session, state.steps); }
  function isLegacy() { return state.session && state.session.prescription_mode !== 'structured'; }
  function isPublished() { return state.session && state.session.publish_state === 'published'; }

  // ── Load ────────────────────────────────────────────────────────────────

  function load(data, ctx) {
    state.ctx = ctx || state.ctx;
    state.sessionId = data.session ? data.session.id : null;
    state.session = data.session || null;
    state.steps = (data.runSteps || []).map(R.fromRow);
    state.saved = serialise(state.steps);
    state.legacyRun = data.legacyRun || [];
    state.garmin = data.garmin || { delivery: 'none' };
    state.converting = false;
    remember();
  }

  function reset() {
    state.sessionId = null;
    state.session = null;
    state.steps = [];
    state.saved = '[]';
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  function find(id) { return state.steps.find(function (s) { return s.id === id; }); }

  function siblings(step) { return R.childrenOf(state.steps, step.parent_step_id); }

  function renumber(parentId) {
    R.childrenOf(state.steps, parentId).forEach(function (s, i) { s.step_order = i; });
  }

  function addStep(type, parentId) {
    var base = DEFAULTS[type] || {};
    var step = R.fromInput({
      id: newId(),
      parent_step_id: parentId || null,
      step_order: R.childrenOf(state.steps, parentId || null).length,
      step_type: type,
      end: base.end || 'lap',
      distance_km: base.distance_km,
      duration_sec: base.duration_sec,
      target: base.target || 'none',
      effort: base.effort || '',
    });
    step.id = step.id || newId();
    if (step.end === 'time') step.durationText = R.formatDuration(step.duration_sec);
    state.steps.push(step);
    return step;
  }

  function addRepeat() {
    var repeat = R.fromInput({
      id: newId(), step_type: 'repeat', repeat_count: 6,
      step_order: R.childrenOf(state.steps, null).length,
    });
    state.steps.push(repeat);
    addStep('interval', repeat.id);
    addStep('recovery', repeat.id);
    return repeat;
  }

  function move(id, delta) {
    var step = find(id);
    if (!step) return;
    var list = siblings(step);
    var index = list.indexOf(step);
    var target = index + delta;
    if (target < 0 || target >= list.length) return;
    list.splice(index, 1);
    list.splice(target, 0, step);
    list.forEach(function (s, i) { s.step_order = i; });
  }

  function remove(id) {
    var doomed = {};
    (function mark(target) {
      doomed[target] = true;
      state.steps.forEach(function (s) { if (s.parent_step_id === target) mark(s.id); });
    })(id);
    var step = find(id);
    var parent = step ? step.parent_step_id : null;
    state.steps = state.steps.filter(function (s) { return !doomed[s.id]; });
    renumber(parent);
  }

  // Coach-initiated Garmin-shaped starting point for a common session. Only
  // offered on an empty builder, never applied over existing steps.
  function quickStart(kind) {
    if (state.steps.length) return;
    if (kind === 'intervals') {
      addStep('warmup');
      addRepeat();
      addStep('cooldown');
    } else {
      addStep('run');
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  function options(map, current) {
    return Object.keys(map).map(function (key) {
      return '<option value="' + key + '"' + (key === current ? ' selected' : '') + '>' + esc(map[key]) + '</option>';
    }).join('');
  }

  function typeOptions(current) {
    var map = {};
    TYPE_ORDER.forEach(function (t) { map[t] = R.LABELS[t]; });
    return options(map, current);
  }

  function field(label, control, extraClass) {
    return '<label class="rb-f' + (extraClass ? ' ' + extraClass : '') + '"><span>' + esc(label) + '</span>' + control + '</label>';
  }

  function endControl(step) {
    if (step.end === 'distance') {
      return field('km', '<input class="rx-input rb-num" type="number" inputmode="decimal" min="0" step="0.01" data-k="distance_km" value="' +
        (step.distance_km == null || Number.isNaN(step.distance_km) ? '' : esc(step.distance_km)) + '" placeholder="1" aria-label="Distance in km">');
    }
    if (step.end === 'time') {
      return field('mm:ss', '<input class="rx-input rb-num" type="text" inputmode="numeric" data-k="durationText" value="' +
        esc(step.durationText || '') + '" placeholder="10:00" aria-label="Time, minutes and seconds">');
    }
    if (step.end === 'both') {
      return '<span class="rb-hint">Has both ' + esc(R.humanDistance(step.distance_km)) + ' and ' + esc(R.humanDuration(step.duration_sec)) + '. Choose one.</span>';
    }
    return '<span class="rb-hint">Ends when the athlete presses lap.</span>';
  }

  function targetControl(step) {
    if (step.target === 'pace') {
      return field('Fast', '<input class="rx-input rb-num" type="text" inputmode="numeric" data-k="pace_fast" value="' + esc(step.pace_fast) + '" placeholder="4:30" aria-label="Faster pace per km">') +
        field('Slow', '<input class="rx-input rb-num" type="text" inputmode="numeric" data-k="pace_slow" value="' + esc(step.pace_slow) + '" placeholder="4:45" aria-label="Slower pace per km (optional)">');
    }
    if (step.target === 'hr') {
      return field('Zone', '<select class="rx-input rb-num" data-k="hr_zone" aria-label="Heart-rate zone"><option value="">—</option>' +
        [1, 2, 3, 4, 5].map(function (z) { return '<option value="' + z + '"' + (String(R.hrZone(step.hr_zone) || '') === String(z) ? ' selected' : '') + '>Z' + z + '</option>'; }).join('') +
        '</select>');
    }
    if (step.target === 'rpe') {
      return field('RPE 1–10', '<input class="rx-input rb-num" type="number" inputmode="decimal" min="1" max="10" step="0.5" data-k="rpe" value="' +
        (step.rpe == null || Number.isNaN(step.rpe) ? '' : esc(step.rpe)) + '" placeholder="7" aria-label="RPE from 1 to 10">');
    }
    if (step.target === 'effort') {
      return field('Effort', '<input class="rx-input" type="text" maxlength="' + R.LIMITS.effort + '" data-k="effort" value="' + esc(step.effort) + '" placeholder="Easy, conversational" aria-label="Effort">', 'rb-grow');
    }
    return '';
  }

  // The type is already in the select beside it.
  function shortDescribe(step) {
    return R.describe(step).split(' · ').slice(1).join(' · ');
  }

  function renderLeaf(step, numbers, isChild) {
    var number = numbers[step.id] || '';
    return '' +
      '<div class="rb-step' + (isChild ? ' is-child' : '') + ' is-' + esc(step.step_type) + '" data-step="' + esc(step.id) + '">' +
        '<div class="rb-step-head">' +
          '<span class="rb-num-badge" aria-hidden="true">' + esc(number) + '</span>' +
          '<select class="rx-input rb-type" data-k="step_type" aria-label="Step ' + esc(number) + ' type">' + typeOptions(step.step_type) + '</select>' +
          '<span class="rb-step-summary" data-summary>' + esc(shortDescribe(step)) + '</span>' +
          tools(step, number) +
        '</div>' +
        '<div class="rb-grid">' +
          field('Ends by', '<select class="rx-input" data-k="end" aria-label="Step ' + esc(number) + ' ends by">' +
            options(step.end === 'both' ? Object.assign({ both: 'Both (fix)' }, END_LABELS) : END_LABELS, step.end) + '</select>') +
          endControl(step) +
          field('Target', '<select class="rx-input" data-k="target" aria-label="Step ' + esc(number) + ' target">' + options(TARGET_LABELS, step.target) + '</select>') +
          targetControl(step) +
        '</div>' +
        '<label class="rb-lbl">Instructions <span>athlete sees this, and it shows on the watch</span></label>' +
        '<textarea class="rx-input rx-ta" rows="1" maxlength="' + R.LIMITS.instructions + '" data-k="instructions" placeholder="e.g. Relaxed shoulders, quick feet">' + esc(step.instructions) + '</textarea>' +
        '<details class="rb-coach"' + (step.coach_notes ? ' open' : '') + '><summary>Coach note <span>private</span></summary>' +
          '<textarea class="rx-input rx-ta rx-ta-coach" rows="1" data-k="coach_notes" placeholder="Never shown to the athlete or sent to Garmin">' + esc(step.coach_notes) + '</textarea>' +
        '</details>' +
        '<div class="rb-step-errors" data-errors-for="' + esc(step.id) + '" role="alert"></div>' +
      '</div>';
  }

  function tools(step, number) {
    return '<div class="rb-tools">' +
      '<button type="button" class="rx-icon" data-act="up" title="Move up" aria-label="Move step ' + esc(number) + ' up">↑</button>' +
      '<button type="button" class="rx-icon" data-act="down" title="Move down" aria-label="Move step ' + esc(number) + ' down">↓</button>' +
      '<button type="button" class="rx-icon rx-icon-danger" data-act="remove" title="Remove" aria-label="Remove step ' + esc(number) + '">×</button>' +
    '</div>';
  }

  function renderRepeat(step, numbers, depth) {
    var number = numbers[step.id] || '';
    var children = R.childrenOf(state.steps, step.id);
    return '' +
      '<div class="rb-repeat" data-step="' + esc(step.id) + '">' +
        '<div class="rb-step-head">' +
          '<span class="rb-num-badge" aria-hidden="true">' + esc(number) + '</span>' +
          '<span class="rb-repeat-label">Repeat</span>' +
          '<input class="rx-input rb-num rb-count" type="number" inputmode="numeric" min="1" max="100" step="1" data-k="repeat_count" value="' +
            (step.repeat_count == null || Number.isNaN(step.repeat_count) ? '' : esc(step.repeat_count)) + '" aria-label="Number of rounds">' +
          '<span class="rb-repeat-label">times</span>' +
          tools(step, number) +
        '</div>' +
        '<div class="rb-children">' +
          children.map(function (child) {
            return child.step_type === 'repeat' ? renderRepeat(child, numbers, depth + 1) : renderLeaf(child, numbers, true);
          }).join('') +
          '<div class="rb-add rb-add-inside">' +
            ['interval', 'recovery', 'run', 'rest'].map(function (t) {
              return '<button type="button" class="rx-btn rx-btn-tiny" data-add="' + t + '" data-parent="' + esc(step.id) + '">+ ' + esc(R.LABELS[t]) + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="rb-step-errors" data-errors-for="' + esc(step.id) + '" role="alert"></div>' +
      '</div>';
  }

  function renderSteps() {
    var numbers = R.numbering(state.steps);
    var top = R.childrenOf(state.steps, null);
    if (!top.length) {
      return '<div class="rb-empty">' +
        '<p>No steps yet. Build the run the way the watch will run it.</p>' +
        '<div class="rb-quick">' +
          '<button type="button" class="rx-btn" data-quick="intervals">Warm-up · repeat block · cool-down</button>' +
          '<button type="button" class="rx-btn" data-quick="run">Single continuous run</button>' +
        '</div>' +
      '</div>';
    }
    return top.map(function (step) {
      return step.step_type === 'repeat' ? renderRepeat(step, numbers, 1) : renderLeaf(step, numbers, false);
    }).join('');
  }

  function renderLegacy(open) {
    if (!state.legacyRun || !state.legacyRun.length) return '';
    return '<details class="rb-legacy"' + (open ? ' open' : '') + '>' +
      '<summary>Text prescription <span>reference only · not copied · not changed</span></summary>' +
      '<dl>' + state.legacyRun.map(function (row) {
        return '<dt>' + esc(row.label) + '</dt><dd>' + esc(row.value) + '</dd>';
      }).join('') + '</dl>' +
    '</details>';
  }

  function renderConvertIntro() {
    return '' +
      '<div class="rb-convert">' +
        '<div class="rb-convert-title">This run is a text prescription</div>' +
        '<p>The portal can only send structured runs to Garmin. Converting starts an empty step builder; nothing is read out of the text and the text fields are left exactly as they are.</p>' +
        '<p>' + (isPublished()
          ? 'This session is <strong>published</strong>, so the structured version reaches the athlete only when you choose <em>Review &amp; publish</em>.'
          : 'This session is a <strong>draft</strong>. Save the steps, then publish when ready.') + '</p>' +
        '<button type="button" class="rx-btn rx-btn-primary" data-act-global="convert">Build structured steps</button>' +
      '</div>';
  }

  function html() {
    if (!state.session) return '';
    var showBuilder = !isLegacy() || state.steps.length || state.converting;
    return '' +
      '<div class="rb" id="rb">' +
        '<section class="rb-status" id="rb-status" aria-live="polite"></section>' +
        (showBuilder
          ? (isLegacy() ? '<div class="rb-banner">Converting from the text prescription. Build the steps below; the text is shown for reference only.</div>' : '') +
            renderLegacy(isLegacy()) +
            '<div class="rb-steps" id="rb-steps">' + renderSteps() + '</div>' +
            '<div class="rb-add" id="rb-add">' +
              TYPE_ORDER.map(function (t) {
                return '<button type="button" class="rx-btn" data-add="' + t + '">+ ' + esc(R.LABELS[t]) + '</button>';
              }).join('') +
              '<button type="button" class="rx-btn" data-add="repeat">+ Repeat block</button>' +
            '</div>' +
            '<section class="rb-preview" id="rb-preview"></section>' +
            '<div class="rb-savebar" id="rb-savebar"></div>'
          : renderConvertIntro() + renderLegacy(true)) +
      '</div>';
  }

  // ── Derived panels (re-rendered on every edit, without touching inputs) ──

  function statusHtml(rep) {
    var lines = [];
    var tone, title;
    var dirty = isDirty();
    if (!rep.valid) {
      tone = 'bad';
      title = 'Not Garmin-compatible yet · ' + rep.errors.length + ' thing' + (rep.errors.length === 1 ? '' : 's') + ' to fix';
    } else if (rep.blockers.length) {
      tone = 'warn';
      title = 'Steps are valid, but the portal won’t offer Send to Garmin';
    } else if (dirty) {
      tone = 'warn';
      title = 'Garmin-compatible · unsaved changes';
    } else if (!isPublished()) {
      tone = 'warn';
      title = 'Garmin-compatible · draft, hidden from the athlete';
    } else {
      tone = 'ok';
      title = 'Garmin-compatible · published';
    }

    if (rep.valid && !rep.blockers.length) {
      lines.push(dirty
        ? 'Save to make these changes available to the athlete.'
        : isPublished()
          ? 'The athlete can review this run in the portal and tap Send to Garmin. It is not on their watch until they do and their watch syncs.'
          : 'Publish when ready. The athlete then reviews it in the portal and taps Send to Garmin.');
    }
    rep.blockers.forEach(function (b) { lines.push(b); });

    var g = state.garmin || {};
    var delivery = '';
    if (g.delivery === 'sent') {
      delivery = 'Athlete sent this to Garmin Connect' + (g.sentAt ? ' on ' + fmtDate(g.sentAt) : '') +
        (g.scheduledDate ? ' for ' + fmtDay(g.scheduledDate) : '') + '. That confirms Garmin Connect, not the watch.';
      if (g.changedSince || dirty) delivery += ' <strong>Changes since then are not on Garmin</strong> — the athlete needs to send it again from the portal.';
      if (g.plannedDateDiffers) delivery += ' The Garmin calendar date differs from the planned date.';
    } else if (g.delivery === 'uncertain') {
      delivery = '<strong>Last Garmin delivery is uncertain.</strong> The athlete should check Garmin Connect before sending again.';
    }

    return '<div class="rb-status-card is-' + tone + '">' +
      '<div class="rb-status-title">' + esc(title) + '</div>' +
      lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') +
      (delivery ? '<p class="rb-delivery">' + delivery + '</p>' : '') +
      (rep.errors.length > 3
        ? '<p class="rb-issues-more">Each issue is shown in red under its step.</p>'
        : rep.errors.length ? '<ul class="rb-issues">' + rep.errors.map(function (e) { return '<li>' + esc(e.message) + '</li>'; }).join('') + '</ul>' : '') +
      '<p class="rb-fine">Sending is started by the athlete. Edits or a new date need the athlete to send again, and deleting or moving a session to draft does not remove a workout already in Garmin Connect.</p>' +
    '</div>';
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function fmtDay(iso) {
    var d = new Date(String(iso) + 'T12:00:00');
    return isNaN(d) ? String(iso) : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function previewTreeHtml(nodes) {
    return '<ol class="rb-tree">' + nodes.map(function (node) {
      var s = node.step;
      return '<li class="is-' + esc(s.step_type) + '"><span class="rb-tree-label">' + esc(node.label) + '</span>' +
        (s.instructions ? '<small>' + esc(s.instructions) + '</small>' : '') +
        (node.children.length ? previewTreeHtml(node.children) : '') + '</li>';
    }).join('') + '</ol>';
  }

  function previewHtml(rep) {
    if (!state.steps.length) return '';
    var total = R.summary(rep);
    return '<div class="rb-preview-head">' +
        '<span>Workout preview</span>' +
        '<span class="rb-meter' + (rep.expandedSteps > R.LIMITS.expanded ? ' is-over' : '') + '">' +
          rep.expandedSteps + ' / ' + R.LIMITS.expanded + ' Garmin steps</span>' +
      '</div>' +
      (total ? '<div class="rb-total">' + esc(total) + '</div>' : '') +
      previewTreeHtml(R.tree(state.steps)) +
      (rep.notes.length ? '<ul class="rb-notes">' + rep.notes.map(function (n) { return '<li>' + esc(n.message) + '</li>'; }).join('') + '</ul>' : '');
  }

  function saveLabel() {
    if (isLegacy() && isPublished()) return 'Review & publish structured version';
    if (isPublished()) return 'Save & update athlete';
    return 'Save draft steps';
  }

  function savebarHtml(rep) {
    var dirty = isDirty();
    return '<span class="rb-dirty' + (dirty ? ' is-dirty' : '') + '">' + (dirty ? 'Unsaved changes' : 'All changes saved') + '</span>' +
      '<div class="rb-savebar-actions">' +
        (dirty ? '<button type="button" class="rx-btn rx-btn-quiet" data-act-global="discard">Discard</button>' : '') +
        '<button type="button" class="rx-btn rx-btn-primary" data-act-global="save"' + (dirty && !state.saving ? '' : ' disabled') + '>' + esc(state.saving ? 'Saving…' : saveLabel()) + '</button>' +
      '</div>';
  }

  function refresh(root) {
    var rep = report();
    var scope = root || document;
    var status = scope.querySelector('#rb-status');
    if (status) status.innerHTML = statusHtml(rep);
    var preview = scope.querySelector('#rb-preview');
    if (preview) preview.innerHTML = previewHtml(rep);
    var savebar = scope.querySelector('#rb-savebar');
    if (savebar) savebar.innerHTML = savebarHtml(rep);

    // Per-step problems sit under the step they belong to.
    var byStep = {};
    rep.errors.forEach(function (e) { if (e.stepId) (byStep[e.stepId] = byStep[e.stepId] || []).push(e.message); });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-errors-for]'), function (box) {
      var shown = byStep[box.getAttribute('data-errors-for')] || [];
      box.innerHTML = shown.map(function (m) { return '<div>' + esc(m.replace(/^Step [\d.]+ \([^)]*\): /, '')) + '</div>'; }).join('');
      var card = box.closest('[data-step]');
      if (card) card.classList.toggle('has-error', shown.length > 0);
    });
    Array.prototype.forEach.call(scope.querySelectorAll('.rb-step[data-step]'), function (card) {
      var step = find(card.getAttribute('data-step'));
      var summary = card.querySelector('[data-summary]');
      if (step && summary) summary.textContent = shortDescribe(step);
    });
    if (state.ctx && state.ctx.onChange) state.ctx.onChange();
  }

  // ── Binding ─────────────────────────────────────────────────────────────

  var STRUCTURAL = { step_type: true, end: true, target: true };

  function applyInput(step, key, raw) {
    if (key === 'distance_km' || key === 'rpe' || key === 'repeat_count') {
      step[key] = raw === '' ? null : Number(raw);
    } else if (key === 'durationText') {
      step.durationText = raw;
      var parsed = R.parseDuration(raw);
      step.duration_sec = parsed;
    } else if (key === 'end') {
      step.end = raw;
      if (raw !== 'distance') step.distance_km = raw === 'both' ? step.distance_km : null;
      if (raw !== 'time') { step.duration_sec = raw === 'both' ? step.duration_sec : null; if (raw !== 'both') step.durationText = ''; }
    } else if (key === 'target') {
      step.target = raw;
    } else {
      step[key] = raw;
    }
  }

  function bind(root) {
    var scope = root || document;
    var rb = scope.querySelector('#rb');
    if (!rb) return;

    rb.addEventListener('input', function (event) {
      var input = event.target;
      var key = input.getAttribute('data-k');
      if (!key || STRUCTURAL[key]) return;
      var card = input.closest('[data-step]');
      var step = card && find(card.getAttribute('data-step'));
      if (!step) return;
      applyInput(step, key, input.value);
      refresh(scope);
    });

    rb.addEventListener('change', function (event) {
      var input = event.target;
      var key = input.getAttribute('data-k');
      if (!key) return;
      var card = input.closest('[data-step]');
      var step = card && find(card.getAttribute('data-step'));
      if (!step) return;
      applyInput(step, key, input.value);
      if (key === 'durationText' && Number.isFinite(step.duration_sec) && step.duration_sec > 0) {
        // Normalise "90s" → "1:30" once the coach leaves the field.
        step.durationText = R.formatDuration(step.duration_sec);
        input.value = step.durationText;
      }
      if (STRUCTURAL[key]) rerender(scope, input);
      else refresh(scope);
    });

    rb.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button || !rb.contains(button)) return;

      var add = button.getAttribute('data-add');
      if (add) {
        var created = add === 'repeat' ? addRepeat() : addStep(add, button.getAttribute('data-parent'));
        rerender(scope, null, created.id);
        return;
      }
      var quick = button.getAttribute('data-quick');
      if (quick) { quickStart(quick); rerender(scope); return; }

      var act = button.getAttribute('data-act');
      if (act) {
        var card = button.closest('[data-step]');
        var id = card && card.getAttribute('data-step');
        if (!id) return;
        if (act === 'up' || act === 'down') { move(id, act === 'up' ? -1 : 1); rerender(scope, null, id); }
        if (act === 'remove') {
          var step = find(id);
          var kids = step && step.step_type === 'repeat' ? R.childrenOf(state.steps, id).length : 0;
          if (kids && !window.confirm('Remove this repeat block and the ' + kids + ' step' + (kids === 1 ? '' : 's') + ' inside it?')) return;
          remove(id);
          rerender(scope);
        }
        return;
      }

      var global = button.getAttribute('data-act-global');
      if (global === 'convert') { state.converting = true; rerender(scope); }
      if (global === 'discard') {
        if (!window.confirm('Discard unsaved changes to this run?')) return;
        reloadFromSaved();
        state.converting = false;
        rerender(scope);
      }
      if (global === 'save') save({ publish: false });
    });
  }

  // Keep the last saved steps so Discard does not need a network round trip.
  function remember() { state.savedSteps = JSON.stringify(state.steps); state.saved = serialise(state.steps); }
  function reloadFromSaved() {
    state.steps = JSON.parse(state.savedSteps || '[]');
    state.saved = serialise(state.steps);
  }

  function rerender(scope, focusInput, focusStepId) {
    var body = scope.querySelector('#rb') ? scope.querySelector('#rb').parentElement : null;
    if (!body) return;
    var key = focusInput && focusInput.getAttribute('data-k');
    var stepId = focusStepId || (focusInput && focusInput.closest('[data-step]') && focusInput.closest('[data-step]').getAttribute('data-step'));
    body.innerHTML = html();
    bind(body);
    refresh(body);
    if (stepId) {
      var card = body.querySelector('[data-step="' + cssEscape(stepId) + '"]');
      var target = card && (key ? card.querySelector('[data-k="' + key + '"]') : card.querySelector('select, input'));
      if (target) { try { target.focus({ preventScroll: !focusStepId }); } catch (e) { target.focus(); } }
      if (card && focusStepId && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
    }
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  // ── Save / publish ──────────────────────────────────────────────────────

  async function save(options) {
    var opts = options || {};
    var rep = report();
    var body = document.querySelector('#rb');
    if (!rep.valid) {
      refresh(body ? body.parentElement : document);
      toast(rep.errors.length === 1 ? rep.errors[0].message : 'Fix the ' + rep.errors.length + ' highlighted issues before saving.', 'bad');
      return false;
    }
    var publishing = opts.publish === true && !isPublished();
    var code = state.session.athlete_code;
    if (isLegacy() && (isPublished() || publishing)) {
      if (!window.confirm('Publish the structured version of “' + (state.session.title || 'this run') + '” to ' + code + '?\n\n' +
        state.steps.length + ' step' + (state.steps.length === 1 ? '' : 's') + ', ' + rep.expandedSteps + ' on the watch once repeats are expanded.\n' +
        'The text prescription fields stay stored and unchanged.')) return false;
    } else if (publishing) {
      if (!window.confirm('Publish this run to ' + code + '?\n\nThey can then review it in the portal and tap Send to Garmin.')) return false;
    }

    state.saving = true;
    refresh(body ? body.parentElement : document);
    try {
      var result = await state.ctx.apiPost({
        action: 'runsteps_save',
        session_id: state.sessionId,
        steps: state.steps,
        publish: opts.publish === true,
      });
      state.session.publish_state = result.publish_state || state.session.publish_state;
      state.session.prescription_mode = result.prescription_mode || state.session.prescription_mode;
      state.steps = (result.runSteps || []).map(R.fromRow);
      remember();
      state.converting = false;
        if (state.garmin && state.garmin.delivery === 'sent') state.garmin.changedSince = true;
      var message = state.session.publish_state === 'published'
        ? (state.garmin && state.garmin.delivery === 'sent'
          ? 'Saved and live. The athlete must send it to Garmin again to update their watch.'
          : 'Saved and live in the portal')
        : 'Saved as a draft — hidden from the athlete';
      toast(message, 'ok');
      if (state.ctx.onSaved) state.ctx.onSaved(result);
      return true;
    } catch (error) {
      toast(error.message || 'Could not save the run', 'bad');
      return false;
    } finally {
      state.saving = false;
      var current = document.querySelector('#rb');
      if (current) rerender(current.parentElement);
    }
  }

  // Footer publish toggle for run sessions.
  async function togglePublish() {
    if (!state.session) return;
    if (isPublished()) {
      if (isDirty() && !window.confirm('You have unsaved step changes. Moving to draft keeps the last saved version. Continue?')) return;
      if (!window.confirm('Move “' + (state.session.title || 'this run') + '” to draft?\n\nIt disappears from the athlete’s portal. A workout they already sent stays in Garmin Connect until they delete it there.')) return;
      return publishState('draft');
    }
    // Draft → published. Unsaved edits are saved and published together, in
    // one transaction, so the athlete never sees the old steps flash live.
    if (isDirty() || (isLegacy() && state.steps.length)) return save({ publish: true });
    var rep = report();
    if (!rep.valid) { var b = document.querySelector('#rb'); refresh(b ? b.parentElement : document); toast('Fix the highlighted issues before publishing.', 'bad'); return; }
    if (!window.confirm('Publish this run to ' + state.session.athlete_code + '?\n\nThey can then review it in the portal and tap Send to Garmin.')) return;
    return publishState('published');
  }

  async function publishState(next) {
    try {
      await state.ctx.apiPost({ action: 'session_publish', session_ids: [state.sessionId], publish_state: next });
      state.session.publish_state = next;
      toast(next === 'published' ? 'Published — the athlete can review it and send it to Garmin' : 'Moved to draft — hidden from the athlete', 'ok');
      if (state.ctx.onSaved) state.ctx.onSaved({ publish_state: next });
      var current = document.querySelector('#rb');
      if (current) rerender(current.parentElement);
    } catch (error) {
      toast(error.message || 'Could not change publish state', 'bad');
    }
  }

  function toast(message, tone) { if (state.ctx && state.ctx.toast) state.ctx.toast(message, tone); }

  // ── Athlete preview ─────────────────────────────────────────────────────
  // Only athlete-facing fields: coach_notes is never read here.
  function athletePreviewHtml() {
    if (!state.steps.length) {
      return '<div class="rxp-empty">No structured steps. The athlete sees the text prescription, and the portal cannot send this run to Garmin.</div>';
    }
    var rep = report();
    return (isDirty() ? '<div class="rb-banner">Showing unsaved changes. The athlete still has the last saved version.</div>' : '') +
      '<div class="rb-preview-head"><span>What the athlete reviews before Send to Garmin</span><span class="rb-meter">' + rep.expandedSteps + ' Garmin steps</span></div>' +
      (R.summary(rep) ? '<div class="rb-total">' + esc(R.summary(rep)) + '</div>' : '') +
      previewTreeHtml(R.tree(state.steps));
  }

  window.DPRunBuilder = {
    load: load,
    reset: reset,
    html: html,
    bind: bind,
    refresh: refresh,
    isDirty: isDirty,
    togglePublish: togglePublish,
    save: save,
    athletePreviewHtml: athletePreviewHtml,
    // Test hooks.
    _state: state,
  };
})();
