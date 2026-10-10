// All Activities: every Strava activity an athlete has chosen to share with
// their coaches, classified against the programme, inside the athlete's
// Training tab.
//
// Data arrives from /api/athletes?action=strava_activities, which enforces the
// coach's athlete scope, the deployment switch and the athlete's consent before
// it reads anything. Decisions go back through the same coach-gated route. The
// browser never talks to Supabase or Strava, and nothing here is persisted on
// the device: the only localStorage use is the coach's last range and filter.
(function (root) {
  'use strict';

  const TZ = 'Australia/Adelaide';
  const cache = new Map(); // `${code}|${start}|${end}` -> entry
  const view = new Map();  // code -> { preset, start, end, show, sport, open }
  const PREF_KEY = 'dp_sa_view';

  // ── Formatting ─────────────────────────────────────────────────────────────

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmtNum(value, places = 0) {
    const n = num(value);
    if (n === null) return null;
    return n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: places });
  }

  function fmtDuration(seconds) {
    const s = num(seconds);
    if (!s || s <= 0) return null;
    const totalMin = Math.round(s / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
  }

  function fmtMinutes(minutes) {
    const m = num(minutes);
    return m && m > 0 ? fmtDuration(m * 60) : null;
  }

  function fmtPace(secPerKm) {
    const s = num(secPerKm);
    if (!s || s <= 0) return null;
    return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} /km`;
  }

  // Swims read in metres, everything else in km.
  function fmtDistance(metres, sport) {
    const m = num(metres);
    if (!m || m <= 0) return null;
    if (sport === 'swimming') return `${fmtNum(Math.round(m))}m`;
    return `${fmtNum(m / 1000, 1)}km`;
  }

  function isoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
  }

  function dateFrom(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12));
  }

  function addDays(iso, days) {
    const date = dateFrom(iso);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function mondayOf(iso) {
    const dow = dateFrom(iso).getUTCDay();
    return addDays(iso, -((dow + 6) % 7));
  }

  function todayISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  function fmtDay(iso, opts = { weekday: 'long', day: 'numeric', month: 'short' }) {
    return new Intl.DateTimeFormat('en-AU', { ...opts, timeZone: 'UTC' }).format(dateFrom(iso));
  }

  function fmtRange(start, end) {
    const short = { day: 'numeric', month: 'short' };
    return `${fmtDay(start, short)} – ${fmtDay(end, { ...short, year: 'numeric' })}`;
  }

  const SPORT_LABEL = { running: 'Running', cycling: 'Cycling', swimming: 'Swimming', strength: 'Strength', walking: 'Walking', other: 'Other' };
  const SPORT_NOUN = { running: ['Run', 'Runs'], cycling: ['Ride', 'Rides'], swimming: ['Swim', 'Swims'], strength: ['Strength', 'Strength'], walking: ['Walk', 'Walks'], other: ['Other', 'Other'] };
  const SPORT_ICON = { running: 'R', cycling: 'C', swimming: 'S', strength: 'G', walking: 'W', other: '·' };

  // Every status carries a text label and a glyph, never colour alone.
  const STATUS = {
    programmed:    { label: 'Programmed · completed', short: 'Completed', glyph: '✓' },
    unprogrammed:  { label: 'Unprogrammed', short: 'Unprogrammed', glyph: '+' },
    needs_review:  { label: 'Needs review', short: 'Review', glyph: '?' },
    missed:        { label: 'Programmed · missed', short: 'Missed', glyph: '×' },
    awaiting_sync: { label: 'Awaiting Strava sync', short: 'Syncing', glyph: '…' },
    upcoming:      { label: 'Programmed · upcoming', short: 'Planned', glyph: '○' },
  };

  const REASON_COPY = {
    activity_named_easy: 'The athlete named this an easy run, but a quality session was prescribed.',
    intensity_below_prescription: 'Relative Effort was below what this quality session needs.',
    ran_above_prescription: 'Ran harder than the easy prescription.',
    structure_unverified: 'Completed on distance. No effort data, so the workout structure is not verified.',
    ambiguous_swim_match: 'More than one swim or swim session that day.',
    ambiguous_ride_match: 'More than one ride or ride session that day.',
    ambiguous_strength_match: 'More than one strength session or gym activity that day.',
    generic_workout_type: 'Recorded as a generic workout, not weight training.',
  };

  const VIA_COPY = {
    coach: 'Confirmed by a coach',
    athlete: 'Matched in the athlete’s portal',
    auto: 'Matched automatically',
  };

  // ── View state ─────────────────────────────────────────────────────────────

  function readPrefs() {
    try { return JSON.parse(root.localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
  }

  function writePrefs(state) {
    try {
      root.localStorage.setItem(PREF_KEY, JSON.stringify({ preset: state.preset, show: state.show, sport: state.sport }));
    } catch { /* private mode */ }
  }

  function rangeFor(preset, today = todayISO()) {
    const monday = mondayOf(today);
    if (preset === 'last') return { start: addDays(monday, -7), end: addDays(monday, -1) };
    if (preset === 'four') return { start: addDays(monday, -21), end: addDays(monday, 6) };
    return { start: monday, end: addDays(monday, 6) };
  }

  function stateFor(code) {
    if (!view.has(code)) {
      const prefs = readPrefs();
      const preset = ['this', 'last', 'four'].includes(prefs.preset) ? prefs.preset : 'this';
      view.set(code, {
        preset,
        ...rangeFor(preset),
        show: ['all', 'programmed', 'unprogrammed', 'needs_review'].includes(prefs.show) ? prefs.show : 'all',
        sport: ['all', 'running', 'cycling', 'swimming', 'strength'].includes(prefs.sport) ? prefs.sport : 'all',
        open: '',
      });
    }
    return view.get(code);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function placeholder(code) {
    if (!code) return '';
    return `<section class="fpc-section sa" data-sa-code="${esc(code)}" aria-labelledby="sa-title-${esc(code)}" aria-busy="true">
      <div class="sa-head">
        <div class="fpc-section-title" id="sa-title-${esc(code)}">All activities</div>
        <span class="sa-attrib">Strava · shared by athlete</span>
      </div>
      <div class="sa-body"><p class="cp-empty" role="status">Loading activities…</p></div>
    </section>`;
  }

  function notSharedHtml(sharing) {
    const status = sharing && sharing.status;
    if (status === 'disabled') {
      return `<div class="sa-gate"><strong>Strava sharing is switched off</strong>
        <p>Coach access to shared Strava activities is turned off for this deployment (STRAVA_COACH_SHARING). Programme compliance still uses the athlete’s submitted logs.</p></div>`;
    }
    if (status === 'unavailable') {
      return `<div class="sa-gate"><strong>Sharing status unavailable</strong>
        <p>The sharing record could not be read, so nothing is shown. If this persists, check the strava_coach_sharing migration has been applied.</p></div>`;
    }
    const revoked = status === 'revoked';
    return `<div class="sa-gate"><strong>${revoked ? 'The athlete stopped sharing Strava activities' : 'Not shared by the athlete'}</strong>
      <p>${revoked
        ? 'They turned sharing off, or disconnected Strava. Nothing from their Strava account is visible to coaches until they share again.'
        : 'Strava activities appear here only after the athlete turns on “Share Strava activities with my coaches” in the portal under Preferences.'}
      Compliance still uses their submitted portal logs.</p></div>`;
  }

  function chip(group, value, label, active, count) {
    return `<button type="button" class="sa-chip${active ? ' is-active' : ''}" data-sa-${group}="${esc(value)}" aria-pressed="${active}">${esc(label)}${count != null ? ` <span>${esc(String(count))}</span>` : ''}</button>`;
  }

  function toolbarHtml(state, items) {
    const count = key => items.filter(i => statusGroup(i) === key).length;
    return `<div class="sa-toolbar">
      <div class="sa-range" role="group" aria-label="Date range">
        ${chip('preset', 'this', 'This week', state.preset === 'this')}
        ${chip('preset', 'last', 'Last week', state.preset === 'last')}
        ${chip('preset', 'four', 'Last 4 weeks', state.preset === 'four')}
        <span class="sa-custom">
          <label><span class="sr-only">From</span><input type="date" data-sa-date="start" value="${esc(state.start)}" max="${esc(state.end)}"></label>
          <span aria-hidden="true">–</span>
          <label><span class="sr-only">To</span><input type="date" data-sa-date="end" value="${esc(state.end)}" min="${esc(state.start)}"></label>
        </span>
      </div>
      <div class="sa-filters" role="group" aria-label="Show">
        ${chip('show', 'all', 'All activities', state.show === 'all')}
        ${chip('show', 'programmed', 'Programmed', state.show === 'programmed', count('programmed'))}
        ${chip('show', 'unprogrammed', 'Unprogrammed', state.show === 'unprogrammed', count('unprogrammed'))}
        ${chip('show', 'needs_review', 'Needs review', state.show === 'needs_review', count('needs_review'))}
      </div>
      <div class="sa-filters" role="group" aria-label="Sport">
        ${chip('sport', 'all', 'All sports', state.sport === 'all')}
        ${chip('sport', 'running', 'Running', state.sport === 'running')}
        ${chip('sport', 'cycling', 'Cycling', state.sport === 'cycling')}
        ${chip('sport', 'swimming', 'Swimming', state.sport === 'swimming')}
        ${chip('sport', 'strength', 'Strength', state.sport === 'strength')}
      </div>
    </div>`;
  }

  function statusGroup(item) {
    if (item.status === 'needs_review') return 'needs_review';
    if (item.status === 'unprogrammed') return 'unprogrammed';
    return 'programmed'; // programmed, missed, awaiting_sync, upcoming
  }

  function itemSport(item) {
    return item.activity ? item.activity.sport : item.session.sport;
  }

  function visible(items, state) {
    return items.filter(item => (state.show === 'all' || statusGroup(item) === state.show) &&
      (state.sport === 'all' || itemSport(item) === state.sport));
  }

  // ── Load overview (prescribed vs actual) ───────────────────────────────────

  function countLine(sessions, distanceM, sport) {
    if (!sessions) return null;
    const [one, many] = SPORT_NOUN[sport] || ['Session', 'Sessions'];
    const dist = fmtDistance(distanceM, sport);
    return `${sessions} ${sessions === 1 ? one : many}${dist ? ` · ${dist}` : ''}`;
  }

  function overviewHtml(week, weeks) {
    if (!week) return '';
    const p = week.prescribed;
    const a = week.actual;
    const prescribedLines = ['running', 'cycling', 'swimming', 'strength']
      .map(sport => countLine(p[sport].sessions, p[sport].km != null ? p[sport].km * 1000 : null, sport)).filter(Boolean);
    const actualLines = ['running', 'cycling', 'swimming', 'strength', 'walking', 'other']
      .map(sport => countLine(a[sport].sessions, a[sport].distanceM, sport)).filter(Boolean);
    const extraLines = ['running', 'cycling', 'swimming', 'strength', 'walking', 'other']
      .filter(sport => week.additional[sport] > 0)
      .map(sport => {
        const [one, many] = SPORT_NOUN[sport];
        return `+${week.additional[sport]} ${week.additional[sport] === 1 ? one : many}`;
      });
    const list = lines => (lines.length ? `<ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="sa-none">None</p>');

    const prog = week.programme;
    const decided = prog.completed + prog.missed;
    const variance = week.variance.runningKm;
    const trend = (weeks || []).slice(-4);
    const effortTrend = trend.map(w => `<span title="${esc(fmtRange(w.weekStart, w.weekEnd))}">${w.overall.relativeEffort == null ? '—' : esc(fmtNum(w.overall.relativeEffort))}</span>`).join('<i aria-hidden="true">›</i>');
    const daysTrend = trend.map(w => `<span>${esc(String(w.overall.activeDays))}</span>`).join('<i aria-hidden="true">›</i>');

    return `<div class="sa-load" aria-label="Training load, ${esc(fmtRange(week.weekStart, week.weekEnd))}">
      <div class="sa-load-head"><span class="cws-lbl">${week.state === 'current' ? 'This week' : esc(fmtRange(week.weekStart, week.weekEnd))}</span>
        <span class="sa-load-note">Additional training is shown for context, not judged.</span></div>
      <div class="sa-compare">
        <div class="sa-col"><div class="sa-col-lbl">Programmed</div>${list(prescribedLines)}</div>
        <div class="sa-col"><div class="sa-col-lbl">Actually completed</div>${list(actualLines)}</div>
        <div class="sa-col is-extra"><div class="sa-col-lbl">Additional training</div>${list(extraLines)}</div>
      </div>
      <div class="cws-grid sa-metrics">
        <div class="cws-tile"><div class="cws-lbl">Compliance</div><div class="cws-num">${decided ? esc(String(prog.completed)) : '—'}<span>${decided ? `/${esc(String(decided))}` : ''}</span></div>
          <div class="cws-sub">${prog.compliancePercent == null ? 'No programmed sessions due yet' : `${esc(String(prog.compliancePercent))}% of due sessions`}${prog.upcoming ? ` · ${esc(String(prog.upcoming))} to come` : ''}</div></div>
        <div class="cws-tile"><div class="cws-lbl">Running distance</div><div class="cws-num">${esc(fmtNum(a.running.distanceKm || 0, 1))}<span> km</span></div>
          <div class="cws-sub">${variance == null ? 'No planned running distance' : `${variance > 0 ? '+' : ''}${esc(fmtNum(variance, 1))} km vs ${esc(fmtNum(p.running.km, 1))} planned${p.running.upcomingKm ? ` · ${esc(fmtNum(p.running.upcomingKm, 1))} km still to come` : ''}`}</div></div>
        <div class="cws-tile"><div class="cws-lbl">Training time</div><div class="cws-num cws-word">${esc(fmtMinutes(week.overall.trainingMinutes) || '0 min')}</div>
          <div class="cws-sub">${esc(String(week.overall.activities))} activities · ${esc(String(week.overall.activeDays))} active days</div></div>
        <div class="cws-tile"><div class="cws-lbl">Unprogrammed</div><div class="cws-num">${esc(String(week.overall.unprogrammedCompleted))}</div>
          <div class="cws-sub">${esc(String(week.overall.programmedCompleted))} programmed completed · ${esc(String(week.overall.missed))} missed</div></div>
        <div class="cws-tile"><div class="cws-lbl">Relative Effort</div><div class="cws-num">${week.overall.relativeEffort == null ? '—' : esc(fmtNum(week.overall.relativeEffort))}</div>
          <div class="cws-sub sa-trend" aria-label="Last four weeks">${effortTrend}</div></div>
        <div class="cws-tile"><div class="cws-lbl">Active days</div><div class="cws-num">${esc(String(week.overall.activeDays))}<span>/7</span></div>
          <div class="cws-sub sa-trend" aria-label="Last four weeks">${daysTrend}</div></div>
      </div>
    </div>`;
  }

  function totalsTableHtml(weeks, range) {
    const shown = weeks.filter(w => w.weekEnd >= range.startDate && w.weekStart <= range.endDate);
    if (!shown.length) return '';
    const rows = [];
    shown.forEach(w => {
      ['running', 'cycling', 'swimming', 'strength'].forEach(sport => {
        const p = w.prescribed[sport];
        const a = w.actual[sport];
        if (!p.sessions && !a.sessions) return;
        rows.push(`<tr>
          ${shown.length > 1 ? `<td class="sa-wk">${esc(fmtDay(w.weekStart, { day: 'numeric', month: 'short' }))}</td>` : ''}
          <th scope="row">${esc(SPORT_LABEL[sport])}</th>
          <td>${p.sessions ? `${esc(String(p.sessions))}${p.km ? ` · ${esc(fmtDistance(p.km * 1000, sport))}` : ''}` : '—'}</td>
          <td>${a.sessions ? `${esc(String(a.sessions))}${a.distanceM ? ` · ${esc(fmtDistance(a.distanceM, sport))}` : ''}` : '0'}</td>
          <td>${esc(fmtMinutes(a.durationMinutes) || '—')}</td>
        </tr>`);
      });
    });
    if (!rows.length) return '';
    return `<div class="cws-row"><div class="cws-lbl">Prescribed vs actual</div><div class="cp-table-wrap"><table class="cp-table sa-table">
      <thead><tr>${shown.length > 1 ? '<th scope="col">Week</th>' : ''}<th scope="col">Sport</th><th scope="col">Prescribed</th><th scope="col">Actual</th><th scope="col">Actual time</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>
      <p class="cws-note">Actual includes programmed and unprogrammed Strava activities, plus programmed sessions logged in the portal without Strava. Each workout is counted once.</p></div>`;
  }

  // ── Activity list ──────────────────────────────────────────────────────────

  function pill(status) {
    const s = STATUS[status] || STATUS.unprogrammed;
    return `<span class="sa-pill is-${esc(status)}"><span aria-hidden="true">${s.glyph}</span>${esc(s.short)}</span>`;
  }

  function itemTitle(item) {
    if (item.activity) {
      const dist = fmtDistance(item.activity.distanceM, item.activity.sport);
      return `${item.activity.name || item.activity.sportType || 'Activity'}${dist ? ` — ${dist}` : ''}`;
    }
    const s = item.session;
    const planned = s.plannedKm ? ` — ${fmtDistance(s.plannedKm * 1000, s.sport)}` : '';
    return `${s.title}${planned && !/\d\s*km/i.test(s.title) ? planned : ''}`;
  }

  function itemMeta(item) {
    const parts = [];
    if (item.activity) {
      const a = item.activity;
      if (a.startTime) parts.push(a.startTime);
      const t = fmtDuration(a.movingTimeS);
      if (t) parts.push(t);
      if (a.sport === 'running' && a.paceSecPerKm) parts.push(fmtPace(a.paceSecPerKm));
      if (a.averageHeartrate) parts.push(`${Math.round(a.averageHeartrate)} bpm`);
      if (item.session && item.status !== 'unprogrammed') parts.push(`for “${item.session.title}”`);
    } else {
      const manual = item.manual;
      if (item.status === 'programmed') parts.push('Logged in portal, no Strava activity');
      if (manual && manual.movingTimeS) parts.push(fmtDuration(manual.movingTimeS));
      if (manual && manual.distanceM) parts.push(fmtDistance(manual.distanceM, item.session.sport));
      if (item.session.plannedMinutes && item.status !== 'programmed') parts.push(`${item.session.plannedMinutes} min planned`);
      if (item.session.rescheduled) parts.push('rescheduled');
    }
    return parts.map(esc).join(' · ');
  }

  function detailHtml(item, data) {
    const rows = [];
    const add = (label, value) => { if (value != null && value !== '') rows.push(`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`); };
    const actions = [];
    if (item.activity) {
      const a = item.activity;
      add('Type', a.sportType);
      add('Date', `${fmtDay(a.date)}${a.startTime ? `, ${a.startTime}` : ''}`);
      add('Distance', fmtDistance(a.distanceM, a.sport));
      add('Moving time', fmtDuration(a.movingTimeS));
      add('Elapsed time', fmtDuration(a.elapsedTimeS));
      if (a.sport === 'running') add('Average pace', fmtPace(a.paceSecPerKm));
      else if (a.averageSpeedMps) add('Average speed', `${fmtNum(a.averageSpeedMps * 3.6, 1)} km/h`);
      add('Average HR', a.averageHeartrate ? `${Math.round(a.averageHeartrate)} bpm` : null);
      add('Max HR', a.maxHeartrate ? `${Math.round(a.maxHeartrate)} bpm` : null);
      add('Elevation gain', a.elevationGainM ? `${fmtNum(a.elevationGainM)} m` : null);
      add('Average power', a.averageWatts ? `${Math.round(a.averageWatts)} W` : null);
      add('Relative Effort', a.relativeEffort != null ? fmtNum(a.relativeEffort) : null);
      add('Source', `${a.source}${a.indoor ? ' · indoor' : ''}`);
    } else {
      add('Programmed for', fmtDay(item.session.date));
      if (item.session.plannedKm) add('Planned distance', fmtDistance(item.session.plannedKm * 1000, item.session.sport));
      if (item.session.plannedMinutes) add('Planned time', `${item.session.plannedMinutes} min`);
      add('Status', STATUS[item.status] ? STATUS[item.status].label : item.status);
    }

    let matchNote = '';
    if (item.match) {
      const reasons = (item.match.reasons || []).map(r => REASON_COPY[r]).filter(Boolean);
      matchNote = `<p class="sa-match">${esc(VIA_COPY[item.match.via] || 'Matched')} to <strong>${esc(item.session.title)}</strong>${item.match.groupSize > 1 ? ` (with ${item.match.groupSize - 1} linked run${item.match.groupSize > 2 ? 's' : ''})` : ''}.${item.match.sessionCompletedInPortal ? ' The athlete also logged this session in the portal.' : ''}</p>
        ${reasons.length ? `<ul class="sa-reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}`;
    }

    if (item.activity && item.session && (item.status === 'needs_review' || item.status === 'programmed')) {
      const ids = `data-sa-activity="${esc(item.activity.id)}" data-sa-session="${esc(item.session.key)}"`;
      if (item.status === 'needs_review') actions.push(`<button type="button" class="cp-btn sa-confirm" ${ids} data-sa-decision="confirmed">Confirm match</button>`);
      actions.push(`<button type="button" class="cp-btn" ${ids} data-sa-decision="rejected">${item.status === 'needs_review' ? 'Not this session' : 'Unlink: not this session'}</button>`);
      if (item.match && item.match.via === 'coach') actions.push(`<button type="button" class="cp-btn" ${ids} data-sa-decision="clear">Undo coach decision</button>`);
    }
    if (item.activity && item.status === 'unprogrammed') {
      const near = (data.sessions || []).filter(s => !s.activityKeys.length && s.status !== 'completed' &&
        Math.abs(dateFrom(s.date) - dateFrom(item.activity.date)) <= 3 * 86400000);
      if (near.length) {
        actions.push(`<label class="sa-link"><span>Link to a programmed session</span>
          <select data-sa-link-activity="${esc(item.activity.id)}">
            <option value="">Choose a session…</option>
            ${near.map(s => `<option value="${esc(s.key)}">${esc(fmtDay(s.date, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${esc(s.title)}</option>`).join('')}
          </select></label>
          <button type="button" class="cp-btn" data-sa-link="${esc(item.activity.id)}">Link</button>`);
      }
    }
    if (item.activity) {
      // A coach rejection is permanent until a coach clears it, so the way
      // back has to be visible on the activity it hid.
      (data.reviews || []).filter(r => r.decision === 'rejected' && r.activityId === item.activity.id).forEach(r => {
        const target = (data.sessions || []).find(s => s.key === r.sessionKey);
        actions.push(`<button type="button" class="cp-btn" data-sa-activity="${esc(item.activity.id)}" data-sa-session="${esc(r.sessionKey)}" data-sa-decision="clear">Undo rejection${target ? `: ${esc(target.title)}` : ''}</button>`);
      });
    }
    if (item.activity && item.activity.stravaUrl) {
      actions.push(`<a class="sa-strava-link" href="${esc(item.activity.stravaUrl)}" target="_blank" rel="noopener noreferrer">View on Strava</a>`);
    }

    return `<div class="sa-detail" id="sa-detail-${esc(item.key.replace(/[^A-Za-z0-9_-]/g, '_'))}">
      ${matchNote}
      <dl class="sa-dl">${rows.join('')}</dl>
      ${actions.length ? `<div class="sa-actions">${actions.join('')}</div>` : ''}
      <p class="sa-status" role="status"></p>
    </div>`;
  }

  function listHtml(items, data, state) {
    const shown = visible(items, state);
    if (!items.length) return '<p class="cp-empty">No Strava activities or programmed sessions in this range.</p>';
    if (!shown.length) return '<p class="cp-empty">Nothing matches these filters.</p>';
    const byDay = new Map();
    shown.forEach(item => {
      const date = item.activity ? item.activity.date : item.session.date;
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date).push(item);
    });
    return `<ol class="sa-days">${[...byDay.entries()].map(([date, dayItems]) => `<li class="sa-day">
      <div class="sa-day-head">${esc(fmtDay(date))}</div>
      <ul class="sa-items">${dayItems.map(item => {
        const sport = itemSport(item);
        const open = state.open === item.key;
        const detailId = `sa-detail-${item.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        return `<li class="sa-item is-${esc(item.status)}${open ? ' is-open' : ''}">
          <button type="button" class="sa-row" data-sa-open="${esc(item.key)}" aria-expanded="${open}" aria-controls="${esc(detailId)}">
            <span class="sa-sport is-${esc(sport)}" aria-hidden="true">${esc(SPORT_ICON[sport] || '·')}</span>
            <span class="sa-main"><span class="sa-title">${esc(itemTitle(item))}</span><span class="sa-meta">${itemMeta(item)}</span></span>
            ${pill(item.status)}
            <span class="sr-only">${esc(SPORT_LABEL[sport] || '')}, ${esc((STATUS[item.status] || {}).label || '')}</span>
          </button>
          ${open ? detailHtml(item, data) : ''}
        </li>`;
      }).join('')}</ul></li>`).join('')}</ol>`;
  }

  function syncNote(data) {
    const sync = data.sync || {};
    const parts = [];
    if (!sync.connected) parts.push('Strava is not connected for this athlete, so no new activities will arrive.');
    else if (sync.pendingEvents) parts.push(`${sync.pendingEvents} Strava update${sync.pendingEvents === 1 ? '' : 's'} still syncing; recent sessions show as “Syncing” rather than missed.`);
    if (data.dataQuality && data.dataQuality.partial) parts.push(`Partial data: ${data.dataQuality.missingSources.join(', ')} could not be read.`);
    return parts.length ? `<p class="cp-partial" role="status">${esc(parts.join(' '))}</p>` : '';
  }

  function bodyHtml(code, data) {
    const state = stateFor(code);
    if (!data.sharing || data.sharing.status !== 'granted') return notSharedHtml(data.sharing);
    const items = data.items || [];
    const weeks = data.weeks || [];
    const focusWeek = weeks.find(w => w.weekStart === mondayOf(data.range.endDate)) || weeks[weeks.length - 1];
    return `${toolbarHtml(state, items)}
      ${syncNote(data)}
      ${overviewHtml(focusWeek, weeks)}
      ${totalsTableHtml(weeks, data.range)}
      <div class="cws-row"><div class="cws-lbl">Activities · ${esc(fmtRange(data.range.startDate, data.range.endDate))}</div>${listHtml(items, data, state)}</div>
      <p class="sa-foot">Activity data from Strava, shared by the athlete${data.sharing.grantedAt ? ` since ${esc(fmtDay(String(data.sharing.grantedAt).slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' }))}` : ''}. Summaries only: no routes or locations.</p>`;
  }

  function paint(section, entry) {
    const body = section.querySelector('.sa-body');
    if (!body) return;
    section.setAttribute('aria-busy', entry.status === 'loading' ? 'true' : 'false');
    if (entry.status === 'loading') {
      body.innerHTML = entry.data ? bodyHtml(section.dataset.saCode, entry.data) : '<p class="cp-empty" role="status">Loading activities…</p>';
    } else if (entry.status === 'error') {
      body.innerHTML = `<p class="cp-partial" role="alert">${esc(entry.error)} <button type="button" class="cp-link" data-sa-retry>Retry</button></p>`;
    } else {
      body.innerHTML = bodyHtml(section.dataset.saCode, entry.data);
    }
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  function liveSection(code) {
    return root.document && root.document.querySelector(`.sa[data-sa-code="${CSS.escape(code)}"]`);
  }

  async function load(code, { force = false } = {}) {
    const state = stateFor(code);
    const key = `${code}|${state.start}|${state.end}`;
    const cached = cache.get(key);
    const section = liveSection(code);
    if (cached && !force && cached.status !== 'error') {
      if (section) paint(section, cached);
      if (cached.status !== 'loading') return cached;
    }
    const previous = cached && cached.data;
    const entry = { status: 'loading', data: previous || null };
    cache.set(key, entry);
    if (section) paint(section, entry);
    try {
      const params = new URLSearchParams({ action: 'strava_activities', code, start: state.start, end: state.end });
      const response = await root.fetch(`/api/athletes?${params}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        Object.assign(entry, { status: 'error', error: data.error || `Activities could not be loaded (HTTP ${response.status}).` });
      } else {
        Object.assign(entry, { status: 'ready', data });
      }
    } catch {
      Object.assign(entry, { status: 'error', error: 'Activities could not be loaded. Check the connection and retry.' });
    }
    const live = liveSection(code);
    const current = stateFor(code);
    if (live && `${code}|${current.start}|${current.end}` === key) paint(live, entry);
    return entry;
  }

  function hydrate(container) {
    if (!container) return;
    container.querySelectorAll('.sa[data-sa-code]').forEach(section => load(section.dataset.saCode));
  }

  function repaint(code) {
    const state = stateFor(code);
    const entry = cache.get(`${code}|${state.start}|${state.end}`);
    const section = liveSection(code);
    if (section && entry) paint(section, entry);
    else if (section) load(code);
  }

  async function decide(button, code, activityId, sessionKey, decision) {
    const detail = button.closest('.sa-detail');
    const status = detail && detail.querySelector('.sa-status');
    detail && detail.querySelectorAll('button, select').forEach(el => { el.disabled = true; });
    if (status) status.textContent = 'Saving…';
    try {
      const response = await root.fetch('/api/athletes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'strava_review', code, activityId, sessionKey, decision }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      // Every cached range for this athlete may now classify differently.
      [...cache.keys()].filter(k => k.startsWith(`${code}|`)).forEach(k => cache.delete(k));
      await load(code, { force: true });
    } catch (error) {
      if (status) status.textContent = `Not saved: ${error.message}`;
      detail && detail.querySelectorAll('button, select').forEach(el => { el.disabled = false; });
    }
  }

  function onClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const section = target.closest('.sa[data-sa-code]');
    if (!section) return;
    const code = section.dataset.saCode;
    const state = stateFor(code);

    const preset = target.closest('[data-sa-preset]');
    if (preset) {
      Object.assign(state, { preset: preset.dataset.saPreset, ...rangeFor(preset.dataset.saPreset), open: '' });
      writePrefs(state);
      load(code);
      return;
    }
    const show = target.closest('[data-sa-show]');
    if (show) { state.show = show.dataset.saShow; writePrefs(state); repaint(code); return; }
    const sport = target.closest('[data-sa-sport]');
    if (sport) { state.sport = sport.dataset.saSport; writePrefs(state); repaint(code); return; }
    const open = target.closest('[data-sa-open]');
    if (open) {
      state.open = state.open === open.dataset.saOpen ? '' : open.dataset.saOpen;
      repaint(code);
      const row = liveSection(code)?.querySelector(`[data-sa-open="${CSS.escape(open.dataset.saOpen)}"]`);
      if (row) row.focus();
      return;
    }
    const decision = target.closest('[data-sa-decision]');
    if (decision) {
      decide(decision, code, decision.dataset.saActivity, decision.dataset.saSession, decision.dataset.saDecision);
      return;
    }
    const link = target.closest('[data-sa-link]');
    if (link) {
      const select = section.querySelector(`select[data-sa-link-activity="${CSS.escape(link.dataset.saLink)}"]`);
      const sessionKey = select && select.value;
      if (!sessionKey) {
        const status = link.closest('.sa-detail')?.querySelector('.sa-status');
        if (status) status.textContent = 'Choose a session to link first.';
        return;
      }
      decide(link, code, link.dataset.saLink, sessionKey, 'confirmed');
      return;
    }
    if (target.closest('[data-sa-retry]')) {
      cache.delete(`${code}|${state.start}|${state.end}`);
      load(code, { force: true });
    }
  }

  function onChange(event) {
    const input = event.target;
    if (!input || !input.matches || !input.matches('[data-sa-date]')) return;
    const section = input.closest('.sa[data-sa-code]');
    if (!section) return;
    const code = section.dataset.saCode;
    const state = stateFor(code);
    const value = isoDate(input.value);
    if (!value) return;
    const next = { ...state, [input.dataset.saDate]: value };
    if (next.start > next.end) return;
    const days = Math.round((dateFrom(next.end) - dateFrom(next.start)) / 86400000) + 1;
    if (days > 92) {
      input.setCustomValidity('Choose 92 days or fewer');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    Object.assign(state, { start: next.start, end: next.end, preset: 'custom', open: '' });
    load(code);
  }

  const api = { placeholder, hydrate, load, _cache: cache, _view: view, _bodyHtml: bodyHtml, _rangeFor: rangeFor };
  root.DP_STRAVA = api;

  if (root.document && typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('click', onClick);
    root.document.addEventListener('change', onChange);
  }
})(typeof window !== 'undefined' ? window : globalThis);
