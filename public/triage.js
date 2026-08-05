(function () {
  'use strict';

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

  function render(data) {
    const counts = data.counts || {};
    const queue = Array.isArray(data.queue) ? data.queue : [];
    const summary = document.getElementById('triage-summary');
    const list = document.getElementById('triage-queue');
    const clear = document.getElementById('triage-clear');
    const badge = document.getElementById('tab-triage-count');

    if (badge) {
      badge.textContent = counts.flagged || '—';
      badge.classList.toggle('red', Number(counts.flagged) > 0);
    }

    if (summary) {
      summary.innerHTML = [
        stat(counts.flagged, 'Need attention', counts.flagged ? 'is-critical' : ''),
        stat(counts.critical, 'Pain / alert', counts.critical ? 'is-critical' : ''),
        stat(counts.clear, 'Nothing flagged', 'is-clear'),
      ].join('');
    }

    if (list) {
      list.innerHTML = queue.map(row => {
        const critical = row.severity === 'critical';
        const label = row.flag === 'pain' ? 'Pain / alert' : 'Gone quiet';
        return `<li class="triage-row${critical ? ' is-critical' : ''}">
          <div class="triage-athlete">
            <div class="triage-athlete-name">${escapeHtml(row.athleteName || row.athleteCode)}</div>
            <div class="triage-flag">${label}</div>
          </div>
          <p class="triage-signal">${escapeHtml(row.signal)}</p>
          <button type="button" class="triage-action" data-triage-code="${escapeHtml(row.action?.athleteCode || row.athleteCode)}">
            ${escapeHtml(row.action?.label || 'Check in')}
          </button>
        </li>`;
      }).join('');
    }

    if (clear) {
      const active = Number(counts.active) || 0;
      const clearCount = Number(counts.clear) || 0;
      clear.textContent = `${clearCount} athlete${clearCount === 1 ? '' : 's'}, nothing flagged.`;
      clear.classList.toggle('is-all-clear', queue.length === 0);
      if (queue.length === 0 && active !== clearCount) {
        clear.textContent = `${active} athlete${active === 1 ? '' : 's'}, nothing flagged.`;
      }
    }

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
    setState('loading');
    try {
      const response = await fetch('/api/coach-data?mode=triage', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || `Triage request failed (${response.status})`);
      }
      render(data);
      setState('ready');
    } catch (error) {
      console.warn('[triage]', error);
      setState('error', error.message || 'Triage data is unavailable.');
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

  window.loadTriage = loadTriage;

  document.addEventListener('DOMContentLoaded', async function () {
    document.querySelector('[data-triage-retry]')?.addEventListener('click', loadTriage);
    document.getElementById('triage-queue')?.addEventListener('click', event => {
      const button = event.target.closest('[data-triage-code]');
      if (button) openMessage(button.dataset.triageCode);
    });
    await window.DP_COACH_AUTH?.ready;
    loadTriage();
  });
})();
