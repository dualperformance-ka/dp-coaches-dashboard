(function () {
  'use strict';

  const KEY_NAME = 'dp_dashboard_key';
  const COACH_NAME = 'dp_dashboard_coach';
  const nativeFetch = window.fetch.bind(window);
  let accessKey = sessionStorage.getItem(KEY_NAME) || '';
  let coach = sessionStorage.getItem(COACH_NAME) || 'KARL';
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  function withCoachHeaders(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const sameOriginApi = url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`);
    if (!sameOriginApi) return init;
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    if (accessKey) headers.set('X-Dashboard-Key', accessKey);
    if (coach) headers.set('X-Coach-Name', coach);
    return { ...(init || {}), headers };
  }

  window.fetch = async function coachFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const sameOriginApi = url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`);
    const isSessionCheck = url.includes('/api/actions?mode=session');
    if (sameOriginApi && !isSessionCheck) await ready;
    const response = await nativeFetch(input, withCoachHeaders(input, init));
    if (sameOriginApi && response.status === 401 && !isSessionCheck) showGate('Your session expired. Enter the dashboard access key again.');
    return response;
  };

  function el(id) { return document.getElementById(id); }

  function ensureGate() {
    if (el('dp-access-gate')) return;
    document.body.insertAdjacentHTML('afterbegin', `
      <div class="dp-access-gate" id="dp-access-gate" role="dialog" aria-modal="true" aria-labelledby="dp-access-title">
        <form class="dp-access-card" id="dp-access-form">
          <img src="/dp-wordmark-dark.png" alt="Dual Performance" class="dp-access-logo">
          <div class="dp-access-kicker">Coaching workspace</div>
          <h1 id="dp-access-title">Start your coach session</h1>
          <p>Athlete information is private. Choose your name and enter the shared dashboard access key.</p>
          <label for="dp-access-coach">Coach</label>
          <select id="dp-access-coach" autocomplete="username">
            <option value="KARL">Karl</option><option value="ALEX">Alex</option>
          </select>
          <label for="dp-access-key">Access key</label>
          <input id="dp-access-key" type="password" autocomplete="current-password" required>
          <div class="dp-access-error" id="dp-access-error" role="alert"></div>
          <button type="submit" id="dp-access-submit">Open dashboard</button>
          <small>The key stays in this browser tab only and is cleared when the tab closes.</small>
        </form>
      </div>`);
    el('dp-access-coach').value = coach;
    el('dp-access-form').addEventListener('submit', verifyFromForm);
  }

  async function verify(key, selectedCoach) {
    const response = await nativeFetch('/api/actions?mode=session', {
      cache: 'no-store',
      headers: { 'X-Dashboard-Key': key, 'X-Coach-Name': selectedCoach },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'Access key rejected');
    accessKey = key;
    coach = String(payload.coach || selectedCoach || 'KARL').toUpperCase();
    sessionStorage.setItem(KEY_NAME, accessKey);
    sessionStorage.setItem(COACH_NAME, coach);
    return payload;
  }

  async function verifyFromForm(event) {
    event.preventDefault();
    const button = el('dp-access-submit');
    const error = el('dp-access-error');
    button.disabled = true;
    button.textContent = 'Checking…';
    error.textContent = '';
    try {
      await verify(el('dp-access-key').value.trim(), el('dp-access-coach').value);
      el('dp-access-gate').classList.add('is-hidden');
      syncCoachControl();
      resolveReady();
    } catch (e) {
      error.textContent = e.message || 'Could not start the coach session';
      el('dp-access-key').select();
    } finally {
      button.disabled = false;
      button.textContent = 'Open dashboard';
    }
  }

  function showGate(message) {
    accessKey = '';
    sessionStorage.removeItem(KEY_NAME);
    ensureGate();
    el('dp-access-gate').classList.remove('is-hidden');
    if (message) el('dp-access-error').textContent = message;
    setTimeout(() => el('dp-access-key')?.focus(), 0);
  }

  function syncCoachControl() {
    const select = el('coach-select');
    if (select) select.value = coach;
    if (!el('dp-logout-btn')) {
      const headerControls = document.querySelector('.h-right');
      const button = document.createElement('button');
      button.id = 'dp-logout-btn';
      button.className = 'refresh-btn dp-logout-btn';
      button.type = 'button';
      button.textContent = 'Lock';
      button.addEventListener('click', logout);
      headerControls?.appendChild(button);
    }
  }

  function setCoach(value) {
    coach = String(value || coach || 'KARL').toUpperCase();
    sessionStorage.setItem(COACH_NAME, coach);
  }

  function logout() {
    accessKey = '';
    sessionStorage.removeItem(KEY_NAME);
    sessionStorage.removeItem(COACH_NAME);
    location.reload();
  }

  window.DP_COACH_AUTH = { ready, getKey: () => accessKey, coach: () => coach, setCoach, logout, showGate };

  document.addEventListener('DOMContentLoaded', async () => {
    ensureGate();
    if (!accessKey) return showGate();
    try {
      await verify(accessKey, coach);
      el('dp-access-gate').classList.add('is-hidden');
      syncCoachControl();
      resolveReady();
    } catch {
      showGate('Enter the current dashboard access key to continue.');
    }
  });
})();
