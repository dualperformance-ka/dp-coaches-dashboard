(function () {
  'use strict';

  // Open, in-progress and waiting actions: what the board polls.
  let actions = [];
  // Completed actions are history. They are fetched only while the Completed
  // tab is open; until then only their count is polled.
  let completed = null;
  let completedCount = null;
  let athletes = [];
  let health = null;
  let filter = 'open';
  let editingId = null;
  let restoreFocus = null;
  const pendingIds = new Set();
  let lastError = '';
  let refreshPromise = null;
  let rendered = false;
  let poller = null;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const currentCoach = () => window.DP_COACH_AUTH?.coach?.() || document.getElementById('coach-select')?.value || 'COACH';

  async function request(url, init) {
    const response = await fetch(url, init);
    // 503 + Retry-After is the server saying the database is down; `error` is
    // already a readable sentence and `code` the stable machine value.
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  function visibleActions() {
    const coach = currentCoach().toLowerCase();
    if (filter === 'mine') return actions.filter(a => !['done', 'cancelled'].includes(a.status) && String(a.owner || '').toLowerCase() === coach);
    if (filter === 'overdue') return actions.filter(a => !['done', 'cancelled'].includes(a.status) && a.due_at && a.due_at < today());
    if (filter === 'done') return (completed || []).filter(a => a.status === 'done');
    return actions.filter(a => !['done', 'cancelled'].includes(a.status));
  }

  function dueLabel(action) {
    if (!action.due_at) return 'No due date';
    if (action.due_at < today() && !['done', 'cancelled'].includes(action.status)) return `Overdue · ${action.due_at}`;
    if (action.due_at === today()) return 'Due today';
    return `Due ${action.due_at}`;
  }

  function actorLabel(action) {
    if (action.status === 'done' && action.completed_by) {
      const completed = action.completed_at ? new Date(action.completed_at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '';
      return `Completed by ${action.completed_by}${completed ? ` · ${completed}` : ''}`;
    }
    return `${action.owner || 'Unassigned'} · ${dueLabel(action)} · ${action.status.replace('_', ' ')}`;
  }

  function render() {
    const root = document.getElementById('coaching-actions');
    if (!root) return;
    const open = actions.filter(a => !['done', 'cancelled'].includes(a.status));
    const overdue = open.filter(a => a.due_at && a.due_at < today());
    const mine = open.filter(a => String(a.owner || '').toLowerCase() === currentCoach().toLowerCase());
    const completedTotal = completed ? completed.length : completedCount;
    const rows = visibleActions();
    const completedLoading = filter === 'done' && completed === null;
    const conflicts = health?.portalSupabase?.integrity?.weeklyConflicts || [];

    root.innerHTML = `
      <section class="coach-actions" aria-labelledby="coach-actions-title">
        <div class="coach-actions-head">
          <div>
            <div class="coach-actions-kicker">Shared accountability</div>
            <h2 id="coach-actions-title">Coaching actions</h2>
            <p>${open.length} open · ${mine.length} owned by ${esc(currentCoach())} · ${overdue.length} overdue</p>
          </div>
          <button type="button" class="coach-action-new" onclick="DP_ACTIONS.open()">+ New action</button>
        </div>
        ${conflicts.length ? `<div class="coach-data-warning" role="status"><strong>Data review:</strong> ${conflicts.length} cross-athlete duplicate check-in${conflicts.length === 1 ? '' : 's'} suppressed. Review this on the Sync tab.</div>` : ''}
        ${lastError ? `<div class="coach-action-load-error" role="alert">${esc(lastError)}</div>` : ''}
        <div class="coach-action-filters" role="tablist" aria-label="Action filters">
          ${[['open', `Open ${open.length}`], ['mine', `Mine ${mine.length}`], ['overdue', `Overdue ${overdue.length}`], ['done', `Completed${completedTotal === null || completedTotal === undefined ? '' : ` ${completedTotal}`}`]].map(([key, label]) => `<button type="button" role="tab" aria-selected="${filter === key}" class="${filter === key ? 'active' : ''}" onclick="DP_ACTIONS.filter('${key}')">${label}</button>`).join('')}
        </div>
        ${filter === 'done' ? `<div class="coach-action-history-note">Completed actions are kept here for both coaches, including who completed them and when.</div>` : ''}
        <div class="coach-action-list">
          ${completedLoading ? `<div class="coach-action-empty">Loading completed actions…</div>` : rows.length ? rows.map(action => `
            <article class="coach-action-row priority-${esc(action.priority)} ${action.due_at && action.due_at < today() && action.status !== 'done' ? 'is-overdue' : ''}">
              <button type="button" class="coach-action-main" onclick="DP_ACTIONS.open('', '', '', '${esc(action.id)}')">
                <span class="coach-action-athlete">${esc(action.athlete_code)}</span>
                <span class="coach-action-title">${esc(action.title)}</span>
                <span class="coach-action-meta">${esc(actorLabel(action))}</span>
              </button>
              ${action.status === 'done' ? `<button type="button" class="coach-action-complete" onclick="DP_ACTIONS.setStatus('${esc(action.id)}','open')" ${pendingIds.has(action.id) ? 'disabled' : ''}>${pendingIds.has(action.id) ? 'Saving…' : 'Reopen'}</button>` : `<button type="button" class="coach-action-complete" onclick="DP_ACTIONS.setStatus('${esc(action.id)}','done')" ${pendingIds.has(action.id) ? 'disabled' : ''}>${pendingIds.has(action.id) ? 'Saving…' : '✓ Done'}</button>`}
            </article>`).join('') : `<div class="coach-action-empty">${filter === 'done' ? 'No completed actions yet. When a coach clicks Done, the action will be stored here.' : 'No actions in this view. Keep it that way—or capture the next coaching commitment.'}</div>`}
        </div>
      </section>`;
  }

  function ensureModal() {
    if (document.getElementById('coach-action-modal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="coach-action-backdrop" id="coach-action-modal" hidden>
        <div class="coach-action-dialog" role="dialog" aria-modal="true" aria-labelledby="coach-action-dialog-title">
          <div class="coach-action-dialog-head"><div><div class="coach-actions-kicker">Coach commitment</div><h2 id="coach-action-dialog-title">New action</h2></div><button type="button" class="coach-action-close" aria-label="Close action" onclick="DP_ACTIONS.close()">×</button></div>
          <form id="coach-action-form">
            <div class="coach-action-grid">
              <label>Athlete<select id="ca-athlete" required></select></label>
              <label>Owner<select id="ca-owner"><option>KARL</option><option>ALEX</option></select></label>
              <label class="span-2">Action<input id="ca-title" maxlength="180" required placeholder="What needs to happen next?"></label>
              <label>Due date<input id="ca-due" type="date"></label>
              <label>Priority<select id="ca-priority"><option value="urgent">Urgent</option><option value="high">High</option><option value="normal" selected>Normal</option><option value="low">Low</option></select></label>
              <label>Category<select id="ca-category"><option value="coaching">Coaching</option><option value="programming">Programming</option><option value="recovery">Recovery / injury</option><option value="nutrition">Nutrition</option><option value="admin">Admin</option></select></label>
              <label>Status<select id="ca-status"><option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting">Waiting</option><option value="done">Done</option><option value="cancelled">Cancelled</option></select></label>
              <label class="span-2">Notes<textarea id="ca-notes" rows="3" maxlength="4000" placeholder="Context, agreed next step, or handover"></textarea></label>
              <label class="span-2">Outcome<textarea id="ca-outcome" rows="2" maxlength="4000" placeholder="What changed? Required when closing meaningful actions."></textarea></label>
            </div>
            <div class="coach-action-error" id="ca-error" role="alert"></div>
            <div class="coach-action-dialog-actions"><button type="button" onclick="DP_ACTIONS.close()">Cancel</button><button type="submit" class="primary" id="ca-save">Save action</button></div>
          </form>
        </div>
      </div>`);
    document.getElementById('coach-action-form').addEventListener('submit', save);
    document.getElementById('coach-action-modal').addEventListener('click', event => { if (event.target.id === 'coach-action-modal') close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.getElementById('coach-action-modal').hidden) close(); });
  }

  function populateAthletes(selected) {
    const select = document.getElementById('ca-athlete');
    select.innerHTML = athletes.map(a => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join('');
    if (selected) select.value = selected;
  }

  function open(athlete = '', title = '', priority = 'normal', id = '') {
    ensureModal();
    restoreFocus = document.activeElement;
    editingId = id || null;
    const action = editingId ? findAction(editingId) : null;
    populateAthletes(action?.athlete_code || athlete || athletes[0]?.id || '');
    document.getElementById('coach-action-dialog-title').textContent = action ? 'Edit action' : 'New action';
    document.getElementById('ca-owner').value = action?.owner || currentCoach();
    document.getElementById('ca-title').value = action?.title || title;
    document.getElementById('ca-due').value = action?.due_at || '';
    document.getElementById('ca-priority').value = action?.priority || priority || 'normal';
    document.getElementById('ca-category').value = action?.category || 'coaching';
    document.getElementById('ca-status').value = action?.status || 'open';
    document.getElementById('ca-notes').value = action?.notes || '';
    document.getElementById('ca-outcome').value = action?.outcome || '';
    document.getElementById('ca-error').textContent = '';
    const modal = document.getElementById('coach-action-modal');
    modal.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => document.getElementById('ca-title').focus(), 0);
  }

  function close() {
    const modal = document.getElementById('coach-action-modal');
    if (modal) modal.hidden = true;
    document.body.classList.remove('modal-open');
    restoreFocus?.focus?.();
  }

  async function save(event) {
    event.preventDefault();
    const button = document.getElementById('ca-save');
    button.disabled = true;
    document.getElementById('ca-error').textContent = '';
    const payload = {
      ...(editingId ? { id: editingId } : {}),
      athlete_code: document.getElementById('ca-athlete').value,
      owner: document.getElementById('ca-owner').value,
      title: document.getElementById('ca-title').value,
      due_at: document.getElementById('ca-due').value || null,
      priority: document.getElementById('ca-priority').value,
      category: document.getElementById('ca-category').value,
      status: document.getElementById('ca-status').value,
      notes: document.getElementById('ca-notes').value,
      outcome: document.getElementById('ca-outcome').value,
    };
    try {
      const saved = await request('/api/actions', { method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      // Show the saved row now; a poll already in flight may predate the save.
      placeAction(saved.action);
      render();
      close();
      await refresh();
    } catch (e) {
      document.getElementById('ca-error').textContent = e.message;
    } finally { button.disabled = false; }
  }

  function findAction(id) {
    return actions.find(item => item.id === id) || (completed || []).find(item => item.id === id) || null;
  }

  // Moves an updated action between the active list and the Completed history
  // without waiting for the next poll.
  function placeAction(updated) {
    if (!updated) return;
    const wasCompleted = (completed || []).some(item => item.id === updated.id);
    const isCompleted = updated.status === 'done';
    actions = actions.filter(item => item.id !== updated.id);
    if (completed) completed = completed.filter(item => item.id !== updated.id);
    if (isCompleted) {
      if (completed) completed = [updated, ...completed];
      if (!wasCompleted && Number.isFinite(completedCount)) completedCount += 1;
    } else {
      if (updated.status !== 'cancelled') actions = [...actions, updated];
      if (wasCompleted && Number.isFinite(completedCount)) completedCount = Math.max(0, completedCount - 1);
    }
  }

  async function setStatus(id, status) {
    if (pendingIds.has(id)) return;
    const action = findAction(id);
    if (!action) return;
    pendingIds.add(id);
    lastError = '';
    render();
    try {
      const payload = await request('/api/actions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status, outcome: action.outcome || '' }),
      });
      placeAction(payload.action);
      window.DP_WORKFLOW_NOTICE?.(
        status === 'done'
          ? `${action.athlete_code} completed by ${payload.action.completed_by || currentCoach()} · moved to Completed`
          : `${action.athlete_code} action reopened by ${payload.action.updated_by || currentCoach()}`
      );
    } catch (error) {
      lastError = `Could not update ${action.athlete_code}: ${error.message}`;
      window.DP_WORKFLOW_NOTICE?.(lastError, 'error');
    } finally {
      pendingIds.delete(id);
      render();
    }
  }

  function isTextField(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable ||
      (tag === 'INPUT' && !['button', 'submit', 'checkbox', 'radio'].includes(el.type));
  }

  // A background refresh never repaints under a coach who is typing in the
  // board; it waits for them to leave the field.
  let renderDeferred = false;
  function renderWhenIdle() {
    const root = document.getElementById('coaching-actions');
    const active = document.activeElement;
    if (root && active && root.contains(active) && isTextField(active)) {
      if (!renderDeferred) {
        renderDeferred = true;
        root.addEventListener('focusout', () => { renderDeferred = false; setTimeout(renderWhenIdle, 0); }, { once: true });
      }
      return;
    }
    render();
    rendered = true;
  }

  // One load at a time per tab: a poll, a save and a context change share the
  // same request. Throws on failure so the poller can back off.
  function load(signal) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const init = { cache: 'no-store', signal };
        const payload = await request('/api/actions?status=active', init);
        const nextActions = Array.isArray(payload.actions) ? payload.actions : [];
        const nextCount = Number.isFinite(payload.completedCount) ? payload.completedCount : completedCount;
        let nextCompleted = completed;
        if (filter === 'done') {
          const history = await request('/api/actions?status=done', init);
          nextCompleted = Array.isArray(history.actions) ? history.actions : [];
        }
        const changed = JSON.stringify([nextActions, nextCount, nextCompleted]) !==
          JSON.stringify([actions, completedCount, completed]);
        actions = nextActions;
        completedCount = nextCount;
        completed = nextCompleted;
        const recovered = Boolean(lastError);
        lastError = '';
        if (changed || recovered || !rendered) renderWhenIdle();
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  // Foreground refresh (start-up, after a save, after the roster reloads).
  // A failure keeps whatever is on screen; only a board that never loaded
  // shows the error in its place.
  async function refresh() {
    try {
      await load();
    } catch (e) {
      const root = document.getElementById('coaching-actions');
      if (root && !rendered) root.innerHTML = `<div class="coach-action-load-error">Coaching actions unavailable: ${esc(e.message)}</div>`;
    }
  }

  function setContext(nextAthletes, nextHealth) {
    athletes = Array.isArray(nextAthletes) ? nextAthletes : athletes;
    health = nextHealth || health;
    refresh();
  }

  function setFilter(next) {
    filter = next;
    render();
    // History is on demand: the first open of Completed fetches it.
    if (next === 'done' && completed === null) refresh();
  }

  window.DP_ACTIONS = { open, close, filter: setFilter, setStatus, refresh, setContext };
  document.addEventListener('DOMContentLoaded', async () => {
    await window.DP_COACH_AUTH?.ready;
    await refresh();
    // Visible, online tabs only; one request at a time; 60s when healthy,
    // backing off to 5 minutes while the API is failing. See background-poller.js.
    if (window.DPPoller) {
      poller = window.DPPoller.createPoller({
        name: 'coaching-actions',
        run: ({ signal }) => load(signal),
        onError: (error, { failures }) => console.warn('[coaching actions] background refresh failed', { failures, message: error?.message }),
      }).start();
    }
  });
})();
