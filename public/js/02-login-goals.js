// ── LOGIN ─────────────────────────────────────────────────────────────────────
function login(){
  var c=sanitizeCode((document.getElementById('codeInput').value||'').trim());
  if(!c){showLoginError('Enter your access code');return;}
  manualLoginIntent=true;
  doLogin(c);
}
// Authenticate through the server. Email sessions are resolved from their JWT;
// access-code sessions exchange the code for a short-lived signed portal token.
async function validateRosterCode(code){
  try{
    var options={cache:'no-store'};
    if(_authToken){
      options.headers=authHeaders({});
    }else{
      options.method='POST';
      options.headers={'Content-Type':'application/json'};
      options.body=JSON.stringify({action:'legacy-login',code:code});
    }
    var r=await fetch('/api/auth-athlete',options);
    var result={};try{result=await r.json();}catch(e){}
    if(r.status===403)return {exists:true,active:false,name:result.name||''};
    if(!r.ok)return null;
    if(result.code&&String(result.code).toUpperCase()!==String(code).toUpperCase())return null;
    if(result.access_token){
      _authToken=result.access_token;
      localStorage.setItem('dp_legacy_session',_authToken);
      localStorage.setItem('dp_auth_method','code');
    }
    return result;
  }catch(e){return null;}
}
function showPausedScreen(name){
  var el=document.getElementById('pausedScreen');if(!el)return;
  var n=document.getElementById('pausedName');
  if(n) n.textContent=name?('Hey '+String(name).split(' ')[0]+' —'):'Hey —';
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('portalScreen').style.display='none';
  var strip=document.getElementById('quicklogStrip');if(strip) strip.style.display='none';
  el.style.display='flex';
}
function pausedBackToLogin(){
  localStorage.removeItem('dp_auth_code');
  var el=document.getElementById('pausedScreen');if(el) el.style.display='none';
  document.getElementById('loginScreen').style.display='block';
  var inp=document.getElementById('codeInput');if(inp) inp.value='';
  renderCode();
}
function buildAthleteProfile(p,code,roster){
  var props=p?(p.properties||{}):{};
  var name=(roster&&roster.name)||(p?getNotionTitle(props):'')||'Athlete'; // roster name first — dashboard is the source of truth
  return {id:p?p.id:null,notionPageId:p?p.id:null,name:name,code:code,
    goalRace:getSelect(props['Goal Race'])||getRichText(props['Goal Race'])||(roster&&roster.race_target)||'',
    peakWeek:(props['Weekly KM Target']&&props['Weekly KM Target'].number!=null?String(props['Weekly KM Target'].number):'')||getRichText(props['Weekly KM Target'])||'',
    weight:getRichText(props['Body Weight (kg)'])||'',startWeight:getRichText(props['Starting Weight'])||getRichText(props['Body Weight (kg)'])||'',bodyFat:getRichText(props['Body Fat %'])||'',
    time5k:getRichText(props['5km Time'])||'',time10k:getRichText(props['10km Time'])||'',
    timeHalf:getRichText(props['Half Marathon Time'])||'',timeMarathon:getRichText(props['Marathon Time'])||'',
    lrPace:getRichText(props['Long Run Pace'])||'',
    why:getRichText(props['Your Why'])||'',m4:getRichText(props['Milestone W4'])||'',
    m8:getRichText(props['Milestone W8'])||'',m12:getRichText(props['Milestone W12'])||'',
    targetWeight:getRichText(props['Target Weight'])||'—',
    startDate:(props['Start Date']&&props['Start Date'].date&&props['Start Date'].date.start)||(roster&&roster.start_date)||'—',
    checkinUrl:getRichText(props['Check-in URL'])||'CHECKIN_URL',whatsapp:getRichText(props['WhatsApp'])||''
  };
}
// Profile is built from the Supabase roster. The legacy Notion profile read was
// removed on 2026-07-20; goal/profile detail loads separately from athlete_data.
async function fetchAthleteProfile(code,roster){
  if(!(roster&&roster.exists)) return null;
  return buildAthleteProfile(null,code,roster);
}
function saveProfileCache(code,profile){try{localStorage.setItem('dp_profile_'+code,JSON.stringify(profile));}catch(e){}}
async function hydratePortalData(code){
  try{
    var bootstrap=await portalRequest('bootstrap');
    // Preserve the established hydration order: compatibility state first,
    // then canonical structured body rows. This keeps cloud/local precedence
    // identical while removing two browser/server round trips.
    await loadCloudData(code,bootstrap.state);
    await loadStructuredBodyData(code,bootstrap.bodyLogs);
    await loadSessionLogs(bootstrap.sessionLogs);
    return;
  }catch(e){
    console.warn('Combined portal bootstrap failed; using compatibility reads',e);
  }
  // Safe rollout/failure path: older deployments and transient bootstrap
  // failures retain the exact request sequence used before this optimisation.
  await Promise.all([(async function(){await loadCloudData(code);await loadStructuredBodyData(code);})(),loadSessionLogs()]);
}
function hydrateLocalPortalState(code){
  ticked=JSON.parse(localStorage.getItem('dp_ticked_'+code)||'{}');
  logs=JSON.parse(localStorage.getItem('dp_logs_'+code)||'{}');
  stravaMatchRejections=JSON.parse(localStorage.getItem('dp_strava_match_rejections_'+code)||'{}');
  exPicks=JSON.parse(localStorage.getItem('dp_ex_picks_'+code)||'{}');
}
async function doLogin(code,prevalidatedRoster){
  var btn=document.getElementById('loginBtn')||document.querySelector('.lbtn');
  btn.textContent='Authenticating...';btn.disabled=true;btn.classList.add('loading');
  clearLoginError();
  function resetBtn(){btn.textContent='Enter Portal';btn.disabled=false;btn.classList.remove('loading');}
  var showWelcome=manualLoginIntent;
  manualLoginIntent=false;
  var roster=prevalidatedRoster||await validateRosterCode(code);
  if(!roster){resetBtn();showLoginError('Access code not recognised or your session has expired');renderCode();return;}
  if(roster.active===false){resetBtn();showPausedScreen(roster.name);return;}
  var fresh=await fetchAthleteProfile(code,roster);
  if(!fresh){resetBtn();showLoginError('Unable to load your athlete profile');renderCode();return;}
  if(showWelcome)showLoginSuccess(fresh.name);
  athlete=fresh;saveProfileCache(code,fresh);
  resetBtn();
  localStorage.setItem('dp_auth_code',code);
  // Supabase remains the identity provider for email OTP only; portal data
  // always flows through the authenticated server gateway.
  if(localStorage.getItem('dp_auth_method')==='email')await ensureSupabaseClient();
  // Render from device state immediately. Cloud history is reconciled below in
  // parallel with the current-week request instead of blocking portal entry.
  hydrateLocalPortalState(code);
  hideLoginSuccess();
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('portalScreen').style.display='block';
  // Coaches authenticate with an athlete access code; clients use email OTP.
  // Keep sign-out available to coaches inside Contact without exposing it in
  // the athlete experience.
  var coachLogout=document.getElementById('coachLogoutBtn');
  if(coachLogout)coachLogout.style.display=localStorage.getItem('dp_auth_method')==='code'?'flex':'none';
  document.getElementById('quicklogStrip').style.display='flex';
  try{syncQuickLogDock();}catch(e){}
  document.getElementById('heroName').textContent=athlete.name;
  populateStatic();
  // The primary plan gets the network first. Strava, nutrition and programme
  // metrics start only after today's session has rendered; they update their
  // existing mounts asynchronously and never gate portal entry.
  window._portalSecondaryStarted=false;
  var hydrationPromise=hydratePortalData(code).then(function(){
    hydrateLocalPortalState(code);
    if(typeof renderBookingPrompts==='function')renderBookingPrompts();
    initCheckinNudge();
  }).catch(function(e){console.warn('Background portal hydration failed',e);});
  var initialWeekPromise=Promise.resolve(loadWeek());
  initialWeekPromise.finally(function(){
    window._portalSecondaryStarted=true;
    window._stravaLoadPromise=window.initStrava ? window.initStrava(athlete.code) : Promise.resolve({connected:false,activities:[]});
    window._stravaLoadPromise.then(function(){
      if(typeof refreshStravaSessionMatches==='function')refreshStravaSessionMatches();
    }).catch(function(){});
    loadNutrition();
    if(typeof refreshRunningLibraryRevision==='function')setTimeout(refreshRunningLibraryRevision,0);
    // Writes, booking repair and push setup are important but must not compete
    // with the first current-week response on a cold connection.
    setTimeout(function(){
      retryPendingCoachWrites(true);
      initCallNudge();
      syncPushSubscription();
    },0);
  });
  // A persisted week paints immediately. Refresh it without clearing the
  // visible cards; on a cold start loadWeek already performs the network read.
  var weekRefreshPromise=initialWeekPromise.then(function(){
    return window._trainingReadServedPersistent&&typeof refreshWeekInBackground==='function'
      ?refreshWeekInBackground():null;
  }).catch(function(){});
  // Once cloud state and the fresh plan have both settled, re-apply reschedules
  // and completion state using the in-memory snapshot. This is a local rerender,
  // not another request.
  Promise.allSettled([hydrationPromise,weekRefreshPromise]).then(function(){
    hydrateLocalPortalState(code);
    if(window._trainingReadSnapshot)loadWeek();
  });
  if(typeof renderBookingPrompts==='function')renderBookingPrompts();
  initCheckinNudge();
}

function populateStatic(){
  document.getElementById('goalName').textContent=athlete.name;
  var saved=JSON.parse(localStorage.getItem('dp_goals_'+athlete.code)||'{}');
  setRaceFromValue(saved.goalRace||athlete.goalRace||'');
  document.getElementById('gPeakWeek').value=saved.peakWeek||athlete.peakWeek||'';
  document.getElementById('gRaceDate').value=saved.raceDate||'';
  document.getElementById('gWeight').value=saved.startWeight||saved.weight||athlete.startWeight||athlete.weight||'';
  document.getElementById('gTargetWeight').value=saved.targetWeight||(athlete.targetWeight!=='—'?athlete.targetWeight:'')||'';
  document.getElementById('gBodyFat').value=saved.bodyFat||athlete.bodyFat||'';
  document.getElementById('g5k').value=saved.time5k||athlete.time5k||'';
  document.getElementById('g10k').value=saved.time10k||athlete.time10k||'';
  document.getElementById('gHalf').value=saved.timeHalf||athlete.timeHalf||'';
  document.getElementById('gMarathon').value=saved.timeMarathon||athlete.timeMarathon||'';
  document.getElementById('gLRPace').value=saved.lrPace||athlete.lrPace||'';
  document.getElementById('gWhy').value=saved.why||athlete.why||'';
  document.getElementById('gM4').value=saved.m4||athlete.m4||'';
  document.getElementById('gM8').value=saved.m8||athlete.m8||'';
  document.getElementById('gM12').value=saved.m12||athlete.m12||'';
  var goalsComplete=!!(saved.savedAt);
  var gBanner=document.getElementById('goalsBanner'),gDot=document.getElementById('goalsDot');
  if(gBanner) gBanner.style.display=goalsComplete?'none':'block';
  if(gDot) gDot.style.display=goalsComplete?'none':'inline-block';
  if(typeof syncWeekCardState==='function') syncWeekCardState();
  if(saved.savedAt){
    var d=new Date(saved.savedAt);
    document.getElementById('goalsSavedTime').textContent=d.toLocaleDateString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    document.getElementById('goalsSavedBadge').classList.add('show');
  }
  document.getElementById('commsStart').textContent=athlete.startDate;
  if(athlete.checkinUrl!=='CHECKIN_URL'){document.querySelectorAll('[href="CHECKIN_URL"]').forEach(function(el){el.href=athlete.checkinUrl;});}
}

function selectRace(btn){
  document.querySelectorAll('.race-opt').forEach(function(b){b.classList.remove('selected');});
  btn.classList.add('selected');
  document.getElementById('otherRaceField').style.display=btn.dataset.val==='Other'?'':'none';
  if(btn.dataset.val!=='Other') document.getElementById('gRaceOther').value='';
}
function setRaceFromValue(val){
  if(!val) return;var v=val.trim();
  var btns=document.querySelectorAll('.race-opt'),matched=false;
  btns.forEach(function(b){if(b.dataset.val.toLowerCase().replace(/\s/g,'')=== v.toLowerCase().replace(/\s/g,'')){b.classList.add('selected');matched=true;}else{b.classList.remove('selected');}});
  if(!matched&&v){btns.forEach(function(b){if(b.dataset.val==='Other') b.classList.add('selected');});document.getElementById('otherRaceField').style.display='';document.getElementById('gRaceOther').value=v;}
}

// ── EXERCISE PICKS (persisted per-exercise memory) ───────────────────────────
// Rebuild the header PB / e1RM / Vol stat block for one exercise slot from the
// chosen exercise's OWN history. Called when an athlete switches a variant so the
// stats never show a different exercise's records. (markInlinePbs refills Vol live.)
function refreshExerciseStat(i,ei,resolvedEx,ex){
  var statEl=document.getElementById('exstat_'+i+'_'+ei);if(!statEl) return;
  var s=sessions[i];if(!s) return;
  // Assistance is machine help, so conventional load/volume/e1RM records are
  // misleading for assisted dips and pull-ups.
  if(_isAssistedExercise(resolvedEx)){statEl.innerHTML='';return;}
  var stored=pbComputeStored(resolvedEx,s.id);
  var isSingleLeg=usesLeftRightReps(resolvedEx,ex);
  var sh='';
  if(stored.load) sh+='<div class="ex-stat ex-stat-pb"><svg class="icon"><use href="#i-trophy"/></svg> PB '+esc(pbRound1(pbNum(stored.load.weight)))+'kg</div>';
  if(!isSingleLeg&&stored.volume) sh+='<div class="ex-stat ex-stat-vol-pb"><svg class="icon"><use href="#i-trophy"/></svg> Vol PB '+esc(Math.round(stored.volume.value).toLocaleString())+'kg</div>';
  if(stored.e1rm) sh+='<div class="ex-stat ex-stat-e1rm">e1RM '+esc(pbRound1(stored.e1rm.value))+'kg</div>';
  if(!isSingleLeg) sh+='<div id="vol_'+i+'_'+ei+'" class="ex-stat ex-stat-vol">Vol 0kg</div>';
  statEl.innerHTML=sh;
}
function syncStrengthRepMode(i,ei,ex,resolvedEx,splitKey){
  var container=document.getElementById('sets_'+i+'_'+ei);if(!container)return;
  var wantsLeftRight=usesLeftRightReps(resolvedEx,ex);
  var hasLeftRight=!!container.querySelector('input[id^="rL_"]');
  var labels=container.previousElementSibling;
  var loadLabel=_isAssistedExercise(resolvedEx)?'Assist kg':'kg';
  if(wantsLeftRight===hasLeftRight){
    var loadHeading=labels&&labels.querySelectorAll('.slbl')[1];
    if(loadHeading)loadHeading.textContent=loadLabel;
    return;
  }
  if(labels){
    labels.className=wantsLeftRight?'slbls-single':'slbls';
    labels.innerHTML=wantsLeftRight
      ?'<div class="slbl"></div><div class="slbl">'+loadLabel+'</div><div class="slbl">Left</div><div class="slbl">Right</div><div class="slbl slbl-tick"><svg class="icon"><use href="#i-check"/></svg></div>'
      :'<div class="slbl"></div><div class="slbl">'+loadLabel+'</div><div class="slbl">reps</div><div class="slbl">RPE</div><div class="slbl slbl-tick"><svg class="icon"><use href="#i-check"/></svg></div>';
  }
  container.querySelectorAll('.setrow,.setrow-single').forEach(function(row){
    var match=String(row.id||'').match(/_(\d+)$/);if(!match)return;
    var si=parseInt(match[1],10),tick=row.querySelector('.st'),weight=row.querySelector('input[id^="w_"]');
    function wire(input,required){
      input.addEventListener('input',function(){draftGym(i,splitKey);});
      if(required)input.addEventListener('change',function(){autoCompleteStrengthSet(i,ei,si);});
    }
    if(wantsLeftRight){
      var reps=row.querySelector('input[id^="r_"]'),rpe=row.querySelector('input[id^="rpe_"]');
      var shared=reps?reps.value:'';
      if(rpe&&rpe.value)row.setAttribute('data-bilateral-rpe',rpe.value);
      var left=document.createElement('input');left.type='number';left.className='sin';left.id='rL_'+i+'_'+ei+'_'+si;left.placeholder='L';left.min='0';left.value=shared;wire(left,true);
      var right=document.createElement('input');right.type='number';right.className='sin';right.id='rR_'+i+'_'+ei+'_'+si;right.placeholder='R';right.min='0';right.value=shared;wire(right,true);
      if(reps)reps.remove();if(rpe)rpe.remove();
      row.insertBefore(left,tick);row.insertBefore(right,tick);
      row.classList.remove('setrow');row.classList.add('setrow-single');
    }else{
      var leftInput=row.querySelector('input[id^="rL_"]'),rightInput=row.querySelector('input[id^="rR_"]');
      var leftValue=leftInput?leftInput.value:'',rightValue=rightInput?rightInput.value:'';
      var leftNum=parseFloat(leftValue),rightNum=parseFloat(rightValue);
      var combined=!isNaN(leftNum)&&!isNaN(rightNum)?String(Math.min(leftNum,rightNum)):(leftValue||rightValue);
      var repsInput=document.createElement('input');repsInput.type='number';repsInput.className='sin';repsInput.id='r_'+i+'_'+ei+'_'+si;repsInput.placeholder='—';repsInput.min='0';repsInput.value=combined;wire(repsInput,true);
      var rpeInput=document.createElement('input');rpeInput.type='number';rpeInput.className='rpe-in';rpeInput.id='rpe_'+i+'_'+ei+'_'+si;rpeInput.placeholder='—';rpeInput.min='1';rpeInput.max='10';rpeInput.step='0.5';rpeInput.value=row.getAttribute('data-bilateral-rpe')||'';wire(rpeInput,true);
      if(leftInput)leftInput.remove();if(rightInput)rightInput.remove();
      row.insertBefore(repsInput,tick);row.insertBefore(rpeInput,tick);
      row.classList.remove('setrow-single');row.classList.add('setrow');
    }
  });
}
function pickEx(exName,chosen){
  exPicks[exName]=chosen;
  localStorage.setItem('dp_ex_picks_'+athlete.code,JSON.stringify(exPicks));
  portalStateWrite('ex_picks',exPicks).catch(function(){});
  var safeKey=exName.replace(/[^a-z0-9]/gi,'_');
  document.querySelectorAll('[data-pg="'+safeKey+'"]').forEach(function(p){
    p.classList.toggle('active',p.dataset.pv===chosen);
  });
  // Flag the "More options" button whenever the athlete lands on a swap from
  // the wider bank, so a card collapsed back down still shows it is off-plan.
  document.querySelectorAll('.exc').forEach(function(card){
    var pills=card.querySelectorAll('[data-pg="'+safeKey+'"]');
    if(!pills.length) return;
    var moreBtn=card.querySelector('.ex-pill-more');
    if(!moreBtn) return;
    var chosenIsExtra=!!card.querySelector('.ex-pill-alt[data-pg="'+safeKey+'"].active');
    moreBtn.classList.toggle('is-swapped',chosenIsExtra);
  });
  var nameEl=document.getElementById('exn_'+safeKey);
  if(nameEl) nameEl.textContent=chosen;
  // Re-pull the chosen variant's own history: PB / e1RM / Vol header + LAST/TARGET
  // pill + inline set badges all refresh to match, so stats stay per-exercise.
  var card=nameEl?nameEl.closest('.exc'):null;
  var setsEl=card?card.querySelector('[id^="sets_"]'):null;
  var m=setsEl?setsEl.id.match(/^sets_(\d+)_(\d+)$/):null;
  if(m){
    var i=+m[1],ei=+m[2],s=sessions[i];
    if(s){
      var splitKey=GYM_KEYS.find(function(k){return((s.name||'').indexOf(k)>=0);})||'Upper A';
      var ex=getSplit(splitKey)[ei]||null;
      syncStrengthRepMode(i,ei,ex,chosen,splitKey);
      refreshExerciseStat(i,ei,chosen,ex);
      // Recompute the overload decision for the chosen variant so the chip, why line,
      // ladder, tip, SUGGESTED pill and set placeholders all match this exercise's own
      // history instead of the one it was swapped from.
      try{repaintOverload(i,ei);}catch(e){}
      try{refreshStrengthFeedback(i,splitKey);}catch(e){}
      try{markInlinePbs(i,splitKey);}catch(e){}
      try{draftGym(i,splitKey);}catch(e){}
    }
  }
}

async function saveGoals(){
  var btn=document.getElementById('goalsSaveBtn');btn.textContent='Saving...';btn.disabled=true;
  var selectedRaceBtn=document.querySelector('.race-opt.selected');
  var raceVal=selectedRaceBtn?(selectedRaceBtn.dataset.val==='Other'?document.getElementById('gRaceOther').value.trim():selectedRaceBtn.dataset.val):'';
  var goals={goalRace:raceVal,peakWeek:document.getElementById('gPeakWeek').value.trim(),raceDate:document.getElementById('gRaceDate').value.trim(),
    startWeight:document.getElementById('gWeight').value.trim(),weight:document.getElementById('gWeight').value.trim(),targetWeight:document.getElementById('gTargetWeight').value.trim(),
    bodyFat:document.getElementById('gBodyFat').value.trim(),time5k:document.getElementById('g5k').value.trim(),
    time10k:document.getElementById('g10k').value.trim(),timeHalf:document.getElementById('gHalf').value.trim(),
    timeMarathon:document.getElementById('gMarathon').value.trim(),lrPace:document.getElementById('gLRPace').value.trim(),
    why:document.getElementById('gWhy').value.trim(),m4:document.getElementById('gM4').value.trim(),
    m8:document.getElementById('gM8').value.trim(),m12:document.getElementById('gM12').value.trim(),savedAt:new Date().toISOString()};
  localStorage.setItem('dp_goals_'+athlete.code,JSON.stringify(goals));
  try{await portalStateWrite('goals',goals);}catch(e){console.warn('Goals sync failed:',e);}
  athlete.startWeight=goals.startWeight||athlete.startWeight;
  var coachResult=await coachWrite(GOALS_WEBHOOK,Object.assign({type:'goals',athleteId:athlete.notionPageId,athleteName:athlete.name,athleteCode:athlete.code,submittedAt:goals.savedAt},goals));
  btn.textContent='Saved ✓';btn.classList.add('saved');
  var d=new Date(goals.savedAt);
  document.getElementById('goalsSavedTime').textContent=d.toLocaleDateString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  document.getElementById('goalsSavedBadge').classList.add('show');
  var gBanner=document.getElementById('goalsBanner'),gDot=document.getElementById('goalsDot');
  if(gBanner) gBanner.style.display='none';
  if(gDot) gDot.style.display='none';
  if(typeof syncWeekCardState==='function') syncWeekCardState();
  showToast(coachResult.queued?'Goals saved - coach dashboard sync pending':'Goals saved ✓');
  setTimeout(function(){btn.textContent='Save Goals';btn.classList.remove('saved');btn.disabled=false;},2500);
}
