/* Dual Performance — Garmin steps inside the Plan Session window.
 *
 * A running session is planned in ONE place. The coach builds the steps here
 * (the same builder as the prescription drawer, run-builder.js, in embedded
 * mode); the athlete-card text fields are written FROM the steps; and Save
 * Session stores the session and its steps together through plan_save_run →
 * save_run_session(), one database transaction.
 *
 *   - No steps: the window works exactly as before (text-only run, no Garmin).
 *   - Steps: Warm up / Intervals / Working pace / Rest / Cool down / Target
 *     pace are hidden and filled from the steps, so the portal card and the
 *     watch can never disagree. Text is never parsed into steps.
 *   - Sending stays an athlete action: the athlete reviews the run in the
 *     portal and taps Send to Garmin.
 *
 * Hooks the dashboard's inline Plan Session functions the same way
 * programming.js does (wrapping the global functions), so index.html keeps
 * its flow and only gains two wrappers in its markup.
 */
(function () {
  'use strict';

  var R = window.DPRunWorkout;
  var B = window.DPRunBuilder;
  if (!R || !B) return;

  var TEXT_FIELDS = { warm_up: 'ps-warmup', intervals: 'ps-intervals', working_pace: 'ps-workpace', rest: 'ps-rest', cool_down: 'ps-cooldown', target_pace: 'ps-pace' };
  var ctl = { active: false, rowId: null, loading: false, original: null, legacyText: false, token: 0 };
  function editingId() { return typeof _psEditingId !== 'undefined' ? _psEditingId : null; }

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value.trim() : ''; }

  function apiGet(params) {
    var query = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch('/api/athletes?' + query, { cache: 'no-store' }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status));
        return data;
      });
    });
  }

  function runMode() {
    // Mirrors updatePsVisibility(): Running, or Other → Run + Strength.
    var mode = typeof _psMode !== 'undefined' ? _psMode : null;
    return mode === 'run' || (mode === 'other' && val('ps-type') === 'Run + Strength');
  }

  function hasSteps() { return ctl.active && B.steps().length > 0; }

  // ── Text fields follow the steps ──────────────────────────────────────────

  function syncText() {
    var stepsOn = hasSteps();
    var text = el('ps-run-text'), pace = el('ps-pace-field');
    if (text) text.style.display = stepsOn ? 'none' : '';
    if (pace) pace.style.display = stepsOn ? 'none' : '';
    if (!ctl.active) return;
    if (stepsOn) {
      var report = B.report();
      if (!report.valid) return; // keep the last valid text until the steps are fixed
      var card = R.cardText(B.steps());
      var values = { warm_up: card.warm_up, intervals: card.intervals, working_pace: card.working_pace, rest: card.rest, cool_down: card.cool_down, target_pace: card.working_pace };
      Object.keys(TEXT_FIELDS).forEach(function (key) { var e = el(TEXT_FIELDS[key]); if (e) e.value = values[key] || ''; });
      // Total km follows the steps until the coach types their own total.
      var dist = el('ps-dist');
      if (dist && (!dist.value || dist.value === ctl.autoDist)) {
        dist.value = card.total_km ? String(card.total_km) : (ctl.original.distance_km || '');
        ctl.autoDist = card.total_km ? dist.value : null;
      }
    } else if (ctl.original) {
      // All steps removed: the coach's own text comes back.
      Object.keys(TEXT_FIELDS).forEach(function (key) { var e = el(TEXT_FIELDS[key]); if (e) e.value = ctl.original[key] || ''; });
      var d = el('ps-dist');
      if (d && ctl.autoDist && d.value === ctl.autoDist) d.value = ctl.original.distance_km || '';
      ctl.autoDist = null;
    }
  }

  // ── Mount ─────────────────────────────────────────────────────────────────

  function context() {
    return {
      apiPost: function (payload) { return maPost(payload); },
      toast: function (message, tone) { if (tone === 'bad') alert(message); },
      onChange: function () { syncText(); },
    };
  }

  function sessionFromForm(base) {
    return Object.assign({}, base || {}, {
      title: val('ps-name') || (base && base.title) || 'Session',
      session_type: val('ps-type') || null,
      athlete_code: (base && base.athlete_code) || (typeof _progAthlete !== 'undefined' ? _progAthlete : ''),
      planned_date: val('ps-date') || (base && base.planned_date) || null,
    });
  }

  function render() {
    var host = el('ps-steps');
    if (!host) return;
    host.innerHTML = B.html();
    B.bind(host);
    B.refresh(host);
    syncText();
  }

  function mount(rowId) {
    var field = el('ps-steps-field');
    // openPlanSession → setPsMode → updatePsVisibility all land here for one
    // open; load once.
    if ((ctl.active || ctl.loading) && ctl.rowId === (rowId || null) && runMode()) return;
    var token = ++ctl.token;
    ctl.rowId = rowId || null;
    ctl.original = {};
    Object.keys(TEXT_FIELDS).forEach(function (key) { ctl.original[key] = val(TEXT_FIELDS[key]); });
    ctl.original.distance_km = val('ps-dist');
    ctl.autoDist = null;
    if (!field) return;
    if (!runMode()) { unmount(); return; }
    field.style.display = '';

    if (!rowId) {
      ctl.active = true;
      ctl.legacyText = false;
      B.load({ session: sessionFromForm({ id: null, publish_state: 'published', prescription_mode: 'legacy' }), runSteps: [] }, context(), { embedded: true });
      render();
      return;
    }
    ctl.active = false;
    ctl.loading = true;
    el('ps-steps').innerHTML = '<div class="rb-loading">Loading steps…</div>';
    apiGet({ action: 'prescription', session_id: rowId }).then(function (data) {
      if (token !== ctl.token) return; // the window moved on
      var wasDirty = typeof _modalDirty === 'function' && _modalDirty('ps-overlay');
      ctl.active = true;
      var steps = Array.isArray(data.runSteps) ? data.runSteps : [];
      ctl.legacyText = !steps.length && Object.keys(TEXT_FIELDS).some(function (k) { return ctl.original[k]; });
      // A stored total that equals the steps' total keeps following them.
      if (steps.length) {
        var total = R.cardText(steps.map(R.fromRow)).total_km;
        if (total && Number(ctl.original.distance_km) === total) ctl.autoDist = ctl.original.distance_km;
      }
      B.load(Object.assign({}, data, { session: sessionFromForm(data.session) }), context(), { embedded: true });
      render();
      // Filling the hidden text from saved steps is not a coach edit.
      if (!wasDirty && typeof _snapshotModal === 'function') _snapshotModal('ps-overlay');
    }).catch(function (error) {
      if (token !== ctl.token) return;
      el('ps-steps').innerHTML = '<div class="rb-loading is-bad">Couldn’t load the steps (' + String(error.message || error).replace(/[<>&]/g, '') + '). Close and reopen to try again; text fields still work.</div>';
    }).then(function () { if (token === ctl.token) ctl.loading = false; });
  }

  function unmount() {
    ctl.token += 1;
    ctl.active = false;
    var field = el('ps-steps-field');
    if (field) field.style.display = 'none';
    var host = el('ps-steps');
    if (host) host.innerHTML = '';
    var text = el('ps-run-text'), pace = el('ps-pace-field');
    if (text) text.style.display = '';
    if (pace) pace.style.display = '';
    if (B.isEmbedded()) B.reset();
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function saveWithSteps() {
    var report = B.report();
    if (!report.valid) {
      render();
      alert(report.errors.length === 1 ? report.errors[0].message : 'Fix the ' + report.errors.length + ' issues shown in red under the steps before saving.');
      return;
    }
    // Steps added to a run that had its own text: that text is about to be
    // replaced by text written from the steps. Say so once, plainly.
    if (ctl.legacyText) {
      var card = R.cardText(B.steps());
      if (!window.confirm('Replace this run’s text prescription with the steps?\n\n' +
        'Warm up, intervals, working pace, rest and cool down will read:\n' +
        [card.warm_up, card.intervals && card.working_pace ? card.intervals + (/^\d/.test(card.working_pace) ? ' @ ' : ' · ') + card.working_pace : (card.intervals || card.working_pace), card.rest, card.cool_down].filter(Boolean).join(' · ') +
        '\n\nThe old text is not kept.')) return;
    }
    var dist = val('ps-dist');
    var fields = {
      title: val('ps-name') || 'Session',
      session_type: val('ps-type') || null,
      status: val('ps-status') || 'Planned',
      planned_date: val('ps-date') || null,
      week_label: val('ps-week') || null,
      run_details: val('ps-details') || null,
      library_id: (el('ps-lib') && el('ps-lib').value) || null,
      distance_km: dist ? parseFloat(dist) || null : null,
      notes: val('ps-notes') || null,
    };
    var btn = el('ps-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      var result = await maPost({
        action: 'plan_save_run',
        id: ctl.rowId,
        athlete_code: ctl.rowId ? undefined : _progAthlete,
        fields: fields,
        steps: B.steps(),
      });
      var row = result.row;
      if (!row || !row.id) throw new Error('The saved session was not returned');
      var i = _planRowsSB.findIndex(function (r) { return r.id === row.id; });
      if (i >= 0) _planRowsSB[i] = row; else _planRowsSB.push(row);
      closePlanSession();
      if (typeof renderPlanGrid === 'function') renderPlanGrid();
      if (typeof updatePlanningBadge === 'function') updatePlanningBadge();
    } catch (error) {
      alert('Save failed: ' + (error.message || error));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Session'; }
    }
  }

  // ── Hooks into the inline Plan Session functions ──────────────────────────

  function wrap(name, after) {
    var original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function () {
      var result = original.apply(this, arguments);
      after.apply(this, arguments);
      return result;
    };
  }

  // Builder inputs are tracked by the builder, not the modal snapshot (their
  // count changes as steps are added); the synced text fields carry the change.
  if (typeof window._modalFields === 'function') {
    var fields = window._modalFields;
    window._modalFields = function (overlayId) {
      return fields(overlayId).filter(function (e) { return !(e.closest && e.closest('.rb')); });
    };
  }

  wrap('openPlanSession', function (id) { mount(id || null); });
  wrap('setPsMode', function () { if (runMode() && !ctl.active && !ctl.loading) mount(editingId()); else if (!runMode()) unmount(); });
  wrap('updatePsVisibility', function () {
    if (!runMode()) { if (ctl.active || ctl.loading) unmount(); return; }
    if (!ctl.active && !ctl.loading) { mount(editingId()); return; }
    if (ctl.active) { B.setSession({ session_type: val('ps-type') || null }); syncText(); }
  });
  wrap('applyLibPick', function () { if (hasSteps()) syncText(); });
  wrap('closePlanSession', function () { unmount(); ctl.rowId = null; });

  var save = window.savePlanSession;
  if (typeof save === 'function') {
    window.savePlanSession = function () {
      // Changed steps (or a new session with steps) save atomically with the
      // session. Unchanged steps take the normal path: rewriting them would
      // read as "changed since sent" on an athlete's Garmin receipt.
      if (runMode() && hasSteps() && !ctl.loading && (!ctl.rowId || B.isDirty())) return saveWithSteps();
      return save.apply(this, arguments);
    };
  }

  window.DPPlanSessionRun = { state: ctl, hasSteps: hasSteps };
})();
