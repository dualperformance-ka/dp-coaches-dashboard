(function () {
  'use strict';

  let actions = [];
  let athletes = [];
  let health = null;
  let filter = 'open';
  let editingId = null;
  let restoreFocus = null;
  const pendingIds = new Set();
  let lastError = '';
  let refreshPromise = null;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const currentCoach = () => window.DP_COACH_AUTH?.coach?.() || document.getElementById('coach-select')?.value || 'COACH';

  async function request(url, init) {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  function visibleActions() {
    const coach = currentCoach().toLowerCase();
    if (filter === 'mine') return actions.filter(a => !['done', 'cancelled'].includes(a.status) && String(a.owner || '').toLowerCase() === coach);
    if (filter === 'overdue') return actions.filter(a => !['done', 'cancelled'].includes(a.status) && a.due_at && a.due_at < today());
    if (filter === 'done') return actions.filter(a => a.status === 'done');
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
    const completed = actions.filter(a => a.status === 'done');
    const rows = visibleActions();
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
          ${[['open', `Open ${open.length}`], ['mine', `Mine ${mine.length}`], ['overdue', `Overdue ${overdue.length}`], ['done', `Completed ${completed.length}`]].map(([key, label]) => `<button type="button" role="tab" aria-selected="${filter === key}" class="${filter === key ? 'active' : ''}" onclick="DP_ACTIONS.filter('${key}')">${label}</button>`).join('')}
        </div>
        ${filter === 'done' ? `<div class="coach-action-history-note">Completed actions are kept here for both coaches, including who completed them and when.</div>` : ''}
        <div class="coach-action-list">
          ${rows.length ? rows.map(action => `
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
    const action = editingId ? actions.find(item => item.id === editingId) : null;
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
      await request('/api/actions', { method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      close();
      await refresh();
    } catch (e) {
      document.getElementById('ca-error').textContent = e.message;
    } finally { button.disabled = false; }
  }

  async function setStatus(id, status) {
    if (pendingIds.has(id)) return;
    const action = actions.find(item => item.id === id);
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
      actions = actions.map(item => item.id === id ? payload.action : item);
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

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const payload = await request('/api/actions?status=all', { cache: 'no-store' });
        actions = payload.actions || [];
        lastError = '';
        render();
      } catch (e) {
        const root = document.getElementById('coaching-actions');
        if (root && !actions.length) root.innerHTML = `<div class="coach-action-load-error">Coaching actions unavailable: ${esc(e.message)}</div>`;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function setContext(nextAthletes, nextHealth) {
    athletes = Array.isArray(nextAthletes) ? nextAthletes : athletes;
    health = nextHealth || health;
    refresh();
  }

  function setFilter(next) { filter = next; render(); }

  window.DP_ACTIONS = { open, close, filter: setFilter, setStatus, refresh, setContext };
  document.addEventListener('DOMContentLoaded', async () => {
    await window.DP_COACH_AUTH?.ready;
    await refresh();
    setInterval(refresh, 12000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('focus', refresh);
  });
})();
