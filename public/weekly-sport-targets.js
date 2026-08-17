/* Compact coach-owned weekly sport-target editor for the Nutrition/programming
 * screen. All writes use /api/athletes and therefore pass through the existing
 * authenticated coach boundary. No Supabase credential is present here. */
(function () {
  'use strict';

  var SPORTS = [
    { key: 'running', label: 'Running', unit: 'km', step: '0.1' },
    { key: 'cycling', label: 'Cycling', unit: 'km', step: '0.1' },
    { key: 'swimming', label: 'Swimming', unit: 'm', step: '1' },
  ];
  var state = {
    athleteCode: null,
    preferredWeekLabel: null,
    weekIdentifier: null,
    programmeWeeks: [],
    targets: [],
    loading: false,
    error: null,
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function root() { return document.getElementById('weekly-sport-targets-editor'); }

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

  function currentWeek() {
    return state.programmeWeeks.find(function (week) { return week.id === state.weekIdentifier; }) || null;
  }

  function targetFor(sport) {
    return state.targets.find(function (target) {
      return target.weekIdentifier === state.weekIdentifier && target.sport === sport;
    }) || null;
  }

  function distanceDisplay(target, sport) {
    if (!target || target.distanceTargetMetres == null) return '';
    return sport === 'swimming'
      ? String(target.distanceTargetMetres)
      : String(Math.round(Number(target.distanceTargetMetres) / 100) / 10);
  }

  function statusText(target) {
    if (!target || target.removedAt) return 'Not set';
    return target.state === 'published' ? 'Published · locked for athlete' : 'Draft · hidden';
  }

  function sportRow(sport) {
    var target = targetFor(sport.key);
    var enabled = !!(target && !target.removedAt);
    var disabled = enabled ? '' : ' disabled';
    return '<div class="wst-row" data-sport="' + sport.key + '">' +
      '<div class="wst-sport">' +
        '<label><input type="checkbox" class="wst-enabled"' + (enabled ? ' checked' : '') + '> ' + esc(sport.label) + '</label>' +
        '<span class="wst-state ' + (target && target.state === 'published' && !target.removedAt ? 'published' : '') + '">' + esc(statusText(target)) + '</span>' +
      '</div>' +
      '<label class="wst-field"><span>Distance</span><div><input class="wst-distance" type="number" min="0" step="' + sport.step + '" value="' + esc(distanceDisplay(target, sport.key)) + '"' + disabled + '><b>' + sport.unit + '</b></div></label>' +
      '<label class="wst-field"><span>Sessions <i>optional</i></span><input class="wst-sessions" type="number" min="0" step="1" value="' + esc(target && target.sessionTarget != null ? target.sessionTarget : '') + '"' + disabled + '></label>' +
      '<label class="wst-field"><span>Duration <i>min · optional</i></span><input class="wst-duration" type="number" min="0" step="1" value="' + esc(target && target.durationTargetMinutes != null ? target.durationTargetMinutes : '') + '"' + disabled + '></label>' +
      '<label class="wst-field wst-note"><span>Coach note</span><input class="wst-coach-note" maxlength="2000" value="' + esc(target ? target.coachNote || '' : '') + '" placeholder="Optional guidance"' + disabled + '></label>' +
      '<label class="wst-field wst-publish"><span>Visibility</span><select class="wst-publish-state"' + disabled + '><option value="draft"' + (!target || target.state !== 'published' ? ' selected' : '') + '>Draft</option><option value="published"' + (target && target.state === 'published' ? ' selected' : '') + '>Published</option></select></label>' +
      '<div class="wst-actions"><button type="button" class="wst-save"' + disabled + '>Save</button>' +
        (enabled ? '<button type="button" class="wst-remove">Remove</button>' : '') +
      '</div>' +
    '</div>';
  }

  function render() {
    var el = root();
    if (!el) return;
    if (!state.athleteCode) {
      el.innerHTML = '';
      return;
    }
    if (state.loading) {
      el.innerHTML = '<div class="wst-shell"><div class="wst-head"><div><strong>Weekly sport targets</strong><span>Loading ' + esc(state.athleteCode) + '…</span></div></div></div>';
      return;
    }
    if (state.error) {
      el.innerHTML = '<div class="wst-shell"><div class="wst-head"><div><strong>Weekly sport targets</strong><span class="wst-error">' + esc(state.error) + '</span></div><button type="button" class="wst-retry">Retry</button></div></div>';
      bind();
      return;
    }

    var preferredExists = state.programmeWeeks.some(function (week) {
      return week.weekLabel === state.preferredWeekLabel;
    });
    if (!state.programmeWeeks.length || (state.preferredWeekLabel && !preferredExists)) {
      el.innerHTML = '<div class="wst-shell"><div class="wst-head"><div><strong>Weekly sport targets</strong>' +
        '<span>' + esc(state.preferredWeekLabel || 'This week') + ' needs a canonical programme-week record before targets can be prescribed.</span></div>' +
        '<button type="button" class="wst-ensure">Set up ' + esc(state.preferredWeekLabel || 'programme week') + '</button></div></div>';
      bind();
      return;
    }

    var week = currentWeek();
    var options = state.programmeWeeks.map(function (item) {
      return '<option value="' + esc(item.id) + '"' + (item.id === state.weekIdentifier ? ' selected' : '') + '>' + esc(item.weekLabel) + '</option>';
    }).join('');
    el.innerHTML = '<section class="wst-shell" aria-labelledby="wst-title">' +
      '<div class="wst-head"><div><strong id="wst-title">Weekly sport targets</strong><span>Coach-owned prescriptions · published values lock the athlete target, including zero</span></div>' +
      '<label class="wst-week"><span>Programme week</span><select class="wst-week-select">' + options + '</select></label></div>' +
      '<div class="wst-grid" data-week="' + esc(week ? week.id : '') + '">' + SPORTS.map(sportRow).join('') + '</div>' +
      '<div class="wst-message" role="status"></div>' +
    '</section>';
    bind();
  }

  function setRowEnabled(row, enabled) {
    row.querySelectorAll('input:not(.wst-enabled),select,.wst-save').forEach(function (control) {
      control.disabled = !enabled;
    });
    if (!enabled) {
      var sport = row.getAttribute('data-sport');
      var target = targetFor(sport);
      if (target && !target.removedAt) removeTarget(row);
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
      render();
      message(sportDef.label + ' target saved' + (publishState === 'published' ? ' and published.' : ' as a draft.'));
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
      render();
      message(sportDef.label + ' target removed. Its audit history was preserved.');
    } catch (error) {
      render();
      message(error.message || 'Target could not be removed', true);
    }
  }

  async function ensureWeek() {
    if (!state.preferredWeekLabel) return;
    var button = root().querySelector('.wst-ensure');
    button.disabled = true;
    button.textContent = 'Setting up…';
    try {
      await apiPost({
        action: 'weekly_sport_target_week_ensure',
        athlete_code: state.athleteCode,
        week_label: state.preferredWeekLabel,
      });
      await load(true);
    } catch (error) {
      state.error = error.message || 'Programme week could not be created';
      render();
    }
  }

  function bind() {
    var el = root();
    if (!el) return;
    var retry = el.querySelector('.wst-retry');
    if (retry) retry.addEventListener('click', function () { load(true); });
    var ensure = el.querySelector('.wst-ensure');
    if (ensure) ensure.addEventListener('click', ensureWeek);
    var week = el.querySelector('.wst-week-select');
    if (week) week.addEventListener('change', function () {
      state.weekIdentifier = week.value;
      render();
    });
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
    render();
    try {
      var data = await apiGet(state.athleteCode);
      state.programmeWeeks = data.programmeWeeks || [];
      state.targets = data.targets || [];
      var preferred = state.programmeWeeks.find(function (week) {
        return week.weekLabel === state.preferredWeekLabel;
      });
      if (preferred) state.weekIdentifier = preferred.id;
      else if (!state.programmeWeeks.some(function (week) { return week.id === state.weekIdentifier; })) {
        state.weekIdentifier = state.programmeWeeks[0] ? state.programmeWeeks[0].id : null;
      }
    } catch (error) {
      state.error = error.message || 'Weekly sport targets could not load';
    } finally {
      state.loading = false;
      render();
    }
  }

  window.WeeklySportTargetsEditor = {
    mount: function (options) {
      options = options || {};
      var athleteChanged = state.athleteCode !== options.athleteCode;
      state.athleteCode = options.athleteCode || null;
      state.preferredWeekLabel = options.preferredWeekLabel || null;
      if (athleteChanged) {
        state.weekIdentifier = null;
        state.programmeWeeks = [];
        state.targets = [];
        load(true);
      } else {
        var preferred = state.programmeWeeks.find(function (week) {
          return week.weekLabel === state.preferredWeekLabel;
        });
        if (preferred) state.weekIdentifier = preferred.id;
        render();
      }
    },
  };
}());
