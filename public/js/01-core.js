// Public runtime constants are loaded from /config.js.

// ── ANALYTICS ────────────────────────────────────────────────────────────────
// Vercel Web Analytics. window.va is absent until the injected script loads,
// and stays absent forever if a content blocker or bad signal stops it — so
// every call is guarded and wrapped. Tracking must never throw into a user
// action, and no athlete name, email or free text is ever passed as a prop.
function track(event, props){ try{ if(window.va) window.va('event',{name:event,data:props||{}}); }catch(e){} }
// ── WORKOUT SPLITS (Supabase = source of truth, hardcoded STR = fallback) ────
var SPLITS_BY_NAME={};
function getSplit(key){return SPLITS_BY_NAME[key]||STR[key]||[];}

// ── STRUCTURED PRESCRIPTIONS ─────────────────────────────────────────────────
// A coach-built session carries its OWN exercise list rather than sharing a
// named split with every other athlete. The server delivers it in exactly the
// workout_splits shape, so the whole strength stack — rendering, set logging,
// progression, swaps, PBs, muscle coverage — keeps reading it through
// getSplit() with no other change.
//
// The mechanism: each structured session's exercises are registered in
// SPLITS_BY_NAME under a synthetic, session-scoped key. Resolution then just
// picks that key instead of the title-matched one.
//
// Keys are alphanumeric by construction. They are interpolated into inline
// onclick attributes by the renderer (draftGym(i,'<key>')), so a session title
// must never end up inside one.
var SESSION_PRESCRIPTIONS={};   // sessionId -> synthetic split key
var SESSION_RUN_STEPS={};       // sessionId -> ordered run step tree
var SESSION_SPLIT_ALIAS={};     // synthetic split key -> real split name, for priority lookups
var COACH_CHANGES_BY_DATE={};   // YYYY-MM-DD -> safe athlete-facing audit summaries

function registerCoachChanges(result){
  COACH_CHANGES_BY_DATE={};
  ((result&&result.rows)||[]).forEach(function(row){
    var detail=row&&row.detail||{},date=String(detail.date||'').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return;
    if(!COACH_CHANGES_BY_DATE[date])COACH_CHANGES_BY_DATE[date]=[];
    COACH_CHANGES_BY_DATE[date].push({source:row.source||'training',changedAt:row.changed_at||'',item:detail.item||'Session',action:detail.action||'updated'});
  });
}

function prescriptionSplitKey(sessionId){
  return '__s_'+String(sessionId).replace(/[^A-Za-z0-9_-]/g,'-');
}

// Female priority slots are keyed by SPLIT NAME. A synthetic key would never
// match, silently dropping the priority markers from a structured session, so
// every priority lookup resolves back through the alias first.
function splitPriorityKey(key){
  return SESSION_SPLIT_ALIAS[key]||key;
}

function registerSessionPrescriptions(prescriptions,plannedRows){
  SESSION_PRESCRIPTIONS={};SESSION_RUN_STEPS={};SESSION_SPLIT_ALIAS={};
  if(!prescriptions)return;
  var titleById={};
  (plannedRows||[]).forEach(function(r){titleById[r.notion_page_id||r.id]=r.title||'';});
  var exercises=prescriptions.exercises||{};
  Object.keys(exercises).forEach(function(sessionId){
    var list=exercises[sessionId];
    if(!Array.isArray(list)||!list.length)return;
    var key=prescriptionSplitKey(sessionId);
    SPLITS_BY_NAME[key]=list;
    SESSION_PRESCRIPTIONS[sessionId]=key;
    // Alias to the split name this session would have matched by title, so
    // female priority slots keep working for structured sessions too.
    var title=titleById[sessionId]||'';
    var matched=GYM_KEYS.find(function(k){return String(title).toLowerCase().indexOf(String(k).toLowerCase())>=0;});
    SESSION_SPLIT_ALIAS[key]=matched||title;
  });
  var steps=prescriptions.runSteps||{};
  Object.keys(steps).forEach(function(sessionId){
    if(Array.isArray(steps[sessionId])&&steps[sessionId].length)SESSION_RUN_STEPS[sessionId]=steps[sessionId];
  });
}

// THE resolution point for a session's strength work. A structured session
// answers with its own prescription; everything else falls back to the legacy
// title match against workout_splits, unchanged.
function splitKeyForSession(s,fallback){
  if(s&&s.id&&SESSION_PRESCRIPTIONS[s.id])return SESSION_PRESCRIPTIONS[s.id];
  var name=String((s&&s.name)||'');
  var matched=GYM_KEYS.find(function(k){return name.toLowerCase().indexOf(String(k).toLowerCase())>=0;});
  return matched||(fallback===undefined?null:fallback);
}

function sessionHasPrescription(s){
  return !!(s&&s.id&&SESSION_PRESCRIPTIONS[s.id]);
}
function sessionRunSteps(s){
  return (s&&s.id&&SESSION_RUN_STEPS[s.id])||null;
}

// Female sessions keep their full exercise list, but the priority slots give
// athletes a balanced minimum session when time is genuinely tight. Matching
// the programmed slot (rather than the selected alternative) means a swap for
// equivalent equipment keeps the same training priority.
var FEMALE_TIME_CRUNCH_PRIORITIES={
  'glute a female':[
    'barbell hip thrust',
    'barbell romanian deadlift',
    'bulgarian split squat',
    'standing calf raise'
  ],
  'glute b female':[
    'leg press feet high wide',
    'seated hip abduction',
    'lying hamstring curl',
    'seated calf raise'
  ],
  'upper a female':[
    'machine shoulder press',
    'incline dumbbell press',
    'lat pulldown',
    'chest supported row',
    'cable abdominal crunch'
  ],
  'upper b female':[
    'assisted pull up',
    'low machine row',
    'pec dec',
    'cable lateral raise',
    'overhead tricep extension',
    'hanging knee raise'
  ]
};
function priorityMatchKey(value){
  return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function isFemaleSplit(splitKey){
  return /(^|\s)female($|\s)/.test(priorityMatchKey(splitPriorityKey(splitKey)));
}
function isFemalePriorityExercise(splitKey,exerciseName){
  if(!isFemaleSplit(splitKey))return false;
  var priorities=FEMALE_TIME_CRUNCH_PRIORITIES[priorityMatchKey(splitPriorityKey(splitKey))]||[];
  return priorities.indexOf(priorityMatchKey(exerciseName))>=0;
}
async function loadWorkoutSplits(preloaded){
  try{
    var result=preloaded||await portalRequest('workout-splits');
    var rows=result.rows||[];
    if(!rows.length)return;
    var map={};
    // global splits first, then athlete-specific variants override by name
    rows.forEach(function(r){ if(!r.athlete_code) map[r.name]=r.exercises||[]; });
    rows.forEach(function(r){ if(r.athlete_code&&athlete&&r.athlete_code===athlete.code) map[r.name]=r.exercises||[]; });
    SPLITS_BY_NAME=map;
    var names=Object.keys(map);
    GYM_KEYS=names.concat(GYM_KEYS.filter(function(k){return names.indexOf(k)<0;}));
    GYM_KEYS.sort(function(a,b){return b.length-a.length;}); // longest first so specific names match before generic
  }catch(e){console.warn('Workout splits load failed',e);}
}

// ── SUPABASE ──────────────────────────────────────────────────────────────────
var sbClient=null,_supabaseLoadPromise=null,_skipSbSync=false,_sessionOverrides={};
function ensureSupabaseClient(){
  if(sbClient) return Promise.resolve(sbClient);
  if(!SUPABASE_URL||SUPABASE_URL==='YOUR_SUPABASE_URL') return Promise.resolve(null);
  if(_supabaseLoadPromise) return _supabaseLoadPromise;
  _supabaseLoadPromise=new Promise(function(resolve){
    function initialise(){
      try{
        sbClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{
          // PWA persistence: the session lives in localStorage and refreshes
          // itself, so athletes stay signed in across reopens until they log
          // out / clear storage / the refresh token dies.
          persistSession:true,
          autoRefreshToken:true,
          // MUST stay false: legacy coach links open the portal as ?code=THOMAS
          // and supabase-js would try to exchange that ?code= as an OAuth/PKCE
          // code. Email login uses explicit OTP entry — no URL detection needed.
          detectSessionInUrl:false,
          storageKey:'dp-portal-auth'
        }});
        initAuthStateListener();
        resolve(sbClient);
      }
      catch(e){console.warn('Supabase init failed',e);resolve(null);}
    }
    if(window.supabase){initialise();return;}
    var script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/dist/umd/supabase.js';
    script.async=true;script.onload=initialise;
    script.onerror=function(){console.warn('Supabase library failed to load');resolve(null);};
    document.head.appendChild(script);
  });
  return _supabaseLoadPromise;
}

// ── EMAIL AUTH (Supabase session identity layer) ─────────────────────────────
// Identity model: auth.users.id -> athletes.auth_user_id -> athlete.code.
// A session only ever resolves (server-side) to the athlete's EXISTING legacy
// code — every read, write, historical lookup and sync below keeps flowing
// through that same code, so migrated athletes keep all prior data.
var _authToken=null,_authListenerBound=false;
function initAuthStateListener(){
  if(_authListenerBound||!sbClient||!sbClient.auth)return;
  _authListenerBound=true;
  sbClient.auth.onAuthStateChange(function(event,session){
    var method=localStorage.getItem('dp_auth_method');
    if(session&&session.access_token){_authToken=session.access_token;writePortalOfflineState('dp_auth_token',_authToken);}
    else if(method==='email'){_authToken=null;removePortalOfflineState('dp_auth_token');}
    // Refresh failed / signed out elsewhere while the portal is open: fall
    // back to the login screen's email panel with a friendly recovery path
    // ("send a new code") instead of silently 401-ing in the background.
    if(event==='SIGNED_OUT'
       &&localStorage.getItem('dp_auth_method')==='email'
       &&document.getElementById('portalScreen')
       &&document.getElementById('portalScreen').style.display!=='none'){
      handleAuthSessionLost();
    }
  });
}
// Merge the session token into fetch headers. Legacy (non-migrated) athletes
// have no session → headers unchanged → serverless endpoints keep the old path.
function authHeaders(base){
  var h=base||{};
  if(_authToken)h['Authorization']='Bearer '+_authToken;
  return h;
}
// Access-code sessions are deliberately short-lived server-signed tokens, but
// the portal has always remembered a successful access-code login on this
// device. Transparently exchange that remembered credential for a fresh token
// when needed so expiry protects API requests without logging the client out.
// Explicit logout removes dp_auth_code/dp_auth_method, so it cannot auto-renew.
var _legacyRenewPromise=null;
function renewLegacySession(){
  var method='',code='';
  try{method=localStorage.getItem('dp_auth_method')||'';code=localStorage.getItem('dp_auth_code')||'';}catch(e){}
  if(method!=='code'||!code)return Promise.resolve(null);
  if(_legacyRenewPromise)return _legacyRenewPromise;
  _legacyRenewPromise=(async function(){
    try{
      var r=await fetch('/api/auth-athlete',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'legacy-login',code:code}),
        cache:'no-store'
      });
      var result={};try{result=await r.json();}catch(e){}
      if(!r.ok||!result.access_token||String(result.code||'').toUpperCase()!==String(code).toUpperCase()){
        // A definitive credential/account rejection must not loop forever.
        // Keep remembered state on network/5xx failures so a later retry can
        // recover without asking the client to sign in again.
        if(r.status===401||r.status===403){
          localStorage.removeItem('dp_legacy_session');
          localStorage.removeItem('dp_auth_code');
          localStorage.removeItem('dp_auth_method');
        }
        return null;
      }
      _authToken=result.access_token;
      localStorage.setItem('dp_legacy_session',_authToken);
      localStorage.setItem('dp_auth_method','code');
      writePortalOfflineState('dp_auth_token',_authToken);
      writePortalOfflineState('dp_auth_athlete_code',String(code).toUpperCase());
      return result;
    }catch(e){return null;}
  })().finally(function(){_legacyRenewPromise=null;});
  return _legacyRenewPromise;
}
async function portalRequest(action,payload,options){
  if(!_authToken){
    var restored=await renewLegacySession();
    if(!restored)throw new Error('Your session has expired. Please sign in again.');
  }
  var body=Object.assign({action:action},payload||{});
  var encodedBody=JSON.stringify(body);
  function send(){
    return fetch('/api/portal-data',{
      method:'POST',
      headers:authHeaders({'Content-Type':'application/json'}),
      body:encodedBody,
      cache:'no-store',
      keepalive:!!(options&&options.keepalive)
    });
  }
  var response=await send();
  // A code-login token may expire while the PWA remains open. Renew once and
  // replay the request; Supabase email sessions refresh through supabase-js.
  if(response.status===401&&localStorage.getItem('dp_auth_method')==='code'){
    var renewed=await renewLegacySession();
    if(renewed)response=await send();
  }
  var data={};
  try{data=await response.json();}catch(e){}
  if(response.status===401){handleAuthSessionLost();throw new Error('Your session has expired. Please sign in again.');}
  if(!response.ok||data.ok===false)throw new Error(data.error||('Sync failed '+response.status));
  return data;
}
// STRAVA MATCH PAYLOAD TRIMMING
//
// A matched Strava run used to be stored in the log entry in full: the entire
// detailed-activity response, including segment_efforts, laps, best_efforts,
// splits_metric, splits_standard, the map polyline, similar_activities and
// photos. One matched run cost ~71KB while the log the athlete actually filled
// in was ~30 bytes, and api/write.js rejects a state value over 750,000 chars
// with a 413. The logs blob crossed that line, every save was refused, and the
// outbox retried the same oversized payload forever, so the pending banner
// could never clear: retrying could never succeed.
//
// Only the fields below are ever read back out of a stored match. Anything
// richer is re-fetched from /api/strava when it is genuinely needed, so
// trimming costs nothing and keeps the blob an order of magnitude smaller.
var STRAVA_MATCH_ACTIVITY_FIELDS=['id','name','type','sport_type','distance','moving_time','elapsed_time','start_date','start_date_local','suffer_score','relative_effort'];
function slimStravaActivity(activity){
  if(!activity||typeof activity!=='object'||Array.isArray(activity))return activity;
  var slim={},i,field;
  for(i=0;i<STRAVA_MATCH_ACTIVITY_FIELDS.length;i++){
    field=STRAVA_MATCH_ACTIVITY_FIELDS[i];
    if(activity[field]!==undefined)slim[field]=activity[field];
  }
  return slim;
}
// Trims every stored match in place. Returns true when anything changed, so
// callers can persist the smaller copy instead of rewriting an identical blob
// on every load.
function pruneStravaMatchPayloads(logsObject){
  if(!logsObject||typeof logsObject!=='object')return false;
  var changed=false;
  Object.keys(logsObject).forEach(function(sessionId){
    var entry=logsObject[sessionId];
    if(!entry||typeof entry!=='object')return;
    var match=entry.__stravaMatch;
    if(!match||typeof match!=='object'||!match.activity)return;
    var slim=slimStravaActivity(match.activity);
    if(JSON.stringify(slim)===JSON.stringify(match.activity))return;
    match.activity=slim;
    changed=true;
  });
  return changed;
}
function portalStateWrite(key,value,options){
  // Belt and braces: no oversized logs blob can leave the device, whatever
  // path built it or how long it has been sitting in the outbox.
  if(key==='logs')pruneStravaMatchPayloads(value);
  return portalRequest('state-write',{key:key,value:value},options).then(async function(result){
    await removePendingPortalStateWrite(key,null,value);
    return result;
  }).catch(async function(error){
    await queuePortalStateWrite(key,value,error);
    if(options&&options.required)throw error;
    return {ok:true,queued:true,error:String(error&&error.message||error||'State write failed')};
  });
}
async function getAuthSession(){
  var client=await ensureSupabaseClient();
  if(!client||!client.auth)return null;
  try{var r=await client.auth.getSession();return (r&&r.data&&r.data.session)||null;}catch(e){return null;}
}
// Ask the server who this session belongs to. Also performs the one-time
// auth_user_id link on an athlete's first OTP sign-in. Never creates athletes.
async function resolveAuthedAthlete(){
  if(!_authToken)return null;
  try{
    var r=await fetch('/api/auth-athlete',{headers:authHeaders({}),cache:'no-store'});
    if(r.status===403)return {error:'no_linked_athlete'};
    if(r.status===401)return {error:'invalid_session'};
    if(!r.ok)return null;
    return await r.json();
  }catch(e){return null;}
}
async function authSignOut(){
  try{var client=await ensureSupabaseClient();if(client&&client.auth)await client.auth.signOut();}catch(e){}
  _authToken=null;
  try{localStorage.removeItem('dp_legacy_session');}catch(e){}
  await removePortalOfflineState('dp_auth_token');
  await removePortalOfflineState('dp_auth_athlete_code');
}
function handleAuthSessionLost(){
  var method=localStorage.getItem('dp_auth_method');
  logoutToLogin(true);
  if(typeof isEmailLoginEnabled==='function'&&isEmailLoginEnabled()&&typeof showPrimaryLogin==='function'){
    var notice=method==='email'
      ?'Your session expired — enter your email and we’ll send a new code.'
      :'Your access session expired — sign in with email, or use your athlete access code.';
    showPrimaryLogin(notice);
  }else{
    if(typeof showLoginError==='function')showLoginError('Your access session expired — enter your coach-issued code again.');
  }
}

// Intercept all localStorage writes — auto-sync dp_ keys to Supabase.
// Drafts can fire on every keystroke, so the cloud write is DEBOUNCED (batched
// ~1.5s after the last change) instead of firing per keystroke. Pending writes
// are force-flushed the moment the athlete backgrounds or closes the tab, so the
// latest edits reach Supabase before a mobile browser evicts/reloads the page.
var _sbSyncTimers={},_sbSyncPending={};
var _saveStateTimer=null;
function setSaveState(state,label){
  var pill=document.getElementById('saveStatePill');if(!pill)return;
  pill.className='save-state-pill '+state;
  var text=pill.querySelector('b');if(text)text.textContent=label||(state==='saving'?'Syncing with coach':state==='offline'?'Saved on device · will sync':'Synced with coach');
  if(_saveStateTimer)clearTimeout(_saveStateTimer);
  if(state==='saved')_saveStateTimer=setTimeout(function(){pill.classList.add('quiet');},2200);else pill.classList.remove('quiet');
}
function _flushSbKey(sbKey){
  if(_sbSyncTimers[sbKey]){clearTimeout(_sbSyncTimers[sbKey]);delete _sbSyncTimers[sbKey];}
  var p=_sbSyncPending[sbKey];
  if(!p||!_authToken) return;
  delete _sbSyncPending[sbKey];
  portalStateWrite(sbKey,p.value,{keepalive:true})
    .then(function(result){setSaveState(result&&result.queued?'offline':'saved');})
    .catch(function(){_sbSyncPending[sbKey]=p;setSaveState('offline');});
}
function _flushAllSb(){Object.keys(_sbSyncPending).forEach(_flushSbKey);}
function _scheduleSbSync(code,sbKey,parsed){
  setSaveState(navigator.onLine?'saving':'offline');
  _sbSyncPending[sbKey]={code:code,value:parsed};
  // Persist intent immediately, before the network debounce. If iOS kills the
  // page between this keystroke and pagehide, cloud hydration can still see
  // that the device copy is newer and must not overwrite it.
  queuePortalStateWrite(sbKey,parsed,'Awaiting sync').catch(function(){});
  if(_sbSyncTimers[sbKey]) clearTimeout(_sbSyncTimers[sbKey]);
  _sbSyncTimers[sbKey]=setTimeout(function(){_flushSbKey(sbKey);},1500);
}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')_flushAllSb();});
window.addEventListener('pagehide',_flushAllSb);
window.addEventListener('online',function(){setSaveState('saving');_flushAllSb();Promise.all([retryPendingCoachWrites(true,'online'),retryPendingPortalStateWrites(true,'online')]).then(function(){setSaveState('saved');});});
window.addEventListener('offline',function(){setSaveState('offline');});
(function(){
  var _orig=localStorage.setItem.bind(localStorage);
  localStorage.setItem=function(key,value){
    _orig(key,value);
    if(_skipSbSync||!_authToken||!key.startsWith('dp_')) return;
    var code=(athlete&&athlete.code)||'';if(!code) return;
    var sbKey=null;
    if(key==='dp_goals_'+code) sbKey='goals';
    else if(key==='dp_logs_'+code) sbKey='logs';
    else if(key==='dp_ticked_'+code) sbKey='ticked';
    else if(key==='dp_strength_rpe_enabled') sbKey='strength_rpe_enabled';
    else if(key==='dp_reschedules_'+code) sbKey='reschedules';
    else if(key==='dp_strava_match_rejections_'+code) sbKey='strava_match_rejections';
    else if(key==='dp_photos_'+code) sbKey='photos';
    else if(key.startsWith('dp_call_booked_')&&athlete&&athlete.code){var _cpfx='dp_call_booked_'+athlete.code.toUpperCase()+'_';if(key.startsWith(_cpfx))sbKey='call_booked_'+key.slice(_cpfx.length);}
    else if(key.startsWith('dp_daily_body_'+code+'_')) sbKey='daily_body_'+key.slice(('dp_daily_body_'+code+'_').length);
    else if(key.startsWith('dp_daily_nut_'+code+'_')) sbKey='daily_nut_'+key.slice(('dp_daily_nut_'+code+'_').length);
    if(!sbKey) return;
    try{
      var parsedValue=JSON.parse(value);
      // A GHL widget success message does not always include the appointment
      // timestamp. Keep that optimistic "booked" flag on this device only;
      // uploading it would turn a temporary placeholder into the cloud source
      // of truth and leave every device stuck on "Confirming date and time".
      if(sbKey.indexOf('call_booked_')===0){
        var datedBooking=parsedValue&&typeof parsedValue==='object'&&
          (parsedValue.startsAt||parsedValue.startTime||parsedValue.start_time||parsedValue.time||parsedValue.displayTime);
        if(!datedBooking)return;
      }
      _scheduleSbSync(code,sbKey,parsedValue);
    }catch(e){}
  };
})();

function pendingCoachWritesKey(code){return 'dp_pending_writes_'+code;}
function pendingPortalStateWritesKey(code){return 'dp_pending_state_writes_'+code;}
var DP_OFFLINE_DB_NAME='dp-athlete-portal',DP_OFFLINE_DB_VERSION=2;
var DP_QUEUE_STORE='queued_writes',DP_STATE_STORE='app_state',DP_STATE_QUEUE_STORE='state_writes';
var _offlineDbPromise=null,_offlineMigrationPromise=null;
function openPortalOfflineDb(){
  if(_offlineDbPromise)return _offlineDbPromise;
  _offlineDbPromise=new Promise(function(resolve){
    if(typeof indexedDB==='undefined'){resolve(null);return;}
    var request;
    try{request=indexedDB.open(DP_OFFLINE_DB_NAME,DP_OFFLINE_DB_VERSION);}catch(e){resolve(null);return;}
    request.onupgradeneeded=function(){
      var db=request.result;
      if(!db.objectStoreNames.contains(DP_QUEUE_STORE)){
        var queue=db.createObjectStore(DP_QUEUE_STORE,{keyPath:'id'});
        queue.createIndex('bucket','bucket',{unique:false});
      }
      if(!db.objectStoreNames.contains(DP_STATE_STORE))db.createObjectStore(DP_STATE_STORE,{keyPath:'key'});
      if(!db.objectStoreNames.contains(DP_STATE_QUEUE_STORE)){
        var stateQueue=db.createObjectStore(DP_STATE_QUEUE_STORE,{keyPath:'id'});
        stateQueue.createIndex('code','code',{unique:false});
      }
    };
    request.onsuccess=function(){resolve(request.result);};
    request.onerror=function(){resolve(null);};
    request.onblocked=function(){resolve(null);};
  });
  return _offlineDbPromise;
}
function offlineRequest(request){
  return new Promise(function(resolve,reject){
    request.onsuccess=function(){resolve(request.result);};
    request.onerror=function(){reject(request.error||new Error('IndexedDB request failed'));};
  });
}
function offlineTransactionDone(transaction){
  return new Promise(function(resolve,reject){
    transaction.oncomplete=function(){resolve();};
    transaction.onabort=function(){reject(transaction.error||new Error('IndexedDB transaction aborted'));};
    transaction.onerror=function(){reject(transaction.error||new Error('IndexedDB transaction failed'));};
  });
}
async function putOfflineQueueRecords(db,bucket,list){
  var tx=db.transaction(DP_QUEUE_STORE,'readwrite'),store=tx.objectStore(DP_QUEUE_STORE);
  (list||[]).forEach(function(item){store.put(Object.assign({},item,{bucket:bucket}));});
  await offlineTransactionDone(tx);
}
async function migrateOfflineLocalStorage(db){
  if(!db)return null;
  if(_offlineMigrationPromise)return _offlineMigrationPromise;
  _offlineMigrationPromise=(async function(){
    var keys=[];
    try{
      for(var i=0;i<localStorage.length;i++){
        var key=localStorage.key(i);
        if(key&&(key.indexOf('dp_pending_writes_')===0||key.indexOf('dp_pending_state_writes_')===0||key==='dp_run_library_cache_v3'))keys.push(key);
      }
    }catch(e){return db;}
    for(var k=0;k<keys.length;k++){
      var storageKey=keys[k],raw=null;
      try{raw=localStorage.getItem(storageKey);}catch(e){continue;}
      if(raw==null)continue;
      try{
        if(storageKey.indexOf('dp_pending_writes_')===0){
          var list=JSON.parse(raw),bucket=storageKey.slice('dp_pending_writes_'.length);
          if(!Array.isArray(list))continue;
          await putOfflineQueueRecords(db,bucket,list);
        }else if(storageKey.indexOf('dp_pending_state_writes_')===0){
          var stateList=JSON.parse(raw),stateCode=storageKey.slice('dp_pending_state_writes_'.length);
          if(!Array.isArray(stateList))continue;
          var stateTx=db.transaction(DP_STATE_QUEUE_STORE,'readwrite'),stateStore=stateTx.objectStore(DP_STATE_QUEUE_STORE);
          stateList.forEach(function(item){stateStore.put(Object.assign({},item,{code:stateCode}));});
          await offlineTransactionDone(stateTx);
        }else{
          var cached=JSON.parse(raw);
          var tx=db.transaction(DP_STATE_STORE,'readwrite');
          tx.objectStore(DP_STATE_STORE).put({key:storageKey,value:cached});
          await offlineTransactionDone(tx);
        }
        // Removal happens only after the corresponding transaction commits.
        // A reload can safely repeat any unfinished migration without loss.
        localStorage.removeItem(storageKey);
      }catch(e){console.warn('Offline storage migration deferred:',e);}
    }
    return db;
  })();
  return _offlineMigrationPromise;
}
async function getPortalOfflineDb(){return migrateOfflineLocalStorage(await openPortalOfflineDb());}
async function readPortalOfflineState(key){
  try{
    var db=await getPortalOfflineDb();
    if(!db)throw new Error('IndexedDB unavailable');
    var tx=db.transaction(DP_STATE_STORE,'readonly');
    var row=await offlineRequest(tx.objectStore(DP_STATE_STORE).get(key));
    return row?row.value:null;
  }catch(e){
    try{var raw=localStorage.getItem(key);return raw==null?null:JSON.parse(raw);}catch(storageError){return null;}
  }
}
async function writePortalOfflineState(key,value){
  try{
    var db=await getPortalOfflineDb();
    if(!db)throw new Error('IndexedDB unavailable');
    var tx=db.transaction(DP_STATE_STORE,'readwrite');
    tx.objectStore(DP_STATE_STORE).put({key:key,value:value});
    await offlineTransactionDone(tx);
    try{localStorage.removeItem(key);}catch(e){}
  }catch(e){
    try{localStorage.setItem(key,JSON.stringify(value));}catch(storageError){}
  }
}
async function removePortalOfflineState(key){
  try{
    var db=await getPortalOfflineDb();
    if(db){
      var tx=db.transaction(DP_STATE_STORE,'readwrite');
      tx.objectStore(DP_STATE_STORE).delete(key);
      await offlineTransactionDone(tx);
    }
  }catch(e){}
  try{localStorage.removeItem(key);}catch(e){}
}
var _storagePersistenceRequested=false;
async function requestPersistentPortalStorage(){
  if(_storagePersistenceRequested||!navigator.storage||!navigator.storage.persist)return false;
  _storagePersistenceRequested=true;
  try{
    var granted=navigator.storage.persisted?await navigator.storage.persisted():false;
    if(!granted)granted=await navigator.storage.persist();
    track('offline_storage_persistence',{granted:!!granted});
    return !!granted;
  }catch(e){return false;}
}
function readPendingCoachWritesFallback(code){
  try{
    var list=JSON.parse(localStorage.getItem(pendingCoachWritesKey(code))||'[]');
    return Array.isArray(list)?list:[];
  }catch(e){return [];}
}
// Resolve the best athlete code available, even if the athlete object isn't
// ready yet — so a failed write is NEVER silently dropped for lack of a code.
function currentWriteCode(payload){
  if(athlete&&athlete.code) return athlete.code;
  if(payload&&payload.athleteCode) return String(payload.athleteCode);
  try{var c=localStorage.getItem('dp_last_athlete_code');if(c) return c;}catch(e){}
  return '_unknown';
}
function readPendingPortalStateWritesFallback(code){
  try{
    var list=JSON.parse(localStorage.getItem(pendingPortalStateWritesKey(code))||'[]');
    return Array.isArray(list)?list:[];
  }catch(e){return [];}
}
async function readPendingPortalStateWrites(code){
  code=code||currentWriteCode();
  try{
    var db=await getPortalOfflineDb();
    if(!db)return readPendingPortalStateWritesFallback(code);
    var tx=db.transaction(DP_STATE_QUEUE_STORE,'readonly');
    var list=await offlineRequest(tx.objectStore(DP_STATE_QUEUE_STORE).index('code').getAll(code));
    return Array.isArray(list)?list:[];
  }catch(e){return readPendingPortalStateWritesFallback(code);}
}
async function queuePortalStateWrite(key,value,error){
  var code=currentWriteCode();
  if(!code||code==='_unknown')return;
  var id='state_'+code+'_'+key,now=new Date().toISOString();
  var item={id:id,code:code,key:key,value:value,createdAt:now,updatedAt:now,attempts:0,lastError:String(error&&error.message||error||'State write failed')};
  // Stage synchronously before the first await. If a mobile browser kills the
  // page immediately, the next open migrates this exact value into IndexedDB.
  var staged=readPendingPortalStateWritesFallback(code),stagedIndex=staged.findIndex(function(row){return row.id===id;});
  if(stagedIndex>=0)staged[stagedIndex]=item;else staged.push(item);
  try{localStorage.setItem(pendingPortalStateWritesKey(code),JSON.stringify(staged));}catch(e){}
  try{
    var db=await getPortalOfflineDb();
    if(!db)throw new Error('IndexedDB unavailable');
    var tx=db.transaction(DP_STATE_QUEUE_STORE,'readwrite');
    tx.objectStore(DP_STATE_QUEUE_STORE).put(item);
    await offlineTransactionDone(tx);
    try{
      var fallback=readPendingPortalStateWritesFallback(code).filter(function(row){return row.id!==id||JSON.stringify(row.value)!==JSON.stringify(value);});
      if(fallback.length)localStorage.setItem(pendingPortalStateWritesKey(code),JSON.stringify(fallback));else localStorage.removeItem(pendingPortalStateWritesKey(code));
    }catch(e){}
  }catch(e){
    var list=readPendingPortalStateWritesFallback(code),index=list.findIndex(function(row){return row.id===id;});
    if(index>=0)list[index]=item;else list.push(item);
    try{localStorage.setItem(pendingPortalStateWritesKey(code),JSON.stringify(list));}catch(storageError){}
  }
  if(typeof updatePendingQueueIndicator==='function')updatePendingQueueIndicator();
  await registerBackgroundQueueSync();
}
async function removePendingPortalStateWrite(key,code,expectedValue){
  code=code||currentWriteCode();
  if(!code||code==='_unknown')return;
  var id='state_'+code+'_'+key,removed=false;
  try{
    var db=await getPortalOfflineDb();
    if(!db)throw new Error('IndexedDB unavailable');
    var tx=db.transaction(DP_STATE_QUEUE_STORE,'readwrite'),store=tx.objectStore(DP_STATE_QUEUE_STORE);
    var current=await offlineRequest(store.get(id));
    if(current&&(expectedValue===undefined||JSON.stringify(current.value)===JSON.stringify(expectedValue))){store.delete(id);removed=true;}
    await offlineTransactionDone(tx);
  }catch(e){
    var list=readPendingPortalStateWritesFallback(code),keep=[];
    list.forEach(function(item){
      if(item.id===id&&(expectedValue===undefined||JSON.stringify(item.value)===JSON.stringify(expectedValue)))removed=true;
      else keep.push(item);
    });
    try{if(keep.length)localStorage.setItem(pendingPortalStateWritesKey(code),JSON.stringify(keep));else localStorage.removeItem(pendingPortalStateWritesKey(code));}catch(storageError){}
  }
  if(typeof updatePendingQueueIndicator==='function')updatePendingQueueIndicator();
}
async function retryPendingPortalStateWrites(silent,trigger){
  var code=currentWriteCode();
  if(!code||code==='_unknown'||!_authToken)return 0;
  var list=await readPendingPortalStateWrites(code),synced=0;
  for(var i=0;i<list.length;i++){
    var item=list[i];
    // A logs value queued by an older build still carries the full Strava
    // payloads that made the server reject it. Retrying it verbatim fails
    // forever, so trim it here before the send. pruneStravaMatchPayloads
    // mutates in place, so snapshot the fat value first: removal matches on
    // the stored value, and without the snapshot the queue entry is orphaned.
    var original=null,trimmed=false;
    if(item.key==='logs'){
      try{original=JSON.parse(JSON.stringify(item.value));}catch(e){original=null;}
      trimmed=pruneStravaMatchPayloads(item.value)&&!!original;
    }
    try{
      await portalRequest('state-write',{key:item.key,value:item.value},{keepalive:true});
      if(trimmed)await removePendingPortalStateWrite(item.key,code,original);
      await removePendingPortalStateWrite(item.key,code,item.value);
      synced++;
    }
    catch(e){}
  }
  if(synced)track('offline_state_flushed',{count:synced,trigger:trigger||'visibility'});
  if(synced&&!silent)showToast(synced+' pending portal update'+(synced>1?'s':'')+' synced');
  await updatePendingQueueIndicator();
  return synced;
}
async function readPendingCoachWrites(code){
  code=code||currentWriteCode();
  try{
    var db=await getPortalOfflineDb();
    if(!db)return readPendingCoachWritesFallback(code);
    var tx=db.transaction(DP_QUEUE_STORE,'readonly');
    var list=await offlineRequest(tx.objectStore(DP_QUEUE_STORE).index('bucket').getAll(code));
    return Array.isArray(list)?list.map(function(item){var copy=Object.assign({},item);delete copy.bucket;return copy;}):[];
  }catch(e){return readPendingCoachWritesFallback(code);}
}
async function persistPendingCoachWrites(list,code){
  code=code||currentWriteCode();
  try{
    var db=await getPortalOfflineDb();
    if(!db)throw new Error('IndexedDB unavailable');
    var tx=db.transaction(DP_QUEUE_STORE,'readwrite'),store=tx.objectStore(DP_QUEUE_STORE),index=store.index('bucket');
    var existing=await offlineRequest(index.getAll(code));
    existing.forEach(function(item){store.delete(item.id);});
    (list||[]).forEach(function(item){store.put(Object.assign({},item,{bucket:code}));});
    await offlineTransactionDone(tx);
    try{localStorage.removeItem(pendingCoachWritesKey(code));}catch(e){}
  }catch(e){
    try{localStorage.setItem(pendingCoachWritesKey(code),JSON.stringify(list));}catch(storageError){}
  }
  // Mirror the retry queue to the authenticated server gateway.
  if(_authToken&&code&&code!=='_unknown'){
    try{
      await portalStateWrite('pending_writes',list);
    }catch(e){console.warn('Pending coach-write sync failed:',e);}
  }
  if(typeof updatePendingQueueIndicator==='function')updatePendingQueueIndicator();
}
async function registerBackgroundQueueSync(){
  if(!('serviceWorker'in navigator))return;
  try{
    var registration=await navigator.serviceWorker.ready;
    if(registration.sync)await registration.sync.register('dp-flush-queue');
    if(registration.periodicSync&&navigator.permissions&&navigator.permissions.query){
      var permission=await navigator.permissions.query({name:'periodic-background-sync'}).catch(function(){return null;});
      if(permission&&permission.state==='granted'){
        await registration.periodicSync.register('dp-flush-queue',{minInterval:12*60*60*1000}).catch(function(){});
      }
    }
  }catch(e){}
}
async function queueCoachWrite(url,payload,error){
  // Robust: queue under the best code we can resolve; never bail for a missing code.
  var code=currentWriteCode(payload);
  if(code&&code!=='_unknown'){try{localStorage.setItem('dp_last_athlete_code',code);}catch(e){}}
  var list=await readPendingCoachWrites(code);
  var writeId=payload&&payload.clientWriteId?payload.clientWriteId:('cw_'+Date.now()+'_'+Math.random().toString(36).slice(2));
  if(payload) payload.clientWriteId=writeId;
  var existing=list.find(function(item){return item.id===writeId;});
  if(existing){
    existing.payload=payload;existing.lastError=String(error&&error.message||error||'Write failed');existing.updatedAt=new Date().toISOString();
  }else{
    list.push({id:writeId,url:url,payload:payload,createdAt:new Date().toISOString(),attempts:0,lastError:String(error&&error.message||error||'Write failed')});
  }
  await persistPendingCoachWrites(list,code);
  await registerBackgroundQueueSync();
}
async function postJsonChecked(url,payload){
  if(payload&&!payload.clientWriteId) payload.clientWriteId='cw_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  // authHeaders: migrated athletes send their session token so the server
  // derives athlete identity from auth (not the client payload); legacy
  // athletes have no token and the request is byte-identical to before.
  var response=await fetch(url,{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify(payload)});
  var text=await response.text();
  var data={};
  try{data=text?JSON.parse(text):{};}catch(e){data={raw:text};}
  if(!response.ok||data.ok===false){
    throw new Error((data&&(data.error||data.message))||('Write failed '+response.status));
  }
  return data;
}
// Authoritative write: /api/ingest persists to the structured Supabase tables
// (the dashboard's source of truth) AND mirrors to the coach target. ONLY an
// ingest success means the submission is safely in Supabase.
async function ingestWrite(url,payload){
  return postJsonChecked('/api/ingest',{targetUrl:url,payload:payload});
}
async function coachWrite(url,payload,opts){
  opts=opts||{};
  if(payload&&!payload.clientWriteId) payload.clientWriteId='cw_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  if(athlete&&athlete.code){try{localStorage.setItem('dp_last_athlete_code',athlete.code);}catch(e){}}
  try{
    return await ingestWrite(url,payload); // persisted to Supabase (source of truth)
  }catch(ingestError){
    // Supabase persistence did NOT happen. Queue locally so it retries via /api/ingest.
    await queueCoachWrite(url,payload,ingestError);
    if(opts.required) throw ingestError;
    console.warn('Coach write queued for Supabase retry:',ingestError&&ingestError.message);
    return {ok:true,queued:true,error:ingestError&&ingestError.message};
  }
}
var _pendingQueueIndicatorCount=-1;
async function pendingCoachWriteCount(){
  var code=currentWriteCode(),list=await readPendingCoachWrites(code);
  if(code!=='_unknown')list=list.concat(await readPendingCoachWrites('_unknown'));
  var ids={},coachCount=list.filter(function(item){if(!item||ids[item.id])return false;ids[item.id]=true;return true;}).length;
  var stateCount=code==='_unknown'?0:(await readPendingPortalStateWrites(code)).filter(function(item){return item.key!=='pending_writes';}).length;
  return coachCount+stateCount;
}
async function updatePendingQueueIndicator(){
  var banner=document.getElementById('queuePendingBanner');if(!banner)return;
  var count=await pendingCoachWriteCount();
  banner.hidden=count===0;
  banner.style.display=count?'flex':'none';
  var text=banner.querySelector('b');if(text)text.textContent=count+' update'+(count===1?'':'s')+' waiting to send';
  if(count>0&&count!==_pendingQueueIndicatorCount)track('queue_pending_shown',{count:count});
  _pendingQueueIndicatorCount=count;
}
async function manualRetryPendingCoachWrites(){
  track('queue_flush_manual');
  var banner=document.getElementById('queuePendingBanner');if(banner)banner.classList.add('is-retrying');
  try{await Promise.all([retryPendingCoachWrites(false,'manual'),retryPendingPortalStateWrites(false,'manual')]);}
  finally{if(banner)banner.classList.remove('is-retrying');await updatePendingQueueIndicator();}
}
async function retryPendingCoachWrites(silent,trigger){
  var code=currentWriteCode();
  // Process the active code AND any writes parked under '_unknown' before a code was known.
  var buckets=[code];if(code!=='_unknown') buckets.push('_unknown');
  var totalSynced=0;
  for(var b=0;b<buckets.length;b++){
    var bucket=buckets[b];
    var list=await readPendingCoachWrites(bucket);
    if(!list.length) continue;
    var keep=[],synced=0;
    for(var i=0;i<list.length;i++){
      var item=list[i];
      try{
        await ingestWrite(item.url,item.payload); // must reach Supabase to clear the queue
        synced++;
      }catch(e){
        item.attempts=(item.attempts||0)+1;
        item.lastError=String(e&&e.message||e||'Write failed');
        item.updatedAt=new Date().toISOString();
        keep.push(item);
      }
    }
    totalSynced+=synced;
    if(bucket==='_unknown'&&code!=='_unknown'){
      // Re-home any still-failing 'unknown' writes under the now-known code.
      var primary=(await readPendingCoachWrites(code)).concat(keep);
      await persistPendingCoachWrites(primary,code);
      await persistPendingCoachWrites([],'_unknown');
    }else{
      await persistPendingCoachWrites(keep,bucket);
    }
  }
  if(totalSynced){
    // A drained queue means some of those "saved on this device" logs have now
    // actually reached the coaches — re-read the confirmed dates so the dock
    // stops warning about work that has since landed.
    if(typeof loadConfirmedLogDates==='function'){try{await loadConfirmedLogDates();}catch(e){}}
  }
  if(totalSynced) track('offline_queue_flushed',{count:totalSynced,trigger:trigger||'visibility'});
  if(totalSynced&&!silent) showToast(totalSynced+' pending coach update'+(totalSynced>1?'s':'')+' synced');
  await updatePendingQueueIndicator();
}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'){retryPendingCoachWrites(true,'visibility');retryPendingPortalStateWrites(true,'visibility');}});
window.addEventListener('pageshow',function(){retryPendingCoachWrites(true,'visibility');retryPendingPortalStateWrites(true,'visibility');});
if('serviceWorker'in navigator){
  navigator.serviceWorker.addEventListener('message',function(event){
    var data=event.data||{};
    if(data.type==='dp-queue-flushed'){
      if(data.count)track('offline_queue_flushed',{count:data.count,trigger:'sync'});
      updatePendingQueueIndicator();
    }
  });
}

// Coach prescription overrides now live directly on planned_sessions rows in
// Supabase — loadPlannedSessions() populates _sessionOverrides from each row.
async function loadPlannedSessions(startISO,endISO,preloaded){
  try{
    var result=preloaded||await portalRequest('planned-sessions',{start:startISO,end:endISO});
    var plannedRows=(result.rows||[]).slice();
    if(result.next&&!plannedRows.some(function(existing){return existing.id===result.next.id;}))plannedRows.push(result.next);
    _sessionOverrides={};
    // Register coach-built prescriptions before the rows are mapped, so every
    // downstream resolution can already see them.
    try{registerSessionPrescriptions(result.prescriptions,plannedRows);}
    catch(e){console.warn('Prescription registration failed; falling back to named splits',e);}
    return plannedRows.map(function(r){
      var key=r.notion_page_id||r.id;
      if(r.distance_km!=null||r.target_pace||r.warm_up||r.intervals||r.working_pace||r.rest||r.cool_down||r.notes){
        _sessionOverrides[key]={notion_page_id:key,name:null,
          distance_km:r.distance_km,target_pace:r.target_pace,warm_up:r.warm_up,
          intervals:r.intervals,working_pace:r.working_pace,rest:r.rest,
          cool_down:r.cool_down,notes:r.notes};
      }
      return{id:key,name:r.title||'Session',date:r.planned_date||'',plannedDate:r.planned_date||'',
        sessionType:r.session_type||'',status:r.status||'Planned',
        runningSession:'',runningSessionIds:[],
        runningLibraryIds:r.library_id?[r.library_id]:[],
        runDetails:r.run_details||'',intensity:r.intensity||'',week:r.week_label||'',
        programmeWeekIdentifier:r.programme_week_id||null,
        prescriptionMode:r.prescription_mode||'legacy',
        partOfDay:r.part_of_day||'',dayOrder:r.day_order||0,
        estimatedMinutes:r.estimated_minutes||null};
    });
  }catch(e){ console.warn('Planned sessions load failed',e); return null; }
}

async function loadCloudData(code,preloaded){
  _skipSbSync=true;
  programmeWeeks=12;
  try{
    var result=preloaded||await portalRequest('state-read');
    var rows=result.rows||[];
    var structuredCheckins=result.checkins||[];
    var pendingStateWrites=await readPendingPortalStateWrites(code),pendingStateKeys={};
    pendingStateWrites.forEach(function(item){pendingStateKeys[item.key]=true;});
    // Build a set of keys that exist in Supabase
    var cloudKeys={};
    rows.forEach(function(row){cloudKeys[row.key]=row.value;});
    // Programme length (set by coaches in the dashboard Nutrition tab)
    var pw=parseInt(cloudKeys['programme_weeks'],10);
    if(!isNaN(pw)&&pw>0&&pw<=52) programmeWeeks=pw;
    // Coach-set start date is shared by both apps and takes priority over the
    // legacy Notion profile value for week calculations and portal display.
    var startOverride=String(cloudKeys['start_date_override']||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(startOverride)) athlete.startDate=startOverride;
    // Write cloud data to localStorage (cloud is authoritative)
    rows.forEach(function(row){
      var lsKey=null;
      // A locally queued state value is newer by definition: it exists only
      // because the device could not commit it. Never let the older cloud row
      // overwrite that value before the outbox gets a chance to retry.
      if(pendingStateKeys[row.key])return;
      // LOGS: never let an older cloud copy clobber a newer local draft.
      // (Athletes were losing in-progress gym/run data on reload because the
      //  cloud copy was treated as authoritative even when a fresher local
      //  draft existed — e.g. the last keystrokes hadn't synced before the
      //  mobile browser reloaded the tab.)
      if(row.key==='logs'){
        var _cloudLogs=row.value||null;
        var _localLogs=null;try{_localLogs=JSON.parse(localStorage.getItem('dp_logs_'+code)||'null');}catch(e){}
        var _cloudT=(_cloudLogs&&_cloudLogs.__savedAt)||0;
        var _localT=(_localLogs&&_localLogs.__savedAt)||0;
        // Trim both copies before the comparison. A cloud row written by an
        // older build still carries the full Strava payloads, and copying it
        // into localStorage unpruned would just re-inflate the device.
        pruneStravaMatchPayloads(_cloudLogs);
        var _localTrimmed=pruneStravaMatchPayloads(_localLogs);
        if(_localLogs&&_localT>_cloudT){
          // Local draft is newer — keep it, and push it up so other devices catch up.
          if(_localTrimmed){try{localStorage.setItem('dp_logs_'+code,JSON.stringify(_localLogs));}catch(e){}}
          portalStateWrite('logs',_localLogs).catch(function(){});
        }else if(_cloudLogs){
          localStorage.setItem('dp_logs_'+code,JSON.stringify(_cloudLogs));
        }
        return;
      }
      if(row.key==='goals') lsKey='dp_goals_'+code;
      else if(row.key==='logs') lsKey='dp_logs_'+code;
      else if(row.key==='ticked') lsKey='dp_ticked_'+code;
      else if(row.key==='strength_rpe_enabled') lsKey='dp_strength_rpe_enabled';
      else if(row.key==='reschedules') lsKey='dp_reschedules_'+code;
      else if(row.key==='strava_match_rejections') lsKey='dp_strava_match_rejections_'+code;
      else if(row.key==='photos') lsKey='dp_photos_'+code;
      else if(row.key.startsWith('daily_body_')) lsKey='dp_daily_body_'+code+'_'+row.key.slice('daily_body_'.length);
      else if(row.key.startsWith('daily_nut_')) lsKey='dp_daily_nut_'+code+'_'+row.key.slice('daily_nut_'.length);
      else if(row.key==='ex_picks') lsKey='dp_ex_picks_'+code;
      else if(row.key.startsWith('call_booked_')) lsKey='dp_call_booked_'+(code?code.toUpperCase()+'_':'')+row.key.slice('call_booked_'.length);
      // calls_prep_* is retired: the Calls tab prep questions were folded into
      // the weekly check-in. Any row an old build wrote is ignored, not rehydrated.
      else if(row.key.startsWith('calls_prep_')) return;
      else if(row.key==='pending_writes') return;
      if(!lsKey||!row.value) return;
      localStorage.setItem(lsKey,JSON.stringify(row.value));
    });
    if(Array.isArray(cloudKeys['pending_writes'])&&!pendingStateKeys['pending_writes']){
      var localPending=await readPendingCoachWrites(code),pendingById={};
      localPending.concat(cloudKeys['pending_writes']).forEach(function(item){
        if(!item||!item.id)return;
        var prior=pendingById[item.id];
        if(!prior||String(item.updatedAt||item.createdAt||'')>=String(prior.updatedAt||prior.createdAt||''))pendingById[item.id]=item;
      });
      await persistPendingCoachWrites(Object.keys(pendingById).map(function(id){return pendingById[id];}),code);
    }
    // Rebuild this athlete's completion cache exclusively from structured
    // weekly_checkins (plus a locally queued submission). Old releases used a
    // shared dp_checkin_YYYY_WW key and mirrored it through athlete_data; both
    // could create false positives across athletes or after failed submits.
    var checkinPrefix='dp_checkin_'+String(code||'').toUpperCase()+'_';
    try{
      var remove=[];
      for(var _ci=0;_ci<localStorage.length;_ci++){
        var _cik=localStorage.key(_ci);if(_cik&&_cik.indexOf(checkinPrefix)===0)remove.push(_cik);
      }
      remove.forEach(function(key){localStorage.removeItem(key);});
      structuredCheckins.forEach(function(row){
        var ending=String(row.week_ending||'');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(ending)){
          var match=String(row.week_key||'').match(/week_ending_(\d{4}-\d{2}-\d{2})/);
          ending=match?match[1]:'';
        }
        if(!ending)return;
        // The nudge is a weekly action cycle, so completion belongs to the
        // Adelaide week in which the athlete submitted it. This lets Monday
        // start clean while an overdue form can still report on last Sunday.
        var completedOn=row.submitted_at?new Date(row.submitted_at):localDateFromISO(ending);
        if(isNaN(completedOn))completedOn=localDateFromISO(ending);
        localStorage.setItem(checkinPrefix+checkinWeekSuffix(completedOn),JSON.stringify({submittedAt:row.submitted_at||'',weekEnding:ending}));
      });
      // An offline submission is still work the athlete has completed. Keep
      // its nudge quiet while the existing outbox retries the canonical write.
      (await readPendingCoachWrites(code)).forEach(function(item){
        var p=item&&item.payload;if(!p||p.type!=='weekly_checkin'||!p.weekEnding)return;
        var queuedOn=p.submittedAt?new Date(p.submittedAt):(item.createdAt?new Date(item.createdAt):new Date());
        localStorage.setItem(checkinPrefix+checkinWeekSuffix(queuedOn),JSON.stringify({queued:true,weekEnding:p.weekEnding}));
      });
    }catch(e){console.warn('Check-in completion hydration failed',e);}
    // Backfill: if photos exist locally but not in Supabase, push them up now
    if(!cloudKeys['photos']){
      var localPhotos=localStorage.getItem('dp_photos_'+code);
      if(localPhotos&&localPhotos!=='{}'){
        try{
          var parsedPhotos=JSON.parse(localPhotos);
          if(Object.keys(parsedPhotos).length>0){
            _skipSbSync=false;
            await portalStateWrite('photos',parsedPhotos);
            _skipSbSync=true;
          }
        }catch(e){}
      }
    }
    // Backfill: if goals exist locally but not in Supabase, push them up now
    if(!cloudKeys['goals']){
      var localGoals=localStorage.getItem('dp_goals_'+code);
      if(localGoals&&localGoals!=='{}'){
        try{
          var parsed=JSON.parse(localGoals);
          if(parsed.savedAt){
            _skipSbSync=false;
            await portalStateWrite('goals',parsed);
            _skipSbSync=true;
          }
        }catch(e){}
      }
    }
  }catch(e){console.warn('Cloud sync failed:',e);}
  finally{_skipSbSync=false;}
}

// Hydrate daily body logs from the structured Supabase source of truth. The
// readiness card can then use the same local-first path offline while every
// device receives the latest server copy at login.
async function loadStructuredBodyData(code,preloaded){
  if(!code) return;
  var wasSkipping=_skipSbSync;
  try{
    var result=preloaded||await portalRequest('body-logs');
    if(!result||!Array.isArray(result.rows)) return;
    _skipSbSync=true;
    result.rows.forEach(function(row){
      var logDate=String(row.log_date||'').slice(0,10);if(!logDate)return;
      var raw=row.raw_payload&&typeof row.raw_payload==='object'?row.raw_payload:{};
      var value=Object.assign({},raw,{
        type:'daily_body',athleteCode:code,date:logDate,
        weight:row.weight==null?'':String(row.weight),
        sleep:row.sleep==null?'':String(row.sleep),energy:row.energy==null?'':String(row.energy),
        stress:row.stress==null?'':String(row.stress),soreness:row.soreness==null?'':String(row.soreness),
        notes:row.notes||raw.notes||''
      });
      localStorage.setItem('dp_daily_body_'+code+'_'+logDate,JSON.stringify(value));
    });
  }catch(e){console.warn('Body log cloud hydration failed',e);}
  finally{_skipSbSync=wasSkipping;}
}
// The nutrition twin of the above. Both daily logs are supposed to mirror into
// athlete_data on write, but that mirror has quietly stopped landing for
// several athletes — THOMAS logs most days and has zero rows there — so it
// cannot be trusted to repopulate a submitted form. daily_nutrition_logs is
// what the coaches actually read, so hydrate from that and let every device
// agree on what was sent.
async function loadStructuredNutritionData(code,preloaded){
  if(!code) return;
  var wasSkipping=_skipSbSync;
  try{
    var result=preloaded||await portalRequest('nutrition-logs');
    if(!result||!Array.isArray(result.rows)) return;
    _skipSbSync=true;
    var num=function(v){return v==null?'':String(v);};
    result.rows.forEach(function(row){
      var logDate=String(row.log_date||'').slice(0,10);if(!logDate)return;
      var raw=row.raw_payload&&typeof row.raw_payload==='object'?row.raw_payload:{};
      var value=Object.assign({},raw,{
        type:'daily_nutrition',athleteCode:code,date:logDate,
        calories:num(row.calories),protein:num(row.protein),carbs:num(row.carbs),
        fat:num(row.fat),fibre:num(row.fibre),
        notes:row.notes||raw.notes||'',
        submittedAt:row.submitted_at||raw.submittedAt||''
      });
      localStorage.setItem('dp_daily_nut_'+code+'_'+logDate,JSON.stringify(value));
    });
  }catch(e){console.warn('Nutrition log cloud hydration failed',e);}
  finally{_skipSbSync=wasSkipping;}
}

// ── STRENGTH LIBRARY ──────────────────────────────────────────────────────────
const STR = {
  "Lower A":[
    {"exercise":"Leg Extension","sets":"4","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"3","rest":"90s","notes":"First set warm-up","alts":["Single Leg Extension"]},
    {"exercise":"Bulgarian Split Squat","sets":"3","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"3","rest":"90s","notes":"","alts":["Barbell Split Squat","Hack Squat"]},
    {"exercise":"Seated Hamstring Curl","sets":"4","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"3","rest":"90s","notes":"First set warm-up","alts":["Lying Leg Curl"]},
    {"exercise":"Barbell Romanian Dead Lift","sets":"3","reps":"8","repRange":"6-10","warmupSets":"0","workingSets":"3","rest":"90s","notes":"","alts":["Dumbbell Romanian Deadlift"]},
    {"exercise":"Adduction Machine","sets":"2","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable Hip Adduction"],"leftRightExercises":["Cable Hip Adduction"]},
    {"exercise":"Standing Calf Raise","sets":"4","reps":"8","repRange":"10-15","warmupSets":"1","workingSets":"3","rest":"90s","notes":"","alts":["Seated Calf Raise"]},
    {"exercise":"Cable Abdominal Crunch","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":""}
  ],
  "Lower B":[
    {"exercise":"Lying Down Leg Press","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"120s","notes":""},
    {"exercise":"Seated Hamstring Curl","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"90s","notes":""},
    {"exercise":"Single Leg Step Down","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"90s","notes":""},
    {"exercise":"Hip Flexors","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":""},
    {"exercise":"Tibialis Raise","sets":"4","reps":"10","repRange":"12-20","warmupSets":"0","workingSets":"4","rest":"90s","notes":""},
    {"exercise":"Seated Calf Raise","sets":"4","reps":"8","repRange":"10-15","warmupSets":"1","workingSets":"3","rest":"90s","notes":""},
    {"exercise":"Cable Abdominal Crunch","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":""}
  ],
  "Upper A":[
    {"exercise":"Low Machine Row","sets":"4","reps":"8","repRange":"8-12","warmupSets":"2","workingSets":"2","rest":"90s","notes":"First 2 sets warm-up","alts":["Cable row (close grip)"]},
    {"exercise":"Wide Grip Machine Row","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Wide Grip Cable Row"]},
    {"exercise":"Pec Dec","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"90s","notes":"First set warm-up","alts":["Cable fly","Chest fly machine"]},
    {"exercise":"Incline Dumbbell Press","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Barbell incline bench press","Machine incline bench press"]},
    {"exercise":"Lat Pulldown","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable Lat Pulldown","Machine Lat Pulldown"]},
    {"exercise":"Machine Dips","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Assisted dips","Cable pushdown"]},
    {"exercise":"Machine Shoulder Press","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Dumbbell shoulder press","Seated barbell press"]},
    {"exercise":"Dumbbell Hammer Curl","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Bicep curl","Barbell curl"]},
    {"exercise":"Lateral Dumbbell Raise","sets":"2","reps":"10","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Machine lateral raise","Cable lateral raise"]},
    {"exercise":"Tricep Rope Extension","sets":"2","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Overhead rope extension","Cable pushdown (bar)"]},
    {"exercise":"Rear Delt Fly","sets":"2","reps":"10","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable rear delt fly","Face pull"]},
    {"exercise":"Cable Abdominal Crunch","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":"","alts":["Crunch machine","Hanging knee raise"]}
  ],
  "Upper B":[
    {"exercise":"Low Machine Row","sets":"4","reps":"8","repRange":"8-12","warmupSets":"2","workingSets":"2","rest":"90s","notes":"First 2 sets warm-up","alts":["Cable row (close grip)","Low pulley row"]},
    {"exercise":"Mid Machine Row","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Seated cable row (wide)","Cable row (wide grip)"]},
    {"exercise":"Pec Dec","sets":"3","reps":"8","repRange":"8-12","warmupSets":"1","workingSets":"2","rest":"90s","notes":"First set warm up","alts":["Cable fly","Chest fly machine"]},
    {"exercise":"Incline Dumbbell Press","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Barbell incline bench press","Machine incline bench press"]},
    {"exercise":"Lat Pulldown","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable Lat Pulldown","Machine Lat Pulldown"]},
    {"exercise":"Machine Dips","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Parallel bar dip","Cable pushdown"]},
    {"exercise":"Machine Shoulder Press","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Dumbbell shoulder press","Seated barbell press"]},
    {"exercise":"Dumbbell Hammer Curl","sets":"2","reps":"8","repRange":"8-12","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Bicep curl","Barbell curl"]},
    {"exercise":"Lateral Dumbbell Raise","sets":"2","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Machine lateral raise","Cable lateral raise"]},
    {"exercise":"Tricep Rope Extension","sets":"2","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Overhead rope extension","Cable pushdown (bar)"]},
    {"exercise":"Rear Delt Fly","sets":"2","reps":"10","repRange":"10-15","warmupSets":"0","workingSets":"2","rest":"90s","notes":"","alts":["Cable rear delt fly","Face pull"]},
    {"exercise":"Cable Abdominal Crunch","sets":"3","reps":"8","repRange":"10-15","warmupSets":"0","workingSets":"3","rest":"90s","notes":"","alts":["Crunch machine","Hanging knee raise"]}
  ]
};

// ── EXERCISE SWAP LIBRARY ─────────────────────────────────────────────────────
// The programmed exercise and its coach-set `alts` stay the athlete's priority
// options. This library is the safety net behind them: every programmed slot is
// mapped to a movement pattern, and each pattern carries a wider bank of
// substitutions that train the same muscle group. That way a busy squat rack, a
// missing machine or a hotel gym never costs the athlete the training stimulus
// the session was written to deliver.
//
// Options are tagged by equipment so the picker can group them — an athlete
// scanning for "what can I actually get on right now" finds it in one glance.
//   machine | cable | free (barbell/dumbbell/kettlebell) | bodyweight (incl. bands)
var SWAP_EQUIPMENT_ORDER=['machine','cable','free','bodyweight'];
var SWAP_EQUIPMENT_LABELS={machine:'Machine',cable:'Cable',free:'Free weight',bodyweight:'Bodyweight / bands'};
var EX_PATTERNS={
  vertical_pull:{label:'Lats — vertical pull',options:[
    {n:'Machine Lat Pulldown',e:'machine'},{n:'Assisted Pull Up Machine',e:'machine'},{n:'Iso-Lateral Pulldown',e:'machine'},
    {n:'Lat Pulldown',e:'cable'},{n:'Cable Lat Pulldown',e:'cable'},{n:'Close Grip Lat Pulldown',e:'cable'},{n:'Neutral Grip Lat Pulldown',e:'cable'},{n:'Straight Arm Pulldown',e:'cable'},
    {n:'Dumbbell Pullover',e:'free'},
    {n:'Pull Up',e:'bodyweight'},{n:'Chin Up',e:'bodyweight'},{n:'Band Assisted Pull Up',e:'bodyweight'}
  ]},
  horizontal_row:{label:'Upper back — horizontal row',options:[
    {n:'Low Machine Row',e:'machine'},{n:'Mid Machine Row',e:'machine'},{n:'Wide Grip Machine Row',e:'machine'},{n:'Chest Supported Row',e:'machine'},{n:'Iso-Lateral Row',e:'machine'},
    {n:'Seated Cable Row (close grip)',e:'cable'},{n:'Seated Cable Row (wide grip)',e:'cable'},{n:'Single Arm Cable Row',e:'cable'},
    {n:'Single Arm Dumbbell Row',e:'free'},{n:'Chest Supported Dumbbell Row',e:'free'},{n:'Barbell Bent Over Row',e:'free'},{n:'T-Bar Row',e:'free'},
    {n:'Inverted Row',e:'bodyweight'},{n:'Ring Row',e:'bodyweight'}
  ]},
  rear_delt:{label:'Rear delts — upper back health',options:[
    {n:'Reverse Pec Dec',e:'machine'},{n:'Rear Delt Fly Machine',e:'machine'},
    {n:'Cable Rear Delt Fly',e:'cable'},{n:'Face Pull',e:'cable'},{n:'Cable Y-Raise',e:'cable'},
    {n:'Dumbbell Rear Delt Fly',e:'free'},{n:'Prone Incline Rear Delt Raise',e:'free'},
    {n:'Band Pull Apart',e:'bodyweight'}
  ]},
  horizontal_press:{label:'Chest — pressing',options:[
    {n:'Machine Chest Press',e:'machine'},{n:'Machine Incline Bench Press',e:'machine'},{n:'Smith Machine Incline Press',e:'machine'},
    {n:'Cable Chest Press',e:'cable'},
    {n:'Incline Dumbbell Press',e:'free'},{n:'Flat Dumbbell Press',e:'free'},{n:'Barbell Bench Press',e:'free'},{n:'Barbell Incline Bench Press',e:'free'},
    {n:'Push Up',e:'bodyweight'},{n:'Deficit Push Up',e:'bodyweight'},{n:'Feet Elevated Push Up',e:'bodyweight'}
  ]},
  chest_fly:{label:'Chest — fly / stretch',options:[
    {n:'Pec Dec',e:'machine'},{n:'Chest Fly Machine',e:'machine'},
    {n:'Cable Fly',e:'cable'},{n:'High to Low Cable Fly',e:'cable'},{n:'Low to High Cable Fly',e:'cable'},
    {n:'Dumbbell Fly',e:'free'},{n:'Incline Dumbbell Fly',e:'free'},
    {n:'Deficit Push Up',e:'bodyweight'}
  ]},
  vertical_press:{label:'Shoulders — overhead press',options:[
    {n:'Machine Shoulder Press',e:'machine'},{n:'Smith Machine Shoulder Press',e:'machine'},
    {n:'Seated Dumbbell Shoulder Press',e:'free'},{n:'Standing Dumbbell Press',e:'free'},{n:'Seated Barbell Press',e:'free'},{n:'Standing Barbell Overhead Press',e:'free'},{n:'Arnold Press',e:'free'},{n:'Landmine Press',e:'free'},
    {n:'Pike Push Up',e:'bodyweight'}
  ]},
  lateral_delt:{label:'Side delts',options:[
    {n:'Machine Lateral Raise',e:'machine'},
    {n:'Cable Lateral Raise',e:'cable'},{n:'Single Arm Cable Lateral Raise',e:'cable'},
    {n:'Lateral Dumbbell Raise',e:'free'},{n:'Seated Lateral Raise',e:'free'},{n:'Leaning Lateral Raise',e:'free'},
    {n:'Band Lateral Raise',e:'bodyweight'}
  ]},
  triceps:{label:'Triceps',options:[
    {n:'Machine Dips',e:'machine'},{n:'Machine Tricep Extension',e:'machine'},{n:'Assisted Dip Machine',e:'machine'},
    {n:'Tricep Rope Extension',e:'cable'},{n:'Cable Pushdown (bar)',e:'cable'},{n:'Overhead Rope Extension',e:'cable'},{n:'Single Arm Cable Pushdown',e:'cable'},
    {n:'Skull Crusher',e:'free'},{n:'Dumbbell Overhead Extension',e:'free'},{n:'Close Grip Bench Press',e:'free'},{n:'Dumbbell Kickback',e:'free'},
    {n:'Parallel Bar Dip',e:'bodyweight'},{n:'Bench Dip',e:'bodyweight'},{n:'Diamond Push Up',e:'bodyweight'}
  ]},
  biceps:{label:'Biceps',options:[
    {n:'Machine Preacher Curl',e:'machine'},
    {n:'Cable Bicep Curl',e:'cable'},{n:'Cable Rope Hammer Curl',e:'cable'},{n:'Bayesian Cable Curl',e:'cable'},
    {n:'Dumbbell Hammer Curl',e:'free'},{n:'Dumbbell Bicep Curl',e:'free'},{n:'Incline Dumbbell Curl',e:'free'},{n:'Barbell Curl',e:'free'},{n:'EZ Bar Curl',e:'free'},{n:'Preacher Curl',e:'free'},
    {n:'Chin Up',e:'bodyweight'}
  ]},
  quad_isolation:{label:'Quads — knee extension',options:[
    {n:'Leg Extension',e:'machine'},{n:'Single Leg Extension',e:'machine'},
    {n:'Cyclist Goblet Squat',e:'free'},{n:'Heel Elevated Goblet Squat',e:'free'},
    {n:'Sissy Squat',e:'bodyweight'},{n:'Reverse Nordic Curl',e:'bodyweight'},{n:'Wall Sit',e:'bodyweight'}
  ]},
  squat_pattern:{label:'Quads & glutes — squat / press',options:[
    {n:'Lying Down Leg Press',e:'machine'},{n:'Leg Press',e:'machine'},{n:'Hack Squat',e:'machine'},{n:'Pendulum Squat',e:'machine'},{n:'Smith Machine Squat',e:'machine'},
    {n:'Barbell Back Squat',e:'free'},{n:'Barbell Front Squat',e:'free'},{n:'Goblet Squat',e:'free'},{n:'Dumbbell Squat',e:'free'},{n:'Trap Bar Squat',e:'free'},
    {n:'Bodyweight Squat',e:'bodyweight'},{n:'Squat Jump',e:'bodyweight'}
  ]},
  unilateral_leg:{label:'Single leg — quads, glutes & stability',options:[
    {n:'Single Leg Press',e:'machine'},{n:'Smith Machine Split Squat',e:'machine'},
    {n:'Bulgarian Split Squat',e:'free'},{n:'Barbell Split Squat',e:'free'},{n:'Walking Lunge',e:'free'},{n:'Reverse Lunge',e:'free'},{n:'Dumbbell Step Up',e:'free'},{n:'Front Foot Elevated Split Squat',e:'free'},
    {n:'Single Leg Step Down',e:'bodyweight'},{n:'Bodyweight Split Squat',e:'bodyweight'},{n:'Step Up',e:'bodyweight'},{n:'Skater Squat',e:'bodyweight'}
  ]},
  hamstring_curl:{label:'Hamstrings — knee flexion',options:[
    {n:'Seated Hamstring Curl',e:'machine'},{n:'Lying Leg Curl',e:'machine'},{n:'Standing Hamstring Curl',e:'machine'},{n:'Single Leg Seated Curl',e:'machine'},
    {n:'Cable Leg Curl',e:'cable'},
    {n:'Nordic Hamstring Curl',e:'bodyweight'},{n:'Swiss Ball Hamstring Curl',e:'bodyweight'},{n:'Slider Leg Curl',e:'bodyweight'}
  ]},
  hip_hinge:{label:'Hamstrings & glutes — hip hinge',options:[
    {n:'45° Back Extension',e:'machine'},{n:'Machine Back Extension',e:'machine'},
    {n:'Cable Pull Through',e:'cable'},{n:'Single Leg Cable Romanian Deadlift',e:'cable'},
    {n:'Barbell Romanian Dead Lift',e:'free'},{n:'Dumbbell Romanian Deadlift',e:'free'},{n:'Single Leg Romanian Deadlift',e:'free'},{n:'Trap Bar Deadlift',e:'free'},{n:'Conventional Deadlift',e:'free'},{n:'Good Morning',e:'free'},{n:'Kettlebell Swing',e:'free'},
    {n:'Back Extension',e:'bodyweight'},{n:'Single Leg Hip Hinge',e:'bodyweight'}
  ]},
  hip_thrust:{label:'Glutes — hip extension',options:[
    {n:'Hip Thrust Machine',e:'machine'},{n:'Glute Kickback Machine',e:'machine'},
    {n:'Cable Glute Kickback',e:'cable'},{n:'Cable Pull Through',e:'cable'},
    {n:'Barbell Hip Thrust',e:'free'},{n:'Dumbbell Hip Thrust',e:'free'},{n:'Single Leg Hip Thrust',e:'free'},{n:'Frog Pump',e:'free'},
    {n:'Glute Bridge',e:'bodyweight'},{n:'Single Leg Glute Bridge',e:'bodyweight'},{n:'Banded Hip Thrust',e:'bodyweight'}
  ]},
  hip_abduction:{label:'Glute medius — abduction',options:[
    {n:'Seated Hip Abduction',e:'machine'},{n:'Standing Abduction Machine',e:'machine'},
    {n:'Cable Hip Abduction',e:'cable'},
    {n:'Banded Lateral Walk',e:'bodyweight'},{n:'Side Lying Leg Raise',e:'bodyweight'},{n:'Banded Clamshell',e:'bodyweight'}
  ]},
  hip_adduction:{label:'Adductors — groin strength',options:[
    {n:'Adduction Machine',e:'machine'},
    {n:'Cable Hip Adduction',e:'cable'},
    {n:'Copenhagen Plank',e:'bodyweight'},{n:'Side Lying Adduction Raise',e:'bodyweight'},{n:'Swiss Ball Adductor Squeeze',e:'bodyweight'}
  ]},
  hip_flexor:{label:'Hip flexors — stride drive',options:[
    {n:'Cable Hip Flexion',e:'cable'},{n:'Standing Cable Knee Drive',e:'cable'},
    {n:'Weighted Standing Knee Raise',e:'free'},
    {n:'Hip Flexors',e:'bodyweight'},{n:'Banded Standing Knee Drive',e:'bodyweight'},{n:'Seated Hip Flexor Raise',e:'bodyweight'},{n:'Psoas March',e:'bodyweight'},{n:'Hanging Knee Raise',e:'bodyweight'}
  ]},
  calf_straight:{label:'Calves — gastroc (straight leg)',options:[
    {n:'Standing Calf Raise',e:'machine'},{n:'Smith Machine Calf Raise',e:'machine'},{n:'Leg Press Calf Raise',e:'machine'},
    {n:'Dumbbell Standing Calf Raise',e:'free'},{n:'Barbell Standing Calf Raise',e:'free'},
    {n:'Single Leg Standing Calf Raise',e:'bodyweight'},{n:'Bodyweight Calf Raise',e:'bodyweight'},{n:'Pogo Hops',e:'bodyweight'}
  ]},
  calf_bent:{label:'Calves — soleus (bent knee)',options:[
    {n:'Seated Calf Raise',e:'machine'},{n:'Smith Machine Seated Calf Raise',e:'machine'},
    {n:'Dumbbell Seated Calf Raise',e:'free'},{n:'Weighted Seated Calf Raise',e:'free'},
    {n:'Single Leg Seated Calf Raise',e:'bodyweight'},{n:'Bent Knee Wall Calf Raise',e:'bodyweight'}
  ]},
  tibialis:{label:'Tibialis — shin resilience',options:[
    {n:'Tibialis Machine',e:'machine'},
    {n:'Cable Tibialis Raise',e:'cable'},
    {n:'Tib Bar Raise',e:'free'},{n:'Weighted Toe Raise',e:'free'},
    {n:'Tibialis Raise',e:'bodyweight'},{n:'Banded Dorsiflexion',e:'bodyweight'},{n:'Heel Walks',e:'bodyweight'}
  ]},
  core_flexion:{label:'Core — trunk flexion & bracing',options:[
    {n:'Crunch Machine',e:'machine'},{n:'Ab Coaster',e:'machine'},
    {n:'Cable Abdominal Crunch',e:'cable'},{n:'Kneeling Cable Crunch',e:'cable'},{n:'Cable Woodchop',e:'cable'},{n:'Pallof Press',e:'cable'},
    {n:'Weighted Sit Up',e:'free'},{n:'Weighted Plank',e:'free'},
    {n:'Hanging Knee Raise',e:'bodyweight'},{n:'Hanging Leg Raise',e:'bodyweight'},{n:'Reverse Crunch',e:'bodyweight'},{n:'Dead Bug',e:'bodyweight'},{n:'Plank',e:'bodyweight'},{n:'V-Up',e:'bodyweight'}
  ]}
};
// Explicit slot → pattern mapping for every exercise the programme currently
// writes (including coach alts and the female split slots). Anything not listed
// falls back to keyword inference below, so a new Supabase exercise still gets
// sensible options without a code change.
var EX_PATTERN_BY_NAME={
  'lat pulldown':'vertical_pull','cable lat pulldown':'vertical_pull','machine lat pulldown':'vertical_pull','assisted pull up':'vertical_pull','pull up':'vertical_pull','chin up':'vertical_pull','straight arm pulldown':'vertical_pull',
  'low machine row':'horizontal_row','mid machine row':'horizontal_row','wide grip machine row':'horizontal_row','wide grip cable row':'horizontal_row','chest supported row':'horizontal_row','cable row close grip':'horizontal_row','cable row wide grip':'horizontal_row','seated cable row wide':'horizontal_row','low pulley row':'horizontal_row','dumbbell row':'horizontal_row','barbell bent over row':'horizontal_row',
  'rear delt fly':'rear_delt','cable rear delt fly':'rear_delt','face pull':'rear_delt','reverse pec dec':'rear_delt',
  'incline dumbbell press':'horizontal_press','barbell incline bench press':'horizontal_press','machine incline bench press':'horizontal_press','bench press':'horizontal_press','machine chest press':'horizontal_press','push up':'horizontal_press',
  'pec dec':'chest_fly','cable fly':'chest_fly','chest fly machine':'chest_fly','dumbbell fly':'chest_fly',
  'machine shoulder press':'vertical_press','dumbbell shoulder press':'vertical_press','seated barbell press':'vertical_press','overhead press':'vertical_press',
  'lateral dumbbell raise':'lateral_delt','machine lateral raise':'lateral_delt','cable lateral raise':'lateral_delt',
  'machine dips':'triceps','assisted dips':'triceps','parallel bar dip':'triceps','cable pushdown':'triceps','cable pushdown bar':'triceps','tricep rope extension':'triceps','overhead rope extension':'triceps','overhead tricep extension':'triceps','skull crusher':'triceps',
  'dumbbell hammer curl':'biceps','bicep curl':'biceps','barbell curl':'biceps','preacher curl':'biceps',
  'leg extension':'quad_isolation','single leg extension':'quad_isolation',
  'lying down leg press':'squat_pattern','leg press':'squat_pattern','leg press feet high wide':'squat_pattern','hack squat':'squat_pattern','barbell back squat':'squat_pattern','back squat':'squat_pattern','goblet squat':'squat_pattern',
  'bulgarian split squat':'unilateral_leg','barbell split squat':'unilateral_leg','single leg step down':'unilateral_leg','walking lunge':'unilateral_leg','reverse lunge':'unilateral_leg','step up':'unilateral_leg',
  'seated hamstring curl':'hamstring_curl','lying hamstring curl':'hamstring_curl','lying leg curl':'hamstring_curl','standing hamstring curl':'hamstring_curl','nordic hamstring curl':'hamstring_curl',
  'barbell romanian dead lift':'hip_hinge','barbell romanian deadlift':'hip_hinge','dumbbell romanian deadlift':'hip_hinge','romanian deadlift':'hip_hinge','deadlift':'hip_hinge','good morning':'hip_hinge','back extension':'hip_hinge',
  'barbell hip thrust':'hip_thrust','dumbbell hip thrust':'hip_thrust','hip thrust':'hip_thrust','glute bridge':'hip_thrust','glute kickback':'hip_thrust','cable glute kickback':'hip_thrust',
  'seated hip abduction':'hip_abduction','cable hip abduction':'hip_abduction','abduction machine':'hip_abduction',
  'adduction machine':'hip_adduction','cable hip adduction':'hip_adduction','copenhagen plank':'hip_adduction',
  'hip flexors':'hip_flexor','cable hip flexion':'hip_flexor',
  'standing calf raise':'calf_straight','seated calf raise':'calf_bent','tibialis raise':'tibialis',
  'cable abdominal crunch':'core_flexion','crunch machine':'core_flexion','hanging knee raise':'core_flexion','hanging leg raise':'core_flexion','plank':'core_flexion','pallof press':'core_flexion'
};
// Keyword fallback. Order matters — the first match wins, so the more specific
// tests (seated vs standing calf, adduction vs abduction) sit above the general
// ones.
var EX_PATTERN_RULES=[
  [/seated calf|soleus|bent knee calf/,'calf_bent'],
  [/calf raise|calf press/,'calf_straight'],
  [/tibialis|tib bar|dorsiflex|toe raise|heel walk/,'tibialis'],
  [/adduction|adductor|copenhagen/,'hip_adduction'],
  [/abduction|clamshell|lateral walk|glute med/,'hip_abduction'],
  [/hip flexor|knee drive|psoas/,'hip_flexor'],
  [/hip thrust|glute bridge|kickback|frog pump/,'hip_thrust'],
  [/romanian|rdl|deadlift|good morning|pull through|back extension|hinge|kettlebell swing/,'hip_hinge'],
  [/(?:hamstring|leg) curl|nordic/,'hamstring_curl'],
  [/split squat|lunge|step up|step down|single leg press|skater squat/,'unilateral_leg'],
  [/leg extension|sissy squat|wall sit|reverse nordic/,'quad_isolation'],
  [/squat|leg press|hack|pendulum/,'squat_pattern'],
  [/crunch|sit up|plank|leg raise|knee raise|dead bug|woodchop|pallof|\bab\b|\bcore\b|v-up/,'core_flexion'],
  [/rear delt|face pull|reverse pec|pull apart|y-raise/,'rear_delt'],
  [/lateral raise|side raise|lateral dumbbell/,'lateral_delt'],
  [/pulldown|pull up|pull-up|chin up|chin-up|pullover/,'vertical_pull'],
  [/\brow\b|rowing/,'horizontal_row'],
  [/\bfly\b|\bflye\b|pec dec/,'chest_fly'],
  [/shoulder press|overhead press|military press|arnold|pike push/,'vertical_press'],
  [/bench press|chest press|push up|push-up|dips?\b/,'horizontal_press'],
  [/pushdown|tricep|skull crusher|kickback/,'triceps'],
  [/curl/,'biceps']
];
function exercisePatternKey(exerciseName){
  var normalised=normaliseExerciseName(exerciseName);
  if(!normalised)return '';
  if(EX_PATTERN_BY_NAME[normalised])return EX_PATTERN_BY_NAME[normalised];
  for(var r=0;r<EX_PATTERN_RULES.length;r++){
    if(EX_PATTERN_RULES[r][0].test(normalised))return EX_PATTERN_RULES[r][1];
  }
  return '';
}
// Builds the picker payload for one programmed slot:
//   priority — the programmed exercise plus the coach's alts, in coach order
//   groups   — every other same-muscle option, grouped by equipment
// A prescription can opt out with swapLocked:true (Supabase) when the exercise
// itself is the point of the session and no substitution is acceptable.
function getExerciseSwapOptions(prescription){
  var programmed=prescription&&prescription.exercise?prescription.exercise:'';
  var priority=[programmed].concat((prescription&&prescription.alts)||[]).filter(Boolean);
  var seen={},ordered=[];
  priority.forEach(function(name){
    var key=normaliseExerciseName(name);
    if(key&&!seen[key]){seen[key]=true;ordered.push(name);}
  });
  var patternKey=prescription&&prescription.pattern?prescription.pattern:exercisePatternKey(programmed);
  var pattern=EX_PATTERNS[patternKey];
  if(!pattern||(prescription&&prescription.swapLocked))return{priority:ordered,groups:[],patternLabel:pattern?pattern.label:''};
  var byEquipment={};
  pattern.options.forEach(function(option){
    var key=normaliseExerciseName(option.n);
    if(!key||seen[key])return;
    seen[key]=true;
    (byEquipment[option.e]=byEquipment[option.e]||[]).push(option.n);
  });
  var groups=[];
  SWAP_EQUIPMENT_ORDER.forEach(function(equipment){
    if(byEquipment[equipment]&&byEquipment[equipment].length){
      groups.push({equipment:equipment,label:SWAP_EQUIPMENT_LABELS[equipment],options:byEquipment[equipment]});
    }
  });
  return{priority:ordered,groups:groups,patternLabel:pattern.label};
}

// ── MUSCLE GROUP TRACKING ─────────────────────────────────────────────────────
// Per-exercise progression stays the source of truth for load: a pull-up and a
// lat pulldown are not interchangeable numbers. But once an athlete can swap
// freely, "am I progressing?" can no longer be answered by one exercise string
// alone — three sessions of three different rows look like three false starts.
// These helpers add the muscle-group layer over the top: what actually got
// trained, and whether the athlete is staying on a variation long enough for
// the overload engine to have anything to work with.
var MUSCLE_GROUP_CHURN_WINDOW=4;   // how many recent sessions a slot is judged over
var MUSCLE_GROUP_CHURN_LIMIT=3;    // distinct variations within that window before we speak up
function exerciseMuscleGroup(exerciseName){
  var key=exercisePatternKey(exerciseName);
  if(!key||!EX_PATTERNS[key])return null;
  return{key:key,label:EX_PATTERNS[key].label};
}
// A set only counts as training if reps were actually recorded. A typed weight
// with an empty reps box is an abandoned set, and counting it would inflate
// coverage exactly when an athlete cut a session short.
function strengthSetWorkload(set){
  if(!set||typeof set!=='object')return null;
  var weight=parseFloat(set.weight);
  var reps=parseFloat(set.reps);
  if(isNaN(reps)||reps<=0){
    var left=parseFloat(set.repsLeft),right=parseFloat(set.repsRight);
    if(isNaN(left)&&isNaN(right))return null;
    reps=(isNaN(left)?0:left)+(isNaN(right)?0:right);
    if(reps<=0)return null;
  }
  return{reps:reps,volume:(isNaN(weight)||weight<=0)?0:weight*reps};
}
// Rolls a set of session log entries up by muscle group. Feeds the session
// coverage readout and any weekly view — pass one entry for a single session,
// or every entry in a week for the weekly picture.
function summariseMuscleGroups(entries){
  var byGroup={};
  (entries||[]).forEach(function(entry){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))return;
    Object.keys(entry).forEach(function(exerciseName){
      if(exerciseName.indexOf('__')===0||!Array.isArray(entry[exerciseName]))return;
      var group=exerciseMuscleGroup(exerciseName);
      if(!group)return;
      var bucket=byGroup[group.key]||(byGroup[group.key]={key:group.key,label:group.label,sets:0,reps:0,volume:0,exercises:[]});
      var trained=false;
      entry[exerciseName].forEach(function(set){
        var work=strengthSetWorkload(set);
        if(!work)return;
        bucket.sets++;bucket.reps+=work.reps;bucket.volume+=work.volume;trained=true;
      });
      if(trained&&bucket.exercises.indexOf(exerciseName)<0)bucket.exercises.push(exerciseName);
    });
  });
  return Object.keys(byGroup).map(function(key){
    var bucket=byGroup[key];
    bucket.volume=Math.round(bucket.volume);
    return bucket;
  }).sort(function(a,b){return b.sets-a.sets||a.label.localeCompare(b.label);});
}
// Which variation filled a programmed slot, session by session, newest first.
// Reads the __slots map written at save time; logs recorded before that map
// existed simply return nothing, so history stays quiet rather than wrong.
function slotVariationHistory(allLogs,programmedExercise,limit){
  var target=normaliseExerciseName(programmedExercise);
  if(!target)return[];
  var out=[];
  Object.keys(allLogs||{}).forEach(function(sessionId){
    if(sessionId.indexOf('__')===0)return;
    var entry=allLogs[sessionId];
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||!entry.__slots)return;
    var performed=null;
    Object.keys(entry.__slots).forEach(function(slot){
      if(normaliseExerciseName(slot)===target)performed=entry.__slots[slot];
    });
    if(!performed)return;
    var sets=null;
    Object.keys(entry).forEach(function(key){
      if(key.indexOf('__')!==0&&normaliseExerciseName(key)===normaliseExerciseName(performed)&&Array.isArray(entry[key]))sets=entry[key];
    });
    if(!sets||!sets.some(function(set){return !!strengthSetWorkload(set);}))return;
    out.push({sessionId:sessionId,date:String(entry.__sessionDate||'').slice(0,10)||null,exercise:performed});
  });
  out.sort(function(a,b){
    if(a.date&&b.date&&a.date!==b.date)return a.date<b.date?1:-1;
    if(a.date&&!b.date)return-1;
    if(!a.date&&b.date)return 1;
    return 0;
  });
  return limit?out.slice(0,limit):out;
}
// Progressive overload needs repetition to have anything to compare against.
// An athlete rotating through a different variation every week never builds the
// history the engine reads, so their numbers look flat no matter how hard they
// train. This spots that pattern so the card can say so.
function variationChurn(allLogs,programmedExercise){
  var history=slotVariationHistory(allLogs,programmedExercise,MUSCLE_GROUP_CHURN_WINDOW);
  var names=[],seen={};
  history.forEach(function(item){
    var key=normaliseExerciseName(item.exercise);
    if(key&&!seen[key]){seen[key]=true;names.push(item.exercise);}
  });
  return{
    sessions:history.length,
    distinct:names.length,
    variations:names,
    current:history.length?history[0].exercise:null,
    churning:history.length>=MUSCLE_GROUP_CHURN_LIMIT&&names.length>=MUSCLE_GROUP_CHURN_LIMIT
  };
}

// ── RUN LIBRARY ───────────────────────────────────────────────────────────────
const RUN={"Threshold Work":{"description":"Warm up 15min easy. Run at sustained threshold effort (RPE 7–8). Cool down easy.","type":"Threshold","intensity":"Threshold","surface":"Road","difficulty":"Intermediate"},"Easy Run":{"description":"Relaxed aerobic run at conversational pace (RPE 4–5). Focus on easy breathing and good form.","type":"Easy Run","intensity":"Aerobic","surface":"Road","difficulty":"Beginner"},"Long Run":{"description":"Long aerobic endurance run. Relaxed steady effort (RPE 5–6). Focus on time on feet and fueling.","type":"Long Run","intensity":"Aerobic","surface":"Road","difficulty":"Intermediate"},"Progressive Long Run":{"description":"Long run starting easy, gradually increasing pace in final third toward marathon effort.","type":"Long Run","intensity":"Aerobic","surface":"Road","difficulty":"Intermediate"},"Fast Finish Long Run":{"description":"Long run mostly easy with final 3–5km at marathon effort (RPE 7).","type":"Long Run","intensity":"Tempo","surface":"Road","difficulty":"Intermediate"},"12x1min Fartlek":{"description":"Warm up 10–15min easy. 12x1min strong (RPE 7–8) with 1min jog recovery. Cool down easy.","type":"Fartlek","intensity":"Aerobic","surface":"Road","difficulty":"Beginner"},"8x2min Fartlek":{"description":"Warm up 10–15min easy + strides. 8x2min steady hard (RPE 7) with 2min jog recovery. Cool down 10min easy.","type":"Fartlek","intensity":"Threshold","surface":"Road","difficulty":"Beginner"},"20min Tempo":{"description":"Warm up 10–15min easy. 20min tempo steady effort (RPE 7). Cool down 10min easy.","type":"Tempo","intensity":"Tempo","surface":"Road","difficulty":"Intermediate"},"25min Tempo":{"description":"Warm up 15min easy. 25min continuous tempo (RPE 7). Cool down 10–15min easy.","type":"Tempo","intensity":"Threshold","surface":"Road","difficulty":"Intermediate"},"5x1km Threshold":{"description":"Warm up 15min easy + strides. 5x1km threshold (RPE 7–8) with 90s jog recovery. Cool down 10min easy.","type":"Threshold","intensity":"Threshold","surface":"Road","difficulty":"Intermediate"},"6x400m Intervals":{"description":"Warm up 15min easy + drills. 6x400m fast (RPE 8) with 200m jog recovery. Cool down easy.","type":"Track","intensity":"VO2 Max","surface":"Track","difficulty":"Intermediate"},"6x800m Intervals":{"description":"Warm up 15min easy. 6x800m strong (RPE 8) with 2min jog recovery. Cool down easy.","type":"Track","intensity":"VO2 Max","surface":"Track","difficulty":"Intermediate"},"10x20s Hill Sprints":{"description":"Warm up 15min easy. 10x20s hill sprints (RPE 9) full recovery. Cool down easy.","type":"Hills","intensity":"Neuromuscular","surface":"Hills","difficulty":"Beginner"},"5km Recovery":{"description":"5km gentle recovery jog (RPE 3–4).","type":"Recovery","intensity":"Easy","surface":"Road","difficulty":"Beginner"},"6km Recovery":{"description":"6km very easy recovery run (RPE 3–4).","type":"Recovery","intensity":"Easy","surface":"Road","difficulty":"Beginner"}};

// ── STATE ─────────────────────────────────────────────────────────────────────
let athlete=null,weekOffset=0,nutWeekOffset=0,sessions=[],allSessions=[],ticked={},logs={},currentWeekKmData=null,exPicks={},currentNutTargets=null;
var programmeWeeks=12; // per-athlete programme length — loaded from Supabase athlete_data key 'programme_weeks' (default 12)
var _nutLastLoad=0; // timestamp of last nutrition load — gates refetch on rapid tab switching

// ── UTILS ─────────────────────────────────────────────────────────────────────
function localISO(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function localDateFromISO(value){
  var m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3])):new Date(value);
}
function getMon(d){var day=d.getDay(),diff=day===0?-6:1-day;return new Date(d.getFullYear(),d.getMonth(),d.getDate()+diff);}
// ── LOGGING STREAK ────────────────────────────────────────────────────────────
// Consecutive WEEKS containing at least one logged session — weeks, not days.
// The programme runs 8-9 sessions a week, so a day streak would punish planned
// rest and break on a deload. A week streak measures the thing that actually
// matters: showing up, week after week.
//
// Week boundaries are getMon()'s, Monday-start, so a Sunday session belongs to
// the week that is ending rather than the one about to begin.
//
// The current week is live, not yet judged: it counts as soon as it has a
// session, and while it is still empty the run that ended last week stands. An
// athlete opening the portal on Monday morning does not watch their streak
// reset before they have had a chance to train.
//
// Pure: takes dates and a reference date, returns a number. No globals, no clock.
function computeLoggingStreak(sessionDates,today){
  var ref=today==null?new Date():(typeof today==='string'?localDateFromISO(today):new Date(today));
  if(!ref||isNaN(ref.getTime()))return 0;
  var weeks={};
  (Array.isArray(sessionDates)?sessionDates:[]).forEach(function(value){
    // Duck-typed rather than `instanceof Date`: dates cross realms (the tests
    // run this in a vm context) and an identity check would silently drop them.
    var d=(value&&typeof value.getTime==='function')?new Date(value.getTime()):localDateFromISO(String(value||'').slice(0,10));
    if(!d||isNaN(d.getTime()))return;
    weeks[localISO(getMon(d))]=1;
  });
  var cursor=getMon(ref);
  if(!weeks[localISO(cursor)])cursor.setDate(cursor.getDate()-7);
  var streak=0;
  // A programme is 12 weeks by default and the longest athlete history here is
  // shorter than two years, so the guard is generous rather than meaningful.
  for(var guard=0;guard<520;guard++){
    if(!weeks[localISO(cursor)])break;
    streak++;
    cursor.setDate(cursor.getDate()-7);
  }
  return streak;
}
function getWS(){var m=getMon(new Date());m.setDate(m.getDate()+weekOffset*7);return m;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
// Run "feel" used to be stored with a leading emoji (e.g. "💪 Feeling Strong").
// Values are plain text now, so strip any leading glyph off legacy drafts and
// synced records before comparing or displaying them.
function stripFeelGlyph(s){return String(s==null?'':s).replace(/^[^A-Za-z]+/,'').trim();}

// ── LEGACY PROFILE FIELD HELPERS ──────────────────────────────────────────────
// The Notion API proxy (api/apiAll → /api/notion) was removed on 2026-07-20.
// These pure property readers remain only to safely no-op over empty objects
// when building an athlete profile from roster data.
function getNotionTitle(props){
  for(var k in props){var p=props[k];if(p&&p.type==='title'&&p.title&&p.title.length){var t=p.title.map(function(x){return x.plain_text||'';}).join('');if(t.trim())return t.trim();}}
  var explicit=props['Name']||props['name'];
  if(explicit&&explicit.title&&explicit.title.length){return explicit.title.map(function(x){return x.plain_text||'';}).join('').trim();}
  return '';
}
function getRichText(prop){if(!prop)return '';return(prop.rich_text||[]).map(function(t){return t.plain_text||'';}).join('');}
function getSelect(prop){if(!prop)return '';return(prop.select&&prop.select.name)||(prop.status&&prop.status.name)||'';}
function getMultiSelect(prop){if(!prop||!prop.multi_select)return '';return(prop.multi_select||[]).map(function(t){return t.name||'';}).filter(Boolean).join(', ');}
function getFormulaString(prop){if(!prop||!prop.formula)return '';var f=prop.formula;return f.string||String(f.number||f.boolean||'');}
function getRollupText(prop){if(!prop||!prop.rollup)return '';var r=prop.rollup;if(r.type==='array')return(r.array||[]).map(function(x){return getPropText(x);}).filter(Boolean).join(', ');if(r.type==='number')return String(r.number||'');if(r.type==='date'&&r.date&&r.date.start)return r.date.start;return '';}
function getPropText(prop){
  if(!prop) return '';
  if(prop.type==='title') return(prop.title||[]).map(function(t){return t.plain_text||'';}).join('').trim();
  if(prop.type==='rich_text') return getRichText(prop).trim();
  if(prop.type==='select'||prop.type==='status') return getSelect(prop).trim();
  if(prop.type==='multi_select') return getMultiSelect(prop).trim();
  if(prop.type==='number') return prop.number!=null?String(prop.number):'';
  if(prop.type==='date') return prop.date&&prop.date.start?prop.date.start:'';
  if(prop.type==='formula') return getFormulaString(prop).trim();
  if(prop.type==='rollup') return getRollupText(prop).trim();
  return '';
}
function getRelationIds(prop){return prop&&prop.relation?(prop.relation||[]).map(function(r){return r.id;}).filter(Boolean):[];}

// Core programme/photo helpers are needed by the home nudges and check-in.
// Keeping them here lets the heavier Progress renderer load only when opened.
//
// Athletes who started straight on Week 1, before the discovery week existed.
// Closed set — everyone onboarded since goes through a Week 0 — and it mirrors
// NO_DISCOVERY in the coaches dashboard, which decides the week number the
// coach sees. The two must agree or the portal reads a week ahead.
var NO_DISCOVERY_CODES=['JACOB','KHANG'];
function athleteSkipsDiscoveryWeek(){
  return NO_DISCOVERY_CODES.indexOf(String((typeof athlete!=='undefined'&&athlete&&athlete.code)||'').toUpperCase())>=0;
}
function getCurrentProgrammeWeek(){
  var wkS=sessions.find(function(s){return s.week;});
  if(wkS){
    // 'Discovery Week' carries no digit. Falling through to the date maths on
    // that label is what let the nutrition week label sit a week away from the
    // training one for the same athlete on the same day.
    if(typeof isDiscoveryWeek==='function'&&isDiscoveryWeek(wkS.week))return 0;
    var m=wkS.week.match(/\d+/);if(m)return parseInt(m[0]);
  }
  if(athlete.startDate&&athlete.startDate!=='—'){
    var start=localDateFromISO(athlete.startDate);
    var now=new Date();
    var today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    // Whole local days, rounded, so the 23 and 25 hour days either side of a
    // daylight saving change still count as one day each. Measuring raw
    // milliseconds put the week boundary an hour out every October.
    var days=Math.round((today-start)/(24*60*60*1000));
    // Day 0 is the discovery week (Week 0), matching the dashboard. The legacy
    // codes above started on Week 1, so for them day 0 is week 1.
    var skip=athleteSkipsDiscoveryWeek();
    var floor=skip?1:0;
    return Math.max(floor,Math.min(programmeWeeks,Math.floor(days/7)+(skip?1:0)));
  }
  return 1;
}
function getPhotos(){return JSON.parse(localStorage.getItem('dp_photos_'+athlete.code)||'{}');}

let runLibraryById={},runLibraryByName={};
// fetchRunLibrary is now a no-op — loadRunningLibrary populates all the same data
// (runLibraryById, runLibraryByName, RUNNING_LIBRARY_BY_ID) in a single RUN_DB query.
async function fetchRunLibrary(){
  // Data already populated by loadRunningLibrary via Promise.all in loadWeek
}

// ── SESSION TYPE ──────────────────────────────────────────────────────────────
function normaliseExerciseName(exerciseName){
  return canonicalExerciseName(exerciseName).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function canonicalExerciseName(exerciseName){
  var displayName=String(exerciseName||'').trim();
  var normalised=displayName.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  // The generic Bulgarian option has always been performed with dumbbells.
  // Fold both historic dumbbell labels into that one choice, while keeping the
  // barbell setup separate because its loading and progression are different.
  if(normalised==='dumbbell split squat'||normalised==='dumbbell bulgarian split squat')return 'Bulgarian Split Squat';
  return displayName;
}
// Exercise names come from both the built-in swap bank and coach-managed
// Supabase splits. Keep the obvious per-side cases here so a newly added
// unilateral option gets Left / Right inputs even before its split metadata is
// updated. Explicit metadata still wins for movements whose setup is ambiguous.
var LEFT_RIGHT_REP_RULES=[
  /\b(?:single|one) (?:leg|arm|side|limb)\b/,
  /\biso lateral\b/,
  /\bunilateral\b/,
  /\bsplit squat\b/,
  /\blunges?\b/,
  /\bstep (?:up|down)\b/,
  /\bkickbacks?\b/,
  /\bcopenhagen plank\b/,
  /^(?:one arm |single arm )?dumbbell row$/,
  /\bcable (?:hip (?:abduction|adduction|flexion)|adduction|lateral raise|woodchop)\b/,
  /\b(?:standing cable|banded standing) knee drive\b/,
  /\b(?:weighted standing|single leg) knee raise\b/,
  /\bside lying (?:leg|adduction) raise\b/,
  /\bpallof press\b/,
  /\bside plank\b/
];
function usesLeftRightReps(exerciseName,prescription){
  var normalised=normaliseExerciseName(exerciseName);
  var tagged=prescription&&Array.isArray(prescription.leftRightExercises)?prescription.leftRightExercises:
    (prescription&&Array.isArray(prescription.left_right_exercises)?prescription.left_right_exercises:[]);
  if(tagged.some(function(name){return normaliseExerciseName(name)===normalised;}))return true;
  var prescribedName=normaliseExerciseName(prescription&&prescription.exercise);
  var explicitMode=prescription&&(prescription.repMode||prescription.rep_mode);
  if(prescribedName===normalised&&explicitMode==='left_right')return true;
  // Coaches can force an ambiguous movement (for example a two-arm machine
  // variant with "iso-lateral" in its product name) back to a single reps box.
  if(prescribedName===normalised&&explicitMode==='reps')return false;
  // Backward-compatible fallback for older split data and athlete-specific
  // variants that have not yet received explicit Supabase rep-mode metadata.
  return LEFT_RIGHT_REP_RULES.some(function(rule){return rule.test(normalised);});
}
function getType(s){
  var t=(s.sessionType||'').toLowerCase(),n=(s.name||'').toLowerCase();
  if(t==='note'||t==='notes'||t==='general'||t==='discovery'||t==='custom')return 'note';
  // A coach-built strength session carries its own exercises, so it no longer
  // has to be named after one of the four legacy splits to be recognised.
  // Sessions that also carry run steps stay run-led, as they do today.
  if(sessionHasPrescription(s)&&!sessionRunSteps(s))return 'strength';
  if(t==='strength'||GYM_KEYS.some(function(k){return n.indexOf(k.toLowerCase())>=0;}))return 'strength';
  if(t==='rest'||n==='rest')return 'rest';
  return 'run';
}
function sortSessionsForDisplay(list){
  var order={run:0,strength:1,rest:2};
  return(list||[]).slice().sort(function(a,b){
    var ao=order[getType(a)]!=null?order[getType(a)]:9;
    var bo=order[getType(b)]!=null?order[getType(b)]:9;
    if(ao!==bo) return ao-bo;
    return String(a.name||'').localeCompare(String(b.name||''));
  });
}


// Shared UI teardown for both explicit logout and a lost email session.
// preserveEmail=true keeps the remembered email/method so the recovery path
// ("send a new code") is one tap; explicit logout clears everything.
function logoutToLogin(preserveEmail){
  if(typeof invalidateProgrammeVolume==='function')invalidateProgrammeVolume();
  window._trainingReadSnapshot=null;
  localStorage.removeItem('dp_auth_code');
  localStorage.removeItem('dp_legacy_session');
  removePortalOfflineState('dp_auth_token');
  removePortalOfflineState('dp_auth_athlete_code');
  if(!preserveEmail){
    try{localStorage.removeItem('dp_auth_method');localStorage.removeItem('dp_auth_email');}catch(e){}
  }
  if(athlete&&athlete.code){try{localStorage.removeItem('dp_profile_'+athlete.code);}catch(e){}}
  athlete=null;sessions=[];allSessions=[];ticked={};logs={};exPicks={};
  document.getElementById('portalScreen').style.display='none';
  document.getElementById('quicklogStrip').style.display='none';
  document.getElementById('codeInput').value='';
  clearLoginError();
  renderCode();
  if(typeof showPrimaryLogin==='function')showPrimaryLogin();
  document.getElementById('loginScreen').style.display='block';
}
function logout(){
  logoutToLogin(false);
  authSignOut(); // ends the Supabase session too (no-op for legacy code logins)
}

// ── Personalisation ─────────────────────────────────────────────────────────
// The hero greets the athlete by first name and time of day. Deliberately
// driven from a render pass that owns the current date rather than from
// doLogin: a session left open overnight would otherwise keep saying
// "Evening" until the athlete signed in again. Display only — the name comes
// from the Supabase roster (athletes.name), which the coach dashboard owns.
function dpFirstName(full){
  var name=String(full||'').trim();
  if(!name) return '';
  return name.split(/\s+/)[0];
}
function dpGreetingWord(when){
  var hour=(when||new Date()).getHours();
  if(hour<12) return 'Morning';
  if(hour<17) return 'Afternoon';
  return 'Evening';
}
function dpGreetingDate(when){
  // en-AU renders "Fri, 4 Sep"; the engraved label drops the comma.
  try{
    return (when||new Date()).toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'}).replace(',','');
  }catch(e){return '';}
}
function renderHeroGreeting(){
  var el=document.querySelector('.hero-main .hi');
  var first=dpFirstName(typeof athlete!=='undefined'&&athlete&&athlete.name);
  var now=new Date(),date=dpGreetingDate(now);
  if(el) el.textContent=first?(dpGreetingWord(now)+', '+first+(date?' · '+date:'')):'Training Portal';
  // The header carries the athlete's full name above the section label — the
  // hero itself now leads with today's session, so the name lives here.
  var kicker=document.querySelector('.portal-context-kicker');
  var full=String((typeof athlete!=='undefined'&&athlete&&athlete.name)||'').trim();
  if(kicker&&full) kicker.textContent=full;
}
// Re-render on resume so the greeting and date follow real time, not session age.
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible') try{renderHeroGreeting();}catch(e){}
});
