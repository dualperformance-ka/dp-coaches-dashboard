// Coach surfaces for athlete data the portal already stores:
//   - structured pain entries (score, location, the athlete's own note)
//   - the weekly check-in call decision
//   - strength goals, goal rationale and milestones
//   - private athlete messages and data-rights requests (operational queues)
//   - notification delivery health
//   - the athlete's weekly review, coach side
//
// Everything athlete-authored is escaped before it is rendered. Server data
// arrives through /api/coach-data; changes go through the coach-authenticated
// /api/athletes actions via window.maPost. The browser never talks to Supabase.
(function (root) {
  'use strict';

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function present(value) {
    if (value === null || value === undefined) return false;
    const text = String(value).trim();
    return text !== '' && text.toLowerCase() !== 'n/a';
  }

  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmtNum(value, places = 0) {
    const n = num(value);
    if (n === null) return null;
    const factor = 10 ** places;
    const rounded = Math.round(n * factor) / factor;
    return rounded.toLocaleString('en-AU', { maximumFractionDigits: places });
  }

  const TZ = 'Australia/Adelaide';

  function fmtWhen(iso, now = new Date()) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const days = Math.floor((now.getTime() - t) / 86400000);
    if (days <= 0) {
      const hours = Math.floor((now.getTime() - t) / 3600000);
      if (hours <= 0) return 'just now';
      return `${hours}h ago`;
    }
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: 'numeric', month: 'short' }).format(new Date(t));
  }

  function fmtDay(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t));
  }

  // ── Pain ───────────────────────────────────────────────────────────────────

  function bodyPain(row) {
    if (!row) return null;
    const pain = num(row.Pain);
    const location = present(row['Pain Location']) ? String(row['Pain Location']).trim() : '';
    const alert = row['Coach Alert'] === true;
    if (pain === null && !alert && !location) return null;
    return { pain, location, alert, note: present(row['Athlete Note']) ? String(row['Athlete Note']).trim() : '' };
  }

  // A zero is a real answer ("no pain") and is shown quietly; null is "not
  // reported" and shows nothing.
  function painChipHtml(row) {
    const p = bodyPain(row);
    if (!p) return '';
    if (p.pain === 0 && !p.alert) {
      return '<span class="cp-pain is-none">No pain</span>';
    }
    const tone = p.alert || (p.pain !== null && p.pain >= 5) ? 'is-alert' : 'is-low';
    const parts = [];
    parts.push(p.pain !== null ? `Pain <strong>${esc(p.pain)}/10</strong>` : 'Pain');
    if (p.location) parts.push(esc(p.location));
    if (p.alert) parts.push('Coach alert');
    return `<span class="cp-pain ${tone}">${parts.join(' · ')}</span>`;
  }

  function athleteNoteHtml(row) {
    const p = bodyPain(row);
    const note = p?.note || (present(row?.['Athlete Note']) ? String(row['Athlete Note']).trim() : '');
    return note ? `<div class="cp-athlete-note"><span>Athlete note</span> ${esc(note)}</div>` : '';
  }

  // ── Call decision ──────────────────────────────────────────────────────────

  function callDecisionHtml(week, variant) {
    const decision = week && week['Call Decision'];
    if (!present(decision)) return '';
    const cls = variant === 'compact' ? 'cp-call-decision is-compact' : 'cp-call-decision';
    return `<div class="${cls}"><div class="cp-call-decision-label">Call decision</div><div class="cp-call-decision-text">${esc(decision)}</div></div>`;
  }

  // ── Goals ──────────────────────────────────────────────────────────────────

  const INTENT_LABELS = {
    build_strength: 'Build strength',
    strength: 'Build strength',
    maintain: 'Maintain strength',
    maintain_strength: 'Maintain strength',
    injury_resilience: 'Injury resilience',
    resilience: 'Injury resilience',
    body_composition: 'Body composition',
    support_running: 'Support running',
    performance: 'Performance',
  };

  function labelFor(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (INTENT_LABELS[raw.toLowerCase()]) return INTENT_LABELS[raw.toLowerCase()];
    const spaced = raw.replace(/[_-]+/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function trackedLiftText(goal) {
    if (!goal || !present(goal.strength_lift)) return '';
    const current = num(goal.strength_current_load);
    const target = num(goal.strength_target_load);
    const reps = num(goal.strength_reps);
    const loads = current !== null && target !== null
      ? `${fmtNum(current, 1)} kg → ${fmtNum(target, 1)} kg`
      : current !== null ? `${fmtNum(current, 1)} kg now`
        : target !== null ? `target ${fmtNum(target, 1)} kg` : '';
    const repText = reps !== null ? ` × ${fmtNum(reps)}` : '';
    return `${String(goal.strength_lift).trim()}${loads ? `: ${loads}${repText}` : repText}`;
  }

  // includeRationale=false when the client profile panel is already showing
  // why/milestones, so the same text is not printed twice on one screen.
  function goalsPanelHtml(goal, options = {}) {
    if (!goal) return '';
    const rows = [];
    if (present(goal.strength_intent)) rows.push(['Strength intent', labelFor(goal.strength_intent)]);
    if (present(goal.strength_priorities)) {
      const list = String(goal.strength_priorities).split(/[,;|]/).map(s => labelFor(s.trim())).filter(Boolean);
      if (list.length) rows.push(['Priority areas', list.join(', ')]);
    }
    const lift = trackedLiftText(goal);
    if (lift) rows.push(['Tracked lift', lift]);

    const rationale = [];
    if (options.includeRationale !== false) {
      if (present(goal.why)) rationale.push(['Why', goal.why]);
      [['W4', goal.milestone_w4], ['W8', goal.milestone_w8], ['W12', goal.milestone_w12]].forEach(([k, v]) => {
        if (present(v)) rationale.push([`${k} milestone`, v]);
      });
    }
    if (!rows.length && !rationale.length) return '';
    const cls = options.variant === 'card' ? 'sec cp-goals' : 'fpc-section cp-goals';
    const title = options.variant === 'card' ? '<div class="sec-ttl">Goals</div>' : '<div class="fpc-section-title">Goals</div>';
    return `<div class="${cls}">
      ${title}
      ${rows.length ? `<dl class="cp-goal-list">${rows.map(([k, v]) => `<div class="cp-goal-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${rationale.length ? `<dl class="cp-goal-list is-rationale">${rationale.map(([k, v]) => `<div class="cp-goal-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    </div>`;
  }

  // ── Notification health ────────────────────────────────────────────────────

  const DELIVERY_COPY = {
    pushing: 'Pushing to device',
    registered_not_pushed: 'Device registered, nothing pushed yet',
    no_device: 'No registered device: inbox only',
  };

  function notifyLineHtml(row) {
    if (!row) return '';
    const bits = [];
    bits.push(`<strong>${esc(row.devices)}</strong> device${row.devices === 1 ? '' : 's'}`);
    bits.push(row.exempt ? 'Exempt from managed reminders' : 'Managed reminders');
    if (row.unread) bits.push(`${esc(row.unread)} unread in inbox`);
    if (row.queued) bits.push(`${esc(row.queued)} change${row.queued === 1 ? '' : 's'} queued`);
    bits.push(row.lastNotification ? `Last in inbox ${esc(fmtWhen(row.lastNotification))}` : 'Nothing in inbox yet');
    bits.push(row.lastPush ? `Last pushed ${esc(fmtWhen(row.lastPush))}` : 'Never pushed');
    return `<div class="cp-notify-line is-${esc(row.delivery)}"><span class="cp-notify-state">${esc(DELIVERY_COPY[row.delivery] || row.delivery)}</span> ${bits.join(' · ')}</div>`;
  }

  function notifyHealthHtml(rows, nameOf, meta = {}) {
    if (meta.missing) {
      return `<div class="cp-panel"><div class="cp-panel-head"><h2>Notification health</h2></div>
        <p class="cp-partial" role="status">Notification status could not be read. This is missing data, not a squad with no devices.</p></div>`;
    }
    const list = Array.isArray(rows) ? rows : [];
    const sorted = [...list].sort((a, b) => {
      const order = { no_device: 0, registered_not_pushed: 1, pushing: 2 };
      return (order[a.delivery] ?? 3) - (order[b.delivery] ?? 3) || String(nameOf(a.athleteCode)).localeCompare(String(nameOf(b.athleteCode)));
    });
    const noDevice = list.filter(r => r.devices === 0).length;
    return `<div class="cp-panel cp-notify">
      <div class="cp-panel-head"><h2>Notification health</h2><span class="cp-count${noDevice ? ' is-warn' : ''}">${noDevice} without a device</span></div>
      <p class="cp-sub">"In inbox" means the athlete will see it in the portal. "Pushed" means it reached a phone. An athlete with no device only ever gets the inbox.</p>
      ${sorted.length ? `<div class="cp-table-wrap"><table class="cp-table">
        <thead><tr><th scope="col">Athlete</th><th scope="col">Devices</th><th scope="col">Mode</th><th scope="col">Queued</th><th scope="col">Unread</th><th scope="col">Last in inbox</th><th scope="col">Last pushed</th></tr></thead>
        <tbody>${sorted.map(r => `<tr class="is-${esc(r.delivery)}">
          <th scope="row">${esc(nameOf(r.athleteCode))}</th>
          <td>${r.devices ? esc(r.devices) : '<span class="cp-flag">None</span>'}</td>
          <td>${r.exempt ? 'Exempt' : 'Managed'}</td>
          <td>${esc(r.queued)}</td>
          <td>${esc(r.unread)}</td>
          <td>${r.lastNotification ? esc(fmtWhen(r.lastNotification)) : '—'}</td>
          <td>${r.lastPush ? esc(fmtWhen(r.lastPush)) : (r.devices ? 'Never' : 'No device')}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="cp-empty">No athletes in notification status yet.</p>'}
    </div>`;
  }

  // ── Operational queues (Today rail) ────────────────────────────────────────

  const state = {
    loaded: false,
    ok: false,
    messages: [],
    requests: [],
    notify: [],
    missing: [],
    busy: new Set(),
    names: new Map(),
    error: '',
  };

  function nameOf(code) {
    return state.names.get(String(code || '').toUpperCase()) || code || 'Athlete';
  }

  const KIND_COPY = {
    account_deletion: 'Delete account',
    wearable_deletion: 'Delete wearable data',
  };

  const REQUEST_STATE_COPY = {
    overdue: 'Past 30 days',
    due_soon: 'Due within 7 days',
    open: 'Open',
    completed: 'Completed',
  };

  function messagesHtml() {
    const unread = state.messages.filter(m => !m.readAt);
    const head = `<div class="cp-panel-head"><h2 id="cp-msg-title">Athlete messages</h2><span class="cp-count${unread.length ? ' is-alert' : ' is-clear'}">${unread.length}</span></div>`;
    if (!state.loaded) return `<section class="cp-panel" aria-labelledby="cp-msg-title">${head}<p class="cp-empty" role="status">Loading messages…</p></section>`;
    if (state.missing.includes('contact_messages')) {
      return `<section class="cp-panel" aria-labelledby="cp-msg-title">${head}<p class="cp-partial" role="alert">Messages could not be loaded. Private notes may be waiting. <button type="button" class="cp-link" data-cp-retry>Retry</button></p></section>`;
    }
    const shown = [...unread, ...state.messages.filter(m => m.readAt).slice(0, 5)];
    return `<section class="cp-panel" aria-labelledby="cp-msg-title">${head}
      <p class="cp-sub">Private notes from the portal. The email copy is best effort; this list is the record.</p>
      ${shown.length ? `<ul class="cp-list">${shown.map(m => {
        const busy = state.busy.has(`m:${m.id}`);
        return `<li class="cp-item${m.readAt ? ' is-read' : ''}">
          <div class="cp-item-head">
            <button type="button" class="cp-athlete" data-cp-open="${esc(m.athleteCode)}">${esc(nameOf(m.athleteCode))}</button>
            <span class="cp-age">${esc(fmtWhen(m.createdAt))}</span>
          </div>
          <p class="cp-body">${esc(m.body)}</p>
          <div class="cp-item-foot">
            <span class="cp-meta">${m.readAt ? `Read${m.readBy ? ` by ${esc(m.readBy)}` : ''} ${esc(fmtWhen(m.readAt))}` : 'Unread'}</span>
            <button type="button" class="cp-btn" data-cp-message="${esc(m.id)}" data-cp-action="${m.readAt ? 'message_unread' : 'message_read'}" ${busy ? 'disabled' : ''}>${busy ? '…' : m.readAt ? 'Mark unread' : 'Mark read'}</button>
          </div>
        </li>`;
      }).join('')}</ul>` : '<p class="cp-empty">No athlete messages.</p>'}
    </section>`;
  }

  function requestsHtml() {
    const open = state.requests.filter(r => !r.completedAt);
    const overdue = open.filter(r => r.state === 'overdue').length;
    const head = `<div class="cp-panel-head"><h2 id="cp-req-title">Data requests</h2><span class="cp-count${overdue ? ' is-alert' : open.length ? ' is-warn' : ' is-clear'}">${open.length}</span></div>`;
    if (!state.loaded) return `<section class="cp-panel" aria-labelledby="cp-req-title">${head}<p class="cp-empty" role="status">Loading requests…</p></section>`;
    if (state.missing.includes('data_requests')) {
      return `<section class="cp-panel" aria-labelledby="cp-req-title">${head}<p class="cp-partial" role="alert">Data requests could not be loaded. The 30-day clock is still running on any that exist. <button type="button" class="cp-link" data-cp-retry>Retry</button></p></section>`;
    }
    const shown = [...open, ...state.requests.filter(r => r.completedAt).slice(0, 3)];
    return `<section class="cp-panel" aria-labelledby="cp-req-title">${head}
      <p class="cp-sub">Verified requests are completed within 30 days of arrival, as published on the support page.</p>
      ${shown.length ? `<ul class="cp-list">${shown.map(r => {
        const busy = state.busy.has(`r:${r.id}`);
        const actions = [];
        if (!r.completedAt && !r.acknowledgedAt) actions.push(['data_request_acknowledge', 'Acknowledge']);
        if (!r.completedAt) actions.push(['data_request_complete', 'Mark completed']);
        if (r.completedAt) actions.push(['data_request_reopen', 'Reopen']);
        const due = r.dueAt ? `Due ${esc(fmtDay(r.dueAt))}` : '';
        return `<li class="cp-item is-${esc(r.state)}">
          <div class="cp-item-head">
            <button type="button" class="cp-athlete" data-cp-open="${esc(r.athleteCode)}">${esc(nameOf(r.athleteCode))}</button>
            <span class="cp-state is-${esc(r.state)}">${esc(REQUEST_STATE_COPY[r.state] || r.state)}</span>
          </div>
          <p class="cp-body"><strong>${esc(KIND_COPY[r.kind] || r.kind || 'Request')}</strong>${r.note ? ` · ${esc(r.note)}` : ''}</p>
          <div class="cp-meta">Requested ${esc(fmtDay(r.requestedAt))}${r.daysOpen != null && !r.completedAt ? ` · ${esc(r.daysOpen)} day${r.daysOpen === 1 ? '' : 's'} open` : ''}${!r.completedAt && due ? ` · ${due}` : ''}</div>
          <div class="cp-meta">${r.acknowledgedAt ? `Acknowledged${r.acknowledgedBy ? ` by ${esc(r.acknowledgedBy)}` : ''} ${esc(fmtDay(r.acknowledgedAt))}` : 'Not acknowledged'}${r.completedAt ? ` · Completed${r.completedBy ? ` by ${esc(r.completedBy)}` : ''} ${esc(fmtDay(r.completedAt))}` : ''}</div>
          <div class="cp-item-foot">${actions.map(([action, label]) =>
            `<button type="button" class="cp-btn" data-cp-request="${esc(r.id)}" data-cp-action="${action}" ${busy ? 'disabled' : ''}>${busy ? '…' : esc(label)}</button>`).join('')}</div>
        </li>`;
      }).join('')}</ul>` : '<p class="cp-empty">No data requests.</p>'}
    </section>`;
  }

  function renderRail() {
    const messages = root.document?.getElementById('athlete-messages');
    const requests = root.document?.getElementById('data-requests');
    if (messages) messages.innerHTML = messagesHtml();
    if (requests) requests.innerHTML = requestsHtml();
    const notify = root.document?.getElementById('notify-health');
    if (notify) {
      notify.innerHTML = state.loaded
        ? notifyHealthHtml(state.notify, nameOf, { missing: state.missing.includes('notify_status') })
        : '<div class="cp-panel"><p class="cp-empty" role="status">Loading notification status…</p></div>';
    }
  }

  function setOperations(data, athletes) {
    state.loaded = true;
    state.ok = data?.ok === true;
    state.messages = Array.isArray(data?.contactMessages) ? data.contactMessages : [];
    state.requests = Array.isArray(data?.dataRequests) ? data.dataRequests : [];
    state.notify = Array.isArray(data?.notifyStatus) ? data.notifyStatus : [];
    state.missing = Array.isArray(data?.dataQuality?.missingSources) ? data.dataQuality.missingSources.slice() : [];
    if (!state.ok && !state.missing.length) state.missing = ['contact_messages', 'data_requests', 'notify_status'];
    state.names = new Map();
    (athletes || []).forEach(a => {
      const code = String(a.id || a.code || '').toUpperCase();
      if (code) state.names.set(code, a.name || a.displayName || a.profile?.Name || code);
    });
    renderRail();
  }

  function notifyFor(code) {
    const target = String(code || '').toUpperCase();
    return state.notify.find(r => r.athleteCode === target) || null;
  }

  async function runAction(kind, id, action) {
    const key = `${kind}:${id}`;
    if (state.busy.has(key) || typeof root.maPost !== 'function') return;
    state.busy.add(key);
    renderRail();
    try {
      const result = await root.maPost({ action, id });
      if (kind === 'm' && result?.message) {
        state.messages = state.messages.map(m => (m.id === result.message.id ? result.message : m));
      }
      if (kind === 'r' && result?.request) {
        state.requests = state.requests.map(r => (r.id === result.request.id ? result.request : r));
      }
      if (typeof root.workflowNotice === 'function') root.workflowNotice('Saved');
    } catch (error) {
      if (typeof root.workflowNotice === 'function') root.workflowNotice(`Could not update: ${error.message}`, 'error');
    } finally {
      state.busy.delete(key);
      renderRail();
    }
  }

  // ── Weekly review (coach side) ─────────────────────────────────────────────

  const summaryCache = new Map(); // `${code}|${weekId||'current'}` -> { status, data, error }

  const PB_COPY = { load: 'Heaviest', reps: 'Most reps', e1rm: 'Estimated 1RM', volume: 'Set volume' };
  const TYPE_COPY = { running: 'Running', cycling: 'Cycling', swimming: 'Swimming', strength: 'Strength', other: 'Other' };
  const SPORT_COPY = { running: 'Running', cycling: 'Cycling', swimming: 'Swimming' };

  function val(value, suffix = '', places = 0) {
    const n = fmtNum(value, places);
    return n === null ? '<span class="cws-na" title="Not available">—</span>' : `${esc(n)}${suffix}`;
  }

  function summaryHtml(payload) {
    const s = payload.summary || {};
    const nav = payload.navigation || {};
    const t = s.training || {};
    const str = s.strength || {};
    const r = s.readiness || {};
    const bw = s.bodyweight || {};
    const ci = s.checkIn || {};
    const dq = s.dataQuality || {};
    const sports = Object.entries(s.endurance || {}).filter(([, e]) =>
      e && (num(e.actualSessions) || num(e.plannedDistanceKm) || num(e.actualDistanceKm)));
    const completionPct = t.completionPercent ?? null;
    const missed = Array.isArray(t.missedSessions) ? t.missedSessions : [];
    const pbs = Array.isArray(str.personalBests) ? str.personalBests : [];
    const attention = Array.isArray(s.attention) ? s.attention : [];
    const byType = t.byType && typeof t.byType === 'object' ? Object.entries(t.byType).filter(([, v]) => v && (v.planned || v.completed)) : [];

    const navHtml = `<div class="cws-nav" role="group" aria-label="Programme week">
      <button type="button" class="cws-nav-btn" data-cws-week="${esc(nav.previousId || '')}" ${nav.previousId ? '' : 'disabled'} aria-label="Previous week">‹</button>
      <span class="cws-week">${esc(s.period?.label || 'Week')}<small>${esc(fmtDay(s.period?.startDate))} to ${esc(fmtDay(s.period?.endDate))}${s.period?.state === 'in_progress' ? ' · in progress' : ''}</small></span>
      <button type="button" class="cws-nav-btn" data-cws-week="${esc(nav.nextId || '')}" ${nav.nextId ? '' : 'disabled'} aria-label="Next week">›</button>
    </div>`;

    const partial = dq.partial
      ? `<p class="cp-partial" role="status">Partial data: ${esc((dq.missingSources || []).join(', '))} could not be read. Affected figures show as —.</p>` : '';
    const warnings = (dq.warnings || []).length
      ? `<ul class="cws-warn">${dq.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '';

    return `${navHtml}${partial}
      <div class="cws-grid">
        <div class="cws-tile"><div class="cws-lbl">Sessions</div><div class="cws-num">${val(t.completedSessions)}<span>/${val(t.plannedSessions)}</span></div><div class="cws-sub">${completionPct == null ? 'Completion unavailable' : `${esc(fmtNum(completionPct))}% complete`}</div></div>
        <div class="cws-tile"><div class="cws-lbl">Strength</div><div class="cws-num">${val(str.completedSessions)}<span>/${val(str.plannedSessions)}</span></div><div class="cws-sub">${val(str.workingSets)} working sets · ${val(str.measurableVolumeKg, ' kg')}</div></div>
        <div class="cws-tile"><div class="cws-lbl">Readiness</div><div class="cws-num">${val(r.average)}</div><div class="cws-sub">${r.changeFromPreviousWeek != null ? `${r.changeFromPreviousWeek > 0 ? '+' : ''}${esc(fmtNum(r.changeFromPreviousWeek))} vs last week` : 'No previous week to compare'} · ${val(r.daysLogged)} day${r.daysLogged === 1 ? '' : 's'} logged</div></div>
        <div class="cws-tile"><div class="cws-lbl">Bodyweight</div><div class="cws-num">${val(bw.lastKg, ' kg', 1)}</div><div class="cws-sub">${bw.changeKg != null ? `${bw.changeKg > 0 ? '+' : ''}${esc(fmtNum(bw.changeKg, 1))} kg over the week` : 'Change needs two weigh-ins'}</div></div>
        <div class="cws-tile"><div class="cws-lbl">Check-in</div><div class="cws-num cws-word">${ci.submitted === true ? 'Submitted' : ci.submitted === false ? 'Not submitted' : '—'}</div></div>
      </div>
      ${byType.length ? `<div class="cws-row"><div class="cws-lbl">Completion by type</div><div class="cws-chips">${byType.map(([type, v]) => `<span class="cws-chip">${esc(TYPE_COPY[type] || labelFor(type))} ${val(v.completed)}/${val(v.planned)}</span>`).join('')}</div></div>` : ''}
      ${sports.length ? `<div class="cws-row"><div class="cws-lbl">Endurance</div><div class="cp-table-wrap"><table class="cp-table cws-table"><thead><tr><th scope="col">Sport</th><th scope="col">Sessions</th><th scope="col">Distance / planned</th><th scope="col">Time</th></tr></thead><tbody>
        ${sports.map(([sport, e]) => `<tr><th scope="row">${esc(SPORT_COPY[sport] || sport)}<span class="cws-source">Source: ${esc(e.actualSourceLabel || e.actualSource || 'unknown')}</span></th>
          <td>${val(e.actualSessions)}</td>
          <td>${val(e.actualDistanceKm, ' km', 1)}${e.plannedDistanceKm != null ? ` / ${val(e.plannedDistanceKm, ' km', 1)}` : ''}</td>
          <td>${val(e.actualDurationMinutes, ' min')}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="cws-note">Strava activities are shown to the athlete only, so the athlete's own card may show a different distance. This view uses confirmed portal logs and activity files the athlete shared with you, never counted twice.</p></div>` : ''}
      ${missed.length ? `<div class="cws-row"><div class="cws-lbl">Missed</div><ul class="cws-list">${missed.slice(0, 10).map(m => `<li>${esc(m.title || 'Session')}${m.date ? ` · ${esc(fmtDay(m.date))}` : ''}</li>`).join('')}</ul></div>` : ''}
      ${pbs.length ? `<div class="cws-row"><div class="cws-lbl">Personal bests</div><ul class="cws-list">${pbs.slice(0, 10).map(p => `<li>${esc(p.exercise || 'Lift')} · ${esc(PB_COPY[p.type] || p.type)} ${esc(fmtNum(p.value, 1))} ${esc(p.unit || '')}${p.delta != null ? ` (+${esc(fmtNum(p.delta, 1))})` : ''}</li>`).join('')}</ul></div>` : ''}
      ${attention.length ? `<div class="cws-row"><div class="cws-lbl">Attention</div><ul class="cws-list is-attention">${attention.map(a => `<li class="is-${esc(a.severity || 'low')}">${esc(a.message || '')}</li>`).join('')}</ul></div>` : ''}
      ${warnings}`;
  }

  function weeklySummaryPlaceholder(code) {
    if (!code) return '';
    return `<section class="fpc-section cws" data-cws-code="${esc(code)}" aria-labelledby="cws-title-${esc(code)}" aria-busy="true">
      <div class="fpc-section-title" id="cws-title-${esc(code)}">Weekly review</div>
      <div class="cws-body"><p class="cp-empty" role="status">Loading the weekly review…</p></div>
    </section>`;
  }

  function paintSummary(section, entry) {
    const body = section.querySelector('.cws-body');
    if (!body) return;
    section.setAttribute('aria-busy', entry.status === 'loading' ? 'true' : 'false');
    if (entry.status === 'loading') {
      body.innerHTML = '<p class="cp-empty" role="status">Loading the weekly review…</p>';
    } else if (entry.status === 'error') {
      body.innerHTML = `<p class="cp-partial" role="alert">${esc(entry.error || 'The weekly review could not be loaded.')} <button type="button" class="cp-link" data-cws-retry>Retry</button></p>`;
    } else if (entry.status === 'empty') {
      body.innerHTML = `<p class="cp-empty">${esc(entry.error || 'No programme weeks yet for this athlete.')}</p>`;
    } else {
      body.innerHTML = summaryHtml(entry.data);
    }
  }

  async function loadSummary(code, weekId, section) {
    const key = `${code}|${weekId || 'current'}`;
    const cached = summaryCache.get(key);
    if (cached && cached.status !== 'error') { paintSummary(section, cached); if (cached.status !== 'loading') return; }
    const entry = { status: 'loading' };
    summaryCache.set(key, entry);
    paintSummary(section, entry);
    try {
      const params = new URLSearchParams({ mode: 'weekly_summary', code });
      if (weekId) params.set('programmeWeekId', weekId);
      const response = await root.fetch(`/api/coach-data?${params}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (response.status === 404) Object.assign(entry, { status: 'empty', error: data.error });
      else if (!response.ok || data.ok !== true) Object.assign(entry, { status: 'error', error: data.error || `The weekly review could not be loaded (HTTP ${response.status}).` });
      else Object.assign(entry, { status: 'ready', data });
    } catch (error) {
      Object.assign(entry, { status: 'error', error: 'The weekly review could not be loaded. Check the connection and retry.' });
    }
    const live = root.document?.querySelector(`.cws[data-cws-code="${CSS.escape(code)}"]`);
    if (live && (live.dataset.cwsWeek || '') === (weekId || '')) paintSummary(live, entry);
  }

  function hydrate(container) {
    if (!container) return;
    container.querySelectorAll('.cws[data-cws-code]').forEach(section => {
      loadSummary(section.dataset.cwsCode, section.dataset.cwsWeek || '', section);
    });
  }

  function onClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const message = target.closest('[data-cp-message]');
    if (message) return runAction('m', message.dataset.cpMessage, message.dataset.cpAction);
    const request = target.closest('[data-cp-request]');
    if (request) return runAction('r', request.dataset.cpRequest, request.dataset.cpAction);
    const open = target.closest('[data-cp-open]');
    if (open && typeof root.openAthleteFromTriage === 'function') return root.openAthleteFromTriage(open.dataset.cpOpen, { tab: 'overview' });
    if (target.closest('[data-cp-retry]') && typeof root.load === 'function') return root.load({ bust: true });
    const weekButton = target.closest('[data-cws-week]');
    if (weekButton && weekButton.dataset.cwsWeek) {
      const section = weekButton.closest('.cws');
      section.dataset.cwsWeek = weekButton.dataset.cwsWeek;
      return loadSummary(section.dataset.cwsCode, section.dataset.cwsWeek, section);
    }
    if (target.closest('[data-cws-retry]')) {
      const section = target.closest('.cws');
      summaryCache.delete(`${section.dataset.cwsCode}|${section.dataset.cwsWeek || 'current'}`);
      return loadSummary(section.dataset.cwsCode, section.dataset.cwsWeek || '', section);
    }
    return undefined;
  }

  const api = {
    esc,
    bodyPain,
    painChipHtml,
    athleteNoteHtml,
    callDecisionHtml,
    goalsPanelHtml,
    trackedLiftText,
    notifyLineHtml,
    notifyHealthHtml,
    notifyFor,
    setOperations,
    messagesHtml,
    requestsHtml,
    summaryHtml,
    weeklySummaryPlaceholder,
    hydrate,
    _state: state,
  };
  root.DP_PARITY = api;

  if (root.document && typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('click', onClick);
    root.document.addEventListener('DOMContentLoaded', renderRail);
  }
})(typeof window !== 'undefined' ? window : globalThis);
