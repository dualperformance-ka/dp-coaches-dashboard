/* Coach-owned weekly sport targets embedded in each Nutrition week row.
 * The table shows the running plan even before it is published, while every
 * authoritative write still passes through /api/athletes. */
(function () {
  'use strict';

  var SPORTS = [
    { key: 'running', label: 'Running', short: 'Run', unit: 'km', step: '0.1' },
    { key: 'cycling', label: 'Cycling', short: 'Bike', unit: 'km', step: '0.1' },
    { key: 'swimming', label: 'Swimming', short: 'Swim', unit: 'm', step: '1' },
  ];
  var state = {
    athleteCode: null,
    programmeWeeks: [],
    targets: [],
    loading: false,
    loaded: false,
    error: null,
    openWeekLabel: null,
    weekIdentifier: null,
    planRunningKm: null,
    focusSport: null,
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function finiteNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function root() { return document.getElementById('weekly-sport-targets-editor'); }

  function weekForLabel(label) {
    return state.programmeWeeks.find(function (week) { return week.weekLabel === label; }) || null;
  }

  function targetFor(weekIdentifier, sport) {
    return state.targets.find(function (target) {
      return target.weekIdentifier === weekIdentifier && target.sport === sport && !target.removedAt;
    }) || null;
  }

  function formatDistance(target, sport) {
    if (!target || target.distanceTargetMetres == null) return null;
    if (sport === 'swimming') return String(target.distanceTargetMetres) + ' m';
    var km = Number(target.distanceTargetMetres) / 1000;
    return String(Math.round(km * 10) / 10) + ' km';
  }

  function distanceInputValue(target, sport) {
    if (!target || target.distanceTargetMetres == null) return '';
    return sport === 'swimming'
      ? String(target.distanceTargetMetres)
      : String(Math.round(Number(target.distanceTargetMetres) / 100) / 10);
  }

  async function apiGet(code) {
    var response = await fetch(
      '/api/athletes?action=weekly_sport_targets&code=' + encodeURIComponent(code),
      { cache: 'no-store' }
    );
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Targets could not load');
    return data;
  }

  async function apiPost(payload) {
    if (typeof maPost !== 'function') throw new Error('Dashboard session is not ready');
    return maPost(payload);
  }

  function notifyNutritionRows() {
    if (typeof renderNutTable === 'function') renderNutTable();
  }

  function sportCellHtml(options) {
    options = options || {};
    var weekLabel = String(options.weekLabel || '');
    var sport = SPORTS.find(function (item) { return item.key === options.sport; }) || SPORTS[0];
    var planKm = finiteNumber(options.planKm);
    var legacyKm = finiteNumber(options.legacyKm);
    var suggestedKm = legacyKm !== null ? legacyKm : planKm;
    var week = weekForLabel(weekLabel);
    var target = week ? targetFor(week.id, sport.key) : null;
    var suggested = sport.key === 'running' && !target && suggestedKm !== null && suggestedKm > 0;
    var displayValue = target ? formatDistance(target, sport.key) : (suggested ? suggestedKm + ' km' : 'Set target');
    var targetState = target
      ? (target.state === 'published' ? 'Locked' : 'Draft')
      : (suggested ? (legacyKm !== null ? 'Previous · publish' : 'From plan · publish') : 'Not set');
    if (state.loading && !state.loaded) targetState = 'Loading…';
    if (state.error) targetState = sport.key === 'running' && suggested ? 'Plan shown · unavailable' : 'Targets unavailable';

    return '<button type="button" class="wst-sport-summary ' + sport.key + '" data-wst-week="' + esc(weekLabel) + '" data-wst-sport="' + sport.key + '" data-wst-plan-km="' + esc(suggestedKm === null ? '' : suggestedKm) + '" aria-label="Edit ' + esc(sport.label.toLowerCase()) + ' target for ' + esc(weekLabel) + '">' +
      '<span class="wst-cell-sport">' + esc(sport.label) + '</span>' +
      '<strong>' + esc(displayValue) + '</strong>' +
      '<span><i class="' + (target && target.state === 'published' ? 'locked' : (target ? 'draft' : '')) + '">' + esc(targetState) + '</i><b>Edit</b></span>' +
    '</button>';
  }

  function bindCells(container) {
    if (!container) return;
    container.querySelectorAll('.wst-sport-summary').forEach(function (button) {
      button.addEventListener('click', function () {
        openWeek(button.getAttribute('data-wst-week'), button.getAttribute('data-wst-plan-km'), button.getAttribute('data-wst-sport'));
      });
    });
  }

  function editorStatus(target, suggested) {
    if (target) return target.state === 'published' ? 'Published · athlete locked' : 'Draft · hidden from athlete';
    if (suggested) return 'Plan suggestion · ready to publish';
    return 'Not set';
  }

  function sportRow(sport) {
    var target = targetFor(state.weekIdentifier, sport.key);
    var suggested = !target && sport.key === 'running' && state.planRunningKm !== null && state.planRunningKm > 0;
    var enabled = !!target || suggested;
    var disabled = enabled ? '' : ' disabled';
    var distance = target ? distanceInputValue(target, sport.key) : (suggested ? String(state.planRunningKm) : '');
    var publishState = target ? target.state : (suggested ? 'published' : 'draft');
    return '<div class="wst-row' + (state.focusSport === sport.key ? ' focused' : '') + '" data-sport="' + sport.key + '">' +
      '<div class="wst-sport"><label><input type="checkbox" class="wst-enabled"' + (enabled ? ' checked' : '') + '> ' + esc(sport.label) + '</label>' +
        '<span class="wst-state ' + (target && target.state === 'published' ? 'published' : '') + '">' + esc(editorStatus(target, suggested)) + '</span></div>' +
      '<label class="wst-field"><span>Distance</span><div><input class="wst-distance" type="number" min="0" step="' + sport.step + '" value="' + esc(distance) + '"' + disabled + '><b>' + sport.unit + '</b></div></label>' +
      '<label class="wst-field"><span>Sessions <i>optional</i></span><input class="wst-sessions" type="number" min="0" step="1" value="' + esc(target && target.sessionTarget != null ? target.sessionTarget : '') + '"' + disabled + '></label>' +
      '<label class="wst-field"><span>Duration <i>min · optional</i></span><input class="wst-duration" type="number" min="0" step="1" value="' + esc(target && target.durationTargetMinutes != null ? target.durationTargetMinutes : '') + '"' + disabled + '></label>' +
      '<label class="wst-field wst-note"><span>Coach note</span><input class="wst-coach-note" maxlength="2000" value="' + esc(target ? target.coachNote || '' : '') + '" placeholder="Optional guidance"' + disabled + '></label>' +
      '<label class="wst-field wst-publish"><span>Visibility</span><select class="wst-publish-state"' + disabled + '><option value="draft"' + (publishState !== 'published' ? ' selected' : '') + '>Draft</option><option value="published"' + (publishState === 'published' ? ' selected' : '') + '>Published</option></select></label>' +
      '<div class="wst-actions"><button type="button" class="wst-save"' + disabled + '>' + (suggested ? 'Publish target' : 'Save') + '</button>' +
        (target ? '<button type="button" class="wst-remove">Remove</button>' : '') + '</div>' +
    '</div>';
  }

  function dialogShell(content) {
    return '<div class="wst-overlay"><section class="wst-dialog" role="dialog" aria-modal="true" aria-labelledby="wst-title">' + content + '</section></div>';
  }

  function renderEditor() {
    var el = root();
    if (!el) return;
    if (!state.openWeekLabel) { el.innerHTML = ''; return; }
    if (state.loading) {
      el.innerHTML = dialogShell('<div class="wst-head"><div><strong id="wst-title">' + esc(state.openWeekLabel) + ' sport targets</strong><span>Loading coach targets…</span></div><button type="button" class="wst-close" aria-label="Close">×</button></div>');
      bindEditor();
      return;
    }
    if (state.error) {
      el.innerHTML = dialogShell('<div class="wst-head"><div><strong id="wst-title">' + esc(state.openWeekLabel) + ' sport targets</strong><span class="wst-error">' + esc(state.error) + '</span></div><div class="wst-head-actions"><button type="button" class="wst-retry">Retry</button><button type="button" class="wst-close" aria-label="Close">×</button></div></div>');
      bindEditor();
      return;
    }
    var week = weekForLabel(state.openWeekLabel);
    if (!week) {
      el.innerHTML = dialogShell('<div class="wst-head"><div><strong id="wst-title">' + esc(state.openWeekLabel) + ' sport targets</strong><span>This week needs its canonical programme-week record before a target can be published.</span></div><button type="button" class="wst-close" aria-label="Close">×</button></div><div class="wst-setup"><button type="button" class="wst-ensure">Set up ' + esc(state.openWeekLabel) + '</button></div><div class="wst-message" role="status"></div>');
      bindEditor();
      return;
    }
    state.weekIdentifier = week.id;
    el.innerHTML = dialogShell(
      '<div class="wst-head"><div><strong id="wst-title">' + esc(state.openWeekLabel) + ' sport targets</strong><span>Published values are the athlete’s locked prescription. Zero is valid.</span></div><button type="button" class="wst-close" aria-label="Close">×</button></div>' +
      '<div class="wst-grid" data-week="' + esc(week.id) + '">' + SPORTS.map(sportRow).join('') + '</div>' +
      '<div class="wst-message" role="status"></div>'
    );
    bindEditor();
  }

  function setRowEnabled(row, enabled) {
    row.querySelectorAll('input:not(.wst-enabled),select,.wst-save').forEach(function (control) {
      control.disabled = !enabled;
    });
    if (!enabled) {
      var target = targetFor(state.weekIdentifier, row.getAttribute('data-sport'));
      if (target) removeTarget(row);
    }
  }

  function message(text, bad) {
    var box = root() && root().querySelector('.wst-message');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'wst-message' + (bad ? ' bad' : '');
  }

  function value(row, selector) {
    var input = row.querySelector(selector);
    var out = input ? input.value.trim() : '';
    return out === '' ? null : out;
  }

  async function saveTarget(row) {
    var sport = row.getAttribute('data-sport');
    var sportDef = SPORTS.find(function (item) { return item.key === sport; });
    var distance = value(row, '.wst-distance');
    var publishState = row.querySelector('.wst-publish-state').value;
    if (distance === null && publishState === 'published') {
      message('Enter a distance before publishing. Zero is a valid prescription.', true);
      return;
    }
    var button = row.querySelector('.wst-save');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      var metres = distance === null ? null : Math.round(Number(distance) * (sportDef.unit === 'km' ? 1000 : 1));
      var result = await apiPost({
        action: 'weekly_sport_target_save',
        athlete_code: state.athleteCode,
        programme_week_id: state.weekIdentifier,
        sport: sport,
        distance_target_metres: metres,
        session_target: value(row, '.wst-sessions'),
        duration_target_minutes: value(row, '.wst-duration'),
        coach_note: value(row, '.wst-coach-note'),
        publish_state: publishState,
      });
      state.targets = state.targets.filter(function (item) {
        return !(item.weekIdentifier === state.weekIdentifier && item.sport === sport);
      });
      state.targets.push(result.target);
      renderEditor();
      notifyNutritionRows();
      message(sportDef.label + ' target saved' + (publishState === 'published' ? ' and locked for the athlete.' : ' as a draft.'));
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Retry';
      message(error.message || 'Target could not be saved', true);
    }
  }

  async function removeTarget(row) {
    var sport = row.getAttribute('data-sport');
    var sportDef = SPORTS.find(function (item) { return item.key === sport; });
    row.querySelectorAll('button,input,select').forEach(function (control) { control.disabled = true; });
    try {
      var result = await apiPost({
        action: 'weekly_sport_target_remove',
        athlete_code: state.athleteCode,
        programme_week_id: state.weekIdentifier,
        sport: sport,
      });
      state.targets = state.targets.filter(function (item) {
        return !(item.weekIdentifier === state.weekIdentifier && item.sport === sport);
      });
      if (result.target) state.targets.push(result.target);
      renderEditor();
      notifyNutritionRows();
      message(sportDef.label + ' target removed. Its audit history was preserved.');
    } catch (error) {
      renderEditor();
      message(error.message || 'Target could not be removed', true);
    }
  }

  async function ensureWeek() {
    var button = root() && root().querySelector('.wst-ensure');
    if (button) { button.disabled = true; button.textContent = 'Setting up…'; }
    try {
      await apiPost({
        action: 'weekly_sport_target_week_ensure',
        athlete_code: state.athleteCode,
        week_label: state.openWeekLabel,
      });
      await load(true);
      renderEditor();
    } catch (error) {
      state.error = error.message || 'Programme week could not be created';
      renderEditor();
    }
  }

  function closeEditor() {
    state.openWeekLabel = null;
    state.weekIdentifier = null;
    state.planRunningKm = null;
    state.focusSport = null;
    renderEditor();
  }

  function bindEditor() {
    var el = root();
    if (!el) return;
    var overlay = el.querySelector('.wst-overlay');
    if (overlay) overlay.addEventListener('click', function (event) { if (event.target === overlay) closeEditor(); });
    var close = el.querySelector('.wst-close');
    if (close) close.addEventListener('click', closeEditor);
    var retry = el.querySelector('.wst-retry');
    if (retry) retry.addEventListener('click', function () { load(true); });
    var ensure = el.querySelector('.wst-ensure');
    if (ensure) ensure.addEventListener('click', ensureWeek);
    el.querySelectorAll('.wst-row').forEach(function (row) {
      row.querySelector('.wst-enabled').addEventListener('change', function (event) {
        setRowEnabled(row, event.target.checked);
      });
      var save = row.querySelector('.wst-save');
      if (save) save.addEventListener('click', function () { saveTarget(row); });
      var remove = row.querySelector('.wst-remove');
      if (remove) remove.addEventListener('click', function () { removeTarget(row); });
    });
  }

  async function load(force) {
    if (!state.athleteCode || (state.loading && !force)) return;
    state.loading = true;
    state.error = null;
    renderEditor();
    try {
      var data = await apiGet(state.athleteCode);
      state.programmeWeeks = data.programmeWeeks || [];
      state.targets = data.targets || [];
      state.loaded = true;
    } catch (error) {
      state.error = error.message || 'Weekly sport targets could not load';
    } finally {
      state.loading = false;
      renderEditor();
      notifyNutritionRows();
    }
  }

  async function openWeek(weekLabel, planKm, sport) {
    state.openWeekLabel = String(weekLabel || '');
    state.planRunningKm = finiteNumber(planKm);
    state.focusSport = SPORTS.some(function (item) { return item.key === sport; }) ? sport : null;
    renderEditor();
    if (!state.loaded || state.error) await load(true);
    renderEditor();
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.openWeekLabel) closeEditor();
  });

  window.WeeklySportTargetsEditor = {
    mount: function (options) {
      options = options || {};
      var nextAthlete = options.athleteCode || null;
      if (state.athleteCode === nextAthlete) {
        if (nextAthlete && !state.loaded && !state.loading) load(false);
        return;
      }
      state.athleteCode = nextAthlete;
      state.programmeWeeks = [];
      state.targets = [];
      state.loaded = false;
      state.error = null;
      closeEditor();
      if (state.athleteCode) load(true);
    },
    sportCellHtml: sportCellHtml,
    bindCells: bindCells,
    openWeek: openWeek,
    close: closeEditor,
  };
}());
