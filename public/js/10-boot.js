// ── INIT ──────────────────────────────────────────────────────────────────────
var urlCode=new URLSearchParams(location.search).get('code');
// Never leave an access code sitting in the address bar, in history or in a
// screenshot — same treatment the coach token gets at the bottom of this file.
// Only `code` is removed: tab and date deep links are read later, once login
// has resolved, and must survive.
if(urlCode){
  try{
    var _cleanUrl=new URL(location.href);
    _cleanUrl.searchParams.delete('code');
    history.replaceState(null,'',_cleanUrl.toString());
  }catch(e){}
}
// Session-aware boot: resolve the Supabase auth session FIRST so an
// email-migrated athlete reopening the PWA goes straight to the portal (no
// login flash). Legacy athletes have no session and fall through to the
// exact pre-migration paths (?code= link or an active legacy session).
async function bootPortal(){
  // With email auth enabled, email is the primary logged-out experience and
  // the coach-issued athlete code remains available as a one-tap fallback.
  var emailPrimary=typeof EMAIL_AUTH_UI!=='undefined'&&EMAIL_AUTH_UI;
  if(emailPrimary){
    var _emailToggle=document.getElementById('loginMethodToggle');
    if(_emailToggle)_emailToggle.style.display='';
  }
  if(urlCode){
    _authToken=null;
    localStorage.removeItem('dp_legacy_session');
    removePortalOfflineState('dp_auth_token');
    removePortalOfflineState('dp_auth_athlete_code');
    doLogin(sanitizeCode(urlCode));
    return;
  }
  // Fast path: no persisted auth session in storage → skip loading supabase-js
  // before boot, so legacy athletes start exactly as fast as before.
  var hasStoredSession=false;
  try{hasStoredSession=!!localStorage.getItem('dp-portal-auth');}catch(e){}
  try{
    var session=hasStoredSession?await getAuthSession():null;
    if(session){
      _authToken=session.access_token;
      writePortalOfflineState('dp_auth_token',_authToken);
      var me=await resolveAuthedAthlete();
      if(me&&me.ok&&me.exists&&me.code){
        if(me.active===false){showPausedScreen(me.name);return;}
        // Same pipeline as a code login → identical portal, same athlete_code,
        // same history. The session token rides along on API calls.
        // The session lookup already returned the validated roster record.
        // Pass it through so doLogin does not repeat the same network request.
        doLogin(me.code,me);
        return;
      }
      if(me&&(me.error==='invalid_session'||me.error==='no_linked_athlete')) await authSignOut();
      // no_linked_athlete: clear the unresolved session so the athlete can
      // still choose the access-code fallback from the primary email screen.
    }
  }catch(e){console.warn('Auth boot failed, falling back to legacy login',e);}
  var legacyToken=localStorage.getItem('dp_legacy_session');
  if(legacyToken){
    _authToken=legacyToken;
    writePortalOfflineState('dp_auth_token',_authToken);
    var legacyMe=await resolveAuthedAthlete();
    if(legacyMe&&legacyMe.ok&&legacyMe.code){doLogin(legacyMe.code,legacyMe);return;}
    _authToken=null;localStorage.removeItem('dp_legacy_session');removePortalOfflineState('dp_auth_token');
  }
  var savedCode=localStorage.getItem('dp_auth_code');
  var savedMethod=localStorage.getItem('dp_auth_method');
  // A previously authenticated access-code client stays signed in even after
  // its short-lived server token expires: doLogin exchanges the remembered
  // code for a fresh signed session. Explicit logout clears both values.
  if(savedCode&&savedMethod==='code'){doLogin(savedCode);return;}
  // Pre-migration remembered codes (which have no method marker) retain the old
  // automatic behaviour only when email auth is not the primary login.
  if(savedCode&&!emailPrimary){doLogin(savedCode);return;}
  if(typeof showPrimaryLogin==='function')showPrimaryLogin();
  document.getElementById('loginScreen').style.display='block';
}
// ── ANALYTICS LOADER ─────────────────────────────────────────────────────────
// Vercel Web Analytics lives at the same-origin path /_vercel/insights/script.js,
// which does not exist in public/. check-portal.mjs asserts that every
// same-origin src="...js" in index.html is a real file AND appears in the
// service worker shell, so this can only be injected at runtime — never
// written as a literal tag. Async, guarded, and never awaited: a blocked or
// failed load simply leaves window.va undefined and track() becomes a no-op.
function loadVercelAnalytics(){
  try{
    if(window.__dpAnalyticsStarted)return;
    window.__dpAnalyticsStarted=true;
    // Queue shim so events fired before the script lands are not lost.
    window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};
    var el=document.createElement('script');
    el.async=true;el.defer=true;el.src='/_vercel/insights/script.js';
    el.onerror=function(){};
    document.head.appendChild(el);
  }catch(e){}
}
bootPortal().finally(function(){loadVercelAnalytics();});

// Mobile portal header: keep the full-width brand bar at the top, then turn it
// into a compact glass surface once content is moving underneath it.
function updateFloatingPortalHeader(){
  var portal=document.getElementById('portalScreen');
  var active=!!(portal&&portal.style.display!=='none'&&window.scrollY>18);
  document.body.classList.toggle('portal-header-scrolled',active);
}
window.addEventListener('scroll',updateFloatingPortalHeader,{passive:true});
window.addEventListener('resize',updateFloatingPortalHeader);
updateFloatingPortalHeader();

// ============================================================================
// RUNNING LIBRARY INTEGRATION
// Enhances calendar sessions with full workout details from the Supabase
// session_library table (source of truth — replaces the Notion library)
// ============================================================================

const RUNNING_LIBRARY_BY_ID = {};

// The cached library renders immediately. A compact revision check runs only
// after the primary plan is visible, so coach edits still arrive without
// putting the global library on the critical launch path.
var RUN_LIB_CACHE_KEY='dp_run_library_cache_v3';
var RUN_LIB_CACHE_TTL=24*60*60*1000;
var _runLibraryCacheRevision='',_runLibraryCacheLoaded=false,_runLibraryRevisionChecked=false;

function hydrateRunningLibraryMap(byId){
  var ids=Object.keys(byId||{});
  if(!ids.length)return false;
  ids.forEach(function(id){
    var entry=byId[id];
    RUNNING_LIBRARY_BY_ID[id]=entry;
    runLibraryById[id]=Object.assign({},entry,{warmUp:entry.warmup||'',coolDown:entry.cooldown||'',sessionGoal:entry.goal||'',recoveryType:entry.recovery||''});
    if(entry.name)runLibraryByName[entry.name.toLowerCase()]=runLibraryById[id];
  });
  return true;
}
async function hydrateRunningLibraryCache(){
  if(_runLibraryCacheLoaded)return true;
  try{
    var cached=await readPortalOfflineState(RUN_LIB_CACHE_KEY);
    if(cached&&cached.ts&&(Date.now()-cached.ts)<RUN_LIB_CACHE_TTL&&hydrateRunningLibraryMap(cached.byId)){
      _runLibraryCacheLoaded=true;_runLibraryCacheRevision=String(cached.revision||'');
      console.log('Run library: loaded from cache ('+Object.keys(cached.byId).length+' workouts)');
      return true;
    }
  }catch(e){}
  return false;
}
async function cacheRunningLibrary(revision){
  _runLibraryCacheLoaded=true;_runLibraryCacheRevision=String(revision||'');
  await writePortalOfflineState(RUN_LIB_CACHE_KEY,{ts:Date.now(),revision:_runLibraryCacheRevision,byId:RUNNING_LIBRARY_BY_ID});
}
async function loadRunningLibrary(preloaded){
  try{
    if(preloaded&&preloaded.notModified){await hydrateRunningLibraryCache();return true;}
    if(preloaded&&Array.isArray(preloaded.rows)){
      processLibraryRows(preloaded.rows);await cacheRunningLibrary(preloaded.revision);
      _runLibraryRevisionChecked=true;
      console.log('Running Library loaded:',preloaded.rows.length,'workouts');return true;
    }
    if(await hydrateRunningLibraryCache())return true;
    console.log('Loading Running Library...');
    var res=await portalRequest('session-library');
    if(!res.rows){console.warn('Session library load failed');return false;}
    processLibraryRows(res.rows);await cacheRunningLibrary(res.revision);
    _runLibraryRevisionChecked=true;
    console.log('Running Library loaded:',res.rows.length,'workouts');return true;
  }catch(error){console.error('Failed to load Running Library:',error);return false;}
}
async function refreshRunningLibraryRevision(){
  if(_runLibraryRevisionChecked||!_authToken||!_runLibraryCacheLoaded)return;
  _runLibraryRevisionChecked=true;
  try{
    var res=await portalRequest('session-library',{libraryRevision:_runLibraryCacheRevision});
    if(res.notModified){await cacheRunningLibrary(res.revision);return;}
    if(Array.isArray(res.rows)){
      processLibraryRows(res.rows);await cacheRunningLibrary(res.revision);
      if(typeof invalidateProgrammeVolume==='function')invalidateProgrammeVolume();
      if(typeof renderTodaySection==='function')renderTodaySection();
      if(window._portalSecondaryStarted&&typeof loadNutrition==='function')loadNutrition();
    }
  }catch(e){console.warn('Run library revision check failed',e);}
}

// Map a Supabase session_library row to the shape the portal renderers expect.
// Each template is keyed by BOTH its Supabase uuid and its migrated Notion page
// id, so old planned sessions linked by Notion id still resolve.
function processLibraryRows(rows) {
  Object.keys(RUNNING_LIBRARY_BY_ID).forEach(function(id){delete RUNNING_LIBRARY_BY_ID[id];});
  runLibraryById={};runLibraryByName={};
  rows.forEach(function(r) {
    var mapped = {
      name: r.name || '', type: r.session_type || '', description: r.description || '',
      difficulty: r.difficulty || '', distance: r.distance || '', duration: r.duration || '',
      rpe: r.rpe || '', intensity: r.intensity || '', phase: r.phase || '',
      surface: r.surface || '', fatigue: r.fatigue || '', recovery: r.recovery || '',
      goal: r.goal || '', warmup: r.warm_up || '', cooldown: r.cool_down || '',
      prereqs: r.prereqs || '', slot: r.slot || '', targetPace: r.target_pace || '',
      tags: '', alternative: r.alternative || ''
    };
    [r.id, r.notion_page_id].filter(Boolean).forEach(function(id) {
      RUNNING_LIBRARY_BY_ID[id] = mapped;
      runLibraryById[id] = Object.assign({}, runLibraryById[id] || {}, mapped, {
        warmUp: mapped.warmup, coolDown: mapped.cooldown,
        sessionGoal: mapped.goal, recoveryType: mapped.recovery
      });
    });
    if (mapped.name) runLibraryByName[mapped.name.toLowerCase()] = runLibraryById[r.id];
  });
}

// Get workout details from pre-loaded library using page ID
function getRunningLibraryWorkout(workoutIds) {
  if (!workoutIds || !workoutIds.length) return null;
  const workoutId = workoutIds[0];
  return RUNNING_LIBRARY_BY_ID[workoutId] || null;
}

function nl2brSafe(text){
  return esc(String(text||'')).replace(/\n/g,'<br>');
}

function detailRow(label,value){
  if(!value) return '';
  return `
    <div style="margin-bottom:12px;">
      <div style="font-family:var(--mono);font-size:var(--font-xs);text-transform:uppercase;font-weight:600;letter-spacing:0.08em;color:var(--muted);margin-bottom:6px;">
        ${label}
      </div>
      <div style="font-size:var(--font-md);line-height:1.55;color:var(--text);white-space:normal;">
        ${nl2brSafe(value)}
      </div>
    </div>
  `;
}

// Enhanced workout modal with session-aware fallback logic
async function showEnhancedWorkoutModal(sessionIndex) {
  const s = sessions[sessionIndex];
  if (!s) return;

  let modal = document.getElementById('enhancedWorkoutModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'enhancedWorkoutModal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;align-items:center;justify-content:center;padding:20px;overflow-y:auto;';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeEnhancedModal();
    });
  }

  const resolved = resolveRunDisplay(s);
  const workout = resolved && resolved.related ? resolved.related : null;
  const meta = resolved && resolved.meta ? resolved.meta : null;

  const title =
    (resolved && resolved.title) ||
    (workout && workout.name) ||
    s.runningSession ||
    s.name ||
    'Run';

  const description =
    (workout && workout.description) ||
    (resolved && resolved.detail) ||
    s.runDetails ||
    '';

  const type =
    (workout && workout.type) ||
    (meta && meta.type) ||
    s.sessionType ||
    '';

  const goal =
    (workout && workout.goal) ||
    (meta && meta.sessionGoal) ||
    '';

  const intensity =
    (workout && workout.intensity) ||
    (meta && meta.intensity) ||
    s.intensity ||
    '';

  const phase =
    (workout && workout.phase) ||
    (meta && meta.phase) ||
    s.week ||
    '';

  const surface =
    (workout && workout.surface) ||
    (meta && meta.surface) ||
    '';

  const difficulty =
    (workout && workout.difficulty) ||
    (meta && meta.difficulty) ||
    '';

  const distance =
    (workout && workout.distance) ||
    (meta && meta.distance) ||
    '';

  const duration =
    (workout && workout.duration) ||
    (meta && meta.duration) ||
    '';

  const rpe =
    (workout && workout.rpe) ||
    (meta && meta.rpe) ||
    '';

  const warmup =
    (workout && workout.warmup) ||
    (workout && workout.warmUp) ||
    (meta && meta.warmUp) ||
    '';

  const cooldown =
    (workout && workout.cooldown) ||
    (workout && workout.coolDown) ||
    (meta && meta.coolDown) ||
    '';

  const recovery =
    (workout && workout.recovery) ||
    (workout && workout.recoveryType) ||
    (meta && meta.recoveryType) ||
    '';

  const modalHTML = `
    <div style="max-width:600px;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:28px;margin:auto;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border);">
        <div style="flex:1;">
          <div style="font-family:var(--display);font-size:var(--font-xl);font-weight:700;text-transform:uppercase;letter-spacing:0.02em;color:var(--text);line-height:1.2;">
            ${esc(title)}
          </div>
          ${type ? `<div style="display:inline-block;margin-top:8px;padding:4px 12px;background:rgba(180,83,9,0.1);border:1px solid rgba(180,83,9,0.2);border-radius:var(--radius-sm);font-family:var(--mono);font-size:var(--font-xs);font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--run);">${esc(type)}</div>` : ''}
        </div>
        <button onclick="closeEnhancedModal()" style="background:transparent;border:none;color:var(--muted);font-size:var(--font-2xl);cursor:pointer;line-height:1;padding:0;margin-left:16px;">&times;</button>
      </div>

      <div style="color:var(--text);">
        ${detailRow('Description', description)}
        ${detailRow('Session Goal', goal)}

        ${(intensity || phase || surface || difficulty || distance || duration || rpe || recovery || warmup || cooldown) ? `
          <div style="margin-top:18px;">
            <div style="font-family:var(--mono);font-size:var(--font-xs);text-transform:uppercase;font-weight:600;letter-spacing:0.08em;color:var(--muted);margin-bottom:10px;">
              Workout Details
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:var(--font-sm);line-height:1.6;color:var(--text);">
              ${intensity ? `<div><strong>Intensity Zone:</strong> ${esc(intensity)}</div>` : ''}
              ${phase ? `<div><strong>Phase:</strong> ${esc(phase)}</div>` : ''}
              ${surface ? `<div><strong>Surface:</strong> ${esc(surface)}</div>` : ''}
              ${difficulty ? `<div><strong>Difficulty:</strong> ${esc(difficulty)}</div>` : ''}
              ${distance ? `<div><strong>Distance:</strong> ${esc(distance)}</div>` : ''}
              ${duration ? `<div><strong>Duration:</strong> ${esc(duration)}</div>` : ''}
              ${rpe ? `<div><strong>RPE:</strong> ${esc(rpe)}</div>` : ''}
              ${recovery ? `<div><strong>Recovery:</strong> ${esc(recovery)}</div>` : ''}
            </div>
            ${warmup ? `<div style="margin-top:10px;font-size:var(--font-sm);line-height:1.6;color:var(--text);"><strong>Warm Up:</strong> ${nl2brSafe(warmup)}</div>` : ''}
            ${cooldown ? `<div style="margin-top:10px;font-size:var(--font-sm);line-height:1.6;color:var(--text);"><strong>Cool Down:</strong> ${nl2brSafe(cooldown)}</div>` : ''}
          </div>
        ` : ''}

        ${!description && !goal && !(intensity || phase || surface || difficulty || distance || duration || rpe || recovery || warmup || cooldown) ? `
          <div style="padding:24px;background:var(--surface2);border-radius:var(--radius-sm);text-align:center;">
            <div style="font-family:var(--mono);font-size:var(--font-xs);color:var(--dim);text-transform:uppercase;letter-spacing:0.06em;">No detailed run data found</div>
            <div style="font-size:var(--font-sm);color:var(--muted);margin-top:6px;">Basic session: ${esc(s.name || 'Run')}</div>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  modal.innerHTML = modalHTML;
  modal.style.display = 'flex';
}

function closeEnhancedModal() {
  const modal = document.getElementById('enhancedWorkoutModal');
  if (modal) modal.style.display = 'none';
}

window.showEnhancedWorkoutModal = showEnhancedWorkoutModal;
window.closeEnhancedModal = closeEnhancedModal;

// ============================================================================
// END RUNNING LIBRARY INTEGRATION
// ============================================================================

// ============================================================================
// STRAVA CONNECT BUTTON
// ============================================================================
// The connect URL is minted server-side by /api/strava and carries a signed,
// short-lived `state` token identifying which athlete is connecting. The client
// must never build that URL itself: a hand-made link has no state, so the OAuth
// callback rejects it with "Missing code or athlete identifier". The button is
// therefore hidden until the server answers, and is never given a fallback URL.
(function(){
  var btn = document.getElementById('dp-strava-btn');
  var REFRESH_MS = 5 * 60 * 1000; // re-mint well inside the state token's 10-minute TTL
  var STRAVA_LOGO = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066z"/><path d="M11.234 13.828L7.07 6h5.886l4.143 7.828z" opacity=".7"/></svg>';
  var mintedAt = 0, refreshTimer = null, athleteCode = null, bound = false;
  // Append ?dpdebug=1 to see the raw failure reason on the button itself.
  var DEBUG = /[?&]dpdebug=1/.test(window.location.search);

  function stopRefresh(){ if(refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; } }

  function startRefresh(){
    stopRefresh();
    refreshTimer = setInterval(function(){
      if(document.hidden) return; // a backgrounded tab does not need a fresh link
      load({ silent: true });
    }, REFRESH_MS);
  }

  // A failure must stay visible. Hiding the button turns a broken endpoint into
  // an invisible one, which is harder to diagnose than a button that says so.
  // This state is deliberately NOT a link: it retries the lookup on tap.
  function showUnavailable(label, reason){
    if(!btn) return;
    stopRefresh();
    mintedAt = 0;
    btn.removeAttribute('href');
    btn.innerHTML = STRAVA_LOGO + ' ' + (DEBUG ? label.debug : label.friendly);
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:transparent;color:rgba(255,255,255,.45);border-color:rgba(255,255,255,.18);box-shadow:none;text-decoration:none;cursor:pointer;';
    btn.title = reason;
    btn.setAttribute('aria-label', 'Strava: ' + reason);
  }

  // Showing nothing beats showing a link that cannot work.
  function hideButton(){
    if(!btn) return;
    stopRefresh();
    mintedAt = 0;
    btn.style.display = 'none';
    btn.removeAttribute('href');
    btn.removeAttribute('title');
  }

  function showConnect(url, reconnect){
    if(!btn) return;
    if(!url) return hideButton();
    btn.setAttribute('href', url);
    mintedAt = Date.now();
    btn.innerHTML = STRAVA_LOGO + (reconnect ? ' Reconnect Strava' : ' Connect Strava');
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:#fc4c02;color:#fff;border-color:#fc4c02;box-shadow:0 0 12px rgba(252,76,2,.6);text-decoration:none;font-weight:700;';
    btn.title = reconnect
      ? 'Strava disconnected this app. Tap to link it again.'
      : 'Connect your Strava account';
    btn.setAttribute('aria-label', btn.title);
    startRefresh();
  }

  function showConnected(activitiesAvailable, warning){
    if(!btn) return;
    stopRefresh();
    btn.removeAttribute('href');
    btn.innerHTML = '<span class="btn-ic"><svg class="icon"><use href="#i-check"/></svg></span>Strava connected';
    btn.style.cssText = 'display:inline-flex;align-items:center;background:transparent;color:rgba(74,222,128,.9);border-color:rgba(74,222,128,.35);box-shadow:none;text-decoration:none;pointer-events:none;';
    btn.title = activitiesAvailable === false
      ? (warning === 'strava_access_denied'
          ? 'Strava is connected, but is refusing to share activities with this app. Your logs still work.'
          : 'Strava is connected. Activity sync is temporarily unavailable and will retry automatically.')
      : 'Strava is connected';
    btn.setAttribute('aria-label', btn.title);
  }

  // Connected, syncing runs fine, but linked before profile:read_all was
  // required — so heart-rate and pace zones (time in zone, the easy/hard split)
  // are unavailable until the athlete re-consents. This is deliberately NOT the
  // red "reconnect" state: nothing is broken, and calling it broken would push
  // athletes to disconnect something that is working. It is an offer, and it
  // stays tappable so they can take it whenever.
  function showScopeUpgrade(url, missing){
    if(!btn) return;
    if(!url) return showConnected(true);
    btn.setAttribute('href', url);
    mintedAt = Date.now();
    btn.innerHTML = STRAVA_LOGO + ' Finish Strava setup';
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:transparent;color:rgba(252,76,2,.95);border-color:rgba(252,76,2,.45);box-shadow:none;text-decoration:none;font-weight:700;';
    btn.title = 'Your runs are syncing. Tap to also share your Strava heart-rate and pace zones, which unlocks effort and zone tracking.';
    btn.setAttribute('aria-label', 'Strava connected. ' + btn.title);
    window._stravaMissingScopes = missing || [];
    startRefresh();
  }

  async function showAckBannerIfNeeded(){
    window._stravaAthCode = athleteCode;
    if(!_authToken) return;
    try {
      var state = await portalRequest('state-read');
      var ackRow = (state.rows||[]).find(function(row){ return row.key === 'strava_ack'; });
      if (!ackRow || !ackRow.value || !ackRow.value.acked) {
        var banner = document.getElementById('strava-ack-banner');
        if (banner) banner.style.display = 'flex';
        if (typeof syncWeekCardState === 'function') syncWeekCardState();
      }
    } catch(e) { /* silently skip banner on error */ }
  }

  // Reads the athlete's real Strava state. Every failure path hides the button
  // rather than falling back to a client-built URL.
  async function load(options){
    var silent = !!(options && options.silent), res, data = {};
    try {
      res = await fetch('/api/strava', { headers: authHeaders({}), cache: 'no-store' });
    } catch(e) {
      window._stravaDebug = { status:'network-error', error:String(e&&e.message||e), at:new Date().toISOString() };
      if(!silent) showUnavailable({ friendly:'Strava \u2014 tap to retry', debug:'Strava network error' }, 'Could not reach the portal. Tap to try again.');
      return { connected:false, activities:[] };
    }
    try { data = await res.json(); } catch(e) { data = {}; }

    if (res.status === 401) {
      // The session is gone, so the server cannot sign a state token. Anything
      // we offered here would fail at the callback.
      window._stravaDebug = { status:401, error:(data&&data.error)||'invalid_session', at:new Date().toISOString() };
      showUnavailable({ friendly:'Strava \u2014 sign in again', debug:'Strava 401 ' + ((data&&data.error)||'') },
        'Your session expired, so a Strava link cannot be signed. Sign in again.');
      if (!silent && typeof handleAuthSessionLost === 'function'
          && localStorage.getItem('dp_auth_method') === 'email') handleAuthSessionLost();
      return { connected:false, activities:[] };
    }

    if (!res.ok) {
      console.warn('[strava] /api/strava responded ' + res.status, data && data.error);
      window._stravaDebug = { status:res.status, error:(data&&data.error)||null, at:new Date().toISOString() };
      showUnavailable({ friendly:'Strava unavailable', debug:'Strava ' + res.status + (data&&data.error ? ': ' + String(data.error).slice(0,80) : '') },
        'Strava lookup failed (' + res.status + (data&&data.error ? ': ' + data.error : '') + '). Tap to retry.');
      return { connected:false, activities:[] };
    }

    if (data.connected) {
      if (data.scopeComplete === false && data.reconnectUrl) {
        showScopeUpgrade(data.reconnectUrl, data.missingScopes);
      } else {
        showConnected(data.activitiesAvailable, data.warning);
      }
      showAckBannerIfNeeded();
    } else if (data.connectUrl) {
      // reconnectRequired: Strava rejected the stored token, so this is a
      // re-link rather than a first connection. Say so.
      showConnect(data.connectUrl, !!data.reconnectRequired);
    } else {
      // 200 with neither flag: the endpoint answered but gave us nothing usable.
      window._stravaDebug = { status:200, error:'no connectUrl in response', at:new Date().toISOString() };
      showUnavailable({ friendly:'Strava unavailable', debug:'Strava 200 no-url' },
        'The portal answered but returned no connect link. Tap to retry.');
    }
    return data;
  }

  // Record that the athlete actually followed the consent link. If Vercel later
  // has this marker without a callback marker, the failure happened in Strava or
  // the device hand-off rather than in Supabase. Fire-and-forget plus keepalive
  // lets the same-window OAuth navigation start immediately.
  function markConnectAttempt(){
    try {
      fetch('/api/strava?mode=attempt', {
        method:'POST', headers:authHeaders({}), cache:'no-store', keepalive:true
      }).catch(function(){});
    } catch(e) {}
  }

  function followConnectUrl(url){
    if(!url)return;
    markConnectAttempt();
    window.location.assign(url);
  }

  // A state token older than its TTL lands on "The connection link expired", so
  // re-mint on click when the cached one is stale. OAuth always uses the current
  // window: iOS PWAs and embedded browsers can strand target=_blank on an empty
  // page when Strava hands control back to our HTTPS callback.
  function onClick(e){
    if (!btn.getAttribute('href')) { e.preventDefault(); load({}); return; }
    e.preventDefault();
    if (Date.now() - mintedAt < REFRESH_MS) {
      followConnectUrl(btn.getAttribute('href'));
      return;
    }
    btn.setAttribute('aria-busy','true');
    load({ silent: false }).then(function(data){
      // reconnectUrl covers the scope-upgrade state, where the athlete is
      // already connected so there is no connectUrl in the response.
      var url = data && (data.connectUrl || data.reconnectUrl);
      btn.removeAttribute('aria-busy');
      if (url) followConnectUrl(url);
    }).catch(function(){ btn.removeAttribute('aria-busy'); });
  }

  // Coming back from the Strava tab should flip the pill without a reload.
  document.addEventListener('visibilitychange', function(){
    if (document.hidden || !refreshTimer) return;
    load({ silent: true });
  });

  window.initStrava = async function(code) {
    if (!code || !btn) return { connected:false, activities:[] };
    athleteCode = code;
    hideButton();
    if (!bound) { btn.addEventListener('click', onClick); bound = true; }
    return load({});
  };

  // Revokes the app's access at Strava AND deletes the athlete's cached
  // activities here. Both halves matter: revoking without purging would leave
  // their Strava data in our database after they withdrew consent, which is the
  // thing the API agreement is most explicit about.
  //
  // Confirmation is required, but deliberately not via confirm() — a native
  // dialog blocks the extension bridge and is easy to dismiss by accident on
  // mobile. Callers pass { confirmed: true } once their own UI has asked.
  window.disconnectStrava = async function(options) {
    if (!(options && options.confirmed)) {
      return { ok: false, error: 'confirmation_required' };
    }
    try {
      var res = await fetch('/api/strava-disconnect', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        cache: 'no-store',
      });
      var data = {};
      try { data = await res.json(); } catch(e) { data = {}; }
      if (!res.ok) {
        console.warn('[strava] disconnect failed', res.status, data && data.error);
        return { ok: false, error: (data && data.error) || ('http_' + res.status) };
      }
      // Local match state is meaningless once the activities are gone, and
      // leaving it would resurrect "Not this run" rejections against ids that
      // no longer exist if they reconnect later.
      try {
        if (athleteCode) localStorage.removeItem('dp_strava_match_rejections_' + athleteCode);
      } catch(e) { /* private mode */ }
      await load({});
      if (typeof showToast === 'function') showToast('Strava disconnected');
      return { ok: true };
    } catch (e) {
      console.warn('[strava] disconnect error', e);
      return { ok: false, error: String(e && e.message || e) };
    }
  };
})();

window.acknowledgeStrava = async function() {
  var banner = document.getElementById('strava-ack-banner');
  if (banner) banner.style.display = 'none';
  if (typeof syncWeekCardState === 'function') syncWeekCardState();
  if (_authToken && window._stravaAthCode) {
    try {
      await portalStateWrite('strava_ack',{ acked: true, acked_at: new Date().toISOString() });
    } catch(e) { console.warn('Strava ack save failed', e); }
  }
};
// ============================================================================
// END STRAVA CONNECT BUTTON
// ============================================================================


// ── PUSH REMINDERS ───────────────────────────────────────────────────────────
// Registers this device for coaching reminders. Subscriptions are stored in
// Supabase via /api/reminders and the cron sends whatever is due. On iPhone the
// portal must be added to the home screen before notifications are available.
//
// There are no per-category preferences to sync: which reminders an athlete
// receives is decided server-side (see MANAGED_CATEGORIES in api/reminders.js).
// This deliberately sends no `prefs` at all, so the rare athlete carrying an
// agreed exemption keeps their stored choice through every re-subscribe.
// Permission is the one thing the athlete still controls, because the OS owns
// it — so the only question here is whether it has been granted.
function urlB64ToUint8(base64String){
  var padding='='.repeat((4-base64String.length%4)%4);
  var base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  var raw=window.atob(base64),arr=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i);
  return arr;
}
function setPushStatus(msg,ok){
  try{localStorage.setItem('dp_push_status',msg);}catch(e){}
  var el=document.getElementById('pushStatus');
  if(el){el.textContent='Notifications: '+msg;el.style.color=ok?'var(--ok)':'var(--muted)';}
}
async function syncPushSubscription(){
  try{
    if(!athlete||!athlete.code)return;
    if(!('serviceWorker'in navigator)){setPushStatus('not supported in this browser',false);return;}
    if(!('PushManager'in window)){setPushStatus('not available — on iPhone, open from the home-screen icon',false);return;}
    if(typeof VAPID_PUBLIC_KEY==='undefined'||!VAPID_PUBLIC_KEY){setPushStatus('app update pending — close and reopen the portal',false);return;}
    var granted='Notification'in window&&Notification.permission==='granted';
    setPushStatus('setting up\u2026',false);
    // Robust service-worker acquisition: iOS PWAs can leave .ready hanging on a
    // fresh install, so register explicitly and time out instead of stalling.
    var reg=await navigator.serviceWorker.getRegistration();
    if(!reg){
      try{reg=await navigator.serviceWorker.register('/sw.js');}
      catch(e){setPushStatus('service worker failed: '+String(e&&e.message||e).slice(0,60),false);return;}
    }
    if(!reg.active){
      var ready=await Promise.race([
        navigator.serviceWorker.ready,
        new Promise(function(res){setTimeout(function(){res(null);},8000);})
      ]);
      if(!ready){setPushStatus('service worker not ready \u2014 close the app fully and reopen',false);return;}
      reg=ready;
    }
    var sub=await reg.pushManager.getSubscription();
    if(!granted){
      // Blocked or not yet asked. Leave any existing subscription in place —
      // the browser stops delivering on its own, and tearing the row down here
      // would lose this device the moment permission is restored.
      setPushStatus(('Notification'in window&&Notification.permission==='denied')
        ?'blocked — allow them for the portal in your phone settings'
        :'tap Enable notifications to finish setup',false);
      return;
    }
    if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64ToUint8(VAPID_PUBLIC_KEY)});
    var resp=await fetch('/api/reminders',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({action:'subscribe',subscription:sub.toJSON(),userAgent:navigator.userAgent,timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone||'')})});
    var data=await resp.json().catch(function(){return{};});
    if(resp.ok&&data.ok){setPushStatus('active on this device ✓',true);}
    else{setPushStatus('server rejected: '+(data.error||resp.status),false);}
  }catch(e){setPushStatus('error: '+String(e&&e.message||e).slice(0,80),false);}
}
async function hardRefreshPortal(){
  showToast('Refreshing portal\u2026');
  // The plan the athlete is looking at is held in localStorage, not in Cache
  // Storage, so clearing only the caches below left a stale week in place.
  try{if(typeof clearTrainingWeekCache==='function')clearTrainingWeekCache();}catch(e){}
  try{var keys=await caches.keys();await Promise.all(keys.map(function(k){return caches.delete(k);}));}catch(e){}
  try{var reg=await navigator.serviceWorker.getRegistration();if(reg)await reg.update();}catch(e){}
  setTimeout(function(){location.reload();},300);
}
// Service worker registration
if('serviceWorker' in navigator){
  window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});
  // Check for updates whenever the app comes back to the foreground (key for
  // home-screen apps, which iOS keeps alive for days without a fresh load).
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='visible'){
      navigator.serviceWorker.getRegistration().then(function(reg){if(reg)reg.update().catch(function(){});});
    }
  });
  // When a new service worker takes over, reload once so athletes always run
  // the latest code. Guard: only when replacing an existing controller.
  var dpHadController=!!navigator.serviceWorker.controller,dpReloaded=false;
  navigator.serviceWorker.addEventListener('controllerchange',function(){
    if(dpHadController&&!dpReloaded){dpReloaded=true;showToast('Portal updated');setTimeout(function(){location.reload();},600);}
    dpHadController=true;
  });
}

// ── Coach mode loader ────────────────────────────────────────────────────────
// A coach opens a link the dashboard minted, carrying ?coach=<signed token>.
// The coach UI is fetched ONLY in that case, so an athlete's app never
// downloads it. The real guard is server-side: every coach call re-verifies the
// token's signature, purpose, expiry and athlete.
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('coach');
  if (!token) return;

  // Never leave a coaching token sitting in the address bar or in history.
  var clean = new URL(location.href);
  clean.searchParams.delete('coach');
  history.replaceState(null, '', clean.toString());

  function load(src, isCss) {
    return new Promise(function (resolve) {
      var node = isCss ? document.createElement('link') : document.createElement('script');
      if (isCss) { node.rel = 'stylesheet'; node.href = src; } else { node.src = src; }
      node.onload = resolve;
      node.onerror = resolve;
      document.head.appendChild(node);
    });
  }

  Promise.all([load('/coach-mode.css?v=2', true), load('/coach-mode.js?v=1', false)]).then(function () {
    if (window.DP_COACH_MODE) {
      // Same trap as the daily-log dock: `athlete` is a `let` binding, so it
      // never appears on window and this always handed coach mode an empty
      // code. Read the lexical binding.
      window.DP_COACH_MODE.start(token, (typeof athlete !== 'undefined' && athlete && athlete.code) || '');
    }
  });
})();
