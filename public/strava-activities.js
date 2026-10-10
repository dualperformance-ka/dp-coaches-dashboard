// Strava activity inside the athlete's Training ledger.
//
// Every Strava activity the portal has synced for an athlete with Strava
// connected, classified against the programme, merged into the existing
// day-by-day ledger rather than listed in a section of its own:
//   - each day's Strava column gets a compact card per activity, labelled
//     Programmed, Unprogrammed or Review, expandable for detail and actions;
//     runs the athlete already submitted keep their existing card and are not
//     shown twice
//   - one compact strip above the ledger gives the week's programmed vs actual
//     totals, unprogrammed count, reviews and compliance
// The week is whatever week the ledger is showing.
//
// Data arrives from /api/athletes?action=strava_activities, which enforces the
// coach's athlete scope and the athlete's Strava connection before it reads
// anything. Decisions go back through the same coach-gated route. The browser
// never talks to Supabase or Strava, and nothing is stored on the device.
(function (root) {
  'use strict';

  const TZ = 'Australia/Adelaide';
  const cache = new Map(); // `${code}|${start}|${end}` -> entry

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

  // ── Week from the ledger ───────────────────────────────────────────────────

  function columnsFor(code) {
    if (!root.document) return [];
    return [...root.document.querySelectorAll(`#fp-body .wd-strava-col[data-wd-strava-id="${CSS.escape(code)}"]`)];
  }

  function ledgerRange(code) {
    const dates = columnsFor(code).map(col => isoDate(col.dataset.wdStravaDate)).filter(Boolean).sort();
    if (dates.length) return { start: dates[0], end: dates[dates.length - 1] };
    const monday = mondayOf(todayISO());
    return { start: monday, end: addDays(monday, 6) };
  }

  // Activity ids the ledger already shows as an athlete-submitted Strava card
  // (training_session_logs.client_write_id is strava_<activity id>, or a group
  // of linked runs), so the same run is never drawn twice in one column.
  function submittedIds(column) {
    const ids = new Set();
    column.querySelectorAll('[data-strava-write]').forEach(card => {
      (String(card.dataset.stravaWrite || '').match(/\d{5,}/g) || []).forEach(id => ids.add(id));
    });
    return ids;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function placeholder(code) {
    if (!code) return '';
    return `<section class="sa sa-strip" data-sa-code="${esc(code)}" aria-label="Strava activity this week" aria-busy="true">
      <div class="sa-strip-body"><span class="sa-strip-lbl">Strava</span><span class="sa-quiet" role="status">Loading activities…</span></div>
    </section>`;
  }

  function notConnectedHtml(connection) {
    const status = connection && connection.status;
    const text = status === 'disabled'
      ? 'Strava activities are switched off for this deployment (STRAVA_COACH_SHARING=off).'
      : status === 'unavailable'
        ? 'The Strava connection could not be checked, so no activities are shown.'
        : 'Not connected. Activities appear in the ledger as soon as the athlete connects Strava in the portal.';
    return `<div class="sa-strip-body"><span class="sa-strip-lbl">Strava</span><span class="sa-quiet">${esc(text)}</span></div>`;
  }

  function pill(status) {
    const s = STATUS[status] || STATUS.unprogrammed;
    return `<span class="sa-pill is-${esc(status)}"><span aria-hidden="true">${s.glyph}</span>${esc(s.short)}</span>`;
  }

  // "3 Runs · 46.5km, planned 4 · 63km". Actual counts every activity, so it
  // can exceed the plan; it is never written as a fraction of it.
  function sportChip(sport, prescribed, actual) {
    const p = prescribed || { sessions: 0, km: null };
    const a = actual || { sessions: 0, distanceM: null };
    if (!p.sessions && !a.sessions) return '';
    const [one, many] = SPORT_NOUN[sport];
    const noun = n => (n === 1 ? one : many);
    const actualDist = sport !== 'strength' ? fmtDistance(a.distanceM, sport) : null;
    const plannedDist = sport !== 'strength' && p.km ? fmtDistance(p.km * 1000, sport) : null;
    const plan = p.sessions ? `planned ${p.sessions}${plannedDist ? ` · ${plannedDist}` : ''}` : '';
    return `<span class="sa-chip-stat"><strong>${esc(String(a.sessions))}</strong> ${esc(noun(a.sessions))}${actualDist ? ` · ${esc(actualDist)}` : ''}${plan ? `<em>, ${esc(plan)}</em>` : ''}</span>`;
  }

  function stripHtml(data) {
    if (!data.connection || data.connection.status !== 'connected') return notConnectedHtml(data.connection);
    const weeks = data.weeks || [];
    const week = weeks.find(w => w.weekStart === mondayOf(data.range.startDate)) || weeks[weeks.length - 1];
    if (!week) return notConnectedHtml(null);
    const p = week.prescribed;
    const a = week.actual;
    const prog = week.programme;
    const decided = prog.completed + prog.missed;
    const extra = week.overall.unprogrammedCompleted;
    const reviews = week.overall.needsReview;
    const chips = [
      sportChip('running', p.running, a.running),
      sportChip('cycling', p.cycling, a.cycling),
      sportChip('swimming', p.swimming, a.swimming),
      sportChip('strength', p.strength, a.strength),
      a.walking.sessions ? sportChip('walking', null, a.walking) : '',
      extra ? `<span class="sa-chip-stat is-extra"><strong>+${esc(String(extra))}</strong> unprogrammed</span>` : '',
      reviews ? `<button type="button" class="sa-chip-stat is-review" data-sa-jump="needs_review"><strong>${esc(String(reviews))}</strong> to review</button>` : '',
      week.overall.trainingMinutes ? `<span class="sa-chip-stat"><strong>${esc(fmtMinutes(week.overall.trainingMinutes))}</strong> training</span>` : '',
      decided ? `<span class="sa-chip-stat"><strong>${esc(String(prog.completed))}/${esc(String(decided))}</strong> due sessions done</span>` : '',
    ].filter(Boolean).join('');

    const trend = weeks.slice(-4);
    const trendRow = (label, pick) => `<div class="sa-trend-row"><span>${esc(label)}</span>${trend.map(w => {
      const v = pick(w);
      return `<span title="${esc(fmtRange(w.weekStart, w.weekEnd))}">${v == null ? '—' : esc(String(v))}</span>`;
    }).join('<i aria-hidden="true">›</i>')}</div>`;
    const variance = week.variance.runningKm;
    const sync = data.sync || {};
    const notes = [];
    if (sync.pendingEvents) notes.push(`${sync.pendingEvents} Strava update${sync.pendingEvents === 1 ? '' : 's'} still syncing.`);
    if (data.dataQuality && data.dataQuality.partial) notes.push(`Partial data: ${data.dataQuality.missingSources.join(', ')} could not be read.`);

    return `<div class="sa-strip-body">
        <span class="sa-strip-lbl">Strava</span>
        <div class="sa-chips">${chips || '<span class="sa-quiet">No activities this week.</span>'}</div>
      </div>
      ${notes.length ? `<p class="sa-quiet sa-note" role="status">${esc(notes.join(' '))}</p>` : ''}
      <details class="sa-more">
        <summary>More</summary>
        <div class="sa-more-body">
          ${variance != null ? `<div class="sa-trend-row"><span>Running vs plan</span><span>${variance > 0 ? '+' : ''}${esc(fmtNum(variance, 1))} km${p.running.upcomingKm ? ` · ${esc(fmtNum(p.running.upcomingKm, 1))} km still to come` : ''}</span></div>` : ''}
          ${trendRow('Relative Effort, 4 wk', w => (w.overall.relativeEffort == null ? null : fmtNum(w.overall.relativeEffort)))}
          ${trendRow('Active days, 4 wk', w => w.overall.activeDays)}
          ${trendRow('Training time, 4 wk', w => fmtMinutes(w.overall.trainingMinutes) || '0')}
          <p class="sa-quiet">Unprogrammed work is shown for context and never counts against compliance. Activity data from Strava; summaries only, no routes or locations.</p>
        </div>
      </details>`;
  }

  function cardHtml(item, data) {
    const a = item.activity;
    const dist = fmtDistance(a.distanceM, a.sport);
    const meta = [
      a.startTime,
      fmtDuration(a.movingTimeS),
      a.sport === 'running' && a.paceSecPerKm ? fmtPace(a.paceSecPerKm) : null,
      a.averageHeartrate ? `${Math.round(a.averageHeartrate)} bpm` : null,
      item.session && item.status !== 'unprogrammed' ? `for “${item.session.title}”` : null,
    ].filter(Boolean).map(esc).join(' · ');
    const type = a.sportType ? String(a.sportType).replace(/([a-z])([A-Z])/g, '$1 $2') : (SPORT_LABEL[a.sport] || 'Activity');
    return `<details class="sa-card is-${esc(item.status)}" data-sa-item="${esc(item.key)}"${item.status === 'needs_review' ? ' data-sa-review' : ''}>
      <summary>
        <span class="sa-card-head"><span class="sa-card-type">Strava · ${esc(type)}</span>${pill(item.status)}</span>
        <span class="sa-card-name">${esc(a.name || type)}${dist ? ` <span>${esc(dist)}</span>` : ''}</span>
        ${meta ? `<span class="sa-card-meta">${meta}</span>` : ''}
      </summary>
      ${detailHtml(item, data)}
    </details>`;
  }

  function paintLanes(code, data) {
    columnsFor(code).forEach(column => {
      column.querySelectorAll('.sa-lane').forEach(lane => lane.remove());
      if (!data || !data.connection || data.connection.status !== 'connected') return;
      const date = column.dataset.wdStravaDate;
      const shown = submittedIds(column);
      const items = (data.items || []).filter(item => item.kind === 'activity' && item.activity.date === date &&
        !shown.has(String(item.activity.id)));
      if (!items.length) return;
      column.insertAdjacentHTML('beforeend', `<div class="sa-lane">${items.map(item => cardHtml(item, data)).join('')}</div>`);
    });
  }

  function paint(section, entry) {
    const code = section.dataset.saCode;
    section.setAttribute('aria-busy', entry.status === 'loading' ? 'true' : 'false');
    if (entry.status === 'error') {
      section.innerHTML = `<div class="sa-strip-body"><span class="sa-strip-lbl">Strava</span><span class="sa-quiet" role="alert">${esc(entry.error)} <button type="button" class="cp-link" data-sa-retry>Retry</button></span></div>`;
      return;
    }
    if (!entry.data) return;
    section.innerHTML = stripHtml(entry.data);
    paintLanes(code, entry.data);
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

  // ── Loading ────────────────────────────────────────────────────────────────

  function liveSection(code) {
    return root.document && root.document.querySelector(`.sa[data-sa-code="${CSS.escape(code)}"]`);
  }

  async function load(code, { force = false } = {}) {
    const range = ledgerRange(code);
    const key = `${code}|${range.start}|${range.end}`;
    const cached = cache.get(key);
    if (cached && !force && cached.status !== 'error') {
      const section = liveSection(code);
      if (section) paint(section, cached);
      if (cached.status !== 'loading') return cached;
    }
    const entry = { status: 'loading', data: cached && cached.data ? cached.data : null };
    cache.set(key, entry);
    try {
      const params = new URLSearchParams({ action: 'strava_activities', code, start: range.start, end: range.end });
      const response = await root.fetch(`/api/athletes?${params}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        Object.assign(entry, { status: 'error', error: data.error || `Strava activities could not be loaded (HTTP ${response.status}).` });
      } else {
        Object.assign(entry, { status: 'ready', data });
      }
    } catch {
      Object.assign(entry, { status: 'error', error: 'Strava activities could not be loaded.' });
    }
    // The coach may have moved to another week or athlete while this loaded.
    const live = liveSection(code);
    const now = ledgerRange(code);
    if (live && `${code}|${now.start}|${now.end}` === key) paint(live, entry);
    return entry;
  }

  function hydrate(container) {
    if (!container) return;
    container.querySelectorAll('.sa[data-sa-code]').forEach(section => load(section.dataset.saCode));
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

  function codeFor(target) {
    const card = target.closest('.sa-card');
    if (card) {
      const column = card.closest('.wd-strava-col');
      return column ? column.dataset.wdStravaId : null;
    }
    const section = target.closest('.sa[data-sa-code]');
    return section ? section.dataset.saCode : null;
  }

  function onClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('.sa-card, .sa[data-sa-code]')) return;
    const code = codeFor(target);
    if (!code) return;

    const jump = target.closest('[data-sa-jump]');
    if (jump) {
      const first = root.document.querySelector(`#fp-body .wd-strava-col[data-wd-strava-id="${CSS.escape(code)}"] .sa-card[data-sa-review]`);
      if (first) {
        first.open = true;
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        first.querySelector('summary')?.focus();
      }
      return;
    }
    const decision = target.closest('[data-sa-decision]');
    if (decision) {
      decide(decision, code, decision.dataset.saActivity, decision.dataset.saSession, decision.dataset.saDecision);
      return;
    }
    const link = target.closest('[data-sa-link]');
    if (link) {
      const select = link.closest('.sa-detail')?.querySelector(`select[data-sa-link-activity="${CSS.escape(link.dataset.saLink)}"]`);
      const sessionKey = select && select.value;
      if (!sessionKey) {
        const status = link.closest('.sa-detail')?.querySelector('.sa-status');
        if (status) status.textContent = 'Choose a session to link first.';
        return;
      }
      decide(link, code, link.dataset.saLink, sessionKey, 'confirmed');
      return;
    }
    if (target.closest('[data-sa-retry]')) load(code, { force: true });
  }

  const api = { placeholder, hydrate, load, _cache: cache, _stripHtml: stripHtml, _cardHtml: cardHtml };
  root.DP_STRAVA = api;

  if (root.document && typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('click', onClick);
  }
})(typeof window !== 'undefined' ? window : globalThis);
