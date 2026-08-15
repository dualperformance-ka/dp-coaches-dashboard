/* Dual Performance — coach prescription builder.
 *
 * Self-contained. index.html gains two tags (a stylesheet and this script) and
 * nothing else: the entry point is injected into the existing Plan Session
 * modal at runtime, so none of the 10,900 lines of inline dashboard code had to
 * be touched to add this.
 *
 * What it edits is planned_sessions -> session_exercises / run_steps, through
 * /api/athletes actions. Authorisation, edit-scope resolution and the audit
 * trail all happen server-side; this file is a view.
 */
(function () {
  'use strict';

  var SCOPE_LABELS = {
    session: 'This session only',
    future: 'This and future',
    block: 'Whole block',
  };

  var state = {
    sessionId: null,
    session: null,
    exercises: [],
    runSteps: [],
    legacySplit: null,
    scope: 'session',      // §18: the safe default, always
    preview: false,
    dirty: false,
    saving: 0,
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(id) { return document.getElementById(id); }

  // ── API ────────────────────────────────────────────────────────────────────
  // window.fetch is wrapped by coach-auth.js and already carries the dashboard
  // key and coach name on every /api/ request.

  async function apiGet(params) {
    var query = Object.keys(params)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    var response = await fetch('/api/athletes?' + query, { cache: 'no-store' });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }

  async function apiPost(payload) {
    // maPost is defined by the dashboard's inline script and already handles the
    // access key, the 401 re-gate and error shaping.
    if (typeof maPost === 'function') return maPost(payload);
    throw new Error('Dashboard session is not ready');
  }

  function busy(on) {
    state.saving += on ? 1 : -1;
    if (state.saving < 0) state.saving = 0;
    var pill = el('rx-save-state');
    if (!pill) return;
    pill.textContent = state.saving ? 'Saving…' : 'Saved';
    pill.className = 'rx-save-state' + (state.saving ? ' is-saving' : '');
  }

  function toast(message, tone) {
    var box = el('rx-toast');
    if (!box) return;
    box.textContent = message;
    box.className = 'rx-toast is-visible' + (tone ? ' is-' + tone : '');
    clearTimeout(box._timer);
    box._timer = setTimeout(function () { box.className = 'rx-toast'; }, 4200);
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  function ensureShell() {
    if (el('rx-overlay')) return;
    var html =
      '<div class="rx-overlay hidden" id="rx-overlay" role="dialog" aria-modal="true" aria-labelledby="rx-title">' +
        '<div class="rx-panel">' +
          '<header class="rx-head">' +
            '<div class="rx-head-main">' +
              '<span class="rx-coach-pill" id="rx-coach-pill">Coach Mode</span>' +
              '<div class="rx-title-block">' +
                '<div class="rx-title" id="rx-title">Session</div>' +
                '<div class="rx-sub" id="rx-sub"></div>' +
              '</div>' +
            '</div>' +
            '<div class="rx-head-actions">' +
              '<span class="rx-save-state" id="rx-save-state">Saved</span>' +
              '<button type="button" class="rx-btn" id="rx-preview-btn">Preview as athlete</button>' +
              '<button type="button" class="rx-btn rx-btn-quiet" id="rx-close-btn">Close</button>' +
            '</div>' +
          '</header>' +
          '<div class="rx-scopebar" id="rx-scopebar">' +
            '<span class="rx-scope-label">Changes apply to</span>' +
            '<div class="rx-scope-options" role="radiogroup" aria-label="Edit scope"></div>' +
            '<span class="rx-scope-hint" id="rx-scope-hint"></span>' +
          '</div>' +
          '<div class="rx-body" id="rx-body"></div>' +
          '<footer class="rx-foot" id="rx-foot"></footer>' +
          '<div class="rx-toast" id="rx-toast"></div>' +
        '</div>' +
      '</div>' +
      '<div class="rx-picker hidden" id="rx-picker" role="dialog" aria-modal="true" aria-labelledby="rx-picker-title">' +
        '<div class="rx-picker-card">' +
          '<div class="rx-picker-head">' +
            '<div class="rx-picker-title" id="rx-picker-title">Exercise library</div>' +
            '<button type="button" class="rx-x" id="rx-picker-cancel" aria-label="Close">&times;</button>' +
          '</div>' +
          '<input type="search" id="rx-picker-search" class="rx-input rx-picker-search" placeholder="Filter by name (optional)" autocomplete="off">' +
          '<div class="rx-picker-panes">' +
            '<div class="rx-picker-cats" id="rx-picker-cats" role="tablist" aria-label="Muscle group"></div>' +
            '<div class="rx-picker-results" id="rx-picker-results" role="tabpanel"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="rx-picker hidden" id="rx-saveas" role="dialog" aria-modal="true" aria-labelledby="rx-saveas-title">' +
        '<div class="rx-picker-card rx-saveas-card">' +
          '<div class="rx-picker-head">' +
            '<div class="rx-picker-title" id="rx-saveas-title">Save as split</div>' +
            '<button type="button" class="rx-x" id="rx-saveas-cancel" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="rx-saveas-body">' +
            '<label class="rx-lbl" for="rx-saveas-name">Split name</label>' +
            '<input type="text" id="rx-saveas-name" class="rx-input" placeholder="e.g. Lower C" autocomplete="off">' +
            '<label class="rx-lbl" for="rx-saveas-code">Athlete code <span>blank = all athletes</span></label>' +
            '<input type="text" id="rx-saveas-code" class="rx-input" placeholder="e.g. KHANG" autocomplete="off">' +
            '<p class="rx-saveas-hint" id="rx-saveas-hint"></p>' +
          '</div>' +
          '<div class="rx-picker-foot">' +
            '<button type="button" class="rx-btn rx-btn-primary" id="rx-saveas-go">Save split</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.insertAdjacentHTML('beforeend', html);

    el('rx-close-btn').addEventListener('click', close);
    el('rx-preview-btn').addEventListener('click', togglePreview);
    el('rx-picker-cancel').addEventListener('click', closePicker);
    el('rx-saveas-cancel').addEventListener('click', closeSaveAs);
    el('rx-saveas-go').addEventListener('click', saveAsSplit);
    el('rx-picker-search').addEventListener('input', debounce(runPickerSearch, 180));
    el('rx-overlay').addEventListener('click', function (event) {
      if (event.target === el('rx-overlay')) close();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!el('rx-saveas').classList.contains('hidden')) return closeSaveAs();
      if (!el('rx-picker').classList.contains('hidden')) return closePicker();
      if (!el('rx-overlay').classList.contains('hidden')) close();
    });
    renderScopeBar();
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function renderScopeBar() {
    var wrap = document.querySelector('#rx-scopebar .rx-scope-options');
    if (!wrap) return;
    wrap.innerHTML = Object.keys(SCOPE_LABELS).map(function (key) {
      return '<button type="button" role="radio" aria-checked="' + (state.scope === key) + '" ' +
        'class="rx-scope-opt' + (state.scope === key ? ' is-active' : '') + '" data-scope="' + key + '">' +
        esc(SCOPE_LABELS[key]) + '</button>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('.rx-scope-opt'), function (button) {
      button.addEventListener('click', function () {
        state.scope = button.getAttribute('data-scope');
        renderScopeBar();
        var hint = el('rx-scope-hint');
        if (hint) {
          hint.textContent = state.scope === 'session'
            ? ''
            : 'Completed sessions are never changed.';
        }
      });
    });
  }

  // ── Open / close ───────────────────────────────────────────────────────────

  async function open(sessionId) {
    ensureShell();
    state.sessionId = sessionId;
    state.scope = 'session';
    state.preview = false;
    renderScopeBar();
    el('rx-overlay').classList.remove('hidden');
    el('rx-body').innerHTML = '<div class="rx-loading">Loading prescription…</div>';
    el('rx-foot').innerHTML = '';
    try {
      await load();
    } catch (error) {
      el('rx-body').innerHTML = '<div class="rx-error">' + esc(error.message || 'Could not load this session') + '</div>';
    }
  }

  async function load() {
    var data = await apiGet({ action: 'prescription', session_id: state.sessionId });
    state.session = data.session;
    state.exercises = data.exercises || [];
    state.runSteps = data.runSteps || [];
    state.legacySplit = data.legacySplit || null;
    render();
  }

  function close() {
    var overlay = el('rx-overlay');
    if (overlay) overlay.classList.add('hidden');
    state.sessionId = null;
    // The planner behind this drawer is showing pre-edit data.
    if (typeof window.renderPlanGrid === 'function') {
      try { window.renderPlanGrid(); } catch (e) {}
    }
  }

  function togglePreview() {
    state.preview = !state.preview;
    el('rx-preview-btn').textContent = state.preview ? 'Exit athlete preview' : 'Preview as athlete';
    el('rx-overlay').classList.toggle('is-preview', state.preview);
    render();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function isRunSession(session) {
    var type = String((session && session.session_type) || '').toLowerCase();
    if (state.runSteps.length) return true;
    if (state.exercises.length) return false;
    return !/strength/.test(type) && !/upper|lower|glute|push|pull/i.test(String(session && session.title) || '');
  }

  function render() {
    var session = state.session;
    if (!session) return;

    el('rx-title').textContent = session.title || 'Session';
    el('rx-sub').textContent = [
      session.athlete_code,
      session.planned_date,
      session.week_label,
      session.prescription_mode === 'structured' ? 'Structured' : 'Shared split',
    ].filter(Boolean).join(' · ');

    // §31/§54: in preview the coach chrome disappears entirely, so what is on
    // screen is only what the athlete would see.
    el('rx-scopebar').style.display = state.preview ? 'none' : '';
    el('rx-coach-pill').style.display = state.preview ? 'none' : '';

    el('rx-body').innerHTML = state.preview
      ? renderAthletePreview()
      : (isRunSession(session) ? renderRunBuilder() : renderStrengthBuilder());

    el('rx-foot').innerHTML = state.preview ? '' : renderFooter();

    if (!state.preview) bindBuilder();
  }

  function renderFooter() {
    var session = state.session;
    var draft = session.publish_state === 'draft';
    return '' +
      '<div class="rx-foot-left">' +
        '<span class="rx-badge' + (draft ? ' is-draft' : ' is-live') + '">' +
          (draft ? 'Draft — hidden from athlete' : 'Published — visible to athlete') +
        '</span>' +
      '</div>' +
      '<div class="rx-foot-right">' +
        (state.exercises.length
          ? '<button type="button" class="rx-btn" id="rx-saveas-btn">Save as split</button>'
          : '') +
        '<button type="button" class="rx-btn" id="rx-publish-btn">' +
          (draft ? 'Publish to athlete' : 'Move to draft') +
        '</button>' +
      '</div>';
  }

  function repRangeText(ex) {
    if (ex.rep_min == null && ex.rep_max == null) return '';
    if (ex.rep_max != null && ex.rep_min != null && ex.rep_max !== ex.rep_min) return ex.rep_min + '-' + ex.rep_max;
    return String(ex.rep_min == null ? ex.rep_max : ex.rep_min);
  }

  function renderStrengthBuilder() {
    var session = state.session;

    if (session.prescription_mode !== 'structured') {
      var split = state.legacySplit;
      return '' +
        '<div class="rx-adopt">' +
          '<div class="rx-adopt-title">This session still uses a shared split</div>' +
          '<p class="rx-adopt-body">' +
            (split
              ? 'It currently resolves to <strong>' + esc(split.name) + '</strong> (' + (split.exercises || []).length + ' exercises), which is shared with every athlete training a session of that name. Editing it here would change their training too.'
              : 'No shared split matches this session title, so the athlete currently sees no exercises.') +
          '</p>' +
          '<p class="rx-adopt-body">' +
            'Taking control copies the prescription onto this session only. ' +
            '<strong>' + esc(session.athlete_code) + '</strong> keeps exactly what they have now, and future edits reach nobody else.' +
          '</p>' +
          '<button type="button" class="rx-btn rx-btn-primary" id="rx-adopt-btn">' +
            (split ? 'Take control of this session' : 'Start a prescription') +
          '</button>' +
        '</div>';
    }

    if (!state.exercises.length) {
      return '<div class="rx-empty">No exercises yet.' +
        '<button type="button" class="rx-btn rx-btn-primary" id="rx-add-btn">+ Add exercise</button></div>';
    }

    var rows = state.exercises.map(function (ex, index) {
      var group = ex.superset_group
        ? '<span class="rx-group">' + esc(ex.superset_group) + (indexInGroup(ex) + 1) + '</span>'
        : '';
      return '' +
        '<div class="rx-ex" data-id="' + esc(ex.id) + '">' +
          '<div class="rx-ex-head">' +
            group +
            '<input class="rx-ex-name rx-input" value="' + esc(ex.exercise_name) + '" data-pick="1" readonly ' +
              'aria-label="Exercise name — click to choose from the library" ' +
              'title="Click to choose from the exercise library">' +
            '<div class="rx-ex-tools">' +
              '<button type="button" class="rx-icon" data-act="up" title="Move up" aria-label="Move up">↑</button>' +
              '<button type="button" class="rx-icon" data-act="down" title="Move down" aria-label="Move down">↓</button>' +
              '<button type="button" class="rx-icon" data-act="superset" title="Group into a superset" aria-label="Group into a superset">⛓</button>' +
              '<button type="button" class="rx-icon" data-act="replace" title="Replace exercise" aria-label="Replace exercise">⇄</button>' +
              '<button type="button" class="rx-icon rx-icon-danger" data-act="remove" title="Remove" aria-label="Remove exercise">×</button>' +
            '</div>' +
          '</div>' +
          '<div class="rx-ex-grid">' +
            field('Sets', 'sets', ex.sets, index) +
            field('Warm-up', 'warmup_sets', ex.warmup_sets, index) +
            field('Reps', 'rep_min', ex.rep_min, index) +
            field('to', 'rep_max', ex.rep_max, index) +
            field('RPE', 'rpe', ex.rpe, index) +
            field('RIR', 'rir', ex.rir, index) +
            field('Rest (s)', 'rest_seconds', ex.rest_seconds, index) +
            textField('Tempo', 'tempo', ex.tempo) +
          '</div>' +
          '<details class="rx-adv"' + (ex.coach_notes || ex.athlete_notes || ex.progression_rule ? ' open' : '') + '>' +
            '<summary>Notes, progression and alternatives</summary>' +
            '<label class="rx-lbl rx-lbl-athlete">Athlete note <span>the athlete sees this</span></label>' +
            '<textarea class="rx-input rx-ta" data-field="athlete_notes" rows="2">' + esc(ex.athlete_notes || '') + '</textarea>' +
            '<label class="rx-lbl rx-lbl-coach">Coach note <span>never shown to the athlete</span></label>' +
            '<textarea class="rx-input rx-ta rx-ta-coach" data-field="coach_notes" rows="2">' + esc(ex.coach_notes || '') + '</textarea>' +
            '<label class="rx-lbl">Progression rule</label>' +
            '<textarea class="rx-input rx-ta" data-field="progression_rule" rows="2">' + esc(ex.progression_rule || '') + '</textarea>' +
          '</details>' +
        '</div>';
    }).join('');

    return '<div class="rx-ex-list">' + rows + '</div>' +
      '<button type="button" class="rx-btn rx-btn-primary rx-add" id="rx-add-btn">+ Add exercise</button>';
  }

  function indexInGroup(ex) {
    return state.exercises
      .filter(function (row) { return row.superset_group === ex.superset_group; })
      .findIndex(function (row) { return row.id === ex.id; });
  }

  function field(label, name, value, index) {
    return '<label class="rx-f"><span>' + esc(label) + '</span>' +
      '<input class="rx-input rx-num" type="number" step="any" data-field="' + name + '" ' +
      'value="' + (value == null ? '' : esc(value)) + '" aria-label="' + esc(label) + ' for exercise ' + (index + 1) + '"></label>';
  }

  function textField(label, name, value) {
    return '<label class="rx-f"><span>' + esc(label) + '</span>' +
      '<input class="rx-input" type="text" data-field="' + name + '" value="' + esc(value || '') + '"></label>';
  }

  // ── Athlete preview (§31) ──────────────────────────────────────────────────
  // Rendered from the same fields the portal receives. coach_notes is not
  // referenced anywhere in this function, by design.

  function renderAthletePreview() {
    var session = state.session;
    var head = '<div class="rxp-head"><div class="rxp-day">' + esc(session.planned_date || '') + '</div>' +
      '<div class="rxp-title">' + esc(session.title || 'Session') + '</div>' +
      (session.estimated_minutes ? '<div class="rxp-meta">Estimated ' + esc(session.estimated_minutes) + ' min</div>' : '') +
      '</div>';

    if (state.runSteps.length) {
      var parents = state.runSteps.filter(function (s) { return !s.parent_step_id; });
      return head + '<div class="rxp-steps">' + parents.map(function (step) {
        var children = state.runSteps.filter(function (c) { return c.parent_step_id === step.id; });
        return '<div class="rxp-step">' + '<div class="rxp-step-type">' + esc(stepLabel(step)) + '</div>' +
          (children.length
            ? '<div class="rxp-children">' + children.map(function (c) {
                return '<div class="rxp-child">' + esc(stepLabel(c)) + '</div>';
              }).join('') + '</div>'
            : '') +
        '</div>';
      }).join('') + '</div>';
    }

    if (!state.exercises.length) {
      return head + '<div class="rxp-empty">The athlete would see no exercises for this session.</div>';
    }

    return head + '<div class="rxp-list">' + state.exercises.map(function (ex) {
      var sets = ex.working_sets || ex.sets;
      var rx = [
        sets ? sets + ' × ' + (repRangeText(ex) || '—') : '',
        ex.rpe != null ? 'RPE ' + ex.rpe : '',
        ex.rir != null ? 'RIR ' + ex.rir : '',
        ex.tempo ? 'Tempo ' + ex.tempo : '',
        ex.rest_seconds ? 'Rest ' + ex.rest_seconds + 's' : '',
      ].filter(Boolean).join(' · ');
      return '<div class="rxp-ex">' +
        '<div class="rxp-ex-name">' +
          (ex.superset_group ? '<span class="rxp-group">' + esc(ex.superset_group) + (indexInGroup(ex) + 1) + '</span>' : '') +
          esc(ex.exercise_name) +
        '</div>' +
        '<div class="rxp-ex-rx">' + esc(rx) + '</div>' +
        (ex.athlete_notes ? '<div class="rxp-ex-note">' + esc(ex.athlete_notes) + '</div>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  function stepLabel(step) {
    if (step.step_type === 'repeat') return 'Repeat × ' + step.repeat_count;
    var amount = step.distance_km != null
      ? step.distance_km + ' km'
      : (step.duration_sec != null ? Math.round(step.duration_sec / 60) + ' min' : '');
    var pace = step.pace_min && step.pace_max
      ? step.pace_min + '–' + step.pace_max + '/km'
      : (step.pace_min || step.effort || (step.rpe != null ? 'RPE ' + step.rpe : '') || '');
    return [titleCase(step.step_type), amount, pace].filter(Boolean).join(' · ');
  }

  function titleCase(value) {
    var text = String(value || '').replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // ── Run builder (§23–25) ───────────────────────────────────────────────────

  function renderRunBuilder() {
    var steps = state.runSteps.length ? state.runSteps : [];
    var parents = steps.filter(function (s) { return !s.parent_step_id; });

    var rows = parents.map(function (step) {
      var children = steps.filter(function (c) { return c.parent_step_id === step.id; });
      return renderStepRow(step, false) +
        (step.step_type === 'repeat'
          ? '<div class="rx-step-children" data-parent="' + esc(step.id) + '">' +
              children.map(function (child) { return renderStepRow(child, true); }).join('') +
              '<button type="button" class="rx-btn rx-btn-tiny" data-act="add-child" data-parent="' + esc(step.id) + '">+ Step inside repeat</button>' +
            '</div>'
          : '');
    }).join('');

    return '<div class="rx-steps" id="rx-steps">' + (rows || '<div class="rx-empty">No structured steps yet.</div>') + '</div>' +
      '<div class="rx-step-add">' +
        '<button type="button" class="rx-btn" data-act="add-step" data-type="warmup">+ Warm-up</button>' +
        '<button type="button" class="rx-btn" data-act="add-step" data-type="run">+ Run</button>' +
        '<button type="button" class="rx-btn" data-act="add-step" data-type="interval">+ Interval</button>' +
        '<button type="button" class="rx-btn" data-act="add-step" data-type="recovery">+ Recovery</button>' +
        '<button type="button" class="rx-btn" data-act="add-step" data-type="repeat">+ Repeat block</button>' +
        '<button type="button" class="rx-btn" data-act="add-step" data-type="cooldown">+ Cool-down</button>' +
      '</div>' +
      '<button type="button" class="rx-btn rx-btn-primary rx-add" id="rx-steps-save">Save run structure</button>';
  }

  function renderStepRow(step, isChild) {
    return '<div class="rx-step' + (isChild ? ' is-child' : '') + '" data-step="' + esc(step.id) + '">' +
      '<span class="rx-step-type">' + esc(titleCase(step.step_type)) + '</span>' +
      (step.step_type === 'repeat'
        ? '<label class="rx-f"><span>Times</span><input class="rx-input rx-num" type="number" min="1" data-step-field="repeat_count" value="' + esc(step.repeat_count || 1) + '"></label>'
        : '<label class="rx-f"><span>km</span><input class="rx-input rx-num" type="number" step="any" data-step-field="distance_km" value="' + (step.distance_km == null ? '' : esc(step.distance_km)) + '"></label>' +
          '<label class="rx-f"><span>min</span><input class="rx-input rx-num" type="number" step="any" data-step-field="duration_min" value="' + (step.duration_sec == null ? '' : esc(Math.round(step.duration_sec / 60))) + '"></label>' +
          '<label class="rx-f"><span>Pace from</span><input class="rx-input rx-num" type="text" data-step-field="pace_min" value="' + esc(step.pace_min || '') + '" placeholder="4:10"></label>' +
          '<label class="rx-f"><span>to</span><input class="rx-input rx-num" type="text" data-step-field="pace_max" value="' + esc(step.pace_max || '') + '" placeholder="4:20"></label>' +
          '<label class="rx-f"><span>Effort</span><input class="rx-input" type="text" data-step-field="effort" value="' + esc(step.effort || '') + '" placeholder="easy"></label>') +
      '<button type="button" class="rx-icon rx-icon-danger" data-act="remove-step" title="Remove step" aria-label="Remove step">×</button>' +
    '</div>';
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  function bindBuilder() {
    var adopt = el('rx-adopt-btn');
    if (adopt) adopt.addEventListener('click', adoptSession);

    var add = el('rx-add-btn');
    if (add) add.addEventListener('click', function () { openPicker('add', null); });

    var publish = el('rx-publish-btn');
    if (publish) publish.addEventListener('click', togglePublish);

    var saveAs = el('rx-saveas-btn');
    if (saveAs) saveAs.addEventListener('click', openSaveAs);

    var save = el('rx-steps-save');
    if (save) save.addEventListener('click', saveSteps);

    Array.prototype.forEach.call(document.querySelectorAll('#rx-body .rx-ex'), function (row) {
      var id = row.getAttribute('data-id');
      Array.prototype.forEach.call(row.querySelectorAll('[data-field]'), function (input) {
        input.addEventListener('change', function () { saveField(id, input); });
      });
      // The name is chosen, never typed: clicking it opens the library at the
      // exercise's own muscle group, which is almost always where the coach
      // wants to swap within.
      var nameInput = row.querySelector('[data-pick]');
      if (nameInput) {
        nameInput.addEventListener('click', function () { openPicker('replace', id); });
        // Keyboard equivalent. Deliberately NOT bound to focus: choose() puts
        // focus back on the field, which would immediately reopen the picker.
        nameInput.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPicker('replace', id);
          }
        });
      }
      Array.prototype.forEach.call(row.querySelectorAll('[data-act]'), function (button) {
        button.addEventListener('click', function () { exerciseAction(id, button.getAttribute('data-act')); });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('#rx-body [data-act="add-step"]'), function (button) {
      button.addEventListener('click', function () { addStep(button.getAttribute('data-type'), null); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#rx-body [data-act="add-child"]'), function (button) {
      button.addEventListener('click', function () { addStep('interval', button.getAttribute('data-parent')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#rx-body [data-act="remove-step"]'), function (button) {
      button.addEventListener('click', function () {
        var row = button.closest('.rx-step');
        var id = row && row.getAttribute('data-step');
        state.runSteps = state.runSteps.filter(function (s) { return s.id !== id && s.parent_step_id !== id; });
        render();
      });
    });
  }

  async function adoptSession() {
    var button = el('rx-adopt-btn');
    if (button) { button.disabled = true; button.textContent = 'Taking control…'; }
    try {
      var result = await apiPost({ action: 'session_materialise', session_id: state.sessionId });
      toast(result.source
        ? 'Copied ' + result.created + ' exercises from "' + result.source + '" onto this session'
        : 'Started a blank prescription', 'ok');
      await load();
    } catch (error) {
      toast(error.message || 'Could not take control of this session', 'bad');
      if (button) { button.disabled = false; button.textContent = 'Take control of this session'; }
    }
  }

  function valueOf(input) {
    var raw = input.value;
    if (input.type === 'number') return raw === '' ? null : Number(raw);
    return raw;
  }

  async function saveField(id, input) {
    var fields = {};
    fields[input.getAttribute('data-field')] = valueOf(input);
    busy(true);
    try {
      var result = await apiPost({
        action: 'exercise_update',
        exercise_id: id,
        scope: state.scope,
        fields: fields,
      });
      if (result.note) toast(result.note, 'warn');
      else if (result.appliedScope !== 'session') {
        toast('Applied to ' + result.touched.length + ' session' + (result.touched.length === 1 ? '' : 's'), 'ok');
      }
      var local = state.exercises.find(function (row) { return row.id === id; });
      if (local) local[input.getAttribute('data-field')] = valueOf(input);
    } catch (error) {
      toast(error.message || 'Save failed', 'bad');
      await load();
    } finally {
      busy(false);
    }
  }

  async function exerciseAction(id, action) {
    var index = state.exercises.findIndex(function (row) { return row.id === id; });
    if (index < 0) return;

    if (action === 'up' || action === 'down') {
      var target = action === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= state.exercises.length) return;
      var moved = state.exercises.slice();
      var tmp = moved[index]; moved[index] = moved[target]; moved[target] = tmp;
      state.exercises = moved;
      render();
      busy(true);
      try {
        await apiPost({
          action: 'exercise_reorder',
          session_id: state.sessionId,
          order: moved.map(function (row) { return { id: row.id, superset_group: row.superset_group }; }),
        });
      } catch (error) {
        toast(error.message || 'Reorder failed', 'bad');
        await load();
      } finally { busy(false); }
      return;
    }

    if (action === 'superset') {
      // Group with the exercise above. Two rows sharing a letter render as A1/A2.
      if (index === 0) return toast('Group an exercise with the one above it', 'warn');
      var previous = state.exercises[index - 1];
      var letter = previous.superset_group || nextGroupLetter();
      previous.superset_group = letter;
      state.exercises[index].superset_group = letter;
      render();
      busy(true);
      try {
        await apiPost({
          action: 'exercise_reorder',
          session_id: state.sessionId,
          order: state.exercises.map(function (row) { return { id: row.id, superset_group: row.superset_group }; }),
        });
        toast('Grouped as superset ' + letter, 'ok');
      } catch (error) {
        toast(error.message || 'Grouping failed', 'bad');
        await load();
      } finally { busy(false); }
      return;
    }

    if (action === 'replace') return openPicker('replace', id);

    if (action === 'remove') {
      var name = state.exercises[index].exercise_name;
      var scopeNote = state.scope === 'session'
        ? 'This session only.'
        : 'This will remove it from ' + SCOPE_LABELS[state.scope].toLowerCase() + '. Completed sessions are not affected.';
      if (!confirm('Remove ' + name + '?\n\n' + scopeNote)) return;
      busy(true);
      try {
        var result = await apiPost({ action: 'exercise_remove', exercise_id: id, scope: state.scope });
        if (result.note) toast(result.note, 'warn');
        await load();
      } catch (error) {
        toast(error.message || 'Remove failed', 'bad');
      } finally { busy(false); }
    }
  }

  function nextGroupLetter() {
    var used = {};
    state.exercises.forEach(function (row) { if (row.superset_group) used[row.superset_group] = true; });
    for (var i = 0; i < 26; i += 1) {
      var letter = String.fromCharCode(65 + i);
      if (!used[letter]) return letter;
    }
    return 'A';
  }

  async function togglePublish() {
    var next = state.session.publish_state === 'draft' ? 'published' : 'draft';
    busy(true);
    try {
      await apiPost({
        action: 'session_publish',
        session_ids: [state.sessionId],
        publish_state: next,
      });
      state.session.publish_state = next;
      toast(next === 'published' ? 'Published — the athlete can see this now' : 'Moved to draft — hidden from the athlete', 'ok');
      render();
    } catch (error) {
      toast(error.message || 'Could not change publish state', 'bad');
    } finally { busy(false); }
  }

  // ── Run steps ──────────────────────────────────────────────────────────────

  function addStep(type, parentId) {
    var tempId = 'tmp-' + Math.random().toString(36).slice(2, 10);
    state.runSteps.push({
      id: tempId,
      parent_step_id: parentId,
      step_order: state.runSteps.length,
      step_type: type,
      repeat_count: type === 'repeat' ? 5 : null,
      distance_km: null, duration_sec: null,
      pace_min: '', pace_max: '', effort: '', rpe: null,
    });
    render();
  }

  function collectSteps() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('#rx-body .rx-step'), function (row) {
      var id = row.getAttribute('data-step');
      var source = state.runSteps.find(function (s) { return s.id === id; });
      if (!source) return;
      var read = function (name) {
        var input = row.querySelector('[data-step-field="' + name + '"]');
        return input ? input.value : '';
      };
      var minutes = read('duration_min');
      out.push({
        ref: id,
        parentRef: source.parent_step_id || null,
        type: source.step_type,
        repeat: read('repeat_count'),
        distanceKm: read('distance_km'),
        durationSec: minutes === '' ? null : Math.round(Number(minutes) * 60),
        intensityType: read('pace_min') ? 'pace_range' : (read('effort') ? 'effort' : null),
        paceMin: read('pace_min'),
        paceMax: read('pace_max'),
        effort: read('effort'),
      });
    });
    return out;
  }

  async function saveSteps() {
    busy(true);
    try {
      await apiPost({ action: 'runsteps_save', session_id: state.sessionId, steps: collectSteps() });
      toast('Run structure saved', 'ok');
      await load();
    } catch (error) {
      toast(error.message || 'Could not save the run structure', 'bad');
    } finally { busy(false); }
  }

  // ── Save as split (§39) ────────────────────────────────────────────────────
  // Shape a session on one athlete, then promote it to a reusable split.

  function openSaveAs() {
    el('rx-saveas').classList.remove('hidden');
    var name = el('rx-saveas-name');
    var code = el('rx-saveas-code');
    // Default to the session's own title and no athlete code: the common case
    // is promoting a session to a shared split under the name it already has.
    name.value = (state.session && state.session.title) || '';
    code.value = '';
    updateSaveAsHint();
    code.oninput = updateSaveAsHint;
    setTimeout(function () { name.focus(); name.select(); }, 40);
  }

  function closeSaveAs() { el('rx-saveas').classList.add('hidden'); }

  // Say plainly who this will reach, because "blank = all athletes" is the one
  // field here that can quietly change everyone's training.
  function updateSaveAsHint() {
    var hint = el('rx-saveas-hint');
    if (!hint) return;
    var code = el('rx-saveas-code').value.trim().toUpperCase();
    var count = state.exercises.length;
    hint.textContent = code
      ? count + ' exercises, available to ' + code + ' only.'
      : count + ' exercises, available to every athlete.';
    hint.className = 'rx-saveas-hint' + (code ? '' : ' is-broad');
  }

  async function saveAsSplit() {
    var button = el('rx-saveas-go');
    var name = el('rx-saveas-name').value.trim();
    if (!name) return toast('Give the split a name', 'warn');

    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      var result = await apiPost({
        action: 'split_save_from_session',
        session_id: state.sessionId,
        name: name,
        athlete_code: el('rx-saveas-code').value.trim() || null,
      });
      closeSaveAs();
      toast('Saved "' + name + '" — ' + result.exercises + ' exercises, ' + result.scope, 'ok');
    } catch (error) {
      toast(error.message || 'Could not save the split', 'bad');
    } finally {
      button.disabled = false;
      button.textContent = 'Save split';
    }
  }

  // ── Exercise picker (§16) ──────────────────────────────────────────────────

  var pickerMode = 'add';
  var pickerTargetId = null;
  var pickerInput = null;
  var library = { rows: [], categories: [], loaded: false };
  var activeCategory = null;

  // mode: 'add' | 'replace' | 'input'
  //   'input' writes the chosen name straight into a DOM field and is what the
  //   dashboard's own New Split editor uses — see bindLegacySplitEditor().
  async function openPicker(mode, exerciseId, inputEl) {
    if (!el('rx-picker')) ensureShell();
    pickerMode = mode;
    pickerTargetId = exerciseId;
    pickerInput = inputEl || null;

    var titleEl = el('rx-picker-title');
    if (titleEl) {
      titleEl.textContent = mode === 'replace' ? 'Replace exercise'
        : mode === 'input' ? 'Choose exercise'
        : 'Add exercise';
    }

    el('rx-picker').classList.remove('hidden');
    el('rx-picker-search').value = '';

    if (!library.loaded) {
      el('rx-picker-results').innerHTML = '<div class="rx-loading">Loading library…</div>';
      try {
        var data = await apiGet({ action: 'exercise_library' });
        library = { rows: data.results || [], categories: data.categories || [], loaded: true };
      } catch (error) {
        el('rx-picker-results').innerHTML = '<div class="rx-error">' + esc(error.message) + '</div>';
        return;
      }
    }
    // Land on the category the coach is most likely to want: the group the
    // exercise being replaced already belongs to, or the field's current value.
    var current = '';
    if (mode === 'replace') {
      var ex = state.exercises.find(function (row) { return row.id === exerciseId; });
      current = ex ? ex.exercise_name : '';
    } else if (mode === 'input' && inputEl) {
      current = inputEl.value || '';
    }
    var match = current && library.rows.find(function (row) {
      return row.name.toLowerCase() === current.toLowerCase();
    });
    activeCategory = (match && match.category) || library.categories[0] || null;
    renderPicker();
  }

  function closePicker() {
    el('rx-picker').classList.add('hidden');
    pickerTargetId = null;
    pickerInput = null;
  }

  function categoryCount(name) {
    return library.rows.filter(function (row) { return (row.category || 'General') === name; }).length;
  }

  // Browsing beats typing: a coach picks a muscle group, then an exercise. The
  // filter box is there for when they already know the name, not as the only
  // way in.
  function renderPicker() {
    var term = el('rx-picker-search').value.trim().toLowerCase();

    var cats = el('rx-picker-cats');
    cats.innerHTML = library.categories.map(function (name) {
      return '<button type="button" role="tab" aria-selected="' + (name === activeCategory && !term) + '" ' +
        'class="rx-cat' + (name === activeCategory && !term ? ' is-active' : '') + '" data-cat="' + esc(name) + '">' +
        '<span>' + esc(name) + '</span><span class="rx-cat-n">' + categoryCount(name) + '</span>' +
      '</button>';
    }).join('');
    Array.prototype.forEach.call(cats.querySelectorAll('.rx-cat'), function (button) {
      button.addEventListener('click', function () {
        activeCategory = button.getAttribute('data-cat');
        el('rx-picker-search').value = '';
        renderPicker();
      });
    });

    // A filter search spans every category; otherwise show the chosen one.
    var visible = term
      ? library.rows.filter(function (row) { return row.name.toLowerCase().indexOf(term) >= 0; })
      : library.rows.filter(function (row) { return (row.category || 'General') === activeCategory; });

    var results = el('rx-picker-results');
    if (!visible.length) {
      results.innerHTML = '<div class="rx-empty">' +
        (term
          ? 'Nothing matched “' + esc(term) + '”.<button type="button" class="rx-btn" id="rx-use-typed">Use “' + esc(term) + '” anyway</button>'
          : 'No exercises in this group yet.') +
        '</div>';
      var useTyped = el('rx-use-typed');
      if (useTyped) useTyped.addEventListener('click', function () { choose(null, el('rx-picker-search').value.trim()); });
      return;
    }

    results.innerHTML = (term ? '<div class="rx-picker-group">' + visible.length + ' matches</div>' : '') +
      visible.map(function (row) {
        var meta = [term ? row.category : null, row.equipment].filter(Boolean).join(' · ');
        return '<button type="button" class="rx-picker-row" data-id="' + esc(row.id) + '" data-name="' + esc(row.name) + '">' +
          '<span class="rx-picker-name">' + esc(row.name) + '</span>' +
          (meta ? '<span class="rx-picker-meta">' + esc(meta) + '</span>' : '') +
        '</button>';
      }).join('');

    Array.prototype.forEach.call(results.querySelectorAll('.rx-picker-row'), function (button) {
      button.addEventListener('click', function () {
        choose(button.getAttribute('data-id'), button.getAttribute('data-name'));
      });
    });
  }

  function runPickerSearch() { if (library.loaded) renderPicker(); }

  async function choose(libraryId, name) {
    // 'input' mode is a pure DOM write — no API call, because the field it
    // fills belongs to the dashboard's own editor, which saves on its own.
    if (pickerMode === 'input') {
      var target = pickerInput;
      closePicker();
      if (target) {
        target.value = name;
        // The split editor reads .value on save, but fire both events anyway so
        // anything else listening to that field stays in step.
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.focus();
      }
      return;
    }

    // Capture before closing: closePicker() clears pickerTargetId, and reading
    // it afterwards posted a null exercise id — replace failed every time.
    var mode = pickerMode;
    var targetId = pickerTargetId;
    closePicker();

    busy(true);
    try {
      var result;
      if (mode === 'replace') {
        result = await apiPost({
          action: 'exercise_replace',
          exercise_id: targetId,
          exercise_name: name,
          exercise_library_id: libraryId,
          scope: state.scope,
        });
      } else {
        result = await apiPost({
          action: 'exercise_add',
          session_id: state.sessionId,
          scope: state.scope,
          fields: { exercise_name: name, exercise_id: libraryId, sets: 3, rep_min: 8, rep_max: 12, rest_seconds: 90 },
        });
      }
      if (result.note) toast(result.note, 'warn');
      else if (result.appliedScope !== 'session') {
        toast('Applied to ' + result.touched.length + ' sessions', 'ok');
      }
      await load();
    } catch (error) {
      toast(error.message || 'Could not update the exercise', 'bad');
    } finally { busy(false); }
  }

  // Allow a free-typed exercise that is not in the library yet.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    var picker = el('rx-picker');
    if (!picker || picker.classList.contains('hidden')) return;
    if (document.activeElement !== el('rx-picker-search')) return;
    var term = el('rx-picker-search').value.trim();
    if (term) { event.preventDefault(); choose(null, term); }
  });

  // ── Entry point ────────────────────────────────────────────────────────────
  // Injected into the dashboard's existing Plan Session modal rather than
  // rebuilding it: the coach keeps the flow they already know, and gains a way
  // through to the prescription.

  function injectEntryPoint() {
    var footer = document.querySelector('#ps-overlay .po-modal-foot') ||
                 (el('ps-save') && el('ps-save').parentElement);
    if (!footer || el('rx-open-btn')) return;

    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'rx-open-btn';
    button.className = 'rx-open-btn';
    button.textContent = 'Edit prescription →';
    button.addEventListener('click', function () {
      if (!window._psEditingId) {
        return alert('Save this session first, then open its prescription.');
      }
      if (typeof window.closePlanSession === 'function') window.closePlanSession();
      open(window._psEditingId);
    });
    footer.insertBefore(button, footer.firstChild);
  }

  // _psEditingId lives in the dashboard's inline scope. Mirroring it onto window
  // when the modal opens is the only coupling between the two files.
  function shadowEditingId() {
    if (typeof window.openPlanSession !== 'function') return;
    var original = window.openPlanSession;
    window.openPlanSession = function (id, dateISO) {
      window._psEditingId = id || null;
      var result = original.apply(this, arguments);
      injectEntryPoint();
      var button = el('rx-open-btn');
      if (button) {
        button.disabled = !id;
        button.title = id ? '' : 'Save the session first';
      }
      return result;
    };
  }

  // ── The dashboard's own New Split editor ────────────────────────────────
  //
  // Its rows are built by addSplitExRow() in index.html's inline script and are
  // created on demand, so this delegates from the document rather than binding
  // to elements that may not exist yet. Nothing in the inline code changes: the
  // picker just writes into the same input the editor already reads on save.
  function bindLegacySplitEditor() {
    document.addEventListener('click', function (event) {
      var input = event.target;
      if (!input || input.tagName !== 'INPUT') return;
      if (input.getAttribute('data-f') !== 'exercise') return;
      if (!input.closest('#pw-ex-list')) return;
      event.preventDefault();
      openPicker('input', null, input);
    });

    // Same affordance for the keyboard.
    document.addEventListener('keydown', function (event) {
      var input = event.target;
      if (!input || input.tagName !== 'INPUT') return;
      if (input.getAttribute('data-f') !== 'exercise') return;
      if (!input.closest('#pw-ex-list')) return;
      if (event.key !== 'Enter') return;
      event.preventDefault();
      openPicker('input', null, input);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    ensureShell();
    shadowEditingId();
    bindLegacySplitEditor();
  });

  window.DP_PROGRAMMING = { open: open, close: close };
})();
