(function () {
  'use strict';

  // Every flag the server can emit, including the two Strava rows that are not
  // built yet, plus the dashboard's own client_alert rows. A missing entry used
  // to fall through to 'Gone quiet', which would mislabel any new row the
  // moment it shipped.
  var FLAG_LABELS = {
    pain: 'Pain / alert',
    gone_quiet: 'Gone quiet',
    compliance_drift: 'Compliance drift',
    awaiting_review: 'Awaiting review',
    client_alert: 'Coach watch',
    load_divergence: 'Load vs recovery',
    pace_mismatch: 'Easy-day pace',
  };

  var SEVERITY_CLASS = {
    critical: 'is-critical',
    high: '',
    medium: 'is-medium',
  };

  // Server data and client-computed rows are held separately and merged on
  // every render, so either side can refresh without clobbering the other.
  var serverData = null;
  var clientSignals = [];
  var pending = new Set();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setState(state, message) {
    const loading = document.getElementById('triage-loading');
    const error = document.getElementById('triage-error');
    const content = document.getElementById('triage-content');
    if (loading) loading.hidden = state !== 'loading';
    if (error) error.hidden = state !== 'error';
    if (content) content.hidden = state !== 'ready';
    if (message) {
      const target = document.getElementById('triage-error-message');
      if (target) target.textContent = message;
    }
  }

  function stat(value, label, tone) {
    return `<div class="triage-stat">
      <div class="triage-stat-value${tone ? ` ${tone}` : ''}">${Number(value) || 0}</div>
      <div class="triage-stat-label">${escapeHtml(label)}</div>
    </div>`;
  }

  function codeOf(row) {
    return String(row?.athleteCode || '').toUpperCase();
  }

  // One row per athlete. The server's ranking wins; a client signal for an
  // athlete the server already flagged becomes a sub-line on that row instead
  // of a second entry, so counts.flagged stays honest.
  function mergedQueue() {
    const server = Array.isArray(serverData?.queue) ? serverData.queue : [];
    const byCode = new Map();
    const rows = server.map(row => {
      const copy = { ...row, also: Array.isArray(row.also) ? row.also.slice() : [], source: 'server' };
      byCode.set(codeOf(copy), copy);
      return copy;
    });
    for (const signal of clientSignals) {
      const code = codeOf(signal);
      if (!code) continue;
      const existing = byCode.get(code);
      if (existing) {
        existing.also = existing.also.concat([signal.signal].concat(signal.also || []).filter(Boolean));
        continue;
      }
      const row = { ...signal, also: Array.isArray(signal.also) ? signal.also.slice() : [], source: 'client' };
      byCode.set(code, row);
      rows.push(row);
    }
    return rows.sort((left, right) =>
      (Number(right.priority) || 0) - (Number(left.priority) || 0) ||
      String(left.athleteName || '').localeCompare(String(right.athleteName || '')));
  }

  function painDetail(row) {
    const pain = row.evidence?.pain;
    if (!pain) return '';
    const bits = [];
    if (pain.score !== null && pain.score !== undefined) bits.push(`<strong>${escapeHtml(pain.score)}/10</strong>`);
    if (pain.location) bits.push(escapeHtml(pain.location));
    if (pain.coachAlert) bits.push('Coach alert');
    return bits.length ? `<div class="triage-pain">${bits.join(' · ')}</div>` : '';
  }

  function rowHtml(row) {
    const tone = SEVERITY_CLASS[row.severity] || '';
    const label = FLAG_LABELS[row.flag] || 'Needs review';
    const action = row.action || {};
    const code = action.athleteCode || row.athleteCode;
    const key = `${codeOf(row)}|${row.flag}`;
    const busy = pending.has(key);
    const also = (row.also || []).filter(Boolean);
    return `<li class="triage-row${tone ? ` ${tone}` : ''}">
      <div class="triage-athlete">
        <button type="button" class="triage-athlete-name triage-athlete-open" data-triage-open="${escapeHtml(row.athleteCode)}">${escapeHtml(row.athleteName || row.athleteCode)}</button>
        <div class="triage-flag">${escapeHtml(label)}</div>
      </div>
      <p class="triage-signal">${escapeHtml(row.signal)}</p>
      ${painDetail(row)}
      ${also.length ? `<ul class="triage-also">${also.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      <div class="triage-row-actions">
        <button type="button" class="triage-action" data-triage-code="${escapeHtml(code)}" data-triage-action="${escapeHtml(action.type || 'message')}" data-triage-date="${escapeHtml(action.date || '')}">
          ${escapeHtml(action.label || 'Check in')}
        </button>
        ${row.fingerprint ? `<button type="button" class="triage-resolve" data-triage-resolve="${escapeHtml(row.flag)}" data-triage-code="${escapeHtml(row.athleteCode)}" data-triage-print="${escapeHtml(row.fingerprint)}" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Resolve'}</button>` : ''}
      </div>
    </li>`;
  }

  function resolvedHtml(resolved) {
    if (!resolved.length) return '';
    return `<details class="triage-resolved-list">
      <summary>${resolved.length} resolved</summary>
      ${resolved.map(row => {
        const key = `${codeOf(row)}|${row.flag}`;
        const busy = pending.has(key);
        const when = row.resolvedAt ? new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Adelaide', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(row.resolvedAt)) : '';
        return `<div class="triage-resolved-row">
          <strong>${escapeHtml(row.athleteName || row.athleteCode)}</strong>
          <span>${escapeHtml(FLAG_LABELS[row.flag] || row.flag)} <span class="triage-resolved-meta">${escapeHtml(row.resolvedBy || '')}${when ? ` · ${escapeHtml(when)}` : ''}</span></span>
          <button type="button" class="triage-restore" data-triage-restore="${escapeHtml(row.flag)}" data-triage-code="${escapeHtml(row.athleteCode)}" ${busy ? 'disabled' : ''}>${busy ? '…' : 'Reopen'}</button>
        </div>`;
      }).join('')}
    </details>`;
  }

  function ageCopy(days) {
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d`;
  }

  function renderReviewQueue(review) {
    const target = document.getElementById('review-queue');
    if (!target) return;
    const queue = Array.isArray(review?.queue) ? review.queue : [];
    const counts = review?.counts || {};
    const overdueAfter = Number(review?.overdueAfterDays) || 2;
    const tone = counts.overdue ? ' is-overdue' : queue.length ? '' : ' is-clear';
    const shown = queue.slice(0, 12);
    target.innerHTML = `<section class="review-panel" aria-labelledby="review-title">
      <div class="review-head">
        <h2 id="review-title">To review</h2>
        <span class="review-count${tone}">${queue.length}</span>
      </div>
      <p class="review-sub">Submitted training with no review yet, oldest first.${counts.overdue ? ` ${escapeHtml(counts.overdue)} past ${overdueAfter} days.` : ''}</p>
      ${shown.length ? `<ul class="review-list">${shown.map(entry => {
        const key = `review|${entry.athleteCode}|${entry.date}`;
        const busy = pending.has(key);
        const names = (entry.sessions || []).map(s => s.name).filter(Boolean).join(', ') || 'Training';
        return `<li class="review-item${entry.days >= overdueAfter ? ' is-overdue' : ''}">
          <button type="button" class="review-open" data-review-open="${escapeHtml(entry.athleteCode)}" data-review-date="${escapeHtml(entry.date)}">
            <span class="review-athlete">${escapeHtml(entry.athleteName || entry.athleteCode)}</span>
            <span class="review-session">${escapeHtml(names)}</span>
            <span class="review-age">${escapeHtml(ageCopy(entry.days))}</span>
          </button>
          <button type="button" class="review-tick" data-review-done="${escapeHtml(entry.athleteCode)}" data-review-date="${escapeHtml(entry.date)}" aria-label="Mark ${escapeHtml(entry.athleteName || entry.athleteCode)} ${escapeHtml(entry.date)} reviewed" ${busy ? 'disabled' : ''}>${busy ? '…' : '✓'}</button>
        </li>`;
      }).join('')}</ul>` : '<p class="review-empty">Nothing waiting on review.</p>'}
      ${queue.length > shown.length ? `<div class="review-more">+${queue.length - shown.length} more</div>` : ''}
    </section>`;
  }

  function render() {
    const data = serverData || {};
    const counts = data.counts || {};
    const queue = mergedQueue();
    const summary = document.getElementById('triage-summary');
    const list = document.getElementById('triage-queue');
    const clear = document.getElementById('triage-clear');
    const resolvedTarget = document.getElementById('triage-resolved');
    const badge = document.getElementById('tab-triage-count');
    const flagged = queue.length;
    const critical = queue.filter(row => row.severity === 'critical').length;

    if (badge) {
      badge.textContent = flagged || '—';
      badge.classList.toggle('red', flagged > 0);
    }

    if (summary) {
      summary.innerHTML = [
        stat(flagged, 'Need attention', flagged ? 'is-critical' : ''),
        stat(critical, 'Pain / alert', critical ? 'is-critical' : ''),
        stat(Math.max(0, (Number(counts.active) || 0) - flagged - (Number(counts.resolved) || 0)), 'Nothing flagged', 'is-clear'),
      ].join('');
    }

    if (list) list.innerHTML = queue.map(rowHtml).join('');

    if (clear) {
      const active = Number(counts.active) || 0;
      const clearCount = Math.max(0, active - flagged - (Number(counts.resolved) || 0));
      clear.textContent = `${clearCount} athlete${clearCount === 1 ? '' : 's'}, nothing flagged.`;
      clear.classList.toggle('is-all-clear', queue.length === 0);
    }

    if (resolvedTarget) resolvedTarget.innerHTML = resolvedHtml(Array.isArray(data.resolved) ? data.resolved : []);

    renderReviewQueue(data.review);

    const date = document.getElementById('triage-date');
    if (date) {
      date.textContent = new Intl.DateTimeFormat('en-AU', {
        timeZone: data.timeZone || 'Australia/Adelaide',
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      }).format(new Date(data.generatedAt || Date.now()));
    }
  }

  async function loadTriage() {
    if (!serverData) setState('loading');
    try {
      const response = await fetch('/api/coach-data?mode=triage', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        console.warn('[triage] request failed', { status: response.status, error: data.error || null });
        throw new Error('Today could not load. Retry, or open Overview while the connection recovers.');
      }
      serverData = data;
      render();
      setState('ready');
    } catch (error) {
      console.warn('[triage]', error);
      setState('error', error.message || 'Triage data is unavailable.');
    }
  }

  function setClientSignals(rows) {
    clientSignals = Array.isArray(rows) ? rows.filter(row => row && row.athleteCode) : [];
    if (serverData) render();
  }

  function notice(message, tone) {
    if (typeof window.workflowNotice === 'function') window.workflowNotice(message, tone);
  }

  async function post(payload) {
    if (typeof window.maPost !== 'function') throw new Error('Coach actions are not available');
    return window.maPost(payload);
  }

  async function resolveRow(flag, code, fingerprint) {
    const key = `${String(code).toUpperCase()}|${flag}`;
    if (pending.has(key)) return;
    pending.add(key);
    render();
    try {
      await post({ action: 'signal_resolve', code, signal_type: flag, fingerprint });
      notice(`${code} resolved`);
      // Client alerts share coach_signal_state with the dashboard's own
      // acknowledgement view; pull it so both screens agree.
      if (flag === 'client_alert' && typeof window.refreshSharedAcknowledgements === 'function') {
        await window.refreshSharedAcknowledgements();
      }
      await loadTriage();
    } catch (error) {
      notice(`Could not resolve: ${error.message}`, 'error');
    } finally {
      pending.delete(key);
      render();
    }
  }

  async function restoreRow(flag, code) {
    const key = `${String(code).toUpperCase()}|${flag}`;
    if (pending.has(key)) return;
    pending.add(key);
    render();
    try {
      await post({ action: 'signal_restore', code, signal_type: flag });
      notice(`${code} reopened`);
      if (flag === 'client_alert' && typeof window.refreshSharedAcknowledgements === 'function') {
        await window.refreshSharedAcknowledgements();
      }
      await loadTriage();
    } catch (error) {
      notice(`Could not reopen: ${error.message}`, 'error');
    } finally {
      pending.delete(key);
      render();
    }
  }

  async function markReviewed(code, date) {
    const key = `review|${code}|${date}`;
    if (pending.has(key)) return;
    pending.add(key);
    render();
    try {
      await post({ action: 'session_review', code, session_date: date });
      notice(`${code} · ${date} marked reviewed`);
      await loadTriage();
    } catch (error) {
      notice(`Could not update review: ${error.message}`, 'error');
    } finally {
      pending.delete(key);
      render();
    }
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
    const select = document.getElementById('cn-recipient');
    if (select) {
      const target = String(code).toUpperCase();
      const option = Array.from(select.options).find(item => String(item.value).toUpperCase() === target);
      if (option) select.value = option.value;
    }
    document.getElementById('cn-msg-body')?.focus();
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
    if (type === 'open_review') return openAthlete(code, { tab: 'training', date });
    if (type === 'open_athlete') return openAthlete(code, { tab: 'overview' });
    if (type === 'open_strength') return openAthlete(code, { tab: 'strength' });
    if (type === 'review') return openReview(code);
    return openMessage(code);
  }

  window.loadTriage = loadTriage;
  window.DP_TRIAGE = { reload: loadTriage, setClientSignals, mergedQueue };

  document.addEventListener('DOMContentLoaded', async function () {
    document.querySelector('[data-triage-retry]')?.addEventListener('click', loadTriage);
    const onClick = event => {
      const target = event.target;
      const resolve = target.closest('[data-triage-resolve]');
      if (resolve) return resolveRow(resolve.dataset.triageResolve, resolve.dataset.triageCode, resolve.dataset.triagePrint);
      const restore = target.closest('[data-triage-restore]');
      if (restore) return restoreRow(restore.dataset.triageRestore, restore.dataset.triageCode);
      const open = target.closest('[data-triage-open]');
      if (open) return openAthlete(open.dataset.triageOpen, { tab: 'overview' });
      const button = target.closest('[data-triage-code][data-triage-action]');
      if (button) return runAction(button.dataset.triageAction, button.dataset.triageCode, button.dataset.triageDate || undefined);
      const done = target.closest('[data-review-done]');
      if (done) return markReviewed(done.dataset.reviewDone, done.dataset.reviewDate);
      const review = target.closest('[data-review-open]');
      if (review) {
        const code = review.dataset.reviewOpen;
        const date = review.dataset.reviewDate;
        return openAthlete(code, { tab: 'training', date });
      }
      return undefined;
    };
    document.getElementById('triage-content')?.addEventListener('click', onClick);
    document.getElementById('review-queue')?.addEventListener('click', onClick);
    await window.DP_COACH_AUTH?.ready;
    loadTriage();
  });
})();
