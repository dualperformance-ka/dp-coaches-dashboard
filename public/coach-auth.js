(function () {
  'use strict';

  const KEY_NAME = 'dp_dashboard_key';
  const COACH_NAME = 'dp_dashboard_coach';
  const PERSIST_NAME = 'dp_dashboard_remembered_session';
  const PERSIST_FOR_MS = 30 * 24 * 60 * 60 * 1000;
  const nativeFetch = window.fetch.bind(window);
  const persistedSession = readPersistedSession();
  let accessKey = sessionStorage.getItem(KEY_NAME) || persistedSession?.key || '';
  let coach = sessionStorage.getItem(COACH_NAME) || persistedSession?.coach || 'KARL';
  let rememberSession = !!persistedSession;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  function clearPersistedSession() {
    try { localStorage.removeItem(PERSIST_NAME); } catch {}
  }

  function readPersistedSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(PERSIST_NAME) || 'null');
      const valid =
        saved &&
        typeof saved.key === 'string' &&
        saved.key.length > 0 &&
        typeof saved.expiresAt === 'number' &&
        saved.expiresAt > Date.now();

      if (!valid) {
        clearPersistedSession();
        return null;
      }

      return {
        key: saved.key,
        coach: String(saved.coach || 'KARL').toUpperCase(),
      };
    } catch {
      clearPersistedSession();
      return null;
    }
  }

  function persistSession() {
    if (!rememberSession || !accessKey) return;
    try {
      localStorage.setItem(PERSIST_NAME, JSON.stringify({
        key: accessKey,
        coach,
        expiresAt: Date.now() + PERSIST_FOR_MS,
      }));
    } catch {}
  }

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
          <label class="dp-access-remember" for="dp-access-remember">
            <input id="dp-access-remember" type="checkbox">
            <span>
              <strong>Keep me signed in on this device</strong>
              <small>Private devices only · remembered for 30 days</small>
            </span>
          </label>
          <div class="dp-access-error" id="dp-access-error" role="alert"></div>
          <button type="submit" id="dp-access-submit">Open dashboard</button>
        </form>
      </div>`);
    el('dp-access-coach').value = coach;
    el('dp-access-remember').checked =
      rememberSession ||
      matchMedia('(max-width: 720px)').matches ||
      matchMedia('(display-mode: standalone)').matches;
    el('dp-access-form').addEventListener('submit', verifyFromForm);
  }

  async function verify(key, selectedCoach, remember = rememberSession) {
    const response = await nativeFetch('/api/actions?mode=session', {
      cache: 'no-store',
      headers: { 'X-Dashboard-Key': key, 'X-Coach-Name': selectedCoach },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      const error = new Error(payload.error || 'Access key rejected');
      error.authRejected = response.status === 401 || response.status === 403;
      throw error;
    }
    accessKey = key;
    coach = String(payload.coach || selectedCoach || 'KARL').toUpperCase();
    rememberSession = Boolean(remember);
    sessionStorage.setItem(KEY_NAME, accessKey);
    sessionStorage.setItem(COACH_NAME, coach);
    if (rememberSession) persistSession();
    else clearPersistedSession();
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
      await verify(
        el('dp-access-key').value.trim(),
        el('dp-access-coach').value,
        el('dp-access-remember').checked
      );
      el('dp-access-gate').classList.add('is-hidden');
      syncCoachControl();
      resolveReady();
    } catch (e) {
      if (e.authRejected) {
        rememberSession = false;
        clearPersistedSession();
      }
      error.textContent = e.message || 'Could not start the coach session';
      el('dp-access-key').select();
    } finally {
      button.disabled = false;
      button.textContent = 'Open dashboard';
    }
  }

  function showGate(message, { clearSaved = true } = {}) {
    accessKey = '';
    sessionStorage.removeItem(KEY_NAME);
    if (clearSaved) {
      rememberSession = false;
      clearPersistedSession();
    }
    ensureGate();
    el('dp-access-gate').classList.remove('is-hidden');
    el('dp-access-remember').checked =
      rememberSession ||
      matchMedia('(max-width: 720px)').matches ||
      matchMedia('(display-mode: standalone)').matches;
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
    persistSession();
  }

  function logout() {
    accessKey = '';
    rememberSession = false;
    sessionStorage.removeItem(KEY_NAME);
    sessionStorage.removeItem(COACH_NAME);
    clearPersistedSession();
    location.reload();
  }

  window.DP_COACH_AUTH = { ready, getKey: () => accessKey, coach: () => coach, setCoach, logout, showGate };

  document.addEventListener('DOMContentLoaded', async () => {
    ensureGate();
    if (!accessKey) return showGate();
    try {
      await verify(accessKey, coach, rememberSession);
      el('dp-access-gate').classList.add('is-hidden');
      syncCoachControl();
      resolveReady();
    } catch (error) {
      showGate(
        error.authRejected
          ? 'Enter the current dashboard access key to continue.'
          : 'Could not verify the saved session. Check your connection and try again.',
        { clearSaved: !!error.authRejected }
      );
    }
  });
})();
