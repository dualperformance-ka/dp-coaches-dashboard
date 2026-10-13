(function () {
  'use strict';

  // ── Today: one coaching queue ──────────────────────────────────────────────
  // Server-ranked triage rows, client-computed alerts, the review backlog and
  // unread athlete messages are merged by window.DP_QUEUE (coach-queue.js) into
  // one item per athlete, in four categories: Urgent, Review, Follow up, Plan.
  // This file renders that queue, runs its actions, and owns Focus Mode, the
  // one-item-at-a-time review workspace.
  //
  // Server data, client rows and messages are held separately and merged on
  // every render, so any one can refresh without clobbering the others.

  var FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'urgent', label: 'Urgent' },
    { key: 'review', label: 'Review' },
    { key: 'followup', label: 'Follow up' },
    { key: 'plan', label: 'Plan' },
    { key: 'resolved', label: 'Resolved' },
  ];

  var CATEGORY_ICON = { urgent: 'siren', review: 'clipboard', followup: 'message', plan: 'calendar' };

  var FLAG_LABELS = {
    pain: 'Pain / alert',
    gone_quiet: 'Gone quiet',
    compliance_drift: 'Compliance drift',
    awaiting_review: 'Awaiting review',
    client_alert: 'Coach watch',
    load_divergence: 'Load vs recovery',
    pace_mismatch: 'Easy-day pace',
  };

  var serverData = null;
  var serverLoadedAt = null;
  var clientSignals = [];
  var messages = [];
  var pending = new Set();
  var loadFailed = '';
  var filter = (function () {
    try {
      var saved = localStorage.getItem('dp_queue_filter');
      return FILTERS.some(function (f) { return f.key === saved; }) ? saved : 'all';
    } catch (e) { return 'all'; }
  })();

  // Focus Mode session: a fixed order captured on Start, a pointer, and the
  // codes completed or skipped. Survives closing the drawer so "Continue
  // review" picks up where the coach left off.
  var focus = { open: false, order: [], index: -1, done: [], skipped: [], view: 'item', last: null, returnTo: null, resumeAfterAthlete: false };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function icon(name) {
    return typeof window.DP_ICON === 'function' ? window.DP_ICON(name) : '';
  }

  function model() {
    var Q = window.DP_QUEUE;
    if (!Q) return { items: [], counts: { all: 0, urgent: 0, review: 0, followup: 0, plan: 0, resolved: 0 }, resolved: [] };
    return Q.buildCoachQueue({ server: serverData, client: clientSignals, messages: messages });
  }

  // Kept for callers that read the merged list (Squad status, tests, verify).
  function mergedQueue() { return model().items; }

  function itemFor(code) {
    var key = String(code || '').toUpperCase();
    return model().items.find(function (item) { return item.code === key; }) || null;
  }

  function announce(message) {
    var live = document.getElementById('triage-status');
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = message; }, 30);
  }

  function setState(state, message) {
    var loading = document.getElementById('triage-loading');
    var error = document.getElementById('triage-error');
    var content = document.getElementById('triage-content');
    if (loading) loading.hidden = state !== 'loading';
    if (error) error.hidden = state !== 'error';
    if (content) content.hidden = state !== 'ready';
    if (message) {
      var target = document.getElementById('triage-error-message');
      if (target) target.textContent = message;
    }
  }

  function painDetail(item) {
    var pain = item.evidence && item.evidence.pain;
    if (!pain) return '';
    var bits = [];
    if (pain.score !== null && pain.score !== undefined) bits.push('<strong>' + escapeHtml(pain.score) + '/10</strong>');
    if (pain.location) bits.push(escapeHtml(pain.location));
    if (pain.coachAlert) bits.push('Coach alert');
    return bits.length ? '<div class="triage-pain">' + bits.join(' · ') + '</div>' : '';
  }

  function statusChip(item) {
    return '<span class="cq-status is-' + item.category + '">' +
      '<span class="cq-status-ic" aria-hidden="true">' + icon(CATEGORY_ICON[item.category]) + '</span>' +
      '<span class="cq-status-cat">' + escapeHtml(window.DP_QUEUE.CATEGORY_LABELS[item.category]) + '</span>' +
      '<span class="cq-status-sep" aria-hidden="true">·</span>' +
      escapeHtml(item.status) + '</span>';
  }

  function completionButton(item, extraClass) {
    var c = item.completion;
    if (!c) return '';
    var cls = 'triage-resolve' + (extraClass ? ' ' + extraClass : '');
    if (c.kind === 'signal') {
      var key = item.code + '|' + c.flag;
      var busy = pending.has(key);
      return '<button type="button" class="' + cls + '" data-triage-resolve="' + escapeHtml(c.flag) + '" data-triage-code="' + escapeHtml(item.code) + '" data-triage-print="' + escapeHtml(c.fingerprint) + '" ' + (busy ? 'disabled' : '') + '>' + (busy ? 'Saving…' : escapeHtml(c.label)) + '</button>';
    }
    if (c.kind === 'review') {
      var busyReview = pending.has('review-all|' + item.code);
      return '<button type="button" class="' + cls + '" data-review-all="' + escapeHtml(item.code) + '" ' + (busyReview ? 'disabled' : '') + '>' + (busyReview ? 'Saving…' : 'Mark reviewed') + '</button>';
    }
    if (c.kind === 'message') {
      var busyMsg = pending.has('message|' + c.id);
      return '<button type="button" class="' + cls + '" data-message-read="' + escapeHtml(c.id) + '" data-triage-code="' + escapeHtml(item.code) + '" ' + (busyMsg ? 'disabled' : '') + '>' + (busyMsg ? 'Saving…' : 'Mark read') + '</button>';
    }
    return '';
  }

  function primaryButton(item) {
    var action = item.primaryAction;
    return '<button type="button" class="triage-action" data-triage-code="' + escapeHtml(action.athleteCode || item.code) + '" data-triage-action="' + escapeHtml(action.type) + '" data-triage-date="' + escapeHtml(action.date || '') + '">' + escapeHtml(action.label) + '</button>';
  }

  function rowHtml(item) {
    var additional = item.additional.map(function (a) { return escapeHtml(a.text); }).join(' · ');
    var opensAthlete = item.primaryAction.type === 'open_athlete';
    return '<li class="triage-row cq-row is-' + item.category + (item.severity === 'critical' ? ' is-critical' : '') + '" data-queue-row data-cq-code="' + escapeHtml(item.code) + '">' +
      '<div class="cq-row-head">' +
        '<h3 class="cq-row-name"><button type="button" class="triage-athlete-name triage-athlete-open" data-triage-open="' + escapeHtml(item.code) + '">' + escapeHtml(item.name) + '</button></h3>' +
        statusChip(item) +
      '</div>' +
      (item.summary ? '<p class="cq-summary">' + escapeHtml(item.summary) + '</p>' : '') +
      '<p class="triage-signal cq-reason">' + escapeHtml(item.reason) + '</p>' +
      painDetail(item) +
      (additional ? '<p class="cq-also"><span class="cq-also-lbl">Also</span> ' + additional + '</p>' : '') +
      '<div class="triage-row-actions">' +
        primaryButton(item) +
        (opensAthlete ? '' : '<button type="button" class="cq-secondary" data-triage-open="' + escapeHtml(item.code) + '">Open athlete</button>') +
        completionButton(item) +
        '<button type="button" class="cq-focus-one" data-focus-start="' + escapeHtml(item.code) + '" aria-label="Focus on ' + escapeHtml(item.name) + '">Focus</button>' +
      '</div>' +
    '</li>';
  }

  function resolvedHtml(resolved) {
    if (!resolved.length) {
      return '<div class="cq-empty"><p class="cq-empty-title">Nothing resolved yet today</p><p>Resolved rows stay here so either coach can reopen them.</p></div>';
    }
    return '<ul class="cq-resolved-list">' + resolved.map(function (row) {
      var key = String(row.athleteCode || '').toUpperCase() + '|' + row.flag;
      var busy = pending.has(key);
      var when = row.resolvedAt ? new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Adelaide', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(row.resolvedAt)) : '';
      return '<li class="triage-resolved-row">' +
        '<strong>' + escapeHtml(row.athleteName || row.athleteCode) + '</strong>' +
        '<span>' + escapeHtml(FLAG_LABELS[row.flag] || row.flag) + ' <span class="triage-resolved-meta">' + escapeHtml(row.resolvedBy || '') + (when ? ' · ' + escapeHtml(when) : '') + '</span></span>' +
        '<button type="button" class="triage-restore" data-triage-restore="' + escapeHtml(row.flag) + '" data-triage-code="' + escapeHtml(row.athleteCode) + '" ' + (busy ? 'disabled' : '') + '>' + (busy ? '…' : 'Reopen') + '</button>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function filtersHtml(counts) {
    return FILTERS.map(function (f) {
      var active = f.key === filter;
      var n = counts[f.key] || 0;
      return '<button type="button" class="cq-filter is-' + f.key + (active ? ' is-active' : '') + '" data-queue-filter="' + f.key + '" aria-pressed="' + active + '">' +
        escapeHtml(f.label) + ' <span class="cq-filter-count">' + n + '</span></button>';
    }).join('');
  }

  // "Review backlog" in the rail is a summary and a door into Focus Mode, not
  // a second list of the same days the queue already shows.
  function renderReviewQueue(review) {
    var target = document.getElementById('review-queue');
    if (!target) return;
    var queue = Array.isArray(review && review.queue) ? review.queue : [];
    var counts = (review && review.counts) || {};
    var overdueAfter = Number(review && review.overdueAfterDays) || 2;
    var athletes = new Set(queue.map(function (e) { return String(e.athleteCode).toUpperCase(); })).size;
    var oldest = queue.reduce(function (max, e) { return Math.max(max, Number(e.days) || 0); }, 0);
    var overdue = Number(counts.overdue) || queue.filter(function (e) { return (Number(e.days) || 0) >= overdueAfter; }).length;
    var tone = overdue ? ' is-overdue' : queue.length ? '' : ' is-clear';
    var ageCopy = window.DP_QUEUE ? window.DP_QUEUE.ageCopy : function (d) { return d + ' days'; };
    target.innerHTML = '<section class="review-panel cq-panel" aria-labelledby="review-title">' +
      '<div class="review-head"><h2 id="review-title">Review backlog</h2><span class="review-count' + tone + '">' + queue.length + '</span></div>' +
      (queue.length
        ? '<p class="review-sub">' + queue.length + ' day' + (queue.length === 1 ? '' : 's') + ' of training from ' + athletes + ' athlete' + (athletes === 1 ? '' : 's') + ' · oldest ' + escapeHtml(ageCopy(oldest)) + (overdue ? ' · <strong class="cq-overdue">' + overdue + ' past ' + overdueAfter + ' days</strong>' : '') + '</p>' +
          '<div class="cq-panel-actions">' +
            '<button type="button" class="cq-start-review" data-focus-start="review">Review next</button>' +
            '<button type="button" class="cq-secondary" data-queue-filter="review">Show in queue</button>' +
          '</div>'
        : '<p class="review-empty">No sessions need review. Everything submitted has been read.</p>') +
    '</section>';
  }

  function renderHeaderCount(counts, ready) {
    var target = document.getElementById('today-attention');
    if (!target) return;
    if (!ready) { target.innerHTML = '<span class="today-count-skel" aria-hidden="true"></span><span class="dp-visually-hidden">Loading</span>'; return; }
    var n = counts.all;
    var html = n
      ? '<strong>' + n + '</strong> athlete' + (n === 1 ? '' : 's') + ' need' + (n === 1 ? 's' : '') + ' attention' + (counts.urgent ? ' · <span class="cq-urgent-count">' + counts.urgent + ' urgent</span>' : '')
      : '<strong>0</strong> athletes need attention';
    // A live region: only write when the words change, or every re-render
    // (client signals, messages, a pending spinner) is announced again.
    if (target.innerHTML !== html) target.innerHTML = html;
  }

  function updateStartButtons(items) {
    var Q = window.DP_QUEUE;
    var remaining = focus.order.length && Q ? Q.remainingInSession(focus, items) : 0;
    var label = remaining && focus.index >= 0 ? 'Continue review (' + remaining + ' left)' : 'Start review';
    document.querySelectorAll('[data-focus-start="queue"]').forEach(function (button) {
      button.textContent = label;
      button.disabled = !items.length;
    });
  }

  function render() {
    var data = serverData || {};
    var m = model();
    var items = m.items;
    var counts = m.counts;
    var list = document.getElementById('triage-queue');
    var empty = document.getElementById('triage-clear');
    var resolvedTarget = document.getElementById('triage-resolved');
    var filters = document.getElementById('triage-filters');
    var badge = document.getElementById('tab-triage-count');
    var stale = document.getElementById('triage-stale');

    // The tab badge means one thing everywhere: athletes in the queue.
    if (badge) {
      badge.textContent = items.length || '—';
      badge.classList.toggle('red', counts.urgent > 0);
    }
    renderHeaderCount(counts, !!serverData);
    if (filters) filters.innerHTML = filtersHtml(counts);

    var shown = filter === 'resolved' ? [] : window.DP_QUEUE ? window.DP_QUEUE.filterItems(items, filter) : [];
    if (list) {
      list.hidden = filter === 'resolved';
      list.innerHTML = shown.map(rowHtml).join('');
    }
    if (resolvedTarget) {
      resolvedTarget.hidden = filter !== 'resolved';
      resolvedTarget.innerHTML = filter === 'resolved' ? resolvedHtml(m.resolved) : '';
    }

    if (empty) {
      var active = Number(data.counts && data.counts.active) || 0;
      var clearCount = Math.max(0, active - items.length - (Number(data.counts && data.counts.resolved) || 0));
      var html = '';
      if (filter !== 'resolved' && !shown.length) {
        if (!items.length) {
          html = '<p class="cq-empty-title">Nobody needs you right now</p>' +
            '<p>' + (active ? clearCount + ' of ' + active + ' athletes have nothing flagged' : 'Nothing flagged') + ', and no sessions are waiting for review.</p>';
        } else {
          var label = (FILTERS.find(function (f) { return f.key === filter; }) || {}).label || '';
          html = '<p class="cq-empty-title">No ' + escapeHtml(label.toLowerCase()) + ' items</p>' +
            '<p><button type="button" class="cq-link" data-queue-filter="all">Show all ' + items.length + '</button></p>';
        }
      } else if (filter === 'all' && items.length) {
        html = '<p class="cq-clear-line">' + clearCount + ' athlete' + (clearCount === 1 ? '' : 's') + ' with nothing flagged.</p>';
      }
      empty.innerHTML = html;
      empty.hidden = !html;
      empty.classList.toggle('is-all-clear', !items.length && filter !== 'resolved');
    }

    if (stale) {
      stale.hidden = !loadFailed;
      if (loadFailed) {
        var when = serverLoadedAt ? serverLoadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        stale.innerHTML = '<span>' + escapeHtml(loadFailed) + (when ? ' Showing the queue from ' + escapeHtml(when) + '.' : '') + '</span> <button type="button" class="triage-retry" data-triage-retry>Retry</button>';
      }
    }

    renderReviewQueue(data.review);
    updateStartButtons(items);

    var updated = document.getElementById('today-updated');
    if (updated && serverLoadedAt) {
      updated.textContent = 'Updated ' + serverLoadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    if (focus.open) renderFocus();
    try {
      window.dispatchEvent(new CustomEvent('dp:queue-updated', { detail: { counts: counts } }));
    } catch (e) { /* old browsers: Squad just keeps its last status */ }
  }

  async function loadTriage() {
    if (!serverData) setState('loading');
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('You are offline. Today will refresh when the connection returns.');
      }
      var response = await fetch('/api/coach-data?mode=triage', { cache: 'no-store' });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.ok !== true) {
        console.warn('[triage] request failed', { status: response.status, error: data.error || null });
        throw new Error('The decision queue could not refresh.');
      }
      serverData = data;
      serverLoadedAt = new Date();
      loadFailed = '';
      render();
      setState('ready');
    } catch (error) {
      console.warn('[triage]', error);
      loadFailed = error.message || 'The decision queue could not refresh.';
      if (serverData) {
        // Keep what loaded; say it is stale rather than blanking the queue.
        render();
        setState('ready');
      } else {
        setState('error', loadFailed + ' Messages, actions and squad pulse below still work.');
        var count = document.getElementById('today-attention');
        if (count) count.textContent = 'Queue unavailable';
      }
    }
  }

  function setClientSignals(rows) {
    clientSignals = Array.isArray(rows) ? rows.filter(function (row) { return row && row.athleteCode; }) : [];
    if (serverData) render();
  }

  function setMessages(rows) {
    messages = Array.isArray(rows) ? rows.slice() : [];
    if (serverData) render();
  }

  function setFilter(next) {
    if (!FILTERS.some(function (f) { return f.key === next; })) next = 'all';
    filter = next;
    try { localStorage.setItem('dp_queue_filter', next); } catch (e) { /* private mode */ }
    render();
    var label = (FILTERS.find(function (f) { return f.key === next; }) || {}).label;
    announce('Showing ' + label);
  }

  function notice(message, tone) {
    if (typeof window.workflowNotice === 'function') window.workflowNotice(message, tone);
  }

  async function post(payload) {
    if (typeof window.maPost !== 'function') throw new Error('Coach actions are not available');
    return window.maPost(payload);
  }

  // Every completion returns true on success so Focus Mode knows whether to
  // advance. A failure leaves the item where it is.
  async function resolveRow(flag, code, fingerprint) {
    var key = String(code).toUpperCase() + '|' + flag;
    if (pending.has(key)) return false;
    pending.add(key);
    render();
    try {
      await post({ action: 'signal_resolve', code: code, signal_type: flag, fingerprint: fingerprint });
      notice(code + ' resolved');
      // Client alerts share coach_signal_state with the dashboard's own
      // acknowledgement view; pull it so both screens agree.
      if (flag === 'client_alert' && typeof window.refreshSharedAcknowledgements === 'function') {
        await window.refreshSharedAcknowledgements();
      }
      pending.delete(key);
      await loadTriage();
      return true;
    } catch (error) {
      notice('Could not resolve: ' + error.message, 'error');
      return false;
    } finally {
      pending.delete(key);
      render();
    }
  }

  async function restoreRow(flag, code) {
    var key = String(code).toUpperCase() + '|' + flag;
    if (pending.has(key)) return;
    pending.add(key);
    render();
    try {
      await post({ action: 'signal_restore', code: code, signal_type: flag });
      notice(code + ' reopened');
      if (flag === 'client_alert' && typeof window.refreshSharedAcknowledgements === 'function') {
        await window.refreshSharedAcknowledgements();
      }
      pending.delete(key);
      await loadTriage();
    } catch (error) {
      notice('Could not reopen: ' + error.message, 'error');
    } finally {
      pending.delete(key);
      render();
    }
  }

  async function markReviewed(code, date) {
    var key = 'review|' + code + '|' + date;
    if (pending.has(key)) return false;
    pending.add(key);
    render();
    try {
      await post({ action: 'session_review', code: code, session_date: date });
      notice(code + ' · ' + date + ' marked reviewed');
      if (typeof window.noteSessionReviewed === 'function') window.noteSessionReviewed(code, date);
      pending.delete(key);
      await loadTriage();
      return true;
    } catch (error) {
      notice('Could not update review: ' + error.message, 'error');
      return false;
    } finally {
      pending.delete(key);
      render();
    }
  }

  // Marks every pending day for one athlete. Sequential, so a failure part
  // way reports exactly which day did not save.
  async function markAllReviewed(code) {
    var item = itemFor(code);
    var dates = (item && item.reviewDays || []).map(function (d) { return d.date; });
    if (!dates.length) return false;
    var key = 'review-all|' + item.code;
    if (pending.has(key)) return false;
    pending.add(key);
    render();
    try {
      for (var i = 0; i < dates.length; i += 1) {
        await post({ action: 'session_review', code: item.code, session_date: dates[i] });
        if (typeof window.noteSessionReviewed === 'function') window.noteSessionReviewed(item.code, dates[i]);
      }
      notice(item.name + ': ' + dates.length + ' day' + (dates.length === 1 ? '' : 's') + ' marked reviewed');
      pending.delete(key);
      await loadTriage();
      return true;
    } catch (error) {
      notice('Could not update review: ' + error.message, 'error');
      await loadTriage();
      return false;
    } finally {
      pending.delete(key);
      render();
    }
  }

  async function markMessageRead(id) {
    var key = 'message|' + id;
    if (pending.has(key)) return false;
    var parity = window.DP_PARITY;
    if (!parity || typeof parity.messageAction !== 'function') return false;
    pending.add(key);
    render();
    try {
      var ok = await parity.messageAction(id, 'message_read');
      return ok !== false;
    } finally {
      pending.delete(key);
      render();
    }
  }

  async function completeItem(item) {
    var c = item && item.completion;
    if (!c) return false;
    if (c.kind === 'signal') return resolveRow(c.flag, item.code, c.fingerprint);
    if (c.kind === 'review') return markAllReviewed(item.code);
    if (c.kind === 'message') return markMessageRead(c.id);
    return false;
  }

  function openAthlete(code, options) {
    if (!code) return;
    if (typeof window.openAthleteFromTriage === 'function') {
      window.openAthleteFromTriage(code, options || {});
    }
  }

  async function openMessage(code) {
    if (!code || typeof window.switchTab !== 'function') return;
    window.switchTab('send');
    if (typeof window.cnPopulate === 'function') await window.cnPopulate();
    var select = document.getElementById('cn-recipient');
    if (select) {
      var target = String(code).toUpperCase();
      var option = Array.from(select.options).find(function (item) { return String(item.value).toUpperCase() === target; });
      if (option) select.value = option.value;
    }
    var body = document.getElementById('cn-msg-body');
    if (body) body.focus();
  }

  // Compliance drift asks the coach to review the week's plan, not to send a
  // message, so the action routes to Planning with the athlete already selected.
  async function openReview(code) {
    if (!code || typeof window.switchTab !== 'function') return;
    window.switchTab('planning');
    if (typeof window.setPlanAthlete === 'function') {
      try { await window.setPlanAthlete(code); } catch (error) { console.warn('[triage] setPlanAthlete', error); }
    }
  }

  function runAction(type, code, date) {
    if (type === 'open_review') return openAthlete(code, { tab: 'training', date: date });
    if (type === 'open_athlete') return openAthlete(code, { tab: 'overview' });
    if (type === 'open_strength') return openAthlete(code, { tab: 'strength' });
    if (type === 'review') return openReview(code);
    return openMessage(code);
  }

  // ── Focus Mode ─────────────────────────────────────────────────────────────
  // One item at a time: why it was raised, the evidence, the coach's action,
  // and a completion verb. The coach decides everything; nothing here resolves,
  // messages or edits a plan on its own.

  function ensureFocusShell() {
    var shell = document.getElementById('cq-focus');
    if (shell) return shell;
    shell = document.createElement('div');
    shell.id = 'cq-focus';
    shell.className = 'cq-focus';
    shell.hidden = true;
    shell.innerHTML =
      '<div class="cq-focus-backdrop" data-focus-close></div>' +
      '<div class="cq-focus-panel" role="dialog" aria-modal="true" aria-labelledby="cq-focus-title">' +
        '<div class="cq-focus-bar">' +
          '<button type="button" class="cq-focus-close" data-focus-close aria-label="Close focus mode">' +
            '<span aria-hidden="true">←</span> <span class="cq-focus-close-lbl">Queue</span></button>' +
          '<span class="cq-focus-progress" id="cq-focus-progress"></span>' +
          '<span class="cq-focus-hint" aria-hidden="true">Esc to close</span>' +
        '</div>' +
        '<div class="cq-focus-body" id="cq-focus-body"></div>' +
        '<div class="cq-focus-foot" id="cq-focus-foot"></div>' +
      '</div>';
    document.body.appendChild(shell);
    shell.addEventListener('click', onFocusClick);
    shell.addEventListener('keydown', onFocusKeydown);
    return shell;
  }

  function currentFocusItem() {
    var code = focus.order[focus.index];
    return code ? itemFor(code) : null;
  }

  function sessionItems() {
    var items = model().items;
    return filter === 'all' || filter === 'resolved' ? items : window.DP_QUEUE.filterItems(items, filter);
  }

  function startFocus(scope, trigger) {
    var Q = window.DP_QUEUE;
    if (!Q) return;
    var items = model().items;
    var ordered;
    if (scope && scope !== 'queue' && scope !== 'review') {
      // Focus on one athlete from their row: start there, carry on through
      // the rest of the visible queue.
      var visible = sessionItems().map(function (i) { return i.code; });
      var at = visible.indexOf(String(scope).toUpperCase());
      ordered = at >= 0 ? visible.slice(at).concat(visible.slice(0, at)) : [String(scope).toUpperCase()].concat(visible);
      focus.order = ordered; focus.index = -1; focus.done = []; focus.skipped = [];
    } else if (scope === 'review') {
      focus.order = Q.filterItems(items, 'review').map(function (i) { return i.code; });
      focus.index = -1; focus.done = []; focus.skipped = [];
    } else {
      var resume = focus.order.length && Q.remainingInSession(focus, items) > 0 && focus.index >= 0;
      if (!resume) {
        focus.order = sessionItems().map(function (i) { return i.code; });
        focus.index = -1; focus.done = []; focus.skipped = [];
      } else {
        // Resume on the item the coach was on, if it is still open.
        focus.index -= 1;
      }
    }
    if (!focus.order.length) { announce('Nothing in the queue to review'); return; }
    focus.returnTo = trigger || document.activeElement;
    focus.open = true;
    var next = Q.nextInSession(focus, items);
    focus.index = next;
    focus.view = next < 0 ? 'clear' : 'item';
    var shell = ensureFocusShell();
    shell.hidden = false;
    document.body.classList.add('cq-focus-open');
    renderFocus();
    focusHeading();
  }

  function closeFocus(options) {
    var shell = document.getElementById('cq-focus');
    if (!shell || shell.hidden) return;
    shell.hidden = true;
    focus.open = false;
    document.body.classList.remove('cq-focus-open');
    render();
    if (!(options && options.keepFocus)) {
      var back = focus.returnTo && focus.returnTo.isConnected ? focus.returnTo : document.querySelector('[data-focus-start="queue"]');
      if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
    }
  }

  function focusHeading() {
    requestAnimationFrame(function () {
      var target = document.querySelector('#cq-focus [data-focus-autofocus]') || document.getElementById('cq-focus-title');
      if (target) target.focus({ preventScroll: true });
    });
  }

  function advance() {
    var Q = window.DP_QUEUE;
    var next = Q.nextInSession(focus, model().items);
    focus.index = next;
    focus.view = next < 0 ? 'clear' : 'item';
    renderFocus();
    focusHeading();
    var item = currentFocusItem();
    if (item) announce(item.name + ', ' + item.status);
  }

  function skipFocus() {
    var item = currentFocusItem();
    if (item && focus.skipped.indexOf(item.code) < 0) focus.skipped.push(item.code);
    advance();
  }

  async function completeFocus() {
    var item = currentFocusItem();
    if (!item) return;
    var ok = await completeItem(item);
    if (!ok) { renderFocus(); return; }
    focus.done.push(item.code);
    focus.last = { name: item.name, verb: item.completion.kind === 'review' ? 'marked reviewed' : item.completion.kind === 'message' ? 'message marked read' : 'resolved' };
    // A message or one of several signals may leave the athlete in the queue
    // with something else to do; say so instead of moving on silently.
    var still = itemFor(item.code);
    focus.last.remaining = still ? still.status : '';
    var next = window.DP_QUEUE.nextInSession(focus, model().items);
    focus.view = 'done';
    focus.pendingNext = next;
    renderFocus();
    focusHeading();
    announce(item.name + ' ' + focus.last.verb + '.');
  }

  function focusEvidence(item) {
    var getter = window.DP_FOCUS_EVIDENCE;
    if (typeof getter !== 'function') return null;
    try {
      return getter(item.code, { dates: item.reviewDays.map(function (d) { return d.date; }), category: item.category });
    } catch (error) {
      console.warn('[focus] evidence', error);
      return { error: true };
    }
  }

  function signalListHtml(item) {
    var labels = window.DP_QUEUE.CATEGORY_LABELS;
    return '<ul class="cq-signal-list">' + item.signals.map(function (s) {
      var resolve = '';
      if (s.resolve && s.resolve.kind === 'signal' && s !== item.primary) {
        var key = item.code + '|' + s.resolve.flag;
        resolve = '<button type="button" class="cq-mini" data-triage-resolve="' + escapeHtml(s.resolve.flag) + '" data-triage-code="' + escapeHtml(item.code) + '" data-triage-print="' + escapeHtml(s.resolve.fingerprint) + '" ' + (pending.has(key) ? 'disabled' : '') + '>Resolve</button>';
      }
      if (s.resolve && s.resolve.kind === 'message' && s !== item.primary) {
        resolve = '<button type="button" class="cq-mini" data-message-read="' + escapeHtml(s.resolve.id) + '" data-triage-code="' + escapeHtml(item.code) + '">Mark read</button>';
      }
      return '<li class="cq-signal is-' + s.category + '">' +
        '<span class="cq-signal-cat">' + escapeHtml(labels[s.category]) + '</span>' +
        '<span class="cq-signal-text"><strong>' + escapeHtml(s.status) + '</strong> ' + escapeHtml(s.category === 'review' ? s.text : s.text === s.status ? '' : s.text) + '</span>' +
        resolve +
      '</li>';
    }).join('') + '</ul>';
  }

  function reviewDaysHtml(item, evidence) {
    if (!item.reviewDays.length) return '';
    var byDate = {};
    (evidence && evidence.days || []).forEach(function (d) { byDate[d.date] = d.html; });
    return '<section class="cq-focus-section" aria-labelledby="cq-focus-days">' +
      '<h3 id="cq-focus-days">Submitted training</h3>' +
      item.reviewDays.map(function (day) {
        var key = 'review|' + item.code + '|' + day.date;
        var busy = pending.has(key);
        var names = (day.sessions || []).map(function (s) { return s.name; }).filter(Boolean).join(', ') || 'Training';
        var when = window.DP_QUEUE.ageCopy(day.days);
        return '<article class="cq-day">' +
          '<header class="cq-day-head"><div><h4>' + escapeHtml(names) + '</h4><p>' + escapeHtml(day.date) + ' · ' + escapeHtml(when) + '</p></div>' +
          '<button type="button" class="cq-mini" data-review-done="' + escapeHtml(item.code) + '" data-review-date="' + escapeHtml(day.date) + '" aria-label="Mark ' + escapeHtml(item.name) + ' ' + escapeHtml(day.date) + ' reviewed" ' + (busy ? 'disabled' : '') + '>' + (busy ? '…' : 'Mark day reviewed') + '</button></header>' +
          (byDate[day.date] || (evidence ? '<p class="cq-muted">No session detail loaded for this day.</p>' : '<p class="cq-muted" role="status">Loading session detail…</p>')) +
        '</article>';
      }).join('') +
    '</section>';
  }

  function renderFocus() {
    var shell = document.getElementById('cq-focus');
    if (!shell || !focus.open) return;
    var body = document.getElementById('cq-focus-body');
    var foot = document.getElementById('cq-focus-foot');
    var progress = document.getElementById('cq-focus-progress');
    var Q = window.DP_QUEUE;
    var items = model().items;
    var total = focus.order.length;
    var remaining = Q.remainingInSession(focus, items);
    if (progress) progress.textContent = focus.view === 'clear' ? 'Review complete' : (total - remaining + (focus.view === 'item' ? 1 : 0)) + ' of ' + total;

    if (focus.view === 'clear') {
      body.innerHTML = '<div class="cq-focus-clear">' +
        '<h2 id="cq-focus-title" tabindex="-1">Review complete</h2>' +
        '<p>' + (focus.done.length ? focus.done.length + ' item' + (focus.done.length === 1 ? '' : 's') + ' completed' : 'Nothing completed') +
        (focus.skipped.length ? ', ' + focus.skipped.length + ' skipped' : '') + '. ' +
        (items.length ? items.length + ' athlete' + (items.length === 1 ? '' : 's') + ' still in the queue.' : 'The queue is clear.') + '</p></div>';
      foot.innerHTML = '<button type="button" class="triage-action" data-focus-close data-focus-autofocus>Back to Today</button>' +
        (focus.skipped.length ? '<button type="button" class="cq-secondary" data-focus-restart>Review skipped</button>' : '');
      return;
    }

    if (focus.view === 'done') {
      var nextItem = focus.pendingNext >= 0 ? itemFor(focus.order[focus.pendingNext]) : null;
      body.innerHTML = '<div class="cq-focus-done">' +
        '<p class="cq-done-mark" aria-hidden="true">✓</p>' +
        '<h2 id="cq-focus-title" tabindex="-1">' + escapeHtml(focus.last.name) + ' ' + escapeHtml(focus.last.verb) + '</h2>' +
        (focus.last.remaining ? '<p>Still open for ' + escapeHtml(focus.last.name) + ': ' + escapeHtml(focus.last.remaining) + '. It stays in the queue.</p>' : '') +
        (nextItem ? '<p class="cq-next-preview">Next: <strong>' + escapeHtml(nextItem.name) + '</strong> · ' + escapeHtml(nextItem.status) + '</p>' : '<p>That was the last item in this review.</p>') +
      '</div>';
      foot.innerHTML = nextItem
        ? '<button type="button" class="triage-action" data-focus-next data-focus-autofocus>Next: ' + escapeHtml(nextItem.name) + ' <span aria-hidden="true">→</span></button><button type="button" class="cq-secondary" data-focus-close>Back to Today</button>'
        : '<button type="button" class="triage-action" data-focus-next data-focus-autofocus>Finish review</button>';
      return;
    }

    var item = currentFocusItem();
    if (!item) { advance(); return; }
    var evidence = focusEvidence(item);
    var evidenceHtml = '';
    if (evidence === null) {
      evidenceHtml = '<section class="cq-focus-section"><h3>Athlete detail</h3><p class="cq-muted" role="status">Loading this athlete’s recent training…</p></section>';
    } else if (evidence.error) {
      evidenceHtml = '<section class="cq-focus-section"><h3>Athlete detail</h3><p class="cq-muted">Recent training could not be shown here. Open the athlete for the full record.</p></section>';
    } else {
      evidenceHtml = (item.category === 'review' ? '' : (evidence.recent || '')) + (evidence.checkin || '') + (evidence.snapshot || '');
    }

    body.innerHTML =
      '<div class="cq-focus-head">' +
        '<h2 id="cq-focus-title" tabindex="-1">' + escapeHtml(item.name) + '</h2>' +
        statusChip(item) +
        (evidence && evidence.week ? '<p class="cq-focus-week">' + escapeHtml(evidence.week) + '</p>' : '') +
      '</div>' +
      '<section class="cq-focus-section cq-why" aria-labelledby="cq-focus-why">' +
        '<h3 id="cq-focus-why">Why this was raised</h3>' +
        (item.summary ? '<p class="cq-summary">' + escapeHtml(item.summary) + '</p>' : '') +
        '<p class="cq-reason">' + escapeHtml(item.reason) + '</p>' + painDetail(item) +
        (item.signals.length > 1 ? '<h4 class="cq-subhead">All open signals</h4>' + signalListHtml(item) : '') +
      '</section>' +
      reviewDaysHtml(item, evidence && !evidence.error ? evidence : null) +
      evidenceHtml;

    if (typeof window.clampLongNotes === 'function') window.clampLongNotes(body);

    var action = item.primaryAction;
    foot.innerHTML =
      '<button type="button" class="cq-secondary cq-skip" data-focus-skip>Skip</button>' +
      '<div class="cq-foot-main">' +
        (action.type === 'open_review' || action.type === 'open_athlete'
          ? '<button type="button" class="cq-secondary" data-focus-action="' + escapeHtml(action.type) + '" data-triage-date="' + escapeHtml(action.date || '') + '">' + (action.type === 'open_review' ? 'Open in profile' : 'Open athlete') + '</button>'
          : '<button type="button" class="cq-secondary" data-focus-action="' + escapeHtml(action.type) + '">' + escapeHtml(action.label) + '</button>' +
            '<button type="button" class="cq-secondary" data-focus-action="open_athlete">Open athlete</button>') +
        (item.completion
          ? '<button type="button" class="triage-action cq-complete" data-focus-complete ' + (isBusy(item) ? 'disabled' : '') + '>' + (isBusy(item) ? 'Saving…' : escapeHtml(item.completion.label)) + '</button>'
          : '') +
      '</div>';
  }

  function isBusy(item) {
    var c = item.completion;
    if (!c) return false;
    if (c.kind === 'signal') return pending.has(item.code + '|' + c.flag);
    if (c.kind === 'review') return pending.has('review-all|' + item.code);
    if (c.kind === 'message') return pending.has('message|' + c.id);
    return false;
  }

  // Leaving Focus Mode for the athlete profile or the composer keeps the
  // session. When the profile closes, Focus Mode reopens on the same item so
  // the coach can mark it done and carry on.
  function leaveFocusFor(type, date) {
    var item = currentFocusItem();
    if (!item) return;
    var start = document.querySelector('[data-focus-start="queue"]');
    closeFocus({ keepFocus: true });
    if (start) start.focus({ preventScroll: true });
    focus.resumeAfterAthlete = type === 'open_review' || type === 'open_athlete' || type === 'open_strength';
    focus.index = Math.max(-1, focus.index);
    runAction(type, item.code, date || item.primaryAction.date || undefined);
  }

  function onFocusClick(event) {
    var target = event.target;
    if (target.closest('[data-focus-close]')) {
      if (focus.view === 'clear') { focus.order = []; focus.index = -1; }
      return closeFocus();
    }
    if (target.closest('[data-focus-skip]')) return skipFocus();
    if (target.closest('[data-focus-next]')) {
      if (focus.pendingNext < 0) { focus.view = 'clear'; renderFocus(); focusHeading(); return; }
      return advance();
    }
    if (target.closest('[data-focus-restart]')) {
      focus.order = focus.skipped.slice(); focus.skipped = []; focus.done = []; focus.index = -1;
      return advance();
    }
    if (target.closest('[data-focus-complete]')) return completeFocus();
    var action = target.closest('[data-focus-action]');
    if (action) return leaveFocusFor(action.dataset.focusAction, action.dataset.triageDate);
    var resolve = target.closest('[data-triage-resolve]');
    if (resolve) return resolveRow(resolve.dataset.triageResolve, resolve.dataset.triageCode, resolve.dataset.triagePrint);
    var read = target.closest('[data-message-read]');
    if (read) return markMessageRead(read.dataset.messageRead);
    var done = target.closest('[data-review-done]');
    if (done) {
      return markReviewed(done.dataset.reviewDone, done.dataset.reviewDate).then(function (ok) {
        // The last day for this athlete completes the item.
        if (ok && !itemFor(done.dataset.reviewDone)) {
          focus.done.push(String(done.dataset.reviewDone).toUpperCase());
          focus.last = { name: (currentFocusItem() || {}).name || done.dataset.reviewDone, verb: 'marked reviewed', remaining: '' };
          focus.pendingNext = window.DP_QUEUE.nextInSession(focus, model().items);
          focus.view = 'done';
          renderFocus();
          focusHeading();
        }
      });
    }
    return undefined;
  }

  function onFocusKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      return closeFocus();
    }
    if (event.key !== 'Tab') return;
    // Keep keyboard focus inside the dialog.
    var panel = document.querySelector('#cq-focus .cq-focus-panel');
    var nodes = Array.prototype.filter.call(
      panel.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), summary'),
      function (el) { return el.offsetParent !== null || el === document.activeElement; });
    if (!nodes.length) return;
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  function watchAthleteOverlay() {
    var overlay = document.getElementById('fp-overlay');
    if (!overlay || !('MutationObserver' in window)) return;
    new MutationObserver(function () {
      if (overlay.getAttribute('aria-hidden') !== 'true' || !focus.resumeAfterAthlete) return;
      focus.resumeAfterAthlete = false;
      // Re-open on the item the coach left from, or the next open one.
      if (focus.order.length && window.DP_QUEUE.remainingInSession(focus, model().items) > 0) {
        startFocus('queue', document.querySelector('[data-focus-start="queue"]'));
      }
    }).observe(overlay, { attributes: true, attributeFilter: ['aria-hidden'] });
  }

  window.loadTriage = loadTriage;
  window.DP_TRIAGE = {
    reload: loadTriage,
    setClientSignals: setClientSignals,
    setMessages: setMessages,
    mergedQueue: mergedQueue,
    model: model,
    itemFor: itemFor,
    setFilter: setFilter,
    runAction: runAction,
    startFocus: startFocus,
    closeFocus: closeFocus,
    focusState: function () { return { open: focus.open, view: focus.view, order: focus.order.slice(), index: focus.index, done: focus.done.slice(), skipped: focus.skipped.slice() }; },
  };

  // Re-render once the module model and the full roster load land, so the
  // queue picks up evidence and messages without a second request.
  window.addEventListener('dp:queue-model-ready', function () { if (serverData) render(); });
  window.addEventListener('dp:dashboard-loaded', function () { if (focus.open) renderFocus(); });
  window.addEventListener('online', function () { if (loadFailed) loadTriage(); });

  document.addEventListener('DOMContentLoaded', async function () {
    var onClick = function (event) {
      var target = event.target;
      if (target.closest('[data-triage-retry]')) return loadTriage();
      var filterButton = target.closest('[data-queue-filter]');
      if (filterButton) {
        setFilter(filterButton.dataset.queueFilter);
        if (filterButton.closest('#review-queue')) {
          var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          document.getElementById('triage-title')?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
          document.querySelector('[data-queue-filter="review"].cq-filter')?.focus({ preventScroll: true });
        }
        return undefined;
      }
      var start = target.closest('[data-focus-start]');
      if (start) return startFocus(start.dataset.focusStart, start);
      var resolve = target.closest('[data-triage-resolve]');
      if (resolve) return resolveRow(resolve.dataset.triageResolve, resolve.dataset.triageCode, resolve.dataset.triagePrint);
      var restore = target.closest('[data-triage-restore]');
      if (restore) return restoreRow(restore.dataset.triageRestore, restore.dataset.triageCode);
      var all = target.closest('[data-review-all]');
      if (all) return markAllReviewed(all.dataset.reviewAll);
      var read = target.closest('[data-message-read]');
      if (read) return markMessageRead(read.dataset.messageRead);
      var open = target.closest('[data-triage-open]');
      if (open) return openAthlete(open.dataset.triageOpen, { tab: 'overview' });
      var button = target.closest('[data-triage-code][data-triage-action]');
      if (button) return runAction(button.dataset.triageAction, button.dataset.triageCode, button.dataset.triageDate || undefined);
      var done = target.closest('[data-review-done]');
      if (done) return markReviewed(done.dataset.reviewDone, done.dataset.reviewDate);
      var review = target.closest('[data-review-open]');
      if (review) {
        var code = review.dataset.reviewOpen;
        var date = review.dataset.reviewDate;
        return openAthlete(code, { tab: 'training', date });
      }
      return undefined;
    };
    document.getElementById('tab-triage-content')?.addEventListener('click', onClick);
    watchAthleteOverlay();
    await window.DP_COACH_AUTH?.ready;
    loadTriage();
  });
})();
