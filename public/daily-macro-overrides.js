(function () {
  'use strict';

  var FIELDS = [
    { key: 'calories', label: 'Calories', unit: 'kcal', baseline: 'calories' },
    { key: 'proteinG', label: 'Protein', unit: 'g', baseline: 'proteinG' },
    { key: 'carbsG', label: 'Carbs', unit: 'g', baseline: 'carbsG' },
    { key: 'fatsG', label: 'Fats', unit: 'g', baseline: 'fatsG' },
    { key: 'fibreG', label: 'Fibre', unit: 'g', baseline: 'fibreG' },
  ];
  var state = {
    athleteCode: null, programmeWeeks: [], overrides: [], loaded: false,
    loading: false, error: null, openDate: null, openWeekLabel: null,
    weekStart: null, baseline: null,
  };
  var LOAD_TIMEOUT_MS = 12000;
  var loadPromise = null;
  var loadController = null;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
    });
  }
  function root() { return document.getElementById('daily-macro-overrides-editor'); }
  function number(value) { var out = parseFloat(value); return Number.isFinite(out) ? out : null; }
  function addDays(date, days) {
    var parsed = new Date(String(date) + 'T00:00:00Z');
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
  }
  function dateLabel(date) {
    var parsed = new Date(String(date) + 'T00:00:00Z');
    return {
      day: parsed.toLocaleDateString('en-AU', { weekday: 'short', timeZone: 'UTC' }),
      date: parsed.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    };
  }
  function activeOverride(date) {
    return state.overrides.find(function (row) { return row.date === date && !row.removedAt; }) || null;
  }
  function weekForLabel(label) {
    var discovery = /discovery/i.test(String(label || ''));
    var match = String(label || '').match(/\d+/), numberValue = discovery ? 0 : (match ? Number(match[0]) : null);
    return state.programmeWeeks.find(function (week) {
      return week.weekLabel === label || (numberValue !== null && Number(week.weekNumber) === numberValue);
    }) || null;
  }
  function baselineValue(baseline, key) { return baseline ? baseline[key] : null; }
  function delta(value, baseline) {
    var current = number(value), weekly = number(baseline);
    if (current === null || weekly === null) return '';
    var change = Math.round((current - weekly) * 10) / 10;
    if (change === 0) return 'same as week';
    return (change > 0 ? '+' : '') + change;
  }
  function overrideCount(start) {
    if (!start) return 0;
    var end = addDays(start, 6);
    return state.overrides.filter(function (row) {
      return row.state === 'published' && !row.removedAt && row.date >= start && row.date <= end;
    }).length;
  }

  async function apiGet(code, signal) {
    var response = await fetch('/api/athletes?action=daily_macro_overrides&code=' + encodeURIComponent(code), {
      cache: 'no-store', signal: signal,
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Daily macro overrides could not load');
    return data;
  }
  async function apiPost(payload) {
    if (typeof maPost !== 'function') throw new Error('Dashboard session is not ready');
    return maPost(payload);
  }
  function notify() { if (typeof renderProgramming === 'function') renderProgramming(); }

  function footerHtml(options) {
    options = options || {};
    var baseline = options.baseline || null;
    var row = activeOverride(options.date);
    var baselineCalories = baselineValue(baseline, 'calories');
    if (!row) {
      var baselineDisplay = baselineCalories == null || baselineCalories === '' ? 'No weekly calories' : baselineCalories + ' kcal';
      return '<button type="button" class="dmo-fuel-footer inherits" data-dmo-date="' + esc(options.date) + '" data-dmo-week="' + esc(options.weekLabel) + '">' +
        '<span class="dmo-state">Uses weekly targets</span><span class="dmo-main"><b>' + esc(baselineDisplay) + '</b><span>No daily override</span></span>' +
        '<span class="dmo-label dmo-override-cta"><span aria-hidden="true">+</span> Override macros for this day</span></button>';
    }
    var change = delta(row.calories, baselineCalories);
    return '<button type="button" class="dmo-fuel-footer ' + (row.state === 'published' ? 'published' : 'draft') + '" data-dmo-date="' + esc(options.date) + '" data-dmo-week="' + esc(options.weekLabel) + '">' +
      '<span class="dmo-state">Daily override · ' + (row.state === 'published' ? 'Published' : 'Draft') + '</span>' +
      '<span class="dmo-main"><b>' + esc(row.calories == null ? '—' : row.calories) + ' kcal</b><span>' + esc(change) + '</span></span>' +
      '<span class="dmo-label">' + esc(row.dayLabel || 'Custom daily macros') + '</span></button>';
  }

  function weekBarHtml(options) {
    options = options || {};
    var baseline = options.baseline || {};
    var start = options.weekStart || null;
    var values = [
      baseline.calories ? baseline.calories + ' kcal' : 'No weekly macros',
      baseline.proteinG ? baseline.proteinG + ' P' : null,
      baseline.carbsG ? baseline.carbsG + ' C' : null,
      baseline.fatsG ? baseline.fatsG + ' F' : null,
      baseline.fibreG ? baseline.fibreG + ' Fib' : null,
    ].filter(Boolean);
    var count = overrideCount(start);
    return '<div class="dmo-week-bar"><span class="dmo-kicker">Week baseline</span>' +
      values.map(function (value) { return '<span class="dmo-value">' + esc(value) + '</span>'; }).join('') +
      '<span class="dmo-value dmo-count">' + count + ' day' + (count === 1 ? '' : 's') + ' adjusted</span></div>';
  }

  function fieldHtml(field, row, baseline) {
    var value = row && row[field.key] != null ? row[field.key] : '';
    var difference = delta(value, baselineValue(baseline, field.baseline));
    var deltaClass = difference && difference !== 'same as week' ? (difference.charAt(0) === '+' ? ' up' : ' down') : '';
    return '<label class="dmo-field"><span>' + field.label + ' · ' + field.unit + '</span>' +
      '<input type="number" min="0" step="1" data-field="' + field.key + '" value="' + esc(value) + '">' +
      '<i class="dmo-delta' + deltaClass + '">' + esc(difference) + '</i></label>';
  }

  function editorRow(date) {
    var row = activeOverride(date), label = dateLabel(date), baseline = state.baseline || {};
    var otherDates = [];
    for (var index = 0; index < 7; index += 1) {
      var other = addDays(state.weekStart, index);
      if (other !== date) otherDates.push(other);
    }
    return '<div class="dmo-row' + (date === state.openDate ? ' focused' : '') + '" data-date="' + esc(date) + '">' +
      '<div class="dmo-date"><strong>' + esc(label.day) + '</strong><span>' + esc(label.date) + '</span></div>' +
      '<label class="dmo-field"><span>Day label</span><input maxlength="60" data-field="dayLabel" value="' + esc(row ? row.dayLabel || '' : '') + '" placeholder="Long run"></label>' +
      FIELDS.map(function (field) { return fieldHtml(field, row, baseline); }).join('') +
      '<label class="dmo-field note"><span>Coach note</span><input maxlength="2000" data-field="coachNote" value="' + esc(row ? row.coachNote || '' : '') + '" placeholder="Athlete-visible guidance"></label>' +
      '<label class="dmo-field"><span>Visibility</span><select data-field="state"><option value="draft"' + (!row || row.state !== 'published' ? ' selected' : '') + '>Draft</option><option value="published"' + (row && row.state === 'published' ? ' selected' : '') + '>Published</option></select></label>' +
      '<div><div class="dmo-actions"><button type="button" class="dmo-prefill">Prefill week</button><button type="button" class="dmo-save">Save</button>' +
        (row ? '<button type="button" class="dmo-remove">Remove</button>' : '') + '</div>' +
        '<div class="dmo-copy"><details><summary>Copy to…</summary><div class="dmo-copy-list">' + otherDates.map(function (other) {
          var otherLabel = dateLabel(other); return '<label><input type="checkbox" value="' + esc(other) + '"> ' + esc(otherLabel.day + ' ' + otherLabel.date) + '</label>';
        }).join('') + '<button type="button" class="dmo-copy-save">Copy selected</button></div></details></div></div>' +
    '</div>';
  }

  function renderEditor() {
    var element = root();
    if (!element) return;
    if (!state.openDate) { element.innerHTML = ''; return; }
    var week = weekForLabel(state.openWeekLabel);
    if (state.loading && !state.loaded) {
      element.innerHTML = shell('<div class="dmo-head"><div><strong id="dmo-title">Daily macro overrides</strong><span>Loading programme week…</span></div><button class="dmo-close">×</button></div>'); bindEditor(); return;
    }
    if (state.error) {
      element.innerHTML = shell('<div class="dmo-head"><div><strong id="dmo-title">Daily macro overrides</strong><span>' + esc(state.error) + '</span><button type="button" class="dmo-retry">Retry</button></div><button class="dmo-close">×</button></div>'); bindEditor(); return;
    }
    if (!week) {
      element.innerHTML = shell('<div class="dmo-head"><div><strong id="dmo-title">' + esc(state.openWeekLabel) + ' daily macros</strong><span>This week needs its canonical programme-week record before day overrides can be saved.</span></div><button class="dmo-close">×</button></div>'); bindEditor(); return;
    }
    state.weekStart = week.startDate || state.weekStart;
    var rows = [];
    for (var index = 0; index < 7; index += 1) rows.push(editorRow(addDays(state.weekStart, index)));
    element.innerHTML = shell('<div class="dmo-head"><div><strong id="dmo-title">' + esc(state.openWeekLabel) + ' daily macros</strong><span>Published rows are locked for the athlete. Weekly macros remain the fallback.</span></div><button class="dmo-close">×</button></div><div class="dmo-grid">' + rows.join('') + '</div><div class="dmo-message" role="status"></div>');
    bindEditor();
  }
  function shell(content) { return '<div class="dmo-overlay"><section class="dmo-dialog" role="dialog" aria-modal="true" aria-labelledby="dmo-title">' + content + '</section></div>'; }
  function message(text, bad) { var box = root() && root().querySelector('.dmo-message'); if (box) { box.textContent = text || ''; box.className = 'dmo-message' + (bad ? ' bad' : ''); } }
  function rowPayload(row) {
    function value(field) { var input = row.querySelector('[data-field="' + field + '"]'); return input && input.value.trim() !== '' ? input.value.trim() : null; }
    return {
      athlete_code: state.athleteCode,
      programme_week_id: weekForLabel(state.openWeekLabel).id,
      override_date: row.getAttribute('data-date'),
      calories: value('calories'), protein_g: value('proteinG'), carbs_g: value('carbsG'),
      fats_g: value('fatsG'), fibre_g: value('fibreG'), day_label: value('dayLabel'),
      coach_note: value('coachNote'), publish_state: value('state'),
    };
  }
  function needsOutlierConfirm(payload) {
    var weekly = number(state.baseline && state.baseline.calories), daily = number(payload.calories);
    return payload.publish_state === 'published' && weekly !== null && weekly > 0 && daily !== null && Math.abs(daily - weekly) / weekly > 0.6;
  }
  function replaceSaved(saved) {
    var values = Array.isArray(saved) ? saved : [saved];
    values.filter(Boolean).forEach(function (row) {
      state.overrides = state.overrides.filter(function (existing) { return existing.date !== row.date; });
      state.overrides.push(row);
    });
  }
  async function saveRow(row) {
    var payload = rowPayload(row);
    if (needsOutlierConfirm(payload) && !window.confirm('Calories differ from the weekly baseline by more than 60%. Publish this outlier?')) return;
    try {
      var result = await apiPost(Object.assign({ action: 'daily_macro_override_save' }, payload));
      replaceSaved(result.override); renderEditor(); notify(); message('Daily override saved.');
    } catch (error) { message(error.message || 'Daily override could not be saved', true); }
  }
  async function copyRow(row) {
    var selected = Array.from(row.querySelectorAll('.dmo-copy-list input:checked')).map(function (input) { return input.value; });
    if (!selected.length) { message('Choose at least one other day.', true); return; }
    var payload = rowPayload(row); payload.dates = [payload.override_date].concat(selected);
    if (needsOutlierConfirm(payload) && !window.confirm('Calories differ from the weekly baseline by more than 60%. Publish this outlier to the selected days?')) return;
    delete payload.override_date;
    try {
      var result = await apiPost(Object.assign({ action: 'daily_macro_override_range_save' }, payload));
      replaceSaved(result.overrides); renderEditor(); notify(); message('Override copied to ' + selected.length + ' day' + (selected.length === 1 ? '.' : 's.'));
    } catch (error) { message(error.message || 'Overrides could not be copied', true); }
  }
  async function removeRow(row) {
    try {
      var result = await apiPost({ action: 'daily_macro_override_remove', athlete_code: state.athleteCode, override_date: row.getAttribute('data-date') });
      replaceSaved(result.override); renderEditor(); notify(); message('Override removed; the weekly targets apply again.');
    } catch (error) { message(error.message || 'Override could not be removed', true); }
  }
  function prefillRow(row) {
    FIELDS.forEach(function (field) {
      var input = row.querySelector('[data-field="' + field.key + '"]');
      var value = baselineValue(state.baseline, field.baseline);
      if (input && value != null) input.value = String(number(value) == null ? value : number(value));
    });
    updateDeltas(row);
  }
  function updateDeltas(row) {
    FIELDS.forEach(function (field) {
      var input = row.querySelector('[data-field="' + field.key + '"]'), output = input && input.parentNode.querySelector('.dmo-delta');
      if (!output) return;
      var difference = delta(input.value, baselineValue(state.baseline, field.baseline));
      output.textContent = difference; output.className = 'dmo-delta' + (difference && difference !== 'same as week' ? (difference.charAt(0) === '+' ? ' up' : ' down') : '');
    });
  }
  function closeEditor() { state.openDate = null; state.openWeekLabel = null; renderEditor(); }
  function bindEditor() {
    var element = root(); if (!element) return;
    var overlay = element.querySelector('.dmo-overlay'); if (overlay) overlay.addEventListener('click', function (event) { if (event.target === overlay) closeEditor(); });
    var close = element.querySelector('.dmo-close'); if (close) close.addEventListener('click', closeEditor);
    var retry = element.querySelector('.dmo-retry'); if (retry) retry.addEventListener('click', function () { load(true); });
    element.querySelectorAll('.dmo-row').forEach(function (row) {
      row.querySelectorAll('input[type="number"]').forEach(function (input) { input.addEventListener('input', function () { updateDeltas(row); }); });
      row.querySelector('.dmo-prefill').addEventListener('click', function () { prefillRow(row); });
      row.querySelector('.dmo-save').addEventListener('click', function () { saveRow(row); });
      var remove = row.querySelector('.dmo-remove'); if (remove) remove.addEventListener('click', function () { removeRow(row); });
      row.querySelector('.dmo-copy-save').addEventListener('click', function () { copyRow(row); });
    });
  }
  async function load(force) {
    if (!state.athleteCode) return;
    if (state.loading && loadPromise) return loadPromise;
    if (state.loaded && !force) return state.overrides;
    var athleteCode = state.athleteCode;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, LOAD_TIMEOUT_MS);
    loadController = controller;
    state.loading = true; state.error = null; renderEditor();
    loadPromise = (async function () {
      try {
        var data = await apiGet(athleteCode, controller.signal);
        if (state.athleteCode !== athleteCode) return [];
        state.programmeWeeks = data.programmeWeeks || []; state.overrides = data.overrides || []; state.loaded = true;
        return state.overrides;
      } catch (error) {
        if (state.athleteCode !== athleteCode) return [];
        state.error = error && error.name === 'AbortError'
          ? 'Daily macros took too long to load. Check the database migration, then retry.'
          : (error.message || 'Daily macro overrides could not load');
        return [];
      } finally {
        clearTimeout(timer);
        if (loadController === controller) {
          state.loading = false; loadController = null; loadPromise = null;
          renderEditor(); notify();
        }
      }
    })();
    return loadPromise;
  }
  function open(date, weekLabel, baseline) {
    state.openDate = String(date || ''); state.openWeekLabel = String(weekLabel || ''); state.baseline = baseline || null;
    var week = weekForLabel(state.openWeekLabel), parsed = new Date(state.openDate + 'T00:00:00Z');
    if (!Number.isNaN(parsed.getTime())) parsed.setUTCDate(parsed.getUTCDate() - ((parsed.getUTCDay() + 6) % 7));
    state.weekStart = (week && week.startDate) || (!Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null);
    renderEditor();
    if (!state.loaded && !state.loading && !state.error) load(false);
  }
  function bindCells(container, baselineForWeek) {
    if (!container) return;
    container.querySelectorAll('.dmo-fuel-footer').forEach(function (button) {
      button.addEventListener('click', function () {
        var weekLabel = button.getAttribute('data-dmo-week');
        open(button.getAttribute('data-dmo-date'), weekLabel, typeof baselineForWeek === 'function' ? baselineForWeek(weekLabel) : null);
      });
    });
  }

  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && state.openDate) closeEditor(); });
  window.DailyMacroOverridesEditor = {
    mount: function (options) {
      options = options || {}; var athlete = options.athleteCode || null;
      if (state.athleteCode === athlete) {
        if (athlete && !state.loaded && !state.loading && !state.error) load(false);
        return;
      }
      if (loadController) loadController.abort();
      loadController = null; loadPromise = null; state.loading = false;
      state.athleteCode = athlete; state.programmeWeeks = []; state.overrides = []; state.loaded = false; state.error = null; closeEditor();
      if (athlete) load(true);
    },
    footerHtml: footerHtml,
    weekBarHtml: weekBarHtml,
    bindCells: bindCells,
    open: open,
    close: closeEditor,
    reload: function () { return load(true); },
    publishedCount: overrideCount,
    publishedCountForWeek: function (weekLabel) {
      var week = weekForLabel(weekLabel);
      if (!week) return 0;
      return state.overrides.filter(function (row) {
        return row.weekIdentifier === week.id && row.state === 'published' && !row.removedAt;
      }).length;
    },
    getOverrides: function () { return state.overrides.slice(); },
  };
}());
