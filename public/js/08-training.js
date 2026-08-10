// ── LOAD WEEK ─────────────────────────────────────────────────────────────────
function setDisplay(id,value){var el=document.getElementById(id);if(el)el.style.display=value;}
function strengthRpeEnabled(){try{return localStorage.getItem('dp_strength_rpe_enabled')!=='false';}catch(e){return true;}}
function updateStrengthRpeControls(){
  var enabled=strengthRpeEnabled();
  if(document.documentElement)document.documentElement.classList.toggle('strength-rpe-off',!enabled);
  document.querySelectorAll('[data-strength-rpe-toggle]').forEach(function(btn){
    btn.classList.toggle('is-on',enabled);btn.setAttribute('aria-pressed',enabled?'true':'false');
    var state=btn.querySelector('.rest-pref-state');if(state)state.textContent=enabled?'On':'Off';
  });
}
function toggleStrengthRpePreference(){
  var enabled=!strengthRpeEnabled();
  try{localStorage.setItem('dp_strength_rpe_enabled',enabled?'true':'false');}catch(e){}
  updateStrengthRpeControls();
  document.querySelectorAll('.exc').forEach(function(card){
    var wasComplete=card.classList.contains('exercise-complete');
    refreshStrengthExerciseState(card);
    if(strengthExerciseIsComplete(card))card.classList.remove('open');
    else if(wasComplete)card.classList.add('open');
  });
  if(typeof showToast==='function')showToast(enabled?'RPE column on':'RPE column off');
}
updateStrengthRpeControls();
var trainingMonthGridStart=null,trainingMonthGridEnd=null;
var TRAINING_READ_TTL=60*1000,TRAINING_PERSIST_TTL=24*60*60*1000,_trainingReadPromise=null;
function trainingReadCacheKey(startISO,endISO){
  return 'dp_training_week_v1_'+String((athlete&&athlete.code)||'').toUpperCase()+'_'+startISO+'_'+endISO;
}
function readPersistedTrainingSnapshot(startISO,endISO){
  try{
    var cached=JSON.parse(localStorage.getItem(trainingReadCacheKey(startISO,endISO))||'null');
    if(!cached||!cached.ts||!cached.bundle||(Date.now()-cached.ts)>TRAINING_PERSIST_TTL)return null;
    return cached;
  }catch(e){return null;}
}
function persistTrainingSnapshot(startISO,endISO,bundle){
  try{
    // session_library already has its own compact cache. Do not duplicate that
    // potentially large dataset inside the week snapshot.
    var compact={planned:bundle.planned||null,splits:bundle.splits||null,library:null,errors:bundle.errors||[]};
    localStorage.setItem(trainingReadCacheKey(startISO,endISO),JSON.stringify({ts:Date.now(),bundle:compact}));
  }catch(e){}
}
async function loadTrainingReadSnapshot(startISO,endISO,options){
  options=options||{};
  var cached=window._trainingReadSnapshot;
  var code=String((athlete&&athlete.code)||'').toUpperCase();
  if(!options.force&&cached&&cached.code===code&&cached.start===startISO&&cached.end===endISO&&cached.ts&&(Date.now()-cached.ts)<TRAINING_READ_TTL&&cached.bundle){
    window._trainingReadServedPersistent=cached.source==='persistent';
    return cached.bundle;
  }
  if(!options.force){
    var persisted=readPersistedTrainingSnapshot(startISO,endISO);
    if(persisted){
      window._trainingReadSnapshot={ts:Date.now(),code:code,start:startISO,end:endISO,bundle:persisted.bundle,
        plannedRows:persisted.bundle.planned&&Array.isArray(persisted.bundle.planned.rows)?persisted.bundle.planned.rows:null,
        nutritionRows:null,source:'persistent'};
      window._trainingReadServedPersistent=true;
      return persisted.bundle;
    }
  }
  if(_trainingReadPromise)return _trainingReadPromise;
  _trainingReadPromise=(async function(){
    var hasLibrary=typeof hydrateRunningLibraryCache==='function'&&hydrateRunningLibraryCache();
    var bundle=await portalRequest('training-read',{
      start:startISO,end:endISO,includeLibrary:!hasLibrary,
      libraryRevision:(typeof _runLibraryCacheRevision!=='undefined'&&_runLibraryCacheRevision)||''
    });
    window._trainingReadSnapshot={
      ts:Date.now(),code:code,start:startISO,end:endISO,bundle:bundle,
      plannedRows:bundle.planned&&Array.isArray(bundle.planned.rows)?bundle.planned.rows:null,
      nutritionRows:null,source:'network'
    };
    window._trainingReadServedPersistent=false;
    persistTrainingSnapshot(startISO,endISO,bundle);
    return bundle;
  })();
  try{return await _trainingReadPromise;}
  finally{_trainingReadPromise=null;}
}
async function refreshWeekInBackground(){
  var ws=getWS(),we=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+6);
  var startISO=localISO(ws),endISO=localISO(we);
  try{
    await loadTrainingReadSnapshot(startISO,endISO,{force:true});
    await loadWeek();
    return true;
  }catch(e){
    console.warn('Background week refresh failed; keeping cached plan',e);
    return false;
  }
}
function isMobileTrainingCalendar(){return !!(window.matchMedia&&window.matchMedia('(max-width:760px)').matches);}
function trainingWeekDisplayLabel(){
  var wkS=sessions.find(function(s){return s.week;});
  var raw=wkS&&wkS.week;
  if(isDiscoveryWeek(raw)) return 'Discovery Week';
  var match=String(raw||'').match(/\d+/);
  if(match) return 'Week '+parseInt(match[0],10);
  var fallback=getCurrentProgrammeWeek()+weekOffset;
  fallback=Math.max(0,Math.min(programmeWeeks,fallback));
  return isDiscoveryWeek(fallback)?'Discovery Week':'Week '+fallback;
}
async function loadWeek(){
  var ws=getWS(),we=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+6);
  var wsISO=localISO(ws),weISO=localISO(we);
  var mobileCalendar=isMobileTrainingCalendar(),fetchStart=ws,fetchEnd=we;
  var label=ws.toLocaleDateString('en-AU',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  document.getElementById('wlabel').textContent=label;
  setDisplay('loadingEl','block');
  setDisplay('weeklyLoadingEl','block');
  setDisplay('calEl','none');setDisplay('weeklyCalEl','none');setDisplay('noplanEl','none');setDisplay('weeklyNoplanEl','none');
  var _errEl=document.getElementById('loadErrEl');if(_errEl)_errEl.style.display='none';
  var _weeklyErrEl=document.getElementById('weeklyLoadErrEl');if(_weeklyErrEl)_weeklyErrEl.style.display='none';
  if(typeof applyTrainingView==='function')applyTrainingView();
  // One authenticated read snapshot replaces the previous library + splits +
  // plan requests. Every section retains its original loader as a fallback, so
  // a partial Supabase failure cannot hide an otherwise valid training plan.
  var results;
  try{
    var bundle=null;
    try{bundle=await loadTrainingReadSnapshot(localISO(fetchStart),localISO(fetchEnd));}
    catch(e){console.warn('Combined training read failed; using compatibility reads',e);}
    results=await Promise.all([
      loadRunningLibrary(bundle&&bundle.library),
      loadWorkoutSplits(bundle&&bundle.splits),
      loadPlannedSessions(localISO(fetchStart),localISO(fetchEnd),bundle&&bundle.planned)
    ]);
  }catch(e){console.warn('Week load failed',e);results=[null,null,null];}
  var mapped=results[2];
  setDisplay('loadingEl','none');
  setDisplay('weeklyLoadingEl','none');
  // null = the fetch FAILED (network/Supabase error) — very different from an
  // empty week ([]). Show a retryable error, never "No sessions this week".
  if(!mapped){showLoadError();return;}
  var reschedules={};try{reschedules=JSON.parse(localStorage.getItem('dp_reschedules_'+athlete.code)||'{}');}catch(e){}
  mapped.forEach(function(s){
    if(reschedules[s.id]){s.date=reschedules[s.id];s.rescheduled=s.date!==s.plannedDate;}
  });
  allSessions=mapped;
  sessions=allSessions.filter(function(s){return s.date&&s.date>=wsISO&&s.date<=weISO;});
  // Pin "this week" from the unpaged load so the volume strip's current-week
  // marker doesn't move when the athlete pages through weeks.
  if(weekOffset===0) _baseProgrammeWeek=getCurrentProgrammeWeek();
  if(weekOffset===0) initPhotoNudge();
  renderTodaySection();
  var wkS=sessions.find(function(s){return s.week;});
  var outputWeek=document.getElementById('heroOutputWeek');
  if(outputWeek) outputWeek.textContent=trainingWeekDisplayLabel();
  if(wkS){
    var _hl=document.querySelector('.hero-week-label');
    var _hn=document.getElementById('heroWeek');
    if(isDiscoveryWeek(wkS.week)){
      if(_hl) _hl.style.display='none';
      _hn.classList.add('discovery');
      _hn.textContent='Discovery Week';
    }else{
      if(_hl) _hl.style.display='';
      _hn.classList.remove('discovery');
      _hn.textContent=wkS.week;
    }
  }
  var runs=sessions.filter(function(s){return getType(s)==='run';});
  var lifts=sessions.filter(function(s){return getType(s)==='strength';});
  document.getElementById('ciRuns').textContent=runs.length;document.getElementById('ciLifts').textContent=lifts.length;
  updateSessionCounter();
  // On subsequent week changes refresh secondary metrics after the primary
  // calendar has yielded. The first load starts these from doLogin().
  if(window._portalSecondaryStarted)setTimeout(function(){loadNutrition();},0);
  if(!sessions.length&&!mobileCalendar){showNoplan();return;}
  setDisplay('noplanEl','none');setDisplay('weeklyNoplanEl','none');
  renderCal(ws);
}
function showNoplan(){
  setDisplay('noplanEl','block');setDisplay('weeklyNoplanEl','block');
  var tEl=document.getElementById('todayEl');if(tEl) tEl.style.display='none';
  setDisplay('calEl','none');setDisplay('weeklyCalEl','none');
}
function showLoadError(){
  ['trainingVolumeStrip','weeklyVolumeStrip'].forEach(function(id){
    var strip=document.getElementById(id);
    if(strip){strip.style.display='none';strip.innerHTML='';}
  });
  var el=document.getElementById('loadErrEl');if(el)el.style.display='block';
  var wel=document.getElementById('weeklyLoadErrEl');if(wel)wel.style.display='block';
  var tEl=document.getElementById('todayEl');if(tEl)tEl.style.display='none';
  setDisplay('noplanEl','none');setDisplay('weeklyNoplanEl','none');setDisplay('calEl','none');setDisplay('weeklyCalEl','none');
}

// ── RENDER CALENDAR ───────────────────────────────────────────────────────────
function renderCal(ws){
  var todayISO=localISO(new Date()),we=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+6);
  var mobileCalendar=isMobileTrainingCalendar();
  var runsThisWeek=sessions.filter(function(s){return getType(s)==='run';}).length;
  var strengthThisWeek=sessions.filter(function(s){return getType(s)==='strength';}).length;
  var weekLabel=ws.toLocaleDateString('en-AU',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  var weekTitle=ws.toLocaleDateString('en-AU',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  var programmeWeekLabel=trainingWeekDisplayLabel();
  var weekSummary=sessions.length+' session'+(sessions.length===1?'':'s');
  if(runsThisWeek)weekSummary+=' · '+runsThisWeek+' run'+(runsThisWeek===1?'':'s');
  if(strengthThisWeek)weekSummary+=' · '+strengthThisWeek+' gym';
  var html='<div class="week-plan-shell"><div class="week-plan-heading-copy"><div class="week-plan-kicker">Training week <span class="week-plan-number">'+esc(programmeWeekLabel)+'</span></div><div class="week-plan-title"><span class="week-plan-title-desktop">Built for the week ahead</span><span class="week-plan-title-mobile">'+esc(weekTitle)+'</span></div><div class="week-plan-subtitle"><span class="week-plan-subtitle-desktop">'+esc(weekLabel)+' · '+sessions.length+' session'+(sessions.length===1?'':'s')+' loaded</span><span class="week-plan-subtitle-mobile">'+esc(weekSummary)+'</span></div></div><div class="month-calendar-actions"><button type="button" onclick="shiftWeek(-1)" aria-label="Previous week"><svg class="icon"><use href="#i-chevron-left"/></svg></button><button type="button" class="month-today-btn" onclick="goToday()">Today</button><button type="button" onclick="shiftWeek(1)" aria-label="Next week"><svg class="icon"><use href="#i-chevron-right"/></svg></button></div><div class="week-plan-meta"><span>'+runsThisWeek+' run'+(runsThisWeek===1?'':'s')+'</span><span>'+strengthThisWeek+' strength</span></div></div>';
  // WEEK AT A GLANCE — bird's-eye strip: one tile per day, dots per session
  // type, tick when the day is fully logged. Tapping a tile jumps to that day.
  var sessionDone=function(s){return logHasRealData(logs[s.id])||s.status==='Completed'||ticked[s.id];};
  if(mobileCalendar){
    trainingMonthGridStart=ws;trainingMonthGridEnd=we;
    html+='<div class="mobile-week-agenda" role="grid" aria-label="'+esc(weekTitle)+' training week">';
    for(var mdi=0;mdi<7;mdi++){
      var cellDate=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+mdi),miso=localISO(cellDate),isToday=miso===todayISO;
      var rawDaySessions=allSessions.filter(function(s){return s.date===miso;}),hasRecoveryOnly=rawDaySessions.length>0&&rawDaySessions.every(isCalendarPlaceholder);
      var daySessions=sortSessionsForDisplay(rawDaySessions.filter(function(s){return !isCalendarPlaceholder(s);}));
      var dayDone=daySessions.length>0&&daySessions.every(sessionDone),dayMissed=daySessions.length>0&&miso<todayISO&&!dayDone,labels='';
      daySessions.forEach(function(s,si){
        // Only label an AM/PM double when there are exactly two sessions.
        // Three-plus sessions have no reliable time data, so show every card
        // without inventing a schedule order.
        var timing=daySessions.length===2?(si===0?'AM':'PM'):'';
        labels+='<span class="mobile-week-session '+getType(s)+(timing?' has-time':'')+(s.rescheduled?' rescheduled':'')+'">'+(timing?'<b class="mobile-week-time">'+timing+'</b>':'')+'<span><strong>'+esc(s.name||monthSessionLabel(s))+'</strong><small>'+esc(monthSessionDetail(s))+'</small></span>'+(calendarSessionIsKey(s)?'<i class="mobile-week-key" aria-label="Key session"><svg class="icon"><use href="#i-star-filled"/></svg></i>':'')+'</span>';
      });
      if(!daySessions.length)labels='<span class="mobile-week-rest">'+(hasRecoveryOnly?'Recovery day':'No session planned')+'</span>';
      var aria=cellDate.toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long'})+', '+(daySessions.length?(daySessions.length+' session'+(daySessions.length===1?'':'s')+': '+daySessions.map(function(s){return s.name||wgShortLabel(s);}).join(', ')):'no sessions');
      html+='<button type="button" role="gridcell" class="mobile-week-day'+(isToday?' today':'')+(daySessions.length?' has-sessions':'')+(daySessions.length>1?' multi-session':'')+(dayDone?' done':'')+(dayMissed?' missed':'')+'" data-date="'+miso+'"'+(isToday?' aria-current="date"':'')+' onclick="openDayPlanDate(\''+miso+'\',this)" aria-label="'+esc(aria)+'"><span class="mobile-week-date"><small>'+cellDate.toLocaleDateString('en-AU',{weekday:'short'})+'</small><strong>'+cellDate.getDate()+'</strong>'+(isToday?'<em>Today</em>':'')+'</span><span class="mobile-week-sessions">'+labels+'</span><span class="mobile-week-status">'+(dayDone?'<svg class="icon"><use href="#i-check"/></svg>':dayMissed?'!':'›')+'</span></button>';
    }
    html+='</div>';
  }else{
    html+='<div class="week-glance">';
    for(var gi=0;gi<7;gi++){
      var gd=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+gi);
      var giso=localISO(gd),gToday=giso===todayISO;
      var gs=sortSessionsForDisplay(sessions.filter(function(s){return s.date===giso;}));
      var real=gs.filter(function(s){return getType(s)!=='rest';});
      var allDone=real.length>0&&real.every(sessionDone);
      var labs='';
      if(!real.length){labs='<span class="wg-lab rest">Rest</span>';}
      else{
        real.slice(0,2).forEach(function(s){labs+='<span class="wg-lab '+getType(s)+'">'+esc(wgShortLabel(s))+'</span>';});
        if(real.length>2)labs+='<span class="wg-lab more">+'+(real.length-2)+'</span>';
      }
      html+='<button type="button" class="wg-day'+(gToday?' today':'')+(allDone?' done':'')+(real.length?' has-events':'')+'" data-day-index="'+gi+'" onclick="selectWeekDay('+gi+',this)" aria-label="'+DAYS[gi]+' '+gd.getDate()+', '+(real.length?(real.length+' session'+(real.length===1?'':'s')):'rest day')+'"><span class="wg-name">'+DAYS[gi]+'</span><span class="wg-date">'+gd.getDate()+'</span><span class="wg-labs">'+labs+'</span><span class="wg-done">'+(allDone?'<svg class="icon"><use href="#i-check"/></svg>':'')+'</span></button>';
    }
    html+='</div>';
    for(var di=0;di<7;di++){
      var d=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+di);
      var iso=localISO(d),isToday=iso===todayISO;
      var dayLabel=d.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
      var daySessions=sortSessionsForDisplay(sessions.filter(function(s){return s.date===iso;}));
      html+='<div class="dg" id="dg_'+di+'"><div class="dgh'+(isToday?' today':'')+'"><span class="dgname">'+DAYS[di]+'</span><span class="dgdate">'+dayLabel+'</span>'+(isToday?'<span class="todaybadge">Today</span>':'')+'</div>';
      if(!daySessions.length){html+='<div class="restday">Rest</div>';}
      else{daySessions.forEach(function(s){var i=sessions.indexOf(s);html+=buildCard(s,i);});}
      html+='</div>';
    }
  }
  // #calEl (Today's-Plan week list) and #weeklyCalEl (Weekly Plan) render the
  // same markup, which duplicates every sc_i/scb_i/tick_i id. On desktop BOTH
  // are in the DOM at once, so getElementById would resolve weekly clicks to the
  // hidden Today-side copy and nothing opens/logs. Desktop uses #weeklyCalEl for
  // the week and #todayEl for today, so leave #calEl empty there to keep ids
  // unique. Mobile is untouched: it uses #calEl and never shows #weeklyCalEl.
  var _isDesktopWk = window.matchMedia && window.matchMedia('(min-width:900px)').matches;
  var el=document.getElementById('calEl');if(el){el.innerHTML=_isDesktopWk?'':html;el.style.display='block';}
  var wel=document.getElementById('weeklyCalEl');if(wel){wel.innerHTML=html;wel.style.display='block';}
  renderTrainingVolumeStrips();
  if(typeof applyTrainingView==='function')applyTrainingView();
}
// ── WEEKLY PLAN KM TARGET ─────────────────────────────────────────────────────
// titleKmFromName() and safeKm() live in 05-handbook.js alongside the rest of
// the km helpers, so the strip, the chart and this card all parse identically.
// Planned distance for one run: coach override first, then the library's
// distance field. Ignores duration-style values ("45 min") and implausible
// parses so a bad field can't inflate the week's target.
function plannedRunKm(s){
  if(getType(s)!=='run') return 0;
  var ov=_sessionOverrides[s.id]||{};
  var resolved=resolveRunDisplay(s),meta=(resolved&&resolved.meta)||{};
  return safeKm((ov.distance_km!=null&&ov.distance_km!=='')?ov.distance_km:(meta.distance||''));
}
// Target = coach's weekly total if declared, else the sum of planned run
// distances in the loaded week. Completed follows the same source order as the
// home tracker: Strava → submitted logs → this device's drafts.
function computeWeeklyPlanKm(){
  var sum=0,declared=0;
  (sessions||[]).forEach(function(s){
    var name=String(s.name||'');
    if(String(s.sessionType||'')==='Weekly KM Total'||/km total/i.test(name)){
      var m=name.match(/(\d+(?:\.\d+)?)\s*km/i);
      if(m) declared=Math.max(declared,parseFloat(m[1]));
      return;
    }
    var d=plannedRunKm(s);
    if(!d) d=getType(s)==='run'?titleKmFromName(name):0;
    if(d>0) sum+=d;
  });
  var target=Math.round(Math.max(sum,declared)*10)/10;
  return target>0?target:null;
}
// Desktop reads the week from the Weekly Plan tab, mobile from the plan view
// inside Training. The full km target already lives on Home; Training keeps
// only the lighter programme-volume overview.
function renderTrainingVolumeStrips(){
  renderVolumeStrip('weeklyVolumeStrip','training');
  renderVolumeStrip('trainingVolumeStrip','training');
  if(typeof applyTrainingView==='function') applyTrainingView();
}
function selectWeekDay(di,trigger){
  if(isMobileTrainingCalendar()){
    var ws=getWS(),d=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+di);openDayPlanDate(localISO(d),trigger);return;
  }
  scrollToDay(di);
}
function scrollToDay(di){
  var el=document.getElementById('dg_'+di);
  if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
}
var dayPlanDateISO=null,dayPlanReturnFocus=null;
function ensureDayPlanOverlay(){
  var ov=document.getElementById('dayPlanOverlay');
  if(ov)return ov;
  ov=document.createElement('section');ov.id='dayPlanOverlay';ov.className='day-plan-overlay';ov.setAttribute('aria-hidden','true');ov.setAttribute('aria-labelledby','dayPlanTitle');
  ov.setAttribute('onclick','dayPlanBackdropClick(event)');
  ov.innerHTML='<div class="day-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="dayPlanTitle"><div class="day-plan-topbar"><div class="day-plan-pager"><button type="button" id="dayPlanPrev" onclick="shiftDayPlan(-1)" aria-label="Previous day"><svg class="icon"><use href="#i-chevron-left"/></svg></button><button type="button" id="dayPlanNext" onclick="shiftDayPlan(1)" aria-label="Next day"><svg class="icon"><use href="#i-chevron-right"/></svg></button></div><button type="button" class="day-plan-close" onclick="closeDayPlan()" aria-label="Close day plan">&times;</button></div><div class="day-plan-heading"><div class="day-plan-kicker" id="dayPlanDate"></div><h2 id="dayPlanTitle">Day plan</h2><div class="day-plan-meta" id="dayPlanMeta"></div></div><div class="day-plan-scroll" id="dayPlanContent"></div></div>';
  document.body.appendChild(ov);return ov;
}
function dayPlanBackdropClick(event){if(event&&event.target===event.currentTarget)closeDayPlan();}
function interactiveSessionIndex(s){
  var existing=sessions.findIndex(function(item){return item.id===s.id;});if(existing>-1)return existing;
  var allIndex=allSessions.findIndex(function(item){return item.id===s.id;}),index=-(allIndex+1||1);sessions[index]=s;return index;
}
function renderDayPlanDate(iso){
  var ov=ensureDayPlanOverlay(),d=localDateFromISO(iso);
  var daySessions=sortSessionsForDisplay(allSessions.filter(function(s){return s.date===iso&&!isCalendarPlaceholder(s);}));
  dayPlanDateISO=iso;
  document.getElementById('dayPlanDate').textContent=d.toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'});
  document.getElementById('dayPlanTitle').textContent=d.toLocaleDateString('en-AU',{weekday:'long'});
  document.getElementById('dayPlanMeta').textContent=daySessions.length?(daySessions.length+' session'+(daySessions.length===1?'':'s')+' planned'):'Recovery day';
  var content=document.getElementById('dayPlanContent'),html='';
  if(daySessions.length){
    daySessions.forEach(function(s){html+=buildCard(s,interactiveSessionIndex(s));});
  }else{
    html='<div class="day-plan-rest"><span class="day-plan-rest-mark">Rest</span><h3>Recovery is part of the plan.</h3><p>Keep the day easy, stay on top of nutrition and arrive ready for the next session.</p></div>';
  }
  content.innerHTML=html;
  daySessions.forEach(function(s){var body=document.getElementById('scb_'+interactiveSessionIndex(s));if(body)body.classList.add('open');});
  var prev=document.getElementById('dayPlanPrev'),next=document.getElementById('dayPlanNext');if(prev)prev.disabled=!!(trainingMonthGridStart&&d<=trainingMonthGridStart);if(next)next.disabled=!!(trainingMonthGridEnd&&d>=trainingMonthGridEnd);
  document.querySelectorAll('.month-day,.mobile-week-day').forEach(function(day){var selected=day.dataset.date===iso;day.classList.toggle('selected',selected);day.setAttribute('aria-pressed',selected?'true':'false');});
  content.scrollTop=0;return ov;
}
function openDayPlanDate(iso,trigger){
  dayPlanReturnFocus=trigger||document.activeElement;var ov=renderDayPlanDate(iso);
  document.body.classList.add('day-plan-open');ov.setAttribute('aria-hidden','false');void ov.offsetHeight;ov.classList.add('open');
  var close=ov.querySelector('.day-plan-close');if(close)setTimeout(function(){close.focus();},80);
}
function shiftDayPlan(delta){if(!dayPlanDateISO)return;var d=localDateFromISO(dayPlanDateISO);d.setDate(d.getDate()+(Number(delta)||0));renderDayPlanDate(localISO(d));}
function closeDayPlan(){
  var ov=document.getElementById('dayPlanOverlay');if(!ov)return;if(focusedSessionIndex!=null)closeFocusedSession();
  ov.classList.remove('open');ov.setAttribute('aria-hidden','true');document.body.classList.remove('day-plan-open');dayPlanDateISO=null;
  var content=document.getElementById('dayPlanContent');if(content)setTimeout(function(){if(!ov.classList.contains('open'))content.innerHTML='';},240);
  if(dayPlanReturnFocus&&typeof dayPlanReturnFocus.focus==='function')dayPlanReturnFocus.focus();dayPlanReturnFocus=null;
}
// Short label for the glance tiles: "Upper"/"Lower" for gym, the run flavour
// ("Tempo", "Long Run") for runs. Falls back to the generic type.
function monthSessionLabel(s){
  var type=getType(s),name=String(s.name||'').trim(),match;
  if(type==='strength'){
    match=name.match(/\b(upper|lower)\s*([a-z0-9]+)?/i);
    if(match)return match[1].charAt(0).toUpperCase()+match[1].slice(1).toLowerCase()+(match[2]?' '+match[2].toUpperCase():'');
  }
  return wgShortLabel(s)||name||'Session';
}
function isCalendarPlaceholder(s){
  var name=String((s&&s.name)||'').trim().toLowerCase(),type=getType(s||{});
  return type==='rest'||/^(free|free day|rest|rest day|open|open day|recovery day)$/.test(name);
}
function calendarRunDistance(s){
  if(getType(s)!=='run')return 0;
  var resolved=resolveRunDisplay(s),meta=resolved.meta||{},raw=meta.distance||((_sessionOverrides[s.id]||{}).distance_km)||'';
  var value=parseFloat(String(raw).replace(',','.'));return isNaN(value)?0:value;
}
function monthSessionDetail(s){
  var type=getType(s);
  if(type==='run'){
    var resolved=resolveRunDisplay(s),meta=resolved.meta||{},distance=meta.distance||'',duration=meta.duration||'',intensity=meta.intensity||s.intensity||'';
    if(distance)return String(distance).replace(/\s+/g,'');
    if(duration){var dur=String(duration);return /^\d+$/.test(dur)?dur+' min':dur;}
    if(intensity)return intensity;
    return 'Run session';
  }
  if(type==='strength'){
    var splitKey=GYM_KEYS.find(function(k){return String(s.name||'').toLowerCase().indexOf(String(k).toLowerCase())>=0;});
    var exercises=splitKey?getSplit(splitKey):[];
    return exercises.length?exercises.length+' exercises':(s.intensity||'Strength');
  }
  return s.intensity||'Optional';
}
function calendarSessionIsKey(s){
  if(getType(s)!=='run')return /\bkey\b/i.test(String(s.name||''));
  var text=(String(s.name||'')+' '+String(s.intensity||'')).toLowerCase();
  return /\bkey\b|tempo|threshold|interval|speed|track|race|long run|hill/.test(text)&&!/easy|recovery/.test(text);
}
function wgShortLabel(s){
  var t=getType(s),n=String(s.name||'').toLowerCase();
  if(t==='strength'){
    if(n.indexOf('upper')>-1)return 'Upper';
    if(n.indexOf('lower')>-1)return 'Lower';
    if(n.indexOf('full')>-1)return 'Full Body';
    if(n.indexOf('push')>-1)return 'Push';
    if(n.indexOf('pull')>-1)return 'Pull';
    if(n.indexOf('leg')>-1)return 'Legs';
    return 'Gym';
  }
  if(t==='run'){
    if(n.indexOf('long')>-1)return 'Long Run';
    if(n.indexOf('tempo')>-1)return 'Tempo';
    if(n.indexOf('interval')>-1||n.indexOf('speed')>-1||n.indexOf('track')>-1||n.indexOf('rep')>-1)return 'Speed';
    if(n.indexOf('hill')>-1)return 'Hills';
    if(n.indexOf('easy')>-1)return 'Easy Run';
    if(n.indexOf('recovery')>-1)return 'Recovery';
    if(n.indexOf('race')>-1||n.indexOf('parkrun')>-1)return 'Race';
    return 'Run';
  }
  if(t==='note')return 'Free';
  return '';
}

function logHasRealData(v){
  if(!v||typeof v!=='object') return false;
  return Object.entries(v).some(function(e){
    var k=e[0],val=e[1];
    if(k==='__savedAt') return false;
    if(Array.isArray(val)) return val.length>0; // gym: exercise -> sets[]
    if(val&&typeof val==='object') return Object.keys(val).length>0;
    return val!==''&&val!=null; // run: distance/pace/rpe/...
  });
}
function buildCard(s,i){
  var type=getType(s);
  var logged=logHasRealData(logs[s.id]);
  var done=logged||s.status==='Completed';
  var marked=!done&&!!ticked[s.id];
  var displayName=s.name||'Session';
  var metaLine='';
  if(type==='run'){
    var r=resolveRunDisplay(s);
    metaLine=buildRunSubtitle(s,r.meta||{},r.title||displayName);
    if(!metaLine){var mp=[];if(s.intensity) mp.push(s.intensity);if(s.week) mp.push(s.week);metaLine=mp.join(' · ');}
  }else{
    var meta=[];if(s.intensity) meta.push(s.intensity);if(s.week) meta.push(s.week);
    metaLine=meta.join(' · ');
  }
  var h='<div class="sc'+(done?' done':'')+(marked?' marked':'')+'" id="sc_'+i+'">';
  h+='<div class="sch" onclick="togS('+i+')">';
  h+='<div class="sdot dot-'+type+'"></div>';
  h+='<div class="sinfo"><div class="sname '+type+'">'+esc(displayName)+'</div>';
  if(metaLine) h+='<div class="smeta">'+esc(metaLine)+'</div>';
  h+='</div>';
  h+='<button class="reschedule-btn" title="Reschedule" aria-label="Reschedule '+esc(displayName)+'" onclick="event.stopPropagation();openReschedule('+i+')"><svg class="icon"><use href="#i-calendar"/></svg></button><input class="reschedule-input" id="reschedule_'+i+'" type="date" value="'+esc(s.date||'')+'" onchange="rescheduleSession('+i+',this.value)" />';
  h+='<button class="tick'+(done?' on':'')+(marked?' marked':'')+'" id="tick_'+i+'" aria-label="Mark '+esc(displayName)+' complete" aria-pressed="'+(done||marked?'true':'false')+'" onclick="event.stopPropagation();tickS('+i+')">';
  h+='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  h+='</button></div>';
  if(marked) h+='<div class="sc-nudge" id="nudge_'+i+'">Marked — tap to open &amp; log your data</div>';
  h+='<div class="scb" id="scb_'+i+'">';
  if(type==='run'&&typeof stravaMatchHtml==='function')h+=stravaMatchHtml(s,i,'session');
  h+=buildBody(s,i,type)+'</div></div>';
  return h;
}

function resolveRunDisplay(s){
  var related=null;
  if(s.runningLibraryIds&&s.runningLibraryIds.length){
    for(var li=0;li<s.runningLibraryIds.length;li++){
      if(RUNNING_LIBRARY_BY_ID[s.runningLibraryIds[li]]){related=RUNNING_LIBRARY_BY_ID[s.runningLibraryIds[li]];break;}
      if(runLibraryById[s.runningLibraryIds[li]]){related=runLibraryById[s.runningLibraryIds[li]];break;}
    }
  }
  if(!related&&s.runningSessionIds&&s.runningSessionIds.length){
    for(var ri=0;ri<s.runningSessionIds.length;ri++){
      if(runLibraryById[s.runningSessionIds[ri]]){related=runLibraryById[s.runningSessionIds[ri]];break;}
      if(RUNNING_LIBRARY_BY_ID[s.runningSessionIds[ri]]){related=RUNNING_LIBRARY_BY_ID[s.runningSessionIds[ri]];break;}
    }
  }

  var rsTitle=(related&&related.name)||s.runningSession||s.name||'';
  var rsDetail=(related&&related.description)||s.runDetails||'';
  var rs=null;
  var lookupKey=(rsTitle||(related&&related.name)||s.name||'').toLowerCase();

  if(related){
    rs={
      type:related.type||'',
      phase:related.phase||'',
      distance:related.distance||'',
      intensity:related.intensity||'',
      surface:related.surface||'',
      difficulty:related.difficulty||'',
      tags:related.tags||'',
      rpe:related.rpe||'',
      target:related.target||related.goal||'',
      targetPace:related.targetPace||'',
      duration:related.duration||'',
      warmUp:related.warmUp||related.warmup||'',
      coolDown:related.coolDown||related.cooldown||'',
      sessionGoal:related.sessionGoal||related.goal||'',
      recoveryType:related.recoveryType||related.recovery||'',
      description:related.description||'',
      alternative:related.alternative||''
    };
  }
  if(!rs&&lookupKey){rs=RUN[rsTitle]||runLibraryByName[lookupKey]||null;}
  if(!rs&&lookupKey){for(var k in RUN){if(lookupKey.indexOf(k.toLowerCase())>=0||k.toLowerCase().indexOf(lookupKey)>=0){rs=RUN[k];break;}}}
  // ── Coach override (Supabase session_overrides) ───────────────────────────
  var ov=_sessionOverrides[s.id]||null;
  if(ov){
    if(ov.name) rsTitle=ov.name;
    var ovParts=[];
    if(ov.intervals) ovParts.push(ov.intervals);
    if(ov.working_pace) ovParts.push('Working pace: '+ov.working_pace);
    if(ov.distance_km) ovParts.push('Distance: '+ov.distance_km+'km');
    if(ovParts.length) rsDetail=ovParts.join(' · ');
    if(!rs) rs={};
    if(ov.warm_up) rs.warmUp=ov.warm_up;
    if(ov.cool_down) rs.coolDown=ov.cool_down;
    if(ov.target_pace) rs.targetPace=ov.target_pace;
    if(ov.rest) rs.rest=ov.rest;
    if(ov.notes) rs.sessionGoal=ov.notes;
    if(ov.distance_km) rs.distance=ov.distance_km+'km';
    if(ovParts.length) rs.description=rsDetail;
  }
  return{related:related,title:rsTitle,detail:rsDetail,meta:rs};
}

// ── RPE + ALTERNATIVE WORKOUT HELPERS ─────────────────────────────────────────
// Provide sensible fallbacks when the Notion running library doesn't supply
// RPE or an alternative workout, so every running session card renders with
// the full layout (effort rating box + alternative workout box).
function inferRpeMeta(meta,sessionTitle){
  meta=meta||{};
  var presets={
    recovery:{value:'3/10 RPE',desc:'Very easy, purely for recovery and circulation'},
    easy:{value:'4/10 RPE',desc:'Conversational pace, easy breathing, recovery focus'},
    long:{value:'5/10 RPE',desc:'Steady sustainable effort for extended distance'},
    steady:{value:'6/10 RPE',desc:'Comfortable aerobic effort, able to talk in short sentences'},
    tempo:{value:'7/10 RPE',desc:'Comfortably hard, controlled breathing, sustainable effort'},
    threshold:{value:'8/10 RPE',desc:'Hard effort, controlled breathing, race pace intensity'},
    interval:{value:'8/10 RPE',desc:'Hard effort, controlled breathing, race pace intensity'},
    track:{value:'8/10 RPE',desc:'Hard effort, controlled breathing, race pace intensity'},
    speed:{value:'9/10 RPE',desc:'Very hard, short bursts near maximum effort'},
    sprint:{value:'9/10 RPE',desc:'Near-maximal effort, heavy breathing, full focus'},
    race:{value:'9/10 RPE',desc:'Race-day effort, sustained hard intensity'},
    hill:{value:'8/10 RPE',desc:'Hard effort on climbs, focus on form and power'},
    fartlek:{value:'7/10 RPE',desc:'Varied hard/easy bursts, play with pace'}
  };
  var title=String(sessionTitle||meta.name||'').toLowerCase();
  var intensity=String(meta.intensity||'').toLowerCase();
  var type=String(meta.type||'').toLowerCase();
  var haystack=title+' '+intensity+' '+type;
  var order=['recovery','interval','track','speed','sprint','threshold','tempo','fartlek','hill','race','long','steady','easy'];
  var pick=null;
  for(var oi=0;oi<order.length;oi++){
    if(haystack.indexOf(order[oi])>=0){pick=presets[order[oi]];break;}
  }
  if(!pick) pick=presets.steady;
  var rpe=String(meta.rpe||'').trim();
  if(rpe){
    var value=rpe;
    if(!/rpe/i.test(value)){
      if(value.indexOf('/')<0){
        var num=parseFloat(value);
        if(!isNaN(num)) value=num+'/10';
      }
      value=value+' RPE';
    }
    return{value:value,desc:pick.desc};
  }
  return{value:pick.value,desc:pick.desc};
}

function parseAlternative(meta,sessionTitle){
  meta=meta||{};
  var alt=String(meta.alternative||'').trim();
  // Derive a default alternative workout based on the session type so the
  // panel always renders — even if Notion doesn't supply one.
  var title=String(sessionTitle||meta.name||'').toLowerCase();
  var intensity=String(meta.intensity||'').toLowerCase();
  var haystack=title+' '+intensity;
  var defaults=[
    {match:['track','interval'],name:'Road Tempo Intervals',desc:'6×3min @ threshold pace with 90sec jog recovery. Use if no track access. Same intensity, different structure.'},
    {match:['speed','sprint'],name:'Hill Sprints',desc:'8×20sec hill sprints with full walk-back recovery. Equivalent power work without the track.'},
    {match:['tempo'],name:'Progression Run',desc:'Start easy, build to tempo pace in the final third. Same aerobic stimulus with smoother structure.'},
    {match:['threshold'],name:'Cruise Intervals',desc:'4×6min @ threshold with 2min jog recovery. Same lactate work, broken up for control.'},
    {match:['hill'],name:'Treadmill Incline Run',desc:'25min @ 4-6% incline, easy pace. Strength stimulus without outdoor hills.'},
    {match:['long'],name:'Split Long Run',desc:'Break into AM + PM runs of equal distance. Use if time is tight or legs feel flat.'},
    {match:['recovery'],name:'Walk + Mobility',desc:'30min brisk walk + 10min full-body mobility. Purely for circulation and recovery.'},
    {match:['easy'],name:'Cross-Train Session',desc:'30-40min easy bike, swim, or elliptical. Same aerobic work, zero impact.'},
    {match:['fartlek'],name:'Structured Fartlek',desc:'5min easy, then 8×(1min on / 1min off), 5min easy. Same stimulus with cleaner timing.'}
  ];
  var fallback=null;
  for(var di=0;di<defaults.length;di++){
    var d=defaults[di];
    for(var mi=0;mi<d.match.length;mi++){
      if(haystack.indexOf(d.match[mi])>=0){fallback=d;break;}
    }
    if(fallback) break;
  }
  if(!fallback) fallback={name:'Easy Substitute Run',desc:'30-40min easy run by feel. Use if the main session isn\'t possible today.'};

  if(!alt){return{title:fallback.name,description:fallback.desc};}

  // If alt text includes an explicit title (first line, or "Title: Description")
  var lineBreak=alt.indexOf('\n');
  if(lineBreak>0&&lineBreak<80){
    var first=alt.substring(0,lineBreak).trim().replace(/[:\-–—]+$/,'').trim();
    var rest=alt.substring(lineBreak+1).trim();
    if(first&&rest){return{title:first,description:rest};}
  }
  var colon=alt.indexOf(':');
  if(colon>0&&colon<50){
    var t=alt.substring(0,colon).trim();
    var r=alt.substring(colon+1).trim();
    if(t&&r&&t.split(/\s+/).length<=6){return{title:t,description:r};}
  }
  return{title:fallback.name,description:alt};
}

// ── INTERVAL REST TIME PARSER ──────────────────────────────────────────────────
// Rest times are coach-decided by this function based on session type/intensity.
// Priority: 1) Notion "Rep Rest" field (coach override), 2) this function's logic.
// Notion's Recovery Type / Recovery Time fields are NEVER used for rep rest.
function getIntervalRestInfo(meta, sessionTitle) {
  var title = String(sessionTitle || meta.name || '').toLowerCase();
  var intensity = String(meta.intensity || '').toLowerCase();
  var type = String(meta.type || '').toLowerCase();
  var description = String(meta.description || meta.target || '').toLowerCase();
  var haystack = title + ' ' + intensity + ' ' + type + ' ' + description;

  // Exclude continuous/easy/recovery sessions — no rep-based rest needed
  var isContinuous = /\beasy run\b|\blong run\b|\brecovery run\b|\brecovery\b|\beasy\b|\bcontinuous\b|\bsteady state\b/.test(type) ||
    /\beasy run\b|\blong run\b|\brecovery run\b/.test(title) ||
    intensity === 'aerobic' || intensity === 'easy';
  if (isContinuous) return null;

  // Exclude tempo/threshold runs that are continuous (no reps)
  var isContinuousTempo = /\btempo run\b|\bthreshold run\b|\bsteady tempo\b/.test(title) && !/[x×]|\brep\b|\brepeat/.test(haystack);
  if (isContinuousTempo) return null;

  // Must look like an interval/rep session
  var isInterval = /interval|track|repeat|\brep\b|speed|fartlek|hill sprint|hill rep|yasso|\d+\s*[x×]\s*\d|\d+\s*x\s*\d/.test(haystack);
  if (!isInterval) return null;

  // ── COACH LOGIC: decide rest time based on session type ──────────────────────
  var restTime, restType, restDesc, recoveryNote;

  if (/200\s*m|200m/.test(haystack)) {
    // 200m reps — near-maximal, full walk rest
    restTime = '60–90 sec'; restType = 'Walk Rest';
    restDesc = 'Walk back to the start line. Full recovery — these are near-maximal speed efforts.';
    recoveryNote = 'Short and sharp. Full rest is non-negotiable — rushing recovery kills quality.';

  } else if (/400\s*m|400m/.test(haystack)) {
    // 400m reps — VO2max, 60 sec walk rest
    restTime = '60 sec'; restType = 'Walk Rest';
    restDesc = 'Walk rest between each rep. Short and structured — this keeps the stimulus race-sharp.';
    recoveryNote = 'If pace drops >3 sec/lap by rep 5, add 15–20 sec to rest and hold pace — don\'t sacrifice quality for speed.';

  } else if (/800\s*m|800m/.test(haystack)) {
    // 800m reps — VO2max, jog/walk rest
    restTime = '2–3 min'; restType = 'Jog / Walk Rest';
    restDesc = 'Easy jog or brisk walk between reps. Aim to feel ~80% recovered before the next 800.';
    recoveryNote = 'Don\'t rush the recovery — these demand real effort and real rest.';

  } else if (/1\.6\s*km|1600\s*m/.test(haystack)) {
    // 1600m / mile reps
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. These are threshold-length efforts — you need proper recovery to hold pace.';
    recoveryNote = 'If pace drops >5 sec/km on a rep, the rest wasn\'t long enough.';

  } else if (/1\.5\s*k|1500\s*m/.test(haystack)) {
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. You should be breathing comfortably before the next one starts.';
    recoveryNote = 'Keep the jog very easy — legs should feel ready, not fatigued.';

  } else if (/1\s*km|1000\s*m/.test(haystack)) {
    // 1km reps — threshold/VO2max
    restTime = '90 sec – 2 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog recovery between each 1km rep. HR should drop noticeably before restarting.';
    recoveryNote = 'Consistent pacing across all reps is the goal — use the rest to make that happen.';

  } else if (/2\s*km|2000\s*m/.test(haystack)) {
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog or walk recovery. These are sustained efforts — give yourself enough time to reset.';
    recoveryNote = 'Aim for even splits across all reps.';

  } else if (/3\s*km|3000\s*m/.test(haystack)) {
    restTime = '3–4 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. Full aerobic recovery before the next effort.';
    recoveryNote = 'Quality over quantity — if pace slips >10 sec/km on a rep, cut it and rest more.';

  } else if (/yasso/.test(haystack)) {
    restTime = 'Equal to rep time'; restType = 'Easy Jog Rest';
    restDesc = 'Jog for the same duration as your 800m rep. Classic Yasso structure.';
    recoveryNote = 'E.g. if your 800m takes 4:00, jog for 4:00 before the next rep.';

  } else if (/hill rep|hill sprint/.test(haystack)) {
    restTime = 'Full walk-back'; restType = 'Walk Down Recovery';
    restDesc = 'Walk back down the hill completely. These are power reps — full recovery between each one.';
    recoveryNote = 'Don\'t jog back. The walk IS the rest. Rushing kills the next rep.';

  } else if (/fartlek/.test(haystack)) {
    restTime = 'Equal to work time'; restType = 'Easy Jog Recovery';
    restDesc = 'Match recovery to effort: 1 min hard = 1 min easy. Keep moving — no standing rest.';
    recoveryNote = 'Fartlek is about flow — never stop, just shift gears.';

  } else if (/cruise|tempo interval/.test(haystack)) {
    // Cruise intervals / tempo reps
    restTime = '60–90 sec'; restType = 'Easy Jog Rest';
    restDesc = 'Short jog recovery — these reps are at threshold, not race pace. The rest keeps lactate in check.';
    recoveryNote = 'You should feel controlled between reps, not destroyed.';

  } else if (/(\d+)\s*[x×]\s*(\d+)\s*min/.test(String(meta.description || sessionTitle || ''))) {
    // Timed reps e.g. 6×3min, 8×2min
    var minMatch = String(meta.description || sessionTitle || '').match(/(\d+)\s*[x×]\s*(\d+)\s*min/i);
    var repMins = minMatch ? parseInt(minMatch[2]) : 2;
    if (repMins <= 1) {
      restTime = '60 sec'; restType = 'Easy Jog Rest';
      restDesc = 'Short jog recovery between each 1min rep. Keep moving — these are aerobic surges.';
      recoveryNote = 'Match the intensity: hard 1min, easy 1min. Don\'t stop.';
    } else if (repMins <= 2) {
      restTime = '90 sec'; restType = 'Easy Jog Rest';
      restDesc = 'Easy jog recovery between each rep. Heart rate should come down before restarting.';
      recoveryNote = 'Aim for even pace across all reps. Slow down if needed — don\'t cut rest.';
    } else {
      restTime = '2 min'; restType = 'Easy Jog Rest';
      restDesc = 'Easy jog between longer reps. Give yourself time to reset — these are sustained efforts.';
      recoveryNote = 'Consistent splits are the goal. Add 30 sec rest if pace is falling off.';
    }

  } else {
    // Generic fallback
    restTime = '90 sec – 2 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. You should feel mostly recovered — controlled breathing — before each effort.';
    recoveryNote = 'Adjust rest up if needed. Consistent reps beat fast early, slow late.';
  }

  // ── NOTION OVERRIDE: "Rep Rest" field wins if coaches have set it ────────────
  // Add a "Rep Rest" property to the session in Notion to override the above.
  // E.g. "90 sec", "2 min jog", "3 min". Only this field is used — not Recovery Type.
  var notionRepRest = String(meta.repRest || '').trim();
  if (notionRepRest) {
    restTime = notionRepRest;
    restType = 'Coach-specified Rest';
    restDesc = 'Rest period as prescribed by your coaches. Stick to this — it\'s calibrated to your fitness and session load.';
    recoveryNote = 'Don\'t cut it short. Consistent reps across all efforts is the goal.';
  }

  return { restTime: restTime, restType: restType, restDesc: restDesc, recoveryNote: recoveryNote };
}

function buildRunSubtitle(s,meta,resolvedTitle){
  meta=meta||{};
  var parts=[];
  if(meta.distance) parts.push(meta.distance);
  else if(meta.target&&/\d/.test(meta.target)) parts.push(meta.target);
  if(meta.intensity) parts.push(meta.intensity);
  else if(s&&s.intensity) parts.push(s.intensity);
  if(meta.duration){
    var dur=String(meta.duration);
    if(/^\d+$/.test(dur)) dur=dur+'min';
    parts.push(dur);
  }
  // Dedupe while preserving order
  var seen={},out=[];
  parts.forEach(function(p){var k=String(p).toLowerCase();if(p&&!seen[k]){seen[k]=1;out.push(p);}});
  return out.join(' · ');
}

function calculateDailyReadiness(body){
  if(!body)return null;
  var sleep=parseFloat(body.sleep),energy=parseFloat(body.energy);
  var soreness=parseFloat(body.soreness),stress=parseFloat(body.stress);
  var vals=[];
  if(!isNaN(sleep))vals.push(sleep*10);
  if(!isNaN(energy))vals.push(energy*10);
  if(!isNaN(soreness))vals.push((11-soreness)*10);
  if(!isNaN(stress))vals.push((11-stress)*10);
  return vals.length?Math.round(vals.reduce(function(a,b){return a+b;},0)/vals.length):null;
}

function getHomeInsights(){
  var planned=sessions.filter(function(s){return getType(s)!=='rest';}).length;
  var completed=sessions.filter(function(s){return getType(s)!=='rest'&&(isSessionLogged(s.id)||logHasRealData(logs[s.id])||s.status==='Completed'||ticked[s.id]);}).length;
  var compliance=planned?Math.min(100,Math.round(completed/planned*100)):0;
  var readiness=null,body=null;
  try{body=JSON.parse(localStorage.getItem('dp_daily_body_'+athlete.code+'_'+localISO(new Date()))||'null');}catch(e){}
  var sleep=null,energy=null,soreness=null,stress=null;
  if(body){
    sleep=parseFloat(body.sleep);energy=parseFloat(body.energy);soreness=parseFloat(body.soreness);stress=parseFloat(body.stress);
    readiness=calculateDailyReadiness(body);
  }
  var exerciseNames={};
  Object.keys(logs||{}).forEach(function(id){var entry=logs[id];if(!entry||typeof entry!=='object'||Array.isArray(entry))return;Object.keys(entry).forEach(function(name){if(name.indexOf('__')!==0&&Array.isArray(entry[name]))exerciseNames[pbNormName(name)]=1;});});
  var weights=[];
  try{for(var i=0;i<localStorage.length;i++){var key=localStorage.key(i);if(key&&key.indexOf('dp_daily_body_'+athlete.code+'_')===0){var v=JSON.parse(localStorage.getItem(key)||'null');var w=v&&parseFloat(v.weight);if(!isNaN(w))weights.push({date:key.slice(-10),weight:w});}}}catch(e){}
  weights.sort(function(a,b){return a.date.localeCompare(b.date);});
  var now=localISO(new Date());
  var next=sortSessionsForDisplay(allSessions.filter(function(s){return s.date&&s.date>now&&getType(s)!=='rest';})).sort(function(a,b){return a.date.localeCompare(b.date);})[0]||null;
  var checkinDone=false;try{checkinDone=!!localStorage.getItem(checkinWeekKey());}catch(e){}
  var warning='';
  if(body){
    var pain=parseFloat(body.pain);
    if(!isNaN(pain)&&pain>=5)warning='Pain is '+pain+'/10'+(body.painLocation?' at '+body.painLocation:'')+'. Avoid pushing through it—your coaches have been flagged.';
    else if(!isNaN(soreness)&&soreness>=8)warning='High soreness today—consider reducing load and message your coaches if pain is localised.';
    else if(!isNaN(energy)&&energy<=3)warning='Energy is low today. Keep the session controlled and prioritise recovery.';
    else if(!isNaN(stress)&&stress>=8)warning='Stress is elevated. Use RPE rather than chasing numbers today.';
  }
  var kmTarget=currentWeekKmData&&Number(currentWeekKmData.target),kmDone=currentWeekKmData&&Number(currentWeekKmData.completed||0);
  return {planned:planned,completed:completed,compliance:compliance,readiness:readiness,pbs:Object.keys(exerciseNames).length,weights:weights.slice(-7),body:body,warning:warning,next:next,checkinDone:checkinDone,kmTarget:kmTarget||0,kmDone:kmDone||0};
}
function miniSparkline(points){
  if(!points||points.length<2)return '<span class="insight-empty">Log 2+ weigh-ins</span>';
  var vals=points.map(function(p){return p.weight;}),min=Math.min.apply(null,vals),max=Math.max.apply(null,vals),range=max-min||1;
  var coords=vals.map(function(v,i){return (i*(78/(vals.length-1))).toFixed(1)+','+(24-((v-min)/range)*18).toFixed(1);}).join(' ');
  var delta=vals[vals.length-1]-vals[0];
  return '<svg class="mini-spark" viewBox="0 0 80 28" role="img" aria-label="Recent bodyweight trend"><polyline points="'+coords+'"/></svg><span class="insight-delta">'+(delta>0?'+':'')+delta.toFixed(1)+'kg</span>';
}
function renderInsightRail(data){
  var readiness=data.readiness==null?'—':data.readiness;
  var readinessPct=data.readiness==null?0:data.readiness;
  var weightLabel='Open progress';
  if(data.weights&&data.weights.length>=2){
    var delta=data.weights[data.weights.length-1].weight-data.weights[0].weight;
    weightLabel=(delta>0?'+':'')+delta.toFixed(1)+'kg across recent logs';
  }
  return '<div class="insight-rail" aria-label="This week at a glance">'+
    '<button type="button" class="insight-card insight-card-button" onclick="openWeeklySummary()" aria-label="View weekly compliance summary"><div class="insight-ring" style="--value:'+data.compliance+'"><strong>'+data.compliance+'%</strong></div><div><span>Session completion</span><small>'+data.completed+' of '+data.planned+' planned done</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button" onclick="openQuickLog(\'body\')" aria-label="'+(data.readiness==null?'Log today’s readiness':'Review today’s readiness')+'"><div class="insight-ring readiness" style="--value:'+readinessPct+'"><strong>'+readiness+'</strong></div><div><span>Readiness</span><small>'+(data.readiness==null?'Log your body check':'Body log already captured')+'</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button bodyweight" onclick="switchTab(\'progress\')" aria-label="View bodyweight progress"><div class="insight-viz">'+miniSparkline(data.weights)+'</div><div><span>Bodyweight trend</span><small>'+esc(weightLabel)+'</small></div></button>'+
    '<button type="button" class="insight-card insight-card-button" onclick="openPbHistory()" aria-label="View personal best history"><div class="insight-pb"><svg class="icon"><use href="#i-trophy"/></svg><strong>'+data.pbs+'</strong></div><div><span>Personal bests</span><small>Review your strength history</small></div></button>'+
  '</div>';
}
function renderCommandStatus(data){
  var kmPct=data.kmTarget?Math.min(100,Math.round(data.kmDone/data.kmTarget*100)):0;
  var nextText='No upcoming session';
  if(data.next){var nd=localDateFromISO(data.next.date);nextText=nd.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})+' · '+(data.next.name||'Session');}
  var html='<div class="command-status-grid">';
  html+='<button class="command-status" onclick="switchTab(\'checkin\')"><span class="command-status-icon '+(data.checkinDone?'done':'')+'"><svg class="icon"><use href="#i-clipboard"/></svg></span><span><small>Check-in status</small><strong>'+(data.checkinDone?'Locked in for the week':'Still waiting on your check-in')+'</strong></span></button>';
  html+='<button class="command-status" onclick="switchTab(\'nutrition\')" aria-label="View weekly kilometre details"><span class="command-status-icon"><svg class="icon"><use href="#i-run"/></svg></span><span><small>Run volume</small><strong>'+(data.kmTarget?(data.kmDone.toFixed(1).replace(/\.0$/,'')+' / '+data.kmTarget.toFixed(1).replace(/\.0$/,'')+' km'):'Target loading')+'</strong><i><b style="width:'+kmPct+'%"></b></i></span></button>';
  html+='<button class="command-status next-session" onclick="goTrainingPlan()"><span class="command-status-icon"><svg class="icon"><use href="#i-calendar"/></svg></span><span><small>Next key session</small><strong>'+esc(nextText)+'</strong></span></button>';
  html+='</div>';
  if(data.warning)html+='<div class="recovery-warning"><svg class="icon"><use href="#i-pulse"/></svg><div><strong>Recovery flag</strong><span>'+esc(data.warning)+'</span></div><button onclick="openQuickLog(\'body\')">Review</button></div>';
  return html;
}
function sessionWhy(type,meta,title){
  var text=((meta&&((meta.intensity||'')+' '+(meta.type||'')+' '+(meta.description||'')))+' '+(title||'')).toLowerCase();
  if(/recovery|easy/.test(text))return 'Absorb the harder work, build aerobic volume and arrive fresher for the next key session.';
  if(/threshold|tempo/.test(text))return 'Raise the pace you can sustain comfortably so race effort feels more controlled.';
  if(/interval|vo2|hill|speed|fartlek/.test(text))return 'Develop speed, running economy and confidence when the pace starts to bite.';
  if(/long/.test(text))return 'Build endurance, fuelling confidence and the durability you need late in your goal event.';
  return 'Build the specific fitness your current programme phase needs while keeping the week balanced.';
}
function renderCoachMoment(todaySessions){
  var note='Keep today simple: hit the intended effort and leave enough in the tank to train well again.';
  for(var i=0;i<todaySessions.length;i++){var ov=_sessionOverrides[todaySessions[i].id];if(ov&&ov.notes){note=ov.notes;break;}}
  var label=todaySessions.length?'Coach cue for today':'Coach cue';
  return '<div class="coach-moment"><div class="coach-avatars"><span>K</span><span>A</span></div><div><div class="coach-moment-topline"><div class="coach-moment-label">'+label+'</div><div class="coach-moment-tag">Dual Performance</div></div><p>'+esc(note)+'</p></div><button onclick="switchTab(\'comms\')" aria-label="Contact your coaches"><svg class="icon"><use href="#i-chat"/></svg></button></div>';
}

function syncHeroShell(insights,todaySessions){
  var support=document.getElementById('heroSupport');
  if(support){
    if(todaySessions.length){
      var primary=(todaySessions[0]&&todaySessions[0].name)||'today\'s session';
      support.textContent='Today: '+primary+'. Open the brief and execute cleanly.';
    }else{
      support.textContent='Recovery day. Stay ahead of the week, lock in the admin that matters, and be ready for the next key session.';
    }
  }
  // Sessions reads as done/planned like distance and strength do, so the four
  // week metrics share one grammar instead of mixing a percentage in.
  var compliance=document.getElementById('heroStatCompliance');
  if(compliance){
    if(insights&&insights.planned){
      compliance.textContent='';
      compliance.appendChild(document.createTextNode(String(Number(insights.completed)||0)));
      var _cSmall=document.createElement('small');
      _cSmall.textContent='/'+(Number(insights.planned)||0);
      compliance.appendChild(_cSmall);
    }else{
      compliance.textContent='—';
    }
  }
  var complianceBar=document.getElementById('heroStatComplianceBar');
  if(complianceBar)complianceBar.style.width=((insights&&insights.compliance)||0)+'%';
  var complianceNote=document.getElementById('heroStatComplianceNote');
  if(complianceNote){
    complianceNote.textContent=insights&&insights.planned?(insights.completed>=insights.planned?'Week done':'Underway'):'None planned';
  }
  var complianceCard=document.getElementById('heroComplianceCard');
  if(complianceCard&&insights)complianceCard.setAttribute('aria-label','Open weekly completion summary. '+insights.completed+' of '+insights.planned+' planned sessions complete.');
  var readiness=document.getElementById('heroStatReadiness');
  if(readiness) readiness.textContent=(insights&&insights.readiness!=null)?String(insights.readiness):'—';
  var readinessPct=(insights&&insights.readiness!=null)?Math.max(0,Math.min(100,insights.readiness)):0;
  var readinessRing=document.getElementById('heroReadinessRing');
  if(readinessRing)readinessRing.style.setProperty('--value',readinessPct);
  var readinessNote=document.getElementById('heroStatReadinessNote');
  var readinessText=readinessPct>=80?'Ready to go':readinessPct>=65?'Good to train':readinessPct>=50?'Train with awareness':readinessPct>0?'Recovery first':'Log body check';
  if(readinessNote)readinessNote.textContent=readinessText;
  var readinessCard=document.getElementById('heroReadinessCard');
  if(readinessCard)readinessCard.setAttribute('aria-label',(readinessPct?'Review readiness '+readinessPct+' out of 100. ':'Log today’s readiness. ')+readinessText+'.');
  var pbs=document.getElementById('heroStatPbs');
  if(pbs) pbs.textContent=(insights&&insights.pbs!=null)?String(insights.pbs):'—';
  var pbsCard=document.getElementById('heroPbsCard');
  if(pbsCard&&insights)pbsCard.setAttribute('aria-label','Open all personal bests. '+insights.pbs+' exercises tracked.');
}

function renderTodaySection(){
  var el=document.getElementById('todayEl');if(!el) return;
  var todayISO=localISO(new Date());
  var todaySessions=sortSessionsForDisplay(allSessions.filter(function(s){return s.date===todayISO;}));
  var label=new Date().toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'});
  var insights=getHomeInsights();
  syncHeroShell(insights,todaySessions);
  var title=todaySessions.length?'Today\'s command center':'Recovery command center';
  var subtitle=todaySessions.length?'See the brief, execute cleanly, and log what you actually complete.':'No session scheduled today. Use the space to recover well and stay ahead of the week.';
  // Wrappers keep the mobile linear order identical (head, context, sessions)
  // while letting desktop.css place them as two independent-height columns.
  var html='<div class="todaypanel"><div class="today-mobile-heading"><span>Today&rsquo;s session</span><small>'+esc(label)+'</small></div>';
  html+='<div class="today-head-wrap"><div class="todayeyebrow">Today plan</div><div class="todayhead"><div><div class="todaytitle">'+title+'</div><div class="today-subtitle">'+subtitle+'</div></div><div class="todaydate">'+esc(label)+'</div></div></div>';
  html+='<div class="today-context">';
  html+=renderCoachMoment(todaySessions);
  html+=renderInsightRail(insights);
  html+=renderCommandStatus(insights);
  if(insights.planned>0&&insights.completed>=insights.planned){html+='<div class="milestone-celebration"><svg class="icon"><use href="#i-trophy"/></svg><div><strong>Week complete</strong><span>You showed up for every planned session. That consistency compounds.</span></div></div>';}
  html+='</div>';
  html+='<div class="today-sessions">';
  if(!todaySessions.length){
    html+='<div class="todayempty">No session scheduled today. Recover well and check ahead.</div>';
  }else{
    html+='<div class="todaylist">';
    todaySessions.forEach(function(s){
      var type=getType(s),meta=[],resolved=type==='run'?resolveRunDisplay(s):null;
      if(s.intensity) meta.push(s.intensity);
      if(s.week) meta.push(s.week);
      if(s.status) meta.push(s.status);
      var displayName=s.name||'Session';
      html+='<div class="todayitem"><div class="todaytop"><div class="todaydot '+type+'"></div><div class="todaymain">';
      html+='<div class="todayname '+type+'">'+esc(displayName)+'</div>';
      if(meta.length) html+='<div class="todaymeta">'+esc(meta.join(' · '))+'</div>';
      var sessionIdx=-1;sessions.forEach(function(ws,wi){if(ws.id===s.id) sessionIdx=wi;});
      if(type==='run'){
        var runMeta=(resolved&&resolved.meta)||{};
        var sessionTitle=(resolved&&resolved.title)||s.name||'Run';
        var sessionDetail=(resolved&&resolved.detail)||runMeta.description||'';
        var _todayOv=_sessionOverrides[s.id]||null;
        if(_todayOv&&(_todayOv.warm_up||_todayOv.intervals||_todayOv.working_pace||_todayOv.cool_down)){
          // Override: render structured breakdown
          html+='<div class="todaytarget">';
          if(_todayOv.notes){
            html+='<div class="label">Coach note</div><div class="value">'+esc(_todayOv.notes)+'</div>';
          }
          // Structured rows
          html+='<div style="display:flex;flex-direction:column;gap:0;border:1px solid rgba(255,255,255,.1);border-radius:7px;overflow:hidden;margin-top:10px">';
          var _tRows=[];
          if(_todayOv.distance_km) _tRows.push({label:'Total',val:_todayOv.distance_km+'km',accent:false});
          if(_todayOv.warm_up) _tRows.push({label:'Warm up',val:_todayOv.warm_up,accent:false});
          var _tMain=(_todayOv.intervals||'')+(_todayOv.working_pace?' @ '+_todayOv.working_pace+'/km':'');
          if(_tMain) _tRows.push({label:'Main set',val:_tMain,accent:true});
          if(_todayOv.rest) _tRows.push({label:'Rest',val:_todayOv.rest,accent:false});
          if(_todayOv.cool_down) _tRows.push({label:'Cool down',val:_todayOv.cool_down,accent:false});
          _tRows.forEach(function(row,ri){
            var bb=ri<_tRows.length-1?'border-bottom:1px solid rgba(255,255,255,.08);':'';
            html+='<div style="display:grid;grid-template-columns:72px 1fr;gap:8px;padding:8px 10px;'+bb+'">';
            html+='<span style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:'+(row.accent?'var(--run)':'rgba(255,255,255,.4)')+';font-weight:'+(row.accent?'700':'400')+'">'+row.label+'</span>';
            html+='<span style="font-size:13px;font-weight:'+(row.accent?'700':'500')+';color:#fff;line-height:1.3">'+esc(row.val)+'</span>';
            html+='</div>';
          });
          html+='</div>';
          html+='</div>';
        } else {
          var targetValue=runMeta.target||runMeta.sessionGoal||runMeta.type||runMeta.intensity||sessionTitle;
          html+='<div class="todaytarget"><div class="label">Primary target</div><div class="value">'+esc(targetValue)+'</div>';
          if(sessionDetail){ html+='<div class="desc">'+esc(sessionDetail)+'</div>'; }
          html+='<div class="session-why"><svg class="icon"><use href="#i-bulb"/></svg><div><span>Why it matters</span>'+esc(sessionWhy(type,runMeta,sessionTitle))+'</div></div>';
          var chips=[];
          if(runMeta.rpe) chips.push('RPE '+runMeta.rpe);
          if(runMeta.surface) chips.push(runMeta.surface);
          if(runMeta.duration) chips.push(runMeta.duration);
          if(runMeta.distance) chips.push(runMeta.distance);
          if(chips.length){
            html+='<div class="todaychips">';
            chips.forEach(function(c){ html+='<div class="todaychip">'+esc(c)+'</div>'; });
            html+='</div>';
          }
          html+='</div>';
        }
      }else if(type==='strength'){
        html+='<div class="todaytarget"><div class="label">Primary target</div><div class="value">'+esc(displayName)+'</div><div class="desc">Use your previous efforts as a guide, then log what you actually complete today.</div><div class="session-why"><svg class="icon"><use href="#i-bulb"/></svg><div><span>Why it matters</span>Build durable strength that supports running economy, resilience and confident progression.</div></div></div>';
      }else if(type==='note'){
        var _noteInstr=s.runDetails||(_sessionOverrides[s.id]&&_sessionOverrides[s.id].notes)||'Train as you normally would and log what you did.';
        html+='<div class="todaytarget"><div class="label">Discovery week</div><div class="value">'+esc(displayName)+'</div><div class="desc">'+esc(_noteInstr)+'</div></div>';
      }else{
        html+='<div class="todaytarget"><div class="label">Recovery</div><div class="value">Rest day</div><div class="desc">Recovery is part of the programme. Use today to reset and be ready for the next session.</div></div>';
      }
      if(type!=='rest'&&sessionIdx>=0){
        html+='<button type="button" class="today-action primary" onclick="startFocusedSession('+sessionIdx+')" style="width:100%;margin-top:12px">Open session <svg class="icon"><use href="#i-arrow-right"/></svg></button>';
      }
      html+='</div></div></div>';
    });
    html+='</div>';
  }
  html+='</div>';
  html+='</div>';
  el.innerHTML=html;
  el.style.display='block';
  if(typeof applyTrainingView==='function')applyTrainingView();
}

// Readiness is strictly a daily score. Keep long-running/PWA sessions honest:
// clear yesterday's score at local midnight and re-check the synced body log
// whenever the app returns from the background or regains focus.
var _readinessDayKey='';
var _readinessMidnightTimer=null,_readinessLastCloudRefresh=0,_readinessRefreshPromise=null;
function scheduleReadinessMidnightReset(){
  if(_readinessMidnightTimer)clearTimeout(_readinessMidnightTimer);
  var now=new Date(),next=new Date(now);next.setHours(24,0,1,0);
  _readinessMidnightTimer=setTimeout(function(){refreshDailyReadiness(true);},Math.max(1000,next-now));
}
function paintDailyReadiness(){
  if(!athlete||!athlete.code)return;
  if(typeof renderTodaySection==='function')renderTodaySection();
  if(typeof syncQuickLogDock==='function')syncQuickLogDock();
}
function refreshDailyReadiness(syncCloud){
  var today=localISO(new Date()),dayChanged=today!==_readinessDayKey;
  _readinessDayKey=today;
  scheduleReadinessMidnightReset();
  // Paint first so a new day immediately shows "Log body check" instead of
  // waiting on the network. A current cloud record then replaces it below.
  paintDailyReadiness();
  var canSync=syncCloud&&athlete&&athlete.code&&typeof loadStructuredBodyData==='function';
  var freshEnough=!dayChanged&&(Date.now()-_readinessLastCloudRefresh)<60000;
  if(!canSync||freshEnough||_readinessRefreshPromise)return;
  _readinessLastCloudRefresh=Date.now();
  _readinessRefreshPromise=loadStructuredBodyData(athlete.code)
    .then(paintDailyReadiness)
    .catch(function(){})
    .finally(function(){_readinessRefreshPromise=null;});
}
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible')refreshDailyReadiness(true);
});
window.addEventListener('focus',function(){refreshDailyReadiness(true);});
window.addEventListener('storage',function(event){
  var prefix=athlete&&athlete.code?'dp_daily_body_'+athlete.code+'_':'';
  if(prefix&&event.key&&event.key.indexOf(prefix)===0)refreshDailyReadiness(false);
});
if(document.readyState&&document.readyState!=='loading')scheduleReadinessMidnightReset();
else document.addEventListener('DOMContentLoaded',scheduleReadinessMidnightReset);

function scrollToSession(idx){
  var card=document.getElementById('sc_'+idx);
  if(!card) return;
  var body=document.getElementById('scb_'+idx);
  if(body&&!body.classList.contains('open')) togS(idx);
  setTimeout(function(){card.scrollIntoView({behavior:'smooth',block:'start'});},60);
}

// Exercise progress belongs to the athlete + exercise, never to a programme
// split. Normalising only case and whitespace keeps genuine exercise variants
// separate while allowing a coach to move/recase the same exercise safely.
function exerciseHistoryKey(name){
  return String(name==null?'':name).toLowerCase().replace(/\s+/g,' ').trim();
}
function getExerciseSetsFromLog(entry,exerciseName){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)) return null;
  var target=exerciseHistoryKey(exerciseName),match=null;
  Object.keys(entry).some(function(key){
    if(key.indexOf('__')===0||exerciseHistoryKey(key)!==target||!Array.isArray(entry[key])) return false;
    match=entry[key];return true;
  });
  return match;
}
function strengthLogHasSetData(set){
  return !!(set&&(
    (set.weight&&String(set.weight).trim()!=='')||
    (set.reps&&String(set.reps).trim()!=='')||
    (set.repsLeft&&String(set.repsLeft).trim()!=='')||
    (set.repsRight&&String(set.repsRight).trim()!=='')
  ));
}
function getExercisePreviousEffort(sessionId,exerciseName){
  var history=getExerciseHistory(sessionId,exerciseName);
  return history.length?history[0].sets:null;
}
// Full history for one exercise across every logged session (excluding the current
// one), newest first. Feeds multi-session smarts like stall detection. Mirrors the
// per-session log shape: [{date, sets:[...]}, ...].
function getExerciseHistory(sessionId,exerciseName){
  var dateById={};(typeof allSessions!=='undefined'?allSessions:[]||[]).forEach(function(s){if(s&&s.id!=null)dateById[String(s.id)]=s.date||null;});
  var out=[];
  Object.keys(logs||{}).forEach(function(sid){
    if(sid.indexOf('__')===0||sid===String(sessionId)) return;
    var entry=logs[sid];if(!entry||typeof entry!=='object'||Array.isArray(entry)) return;
    var sets=getExerciseSetsFromLog(entry,exerciseName);if(!Array.isArray(sets)||!sets.length) return;
    var clean=sets.filter(strengthLogHasSetData);
    if(!clean.length) return;
    var sessionDate=String(entry.__sessionDate||dateById[sid]||entry.__submittedAt||'').slice(0,10)||null;
    var updatedAt=Date.parse(entry.__updatedAt||entry.__submittedAt||sessionDate||'')||0;
    out.push({sessionId:sid,date:sessionDate,updatedAt:updatedAt,sets:clean});
  });
  out.sort(function(a,b){
    if(a.date&&b.date&&a.date!==b.date) return a.date<b.date?1:-1;
    if(a.date&&!b.date) return -1;if(!a.date&&b.date) return 1;
    return b.updatedAt-a.updatedAt;
  });
  return out;
}
// Progression is decided only by the programmed working-set rows. Bonus sets
// are still saved and count toward volume/PBs, but they must never replace a
// programmed set in the rep target or next-session recommendation.
// A set counts as completed once it has reps: a weight typed into an empty row
// is a set still in progress.
function getWorkingSlice(ex,arr){
  arr=(arr||[]).filter(function(x){return x&&((x.reps&&String(x.reps).trim()!=='')||(x.repsLeft&&String(x.repsLeft).trim()!=='')||(x.repsRight&&String(x.repsRight).trim()!==''));});
  var workingSets=parseInt(ex.workingSets||ex.sets||arr.length||0)||0;
  var warmupSets=parseInt(ex.warmupSets,10)||0;
  if(!workingSets) return arr;
  // Live entries and newly saved logs carry their original row index. Keep only
  // the programmed window: after warm-ups and before any added bonus rows.
  var hasRowIndexes=arr.some(function(x){return x&&x._rowIndex!=null;});
  if(hasRowIndexes){
    return arr.filter(function(x){
      var row=Number(x._rowIndex);
      return row>=warmupSets&&row<warmupSets+workingSets;
    }).slice(0,workingSets);
  }
  // Legacy logs have no row metadata. Their stored order mirrors the form, so
  // use the programmed window when a warm-up is present and the first N rows
  // otherwise. This keeps a historical bonus set from displacing set one.
  if(warmupSets&&arr.length>=warmupSets+workingSets){
    return arr.slice(warmupSets,warmupSets+workingSets);
  }
  return arr.slice(0,workingSets);
}
function _isAssistedExercise(name){return /\bassist(?:ed|ance)?\b/i.test(String(name||''));}
function formatSetSummary(arr,exerciseName){arr=(arr||[]).filter(function(x){return x&&((x.weight&&String(x.weight).trim()!=='')||(x.reps&&String(x.reps).trim()!=='')||(x.repsLeft&&String(x.repsLeft).trim()!=='')||(x.repsRight&&String(x.repsRight).trim()!==''));});if(!arr.length) return '';var unit=_isAssistedExercise(exerciseName)?'kg assist':'kg';return arr.map(function(ps){var reps=ps.reps?(' × '+ps.reps):(ps.repsLeft||ps.repsRight?(' × L '+(ps.repsLeft||'—')+' / R '+(ps.repsRight||'—')):'');return(ps.weight?ps.weight+unit:'—')+reps;}).join(' | ');}
function setVal(v){return String(v==null?'':v).trim();}
function sameStrengthEffort(a,b){
  a=(a||[]).filter(Boolean);b=(b||[]).filter(Boolean);
  if(!a.length||a.length!==b.length) return false;
  for(var si=0;si<a.length;si++){
    var av=a[si]||{},bv=b[si]||{};
    if(setVal(av.weight)!==setVal(bv.weight)) return false;
    if(setVal(av.reps)!==setVal(bv.reps)) return false;
    if(setVal(av.repsLeft)!==setVal(bv.repsLeft)) return false;
    if(setVal(av.repsRight)!==setVal(bv.repsRight)) return false;
    if(setVal(av.rpe)!==setVal(bv.rpe)) return false;
  }
  return true;
}
function displaySavedStrengthSets(sessionId,savedSets,prevSets){
  if(isSessionLogged(sessionId)) return savedSets||[];
  if(sameStrengthEffort(savedSets,prevSets)) return [];
  return savedSets||[];
}
function getTopRep(ex){var range=String(ex.repRange||ex.reps||'').split('-');var top=parseInt(range[range.length-1],10);return isNaN(top)?parseInt(ex.reps,10)||0:top;}
function getNumeric(v){var n=parseFloat(v);return isNaN(n)?null:n;}
// Effective reps for a set: bilateral uses `reps`, unilateral (single-leg/arm)
// stores `repsLeft`/`repsRight` — use the weaker side so both sides must earn the
// progression. Without this, single-leg sets read as 0 reps and never progress load.
// Effective reps for a set. Returns null when the set carries no rep data at all
// (a weight typed with the reps box still empty) so the engine can ignore it
// instead of reading it as 0 reps and calling a deload the athlete never earned.
function _effReps(s){
  if(!s) return null;
  var l=parseInt(s.repsLeft,10),r=parseInt(s.repsRight,10);
  if(!isNaN(l)||!isNaN(r)) return Math.min(isNaN(l)?Infinity:l,isNaN(r)?Infinity:r);
  var v=parseInt(s.reps,10);
  return isNaN(v)?null:v;
}
// Name-based guess at the load increment. Only ever a fallback now: it can't know
// what's actually on the rack, so anything it returns is marked approximate and
// the athlete is told to round to their equipment.
function _ovGuessStep(name,load){var n=String(name||'').toLowerCase();
  if(_isAssistedExercise(n)) return 5;
  if(/bodyweight|push[- ]?up|pull[- ]?up|chin[- ]?up|\bdip\b|plank/.test(n)) return 0;
  if(/lateral raise|face pull|rear delt|reverse fly|\bfly\b|\bcurl\b|tricep|pushdown|calf|cuff|rotator/.test(n)) return 2.5;
  var barbell=/\bsquat\b|deadlift|\brdl\b|romanian|bench press|barbell|overhead press|\bohp\b|hip thrust|\bpress\b/.test(n);
  var notBar=/machine|cable|smith|dumbbell|\bdb\b|goblet|kettlebell|band|bodyweight|leg press/.test(n);
  if(barbell&&!notBar) return 2.5;
  if(/dumbbell|\bdb\b|goblet|kettlebell/.test(n)) return 2.5;
  if(/machine|cable|smith|leg press|pulldown|pec de|extension|hamstring curl|leg curl|\brow\b/.test(n)) return 5;
  return Math.max(2.5,Math.round(load*0.025*2)/2);}
// ── REAL WEIGHT INCREMENTS ────────────────────────────────────────────────────
// The portal already stores every weight an athlete has logged for an exercise,
// so the equipment tells us its own step: sort the distinct loads, take the
// smallest gap between them. 49/54/59 on a cable stack gives 5kg, and it
// self-corrects when they move gym. Needs 2+ distinct loads to be trustworthy;
// until then we flag the name-based guess as approximate.
function _ovLearnStep(history,ex){
  var loads={};
  (history||[]).forEach(function(h){
    var w=getWorkingSlice(ex,h.sets||h);
    w.forEach(function(s){
      var v=parseFloat(s.weight);
      if(!isNaN(v)&&v>0) loads[Math.round(v*100)/100]=1;
    });
  });
  var vals=Object.keys(loads).map(parseFloat).sort(function(a,b){return a-b;});
  if(vals.length<2) return null;
  // Take the most common gap, not the smallest: one typo or one odd micro-plate
  // session shouldn't redefine the machine's step. Ties go to the smaller gap.
  var freq={},gaps=[];
  for(var i=1;i<vals.length;i++){
    var d=Math.round((vals[i]-vals[i-1])*100)/100;
    if(d<0.5||d>25) continue;   // noise below, deload-sized jumps above
    freq[d]=(freq[d]||0)+1;gaps.push(d);
  }
  if(!gaps.length) return null;
  var step=null,bestN=0;
  Object.keys(freq).map(parseFloat).sort(function(a,b){return a-b;}).forEach(function(d){
    if(freq[d]>bestN){bestN=freq[d];step=d;}
  });
  if(step==null) return null;
  return {step:step,exact:true,rungs:vals};
}
// The next weight that actually exists above `load`. Uses the learned ladder when
// the athlete has been on this exercise before, otherwise the guess.
function _ovStepInfo(name,load,history,ex){
  var learned=_ovLearnStep(history,ex);
  var guess=_ovGuessStep(name,load||0);
  if(guess===0) return {step:0,exact:true,next:load};             // bodyweight
  if(learned){
    // A rung above the current load beats arithmetic: it's a weight they've
    // physically used on this machine.
    var above=null;
    for(var i=0;i<learned.rungs.length;i++){
      if(learned.rungs[i]>load+0.01){above=learned.rungs[i];break;}
    }
    var next=above!=null?above:Math.round((load+learned.step)*100)/100;
    return {step:Math.round((next-load)*100)/100,exact:true,next:next};
  }
  return {step:guess,exact:false,next:Math.round((load+guess)*2)/2};
}
// Assisted machines work in reverse: less assistance is harder. Use the same
// learned machine ladder, but move to the next setting below the current one.
function _ovAssistanceStepInfo(name,assistance,history,ex){
  var learned=_ovLearnStep(history,ex);
  if(learned){
    var below=null;
    for(var i=learned.rungs.length-1;i>=0;i--){
      if(learned.rungs[i]<assistance-0.01){below=learned.rungs[i];break;}
    }
    var next=below!=null?below:Math.max(0,Math.round((assistance-learned.step)*100)/100);
    return {step:Math.round((assistance-next)*100)/100,exact:true,next:next};
  }
  var guess=_ovGuessStep(name,assistance||0);
  return {step:guess,exact:false,next:Math.max(0,Math.round((assistance-guess)*2)/2)};
}
// Kept for callers that only want the number.
function _ovStep(name,load,history,ex){return _ovStepInfo(name,load,history,ex).step;}
// Nearest weight they've actually used at or below `target` — for deloads, so we
// never send them to a weight the machine can't make.
function _ovRungAtOrBelow(target,history,ex){
  var learned=_ovLearnStep(history,ex);
  if(learned){
    var best=null;
    learned.rungs.forEach(function(v){if(v<=target+0.01&&(best==null||v>best)) best=v;});
    if(best!=null) return best;
  }
  return Math.round(target*2)/2;
}
function _ovRungAtOrAbove(target,history,ex){
  var learned=_ovLearnStep(history,ex);
  if(learned){
    for(var i=0;i<learned.rungs.length;i++){
      if(learned.rungs[i]>=target-0.01) return learned.rungs[i];
    }
  }
  return Math.round(target*2)/2;
}
function getProgressionFeedback(ex,prevEffort,currentEffort){
  var prevWorking=getWorkingSlice(ex,prevEffort||[]);var currentWorking=getWorkingSlice(ex,currentEffort||[]);
  if(!currentWorking.length) return{tone:'dim',text:(ex.repRange?'Target '+ex.repRange:'Build this session')};
  var topRep=getTopRep(ex);
  var currentWeights=currentWorking.map(function(s){return getNumeric(s.weight);}).filter(function(v){return v!=null;});
  var prevWeights=prevWorking.map(function(s){return getNumeric(s.weight);}).filter(function(v){return v!=null;});
  var currentLoad=currentWeights.length?Math.max.apply(null,currentWeights):null;
  var prevLoad=prevWeights.length?Math.max.apply(null,prevWeights):null;
  var currentTotal=currentWorking.reduce(function(a,s){var v=_effReps(s);return a+(v==null||v===Infinity?0:v);},0);
  var prevTotal=prevWorking.reduce(function(a,s){var v=_effReps(s);return a+(v==null||v===Infinity?0:v);},0);
  var allAtTop=currentWorking.length&&currentWorking.every(function(s){var v=_effReps(s);return v!=null&&v!==Infinity&&v>=topRep;});
  if(allAtTop) return{tone:'ok',text:'Increase load next time'};
  // Athlete jumped ABOVE last session's load. Recognise the load PB AND tell them how
  // to adjust: at a heavier weight, the job is now to build reps back up to the top of
  // the range before the next bump (double progression).
  if(prevLoad!=null&&currentLoad!=null&&currentLoad>prevLoad&&currentTotal>0) return{tone:'ok',text:'Weight up · build to '+topRep+' reps'};
  if(prevWorking.length){
    if(currentLoad===prevLoad&&currentTotal>prevTotal) return{tone:'ok',text:'Rep PB +'+(currentTotal-prevTotal)};
    if(currentLoad===prevLoad&&currentTotal===prevTotal) return{tone:'dim',text:'Matched last effort'};
    if(currentLoad!=null&&prevLoad!=null&&currentLoad<prevLoad) return{tone:'dim',text:'Build reps before load'};
    if(currentTotal>prevTotal) return{tone:'ok',text:'Progressed this session'};
  }
  return{tone:'dim',text:'Progress reps to '+topRep};
}
function getFeedbackStyle(tone){if(tone==='ok') return 'color:var(--ok);background:var(--ok-bg);border:1px solid var(--ok-border);';if(tone==='warn') return 'color:var(--run);background:rgba(180,83,9,.06);border:1px solid rgba(180,83,9,.18);';return 'color:var(--dim);background:var(--surface);border:1px solid var(--border);';}
function collectExerciseSets(i,ei,trackRows){
  var c=document.getElementById('sets_'+i+'_'+ei),arr=[];if(!c) return arr;
  c.querySelectorAll('.setrow,.setrow-single').forEach(function(row,rowIndex){
    var wEl=row.querySelector('input[id^="w_"]');var rLEl=row.querySelector('input[id^="rL_"]');var rREl=row.querySelector('input[id^="rR_"]');var doneEl=row.querySelector('button[id^="st_"]');
    var w=wEl?wEl.value||'':'';var done=doneEl?doneEl.classList.contains('on'):false;var item=null;
    if(rLEl&&rREl){var rL=rLEl.value||'';var rR=rREl.value||'';if(w||rL||rR||done)item={weight:w,repsLeft:rL,repsRight:rR,done:done};}
    else{var rEl=row.querySelector('input[id^="r_"]');var rpeEl=row.querySelector('input[id^="rpe_"]');var r=rEl?rEl.value||'':'';var rpe=rpeEl?rpeEl.value||'':'';if(w||r||rpe||done)item={weight:w,reps:r,rpe:rpe,done:done};}
    if(item){if(trackRows)item._rowIndex=rowIndex;arr.push(item);}
  });
  return arr;
}
function refreshStrengthFeedback(i,splitKey){
  var exercises=getSplit(splitKey);var s=sessions[i];
  exercises.forEach(function(ex,ei){
    var resolvedEx=exPicks[ex.exercise]||ex.exercise;
    var currentEffort=collectExerciseSets(i,ei,true);
    var prevEffort=getExercisePreviousEffort(s.id,resolvedEx);
    if(!currentEffort.length&&logs[s.id]&&logs[s.id][resolvedEx]) currentEffort=displaySavedStrengthSets(s.id,logs[s.id][resolvedEx],prevEffort);
    // Single source of truth: evaluate today's entry when present (forward-looking),
    // otherwise last session. One recommendation, no competing messages.
    // The Next Session verdict is always read from the LAST completed session, so
    // it holds still while the athlete logs. Recomputing it from half-entered sets
    // made the card contradict itself mid-workout (and read warm-ups as working
    // sets). Today's entries drive the live progress line underneath instead.
    var history=getExerciseHistory(s.id,resolvedEx);
    var rec=_nsRecommendation(ex,prevEffort,resolvedEx,history);
    rec.live=_nsLiveProgress(ex,currentEffort,rec,resolvedEx,history,prevEffort);
    var card=document.querySelector('.exc[data-session-index="'+i+'"][data-exercise-index="'+ei+'"]');
    if(card){
      card.setAttribute('data-ns-action',rec.action);card.setAttribute('data-ns-tone',rec.tone);
      var chip=card.querySelector('.ns-chip');if(chip) chip.outerHTML=_nsChip(rec);
      var blk=card.querySelector('.ns-block');if(blk) blk.outerHTML=_nsBody(rec);
      refreshStrengthExerciseState(card);
    }
    var lastEl=document.getElementById('prev_'+i+'_'+ei);
    if(lastEl){lastEl.className='prev-effort'+(prevEffort?' has-last':'');lastEl.innerHTML=prevEffort?('LAST: '+esc(formatSetSummary(getWorkingSlice(ex,prevEffort),resolvedEx))):('TARGET: '+esc(ex.repRange||ex.reps));}
  });
  refreshMuscleCoverage(i,splitKey);
}

// What the session was written to train, against what has actually been logged.
// With swaps in play the exercise names alone no longer answer that, so the
// readout works off muscle groups: a session where every exercise was
// substituted still confirms the target groups were covered — or shows exactly
// which one got dropped when the athlete ran out of time.
function buildMuscleCoverage(i,splitKey){
  var exercises=getSplit(splitKey),s=sessions[i];
  if(!s||!exercises.length) return [];
  var planned={},order=[];
  exercises.forEach(function(ex){
    var group=(typeof exerciseMuscleGroup==='function')?exerciseMuscleGroup(ex.exercise):null;
    if(!group) return;
    if(!planned[group.key]){planned[group.key]={key:group.key,label:group.label,plannedSets:0,loggedSets:0};order.push(group.key);}
    planned[group.key].plannedSets+=parseInt(ex.workingSets||ex.sets,10)||0;
  });
  exercises.forEach(function(ex,ei){
    var resolvedEx=exPicks[ex.exercise]||ex.exercise;
    var sets=collectExerciseSets(i,ei,true);
    if(!sets.length&&logs[s.id]) sets=getExerciseSetsFromLog(logs[s.id],resolvedEx)||[];
    // Credit the group the athlete actually trained. Swapping a row for a
    // pull-up moves the work from horizontal to vertical pull, and the readout
    // should show that honestly rather than assume the prescription was met.
    var group=(typeof exerciseMuscleGroup==='function')?exerciseMuscleGroup(resolvedEx):null;
    if(!group) return;
    if(!planned[group.key]){planned[group.key]={key:group.key,label:group.label,plannedSets:0,loggedSets:0};order.push(group.key);}
    sets.forEach(function(set){
      if(typeof strengthSetWorkload==='function'&&strengthSetWorkload(set)) planned[group.key].loggedSets++;
    });
  });
  return order.map(function(key){return planned[key];});
}
function muscleCoverageHtml(groups){
  if(!groups||!groups.length) return '';
  var covered=groups.filter(function(g){return g.loggedSets>0;}).length;
  var missing=groups.filter(function(g){return g.plannedSets>0&&g.loggedSets===0;});
  var summary=covered+' of '+groups.length+' muscle groups trained';
  var chips='';
  groups.forEach(function(g){
    var state=g.loggedSets===0?'todo':(g.plannedSets&&g.loggedSets>=g.plannedSets?'done':'partial');
    chips+='<span class="mcov-chip is-'+state+'"><span class="mcov-chip-label">'+esc(g.label)+'</span><span class="mcov-chip-sets">'+g.loggedSets+(g.plannedSets?'/'+g.plannedSets:'')+'</span></span>';
  });
  return '<div class="mcov-head"><span class="mcov-title">Muscle groups this session</span><span class="mcov-sum">'+esc(summary)+'</span></div>'
    +'<div class="mcov-chips">'+chips+'</div>'
    +(missing.length?'<div class="mcov-gap">Still untouched: '+esc(missing.map(function(g){return g.label;}).join(', '))+'</div>':'');
}
function refreshMuscleCoverage(i,splitKey){
  var mount=document.getElementById('mcov_'+i);
  if(!mount) return;
  var html=muscleCoverageHtml(buildMuscleCoverage(i,splitKey));
  mount.innerHTML=html;
  mount.style.display=html?'block':'none';
}

// ---------------------------------------------------------------------------
// Unified "Next Session" engine. ONE recommendation per exercise: a single
// action, the weight the badge must show, a per-set rep target, and the reason.
// `effort` is whichever sets we evaluate: the athlete's last completed session
// (before they log) or what they have entered today (live) which then becomes
// the basis for next time. No competing messages, ever.
//
// Returns: {
//   tone:'green'|'yellow'|'blue'|'red', status:<label>, action:<string>,
//   weightKg:<number|null>, arrow:'↗'|'→'|'↻'|'', target:<number[]|null>,
//   targetNote:<string|null>, reason:<string|null>
// }
// ---------------------------------------------------------------------------
function _nsFilled(n,v){var a=[];for(var i=0;i<n;i++)a.push(v);return a;}
function computeOverload(ex,effort,resolvedName,history){
  var name=resolvedName||ex.exercise||'';
  var assisted=_isAssistedExercise(name);
  var low=parseInt(String(ex.repRange||ex.reps||'').split('-')[0],10)||8;
  var top=getTopRep(ex)||low;
  var wantSets=parseInt(ex.workingSets||ex.sets,10)||3;

  var working=getWorkingSlice(ex,effort||[]);
  var loads=working.map(function(s){return parseFloat(s.weight);}).filter(function(n){return !isNaN(n)&&n>0;});
  // On assisted movements, the lowest number is the hardest setting because it
  // represents less help from the machine.
  var maxLoad=loads.length?(assisted?Math.min.apply(null,loads):Math.max.apply(null,loads)):null;
  var reps=working.map(_effReps).filter(function(v){return v!=null&&v!==Infinity;});

  // 0. No usable history: set a base.
  if(!working.length||(maxLoad==null&&!reps.length)){
    return {tone:'blue',status:assisted?'Set Assistance':'Maintain Weight',action:assisted?'Find your assistance level':'Find your weight',weightKg:null,arrow:'',assisted:assisted,
      target:null,targetNote:assisted?('Choose enough assistance for '+low+' clean reps, with 2 to 3 left in the tank.'):('Pick a weight you control for '+low+' clean reps, 2 to 3 left in the tank.'),
      reason:'First working session. Form comes first, numbers after.'};
  }

  // Only sets that carry reps count as completed work. A weight typed with the
  // reps box left empty is an unfinished set, not a zero-rep one.
  var completedAll=reps.length>=wantSets;
  var allTop=reps.length>=wantSets&&reps.every(function(v){return v>=top;});
  var exceeded=reps.length>=wantSets&&reps.every(function(v){return v>top;});
  var wellBelow=reps.length>=wantSets&&reps.some(function(v){return v<low-2;});
  var info=assisted?_ovAssistanceStepInfo(name,maxLoad||0,history,ex):_ovStepInfo(name,maxLoad||0,history,ex);
  var step=info.step;
  // Ramped sets (47 / 54 / 61 up the working sets) aren't a single load, so
  // "stay at 61kg" would read as a flat prescription. Speak about the top set.
  var distinct={};loads.forEach(function(v){distinct[v]=1;});
  var ramped=Object.keys(distinct).length>1;

  // 1. Every working set at/over the top of the range -> add load.
  if(maxLoad!=null&&allTop){
    if(assisted){
      var nextAssist=info.next;
      var assistApprox=!info.exact;
      return {tone:'green',status:'Ready to Progress',action:nextAssist>0?'Reduce assistance to '+_nsKg(nextAssist):'Try bodyweight',weightKg:nextAssist,arrow:'↘',approx:assistApprox,assisted:true,
        target:_nsFilled(wantSets,low),targetNote:null,milestone:_nsMilestone(reps,top,wantSets),
        reason:'Progression unlocked. You earned less assistance next session.'+(assistApprox?' Round to the next setting your machine actually has.':'')};
    }
    if(step===0){ // bodyweight: push reps past the range instead of adding load
      return {tone:'green',status:'Ready to Increase',action:'Add reps beyond '+top,weightKg:maxLoad,arrow:'↗',
        target:_nsFilled(wantSets,top+1),targetNote:null,milestone:_nsMilestone(reps,top,wantSets),
        reason:'Progression unlocked. Push reps past '+top+' next session.'};
    }
    var next=info.next; if(next<=maxLoad) next=Math.round((maxLoad+step)*2)/2;
    // approx = we're guessing the equipment's step because there isn't enough
    // logged history yet. Say so rather than sending them after a weight that
    // may not exist on their rack.
    var approx=!info.exact;
    return {tone:'green',status:'Ready to Increase',action:(ramped?'Top set to ':(approx?'Increase to about ':'Increase to '))+_nsKg(next),weightKg:next,arrow:'↗',approx:approx,
      target:_nsFilled(wantSets,low),targetNote:null,milestone:_nsMilestone(reps,top,wantSets),
      reason:(exceeded?'Progression unlocked. You blew past the range, so the load climbs next session.':'Progression unlocked. You earned the jump next session.')
        +(approx?' Round to the next weight your equipment actually has.':'')};
  }

  // 2. Stall: 3+ sessions stuck at the same load, none topped, no rep gain -> deload.
  if(maxLoad!=null&&history&&history.length>=3){
    var recent=history.slice(0,3).map(function(h){
      var w=getWorkingSlice(ex,h.sets||h);
      var l=w.map(function(s){return parseFloat(s.weight);}).filter(function(n){return !isNaN(n)&&n>0;});
      var rp=w.map(_effReps).filter(function(v){return v!=null&&v!==Infinity;});
      return {ml:l.length?(assisted?Math.min.apply(null,l):Math.max.apply(null,l)):null,tot:rp.reduce(function(a,b){return a+b;},0),topped:rp.length&&rp.every(function(v){return v>=top;})};
    });
    var sameLoad=recent.every(function(x){return x.ml!=null&&x.ml===recent[0].ml;});
    var noneTopped=recent.every(function(x){return !x.topped;});
    var noGain=recent[0].tot<=recent[2].tot;
    // Already backed off? Then the advice has been taken; don't keep repeating it.
    var alreadyDeloaded=maxLoad!=null&&(assisted?maxLoad>recent[0].ml:maxLoad<recent[0].ml);
    if(sameLoad&&noneTopped&&noGain&&!alreadyDeloaded){
      var deload=assisted?_ovRungAtOrAbove(recent[0].ml*1.1,history,ex):_ovRungAtOrBelow(recent[0].ml*0.9,history,ex);
      return {tone:'red',status:'Rebuild Technique',action:(assisted?'Increase assistance to ':'Reduce to ')+_nsKg(deload),weightKg:deload,arrow:'↻',assisted:assisted,
        target:_nsFilled(wantSets,low),targetNote:null,
        reason:assisted
          ?'Stuck at '+_nsKg(recent[0].ml)+' assistance for several sessions. Add some help, sharpen form, then reduce it again.'
          :'Stuck at '+_nsKg(recent[0].ml)+' for several sessions. Back off, sharpen form, then climb again with momentum.'};
    }
  }

  // 3. Missed the minimum badly -> hold and rebuild.
  if(wellBelow&&maxLoad!=null){
    return {tone:'red',status:'Rebuild Technique',action:assisted?'Keep assistance at '+_nsKg(maxLoad):'Keep '+_nsKg(maxLoad),weightKg:maxLoad,arrow:'→',assisted:assisted,
      target:_nsFilled(wantSets,low),targetNote:null,
      reason:'You fell short of '+low+' reps. '+(assisted?'Own this assistance level before reducing the help.':'Own this weight before adding more.')};
  }

  // 4. Last session didn't finish the prescribed working sets -> finish them first.
  if(!completedAll){
    return {tone:'blue',status:assisted?'Maintain Assistance':'Maintain Weight',action:assisted?('Keep assistance at '+(maxLoad!=null?_nsKg(maxLoad):'this level')):('Keep '+(maxLoad!=null?_nsKg(maxLoad):'this weight')),weightKg:maxLoad,arrow:'→',assisted:assisted,
      target:_nsFilled(wantSets,Math.max(low,reps.length?Math.max.apply(null,reps):low)),targetNote:null,
      reason:'Only '+reps.length+' of '+wantSets+' working sets logged last time. Complete all '+wantSets+' before '+(assisted?'assistance changes.':'the weight moves.')};
  }

  // 5. In range, not topped -> hold and beat last session (+1 total rep).
  var tgt=[];
  for(var k=0;k<wantSets;k++){var b=reps[k]!=null?reps[k]:(reps.length?reps[reps.length-1]:low);tgt.push(Math.min(top,b));}
  for(var m2=0;m2<tgt.length;m2++){if(tgt[m2]<top){tgt[m2]=tgt[m2]+1;break;}}
  var lastTotal=reps.reduce(function(a,b){return a+b;},0);
  return {tone:'yellow',status:'Beat Last Week',action:assisted?((ramped?'Hardest set stays at ':'Stay at ')+_nsKg(maxLoad)+' assistance'):((ramped?'Top set stays at ':'Stay at ')+_nsKg(maxLoad)),weightKg:maxLoad,arrow:'→',assisted:assisted,
    target:tgt,targetNote:null,milestone:_nsMilestone(reps,top,wantSets),beatTotal:lastTotal,
    reason:'Hit one extra rep before '+(assisted?'reducing assistance.':'the weight goes up.')+' Last session was '+lastTotal+' total reps across '+reps.length+' working sets. Beat it.'};
}
function _nsRecommendation(ex,effort,resolvedName,history){
  var rec=computeOverload(ex,effort,resolvedName,history);
  rec.warmupSets=parseInt(ex.warmupSets,10)||0;
  rec.wantSets=parseInt(ex.workingSets||ex.sets,10)||3;
  return rec;
}
function _nsKg(kg){if(kg==null)return '--';var n=Math.round(kg*100)/100;return (Number.isInteger(n)?String(n):n.toFixed(1))+'kg';}
function _nsBare(kg){if(kg==null)return '--';var n=Math.round(kg*100)/100;return Number.isInteger(n)?String(n):n.toFixed(1);}
// Repaint the Next Session card for one exercise slot from the CURRENTLY chosen
// variant's own history: chip, Next Session block, collapsed state and the set-input
// placeholders. Called after a variant swap so nothing shows the previous variant.
function repaintOverload(i,ei){
  var s=sessions[i];if(!s) return;
  var splitKey=GYM_KEYS.find(function(k){return((s.name||'').indexOf(k)>=0);})||'Upper A';
  var ex=getSplit(splitKey)[ei];if(!ex) return;
  var resolvedEx=exPicks[ex.exercise]||ex.exercise;
  var prevEffort=getExercisePreviousEffort(s.id,resolvedEx);
  var history=getExerciseHistory(s.id,resolvedEx);
  var rec=_nsRecommendation(ex,prevEffort,resolvedEx,history);
  var currentEffort=collectExerciseSets(i,ei,true);
  rec.live=_nsLiveProgress(ex,currentEffort,rec,resolvedEx,history,prevEffort);
  var card=document.querySelector('.exc[data-session-index="'+i+'"][data-exercise-index="'+ei+'"]');
  if(!card) return;
  card.setAttribute('data-assisted',_isAssistedExercise(resolvedEx)?'true':'false');
  card.setAttribute('data-ns-action',rec.action);card.setAttribute('data-ns-tone',rec.tone);
  var chip=card.querySelector('.ns-chip');if(chip) chip.outerHTML=_nsChip(rec);
  var blk=card.querySelector('.ns-block');if(blk) blk.outerHTML=_nsBody(rec);
  refreshStrengthExerciseState(card);
  var nSets=parseInt(ex.sets)||2;
  for(var si=0;si<nSets;si++){
    var ps=prevEffort&&prevEffort[si]?prevEffort[si]:null;
    var wEl=document.getElementById('w_'+i+'_'+ei+'_'+si);if(wEl) wEl.placeholder=(ps&&ps.weight)?ps.weight:'—';
    var rEl=document.getElementById('r_'+i+'_'+ei+'_'+si);if(rEl) rEl.placeholder=(ps&&ps.reps)?ps.reps:'—';
    var rLEl=document.getElementById('rL_'+i+'_'+ei+'_'+si);if(rLEl) rLEl.placeholder=(ps&&ps.repsLeft)?ps.repsLeft:'L';
    var rREl=document.getElementById('rR_'+i+'_'+ei+'_'+si);if(rREl) rREl.placeholder=(ps&&ps.repsRight)?ps.repsRight:'R';
  }
}
function _ovLadder(steps){var h='<div class="exc-ladder">';steps.forEach(function(s){h+='<div class="exc-rung '+s[1]+'">'+(s[1].indexOf('done')>-1?'<span class="exc-rk"><svg class="icon"><use href="#i-check"/></svg></span>':'')+'<span class="exc-rt">'+s[0]+'</span></div>';});return h+'</div>';}
function _ovTip(t){return '<div class="exc-tip"><span class="exc-tip-i"><svg class="icon"><use href="#i-bulb"/></svg></span><span>'+t+'</span></div>';}
// ---- Next Session render helpers (shared by template + live repaint) ----
function _nsChip(rec){
  return '<div class="ns-chip ns-t-'+rec.tone+'">'+(rec.arrow?'<span class="ns-ar">'+rec.arrow+'</span>':'')+(rec.weightKg==null?'Base':_nsBare(rec.weightKg)+(rec.assisted?'kg assist':'kg'))+'</div>';
}
// Live progression milestone: how close the athlete is to earning the load bump.
// Recalculates from whatever is currently entered, so it climbs as they log.
function _nsMilestone(reps,top,wantSets){
  var topped=reps.filter(function(v){return v>=top;}).length;
  if(!reps.length) return {stage:0,topped:0,wantSets:wantSets};
  var stage;
  if(topped>=wantSets) stage=4;                          // every set topped -> unlocked
  else if(wantSets>1&&topped===wantSets-1) stage=3;      // last set to go
  else if(topped>0) stage=2;                             // first set topped
  else stage=1;                                          // building reps
  return {stage:stage,topped:topped,wantSets:wantSets};
}
function _nsMileHTML(m,assisted){
  if(!m||m.stage<=0) return '';
  var nodes=[['dot-ring','One more rep'],['dot-ring','One more set'],['dot','Unlocked'],['rocket',assisted?'Less assist':'Increase next']];
  var h='<div class="ns-mile" data-stage="'+m.stage+'">';
  nodes.forEach(function(n,ix){
    var on=ix<m.stage, cur=ix===m.stage-1;
    h+='<div class="ns-mnode'+(on?' on':'')+(cur?' cur':'')+'"><span class="ns-me ov-node-ic"><svg class="icon"><use href="#i-'+n[0]+'"/></svg></span><span class="ns-ml">'+n[1]+'</span></div>';
    if(ix<nodes.length-1) h+='<span class="ns-mbar'+(ix<m.stage-1?' on':'')+'"></span>';
  });
  return h+'</div>';
}
// Live progress for the session in front of them, computed from what's entered
// right now. Separate from the (frozen) Next Session verdict so one never
// rewrites the other. Returns null until they've logged a set with reps.
function _nsLiveProgress(ex,currentEffort,rec,resolvedName,history,previousEffort){
  var assisted=_isAssistedExercise(resolvedName||ex.exercise);
  var top=getTopRep(ex)||0;
  var wantSets=parseInt(ex.workingSets||ex.sets,10)||3;
  var working=getWorkingSlice(ex,currentEffort||[]);
  var reps=working.map(_effReps).filter(function(v){return v!=null&&v!==Infinity;});
  if(!reps.length) return null;
  var total=reps.reduce(function(a,b){return a+b;},0);
  var topped=reps.filter(function(v){return v>=top;}).length;
  var currentLoads=working.map(function(s){return parseFloat(s.weight);}).filter(function(v){return !isNaN(v)&&v>0;});
  var currentLoad=currentLoads.length?(assisted?Math.min.apply(null,currentLoads):Math.max.apply(null,currentLoads)):null;
  var previousWorking=getWorkingSlice(ex,previousEffort||[]);
  var previousReps=previousWorking.map(_effReps).filter(function(v){return v!=null&&v!==Infinity;});
  var beat=previousReps.length?previousReps.reduce(function(a,b){return a+b;},0):null;
  var previousLoads=previousWorking.map(function(s){return parseFloat(s.weight);}).filter(function(v){return !isNaN(v)&&v>0;});
  var previousLoad=previousLoads.length?(assisted?Math.min.apply(null,previousLoads):Math.max.apply(null,previousLoads)):null;
  var complete=reps.length>=wantSets;
  var msg,prompt=null,nextRec=null;
  if(reps.length<wantSets){
    msg=reps.length+' of '+wantSets+' working sets in · '+total+' reps so far';
    if(reps.length===wantSets-1&&topped===reps.length&&currentLoad!=null){
      var info=assisted?_ovAssistanceStepInfo(resolvedName||ex.exercise,currentLoad,history,ex):_ovStepInfo(resolvedName||ex.exercise,currentLoad,history,ex);
      var unlock=assisted?(info.next>0?_nsKg(info.next)+' assistance':'bodyweight'):(info.step===0?'more reps':_nsKg(info.next));
      prompt='Final working set: stay at '+_nsKg(currentLoad)+(assisted?' assistance':'')+' and aim for '+top+'. Hit it to unlock '+unlock+' next session.';
    }
  }else if(assisted&&previousLoad!=null&&currentLoad!=null&&currentLoad<previousLoad){
    msg=total+' reps at '+_nsKg(currentLoad)+' assistance · less help than last session';
  }else if(!assisted&&previousLoad!=null&&currentLoad!=null&&currentLoad>previousLoad){
    msg=total+' reps at '+_nsKg(currentLoad)+' · heavier than last session';
  }else if(beat!=null&&total>beat){
    msg=total+' reps · '+(total-beat)+' up on last session';
  }else if(beat!=null&&total===beat){
    msg=total+' reps · level with last session, one more to beat it';
  }else if(beat!=null){
    msg=total+' reps · '+(beat-total+1)+' more to beat last session';
  }else{
    msg=total+' reps logged across '+reps.length+' sets';
  }
  if(complete){
    nextRec=_nsRecommendation(ex,currentEffort,resolvedName,history);
    prompt='Next session: '+nextRec.action;
  }
  return {msg:msg,prompt:prompt,ahead:(beat!=null&&total>beat)||topped>=wantSets||(assisted&&previousLoad!=null&&currentLoad!=null&&currentLoad<previousLoad),nextTone:nextRec?nextRec.tone:null};
}
function _nsBody(rec){
  var t='';
  if(rec.target&&rec.target.length){
    t='<div class="ns-target"><div class="ns-tl">Working-set target</div><div class="ns-tgrid">'+rec.target.map(function(v,ix){
      return '<div class="ns-trep"><div class="ns-tn">'+v+'</div><div class="ns-ts">Work '+(ix+1)+'</div></div>';}).join('')+'</div>'+
      (rec.warmupSets?'<div class="ns-warmup-map">Warm-up row is separate · working sets '+(rec.warmupSets+1)+'–'+(rec.warmupSets+rec.target.length)+' decide progression.</div>':'')+'</div>';
  } else if(rec.targetNote){
    t='<div class="ns-target"><div class="ns-tl">Target</div><div class="ns-tnote">'+esc(rec.targetNote)+'</div></div>';
  }
  var mile=rec.milestone?_nsMileHTML(rec.milestone,rec.assisted):'';
  var ri=(rec.milestone&&rec.milestone.stage>=4)?'rocket':(rec.tone==='red'?'alert':'bulb');
  var reason=rec.reason?'<div class="ns-reason"><span class="ns-ri ov-node-ic"><svg class="icon"><use href="#i-'+ri+'"/></svg></span><span>'+esc(rec.reason)+'</span></div>':'';
  // Today's running total, shown under the frozen verdict.
  var live=rec.live?'<div class="ns-live-wrap"><div class="ns-live'+(rec.live.ahead?' ahead':'')+'"><span class="ns-live-k">Today</span><span>'+esc(rec.live.msg)+'</span></div>'+
    (rec.live.prompt?'<div class="ns-live-prompt ns-t-'+(rec.live.nextTone||'blue')+'"><svg class="icon"><use href="#i-arrow-right"/></svg><span>'+esc(rec.live.prompt)+'</span></div>':'')+'</div>':'';
  // Approximate load bump: the equipment's real step isn't known yet.
  var approx=rec.approx?'<div class="ns-approx">'+(rec.assisted?'Estimated change — round to the next assistance setting your machine actually has.':'Estimated jump — round to the next weight your equipment actually has.')+'</div>':'';
  return '<div class="ns-block ns-t-'+rec.tone+'">'+
    '<div class="ns-status"><span class="ns-dot"></span>'+esc(rec.status)+'</div>'+
    '<div class="ns-hd">'+'<svg class="icon"><use href="#i-target"/></svg>'+'Today’s progression target</div>'+
    '<div class="ns-action">'+esc(rec.action)+'</div>'+approx+t+mile+reason+live+'</div>';
}
// Collapsed subtitle driven by live state: done -> today's numbers, in progress
// -> set count, not started -> the single recommended action.
function _nsSubtitle(rec,state,summary,doneCount,total){
  if(state==='done') return '<span class="ns-tag done">Done</span><span class="ns-sum">'+esc(summary||'')+'</span>';
  if(state==='prog') return '<span class="ns-tag prog">In progress</span><span class="ns-sum">'+doneCount+' / '+total+' sets logged</span>';
  return '<span class="ns-todo">'+esc(rec.action)+'</span>';
}
function _nsStateIcon(state){
  if(state==='done') return '<div class="ns-ic done"><svg class="icon"><use href="#i-check"/></svg></div>';
  if(state==='prog') return '<div class="ns-ic prog"></div>';
  return '<div class="ns-ic todo"></div>';
}
function strengthExerciseHasData(card){
  if(!card) return false;
  var inputs=card.querySelectorAll('.exsets input');
  for(var x=0;x<inputs.length;x++){if(String(inputs[x].value||'').trim()!=='') return true;}
  return !!card.querySelector('.st.on,.st.pb-on');
}
function strengthSetHasRequiredInputs(row){
  if(!row) return false;
  var weight=row.querySelector('input[id^="w_"]'),reps=row.querySelector('input[id^="r_"]');
  var left=row.querySelector('input[id^="rL_"]'),right=row.querySelector('input[id^="rR_"]');
  var rpe=row.querySelector('input[id^="rpe_"]');
  var hasWeight=weight&&String(weight.value||'').trim()!=='';
  var hasReps=(reps&&String(reps.value||'').trim()!=='')||
    (left&&right&&String(left.value||'').trim()!==''&&String(right.value||'').trim()!=='');
  // When RPE logging is enabled, bilateral rows stay active until it is filled.
  // With the preference off, weight + reps are enough to complete the set.
  var rpeRequired=typeof strengthRpeEnabled!=='function'||strengthRpeEnabled();
  var hasRpe=!rpe||!rpeRequired||String(rpe.value||'').trim()!=='';
  return !!(hasWeight&&hasReps&&hasRpe);
}
function strengthSavedSetHasRequiredInputs(set,isSingleLeg){
  set=set||{};
  var hasWeight=String(set.weight==null?'':set.weight).trim()!=='';
  var hasReps=isSingleLeg
    ?String(set.repsLeft==null?'':set.repsLeft).trim()!==''&&String(set.repsRight==null?'':set.repsRight).trim()!==''
    :String(set.reps==null?'':set.reps).trim()!=='';
  var hasRpe=isSingleLeg||!strengthRpeEnabled()||String(set.rpe==null?'':set.rpe).trim()!=='';
  return !!(hasWeight&&hasReps&&hasRpe);
}
function strengthExerciseIsComplete(card){
  if(!card) return false;
  var rows=card.querySelectorAll('.setrow,.setrow-single');
  if(!rows.length) return false;
  for(var x=0;x<rows.length;x++){
    var row=rows[x],tick=row.querySelector('.st');
    if(!strengthSetHasRequiredInputs(row)||!tick||!tick.classList.contains('on')) return false;
  }
  return true;
}
function refreshStrengthExerciseState(card){
  if(!card) return;
  var hasData=strengthExerciseHasData(card);
  // Submission does not override set requirements: every visible row must have
  // its enabled columns filled and its completion tick on before this says Done.
  var complete=strengthExerciseIsComplete(card);
  card.classList.toggle('has-entry',hasData);
  card.classList.toggle('exercise-complete',complete);
  // Collapsed-row state: done -> today's numbers, in progress -> set count,
  // not started -> the single recommended action. So the row is readable
  // without reopening it, even when exercises are done out of order.
  var state=complete?'done':(hasData?'prog':'todo');
  var rows=card.querySelectorAll('.setrow,.setrow-single');
  var assisted=card.getAttribute('data-assisted')==='true';
  var total=rows.length,doneCount=0,parts=[],topW=null;
  rows.forEach(function(row){
    var tick=row.querySelector('.st');if(tick&&tick.classList.contains('on')) doneCount++;
    var w=row.querySelector('input[id^="w_"]'),r=row.querySelector('input[id^="r_"]');
    var rL=row.querySelector('input[id^="rL_"]'),rR=row.querySelector('input[id^="rR_"]');
    var wv=w?parseFloat(w.value):NaN;
    var rep=r?String(r.value||'').trim():(rL&&rR?((rL.value||'-')+'/'+(rR.value||'-')):'');
    if(!isNaN(wv)&&(topW==null||(assisted?wv<topW:wv>topW))) topW=wv;
    if(!isNaN(wv)||String(rep).replace(/[-\/]/g,'').trim()!=='') parts.push(rep!==''?rep:'-');
  });
  var summary=(topW!=null?_nsBare(topW)+(assisted?'kg assist × ':'kg × '):'')+parts.join(' · ');
  var rec={action:card.getAttribute('data-ns-action')||'',tone:card.getAttribute('data-ns-tone')||'blue'};
  var ic=card.querySelector('.ns-ic');if(ic) ic.outerHTML=_nsStateIcon(state);
  var sub=card.querySelector('.ns-sub');if(sub) sub.innerHTML=_nsSubtitle(rec,state,summary,doneCount,total);
  card.classList.toggle('ns-logged',state==='done');
  card.classList.toggle('ns-inprogress',state==='prog');
  ['green','yellow','blue','red'].forEach(function(t){card.classList.toggle('ns-t-'+t,state==='todo'&&rec.tone===t);});
  var pill=card.querySelector('.exc-entry-pill');
  if(pill){pill.textContent=complete?'Done':'In progress';}
}
function refreshStrengthExerciseStates(i){
  document.querySelectorAll('.exc[data-session-index="'+i+'"]').forEach(refreshStrengthExerciseState);
}
function toggleExc(el){
  var c=el&&el.closest?el.closest('.exc'):null;
  if(!c) return;
  c.classList.toggle('open');
  refreshStrengthExerciseState(c);
}
// Expands the wider same-muscle swap bank under an exercise. Kept collapsed by
// default so the coach's programmed exercise and alts stay the obvious choice.
function toggleSwapPanel(button,panelId){
  var panel=document.getElementById(panelId);
  if(!panel) return;
  var open=panel.hasAttribute('hidden');
  if(open){panel.removeAttribute('hidden');}
  else{panel.setAttribute('hidden','');}
  panel.classList.toggle('open',open);
  if(button&&button.setAttribute) button.setAttribute('aria-expanded',open?'true':'false');
}
function gymDraftHasData(log){
  if(!log||typeof log!=='object') return false;
  if(String(log.__notes||'').trim()) return true;
  return Object.keys(log).some(function(k){return k.indexOf('__')!==0&&Array.isArray(log[k])&&log[k].length;});
}
function setGymSubmissionStatus(i,state){
  var status=document.getElementById('gym_saved_'+i);if(!status) return;
  if(state==='hidden'){status.style.display='none';return;}
  status.style.display='flex';
  status.className='session-submit-status '+(state==='submitted'?'is-submitted':'is-draft');
  status.innerHTML=state==='submitted'
    ?'<span class="submit-status-icon"><svg class="icon"><use href="#i-check"/></svg></span><span><strong>Session submitted</strong><small>Your coaches can now review this data.</small></span>'
    :'<span class="submit-status-icon">•••</span><span><strong>Draft saved on this device</strong><small>Press Save session below to submit it to your coaches.</small></span>';
}

function buildBody(s,i,type){
  var h='';
  if(type==='run'){
    var resolved=resolveRunDisplay(s),related=resolved.related||null,meta=resolved.meta||{};
    var sessionTitle=resolved.title||s.name||'Run';
    var sessionDetail=resolved.detail||meta.description||'';
    var warmUp=meta.warmUp||'2km easy jog or 10 min easy jog (RPE 4).';
    var coolDown=meta.coolDown||'10min easy jog (RPE 3–4).';
    var workoutText=sessionDetail||sessionTitle;
    var extras=[];
    if(meta.target) extras.push(meta.target);
    if(meta.recoveryType) extras.push('Recovery: '+meta.recoveryType);
    if(meta.sessionGoal) extras.push('Goal: '+meta.sessionGoal);
    var chips=[];
    if(meta.intensity) chips.push(meta.intensity);
    if(meta.surface) chips.push(meta.surface);
    if(meta.difficulty) chips.push(meta.difficulty);
    var sl=logs[s.id]||{};
    var hasSaved=isSessionLogged(s.id);
    var rpeInfo=inferRpeMeta(meta,sessionTitle);
    var altInfo=parseAlternative(meta,sessionTitle);

    // ── Training zone badge ───────────────────────────────────────────────────
    var zoneMap={
      recovery:{label:'Recovery',color:'#059669',bg:'#d1fae5'},
      easy:{label:'Easy Run',color:'#16a34a',bg:'#dcfce7'},
      long:{label:'Long Run',color:'#0891b2',bg:'#cffafe'},
      steady:{label:'Steady State',color:'#0284c7',bg:'#e0f2fe'},
      tempo:{label:'Tempo',color:'#d97706',bg:'#fef3c7'},
      threshold:{label:'Lactate Threshold',color:'#ea580c',bg:'#ffedd5'},
      interval:{label:'VO2 Max / Intervals',color:'#dc2626',bg:'#fee2e2'},
      track:{label:'VO2 Max / Intervals',color:'#dc2626',bg:'#fee2e2'},
      speed:{label:'Speed Work',color:'#9333ea',bg:'#f3e8ff'},
      sprint:{label:'Sprint',color:'#7c3aed',bg:'#ede9fe'},
      race:{label:'Race Pace',color:'#dc2626',bg:'#fee2e2'},
      hill:{label:'Hill Training',color:'#b45309',bg:'#fef3c7'},
      fartlek:{label:'Fartlek',color:'#d97706',bg:'#fef3c7'}
    };
    var zHaystack=(sessionTitle+' '+(meta&&meta.intensity||'')+' '+(meta&&meta.type||'')+' '+(meta&&meta.tags||'')).toLowerCase();
    var zOrder=['recovery','interval','track','speed','sprint','threshold','tempo','fartlek','hill','race','long','steady','easy'];
    var zKey=null;
    for(var zi=0;zi<zOrder.length;zi++){if(zHaystack.indexOf(zOrder[zi])>=0){zKey=zOrder[zi];break;}}
    var zone=zKey?zoneMap[zKey]:{label:'Aerobic',color:'#0284c7',bg:'#e0f2fe'};

    h+='<div class="run-details">';

    // ── Unified session card ──────────────────────────────────────────────────
    h+='<div class="run-prescription-card" style="background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015)), var(--surface);border:1px solid var(--border-mid);border-radius:10px;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)">';

    // Header — session title + RPE + zone
    h+='<div class="run-prescription-head" style="padding:14px 16px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.015)">';
    h+='<div class="run-prescription-title" style="font-family:var(--display);font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:.02em;color:var(--text);line-height:1.1;margin-bottom:8px">'+esc(sessionTitle)+'</div>';
    h+='<div class="run-prescription-badges" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
    h+='<div style="font-family:var(--mono);font-size:11px;font-weight:700;color:#fff;background:var(--run);padding:3px 9px;border-radius:5px;letter-spacing:.04em;white-space:nowrap">'+esc(rpeInfo.value)+'</div>';
    h+='<div style="font-family:var(--mono);font-size:11px;font-weight:700;color:'+zone.color+';background:'+zone.bg+';padding:3px 9px;border-radius:5px;letter-spacing:.04em;white-space:nowrap">'+esc(zone.label)+'</div>';
    h+='<div style="font-size:12px;color:var(--muted);line-height:1.4">'+esc(rpeInfo.desc)+'</div>';
    h+='</div></div>';

    // Body
    h+='<div class="run-prescription-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:rgba(255,255,255,.01)">';

    // ── Workout — main focus ─────────────────────────────────────────────────
    var _ov=_sessionOverrides[s.id]||null;
    var _ovHasStructure=_ov&&(_ov.warm_up||_ov.intervals||_ov.working_pace||_ov.cool_down||_ov.notes||_ov.rest);
    if(_ovHasStructure){
      // Structured override block — clearly labelled rows
      var _ovRows=[];
      if(_ov.distance_km) _ovRows.push({label:'Total',val:_ov.distance_km+'km',accent:false});
      if(_ov.warm_up) _ovRows.push({label:'Warm up',val:_ov.warm_up,accent:false});
      var _mainSet=(_ov.intervals||'')+(_ov.working_pace?' @ '+_ov.working_pace+'/km':'');
      if(_mainSet) _ovRows.push({label:'Main set',val:_mainSet,accent:true});
      if(_ov.rest) _ovRows.push({label:'Rest',val:_ov.rest,accent:false});
      if(_ov.cool_down) _ovRows.push({label:'Cool down',val:_ov.cool_down,accent:false});
      h+='<div class="run-prescription-table" style="border:1px solid var(--border-mid);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.02)">';
      _ovRows.forEach(function(row,ri){
        var borderB=ri<_ovRows.length-1?'border-bottom:1px solid var(--border);':'';
        h+='<div class="run-prescription-row" style="display:grid;grid-template-columns:80px 1fr;align-items:baseline;gap:8px;padding:9px 12px;'+borderB+'">';
        h+='<span style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:'+(row.accent?'var(--run)':'var(--muted)')+';font-weight:'+(row.accent?'700':'400')+';padding-top:1px">'+row.label+'</span>';
        h+='<span style="font-size:14px;font-weight:'+(row.accent?'700':'500')+';color:var(--text);line-height:1.4">'+esc(row.val)+'</span>';
        h+='</div>';
      });
      h+='</div>';
      if(_ov.notes){
        h+='<div class="run-coach-note" style="background:rgba(146,210,237,.07);border:1px solid rgba(146,210,237,.18);border-radius:7px;padding:10px 13px">';
        h+='<div style="font-family:var(--mono);font-size:9px;color:var(--run);text-transform:uppercase;letter-spacing:.07em;font-weight:700;margin-bottom:5px">Coach Note</div>';
        h+='<div style="font-size:13px;color:var(--text);line-height:1.55">'+esc(_ov.notes)+'</div>';
        h+='</div>';
      }
    } else {
      h+='<div style="font-size:15px;font-weight:600;color:var(--text);line-height:1.55">'+esc(workoutText)+'</div>';
    }

    // Rest pill + optional chips — subtle, secondary
    var intervalRest=getIntervalRestInfo(meta,sessionTitle);
    var hasSecondary=intervalRest||chips.length;
    if(hasSecondary&&!_ovHasStructure){
      h+='<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:-4px">';
      if(intervalRest){
        h+='<div style="display:inline-flex;align-items:center;gap:5px;background:var(--surface2);border-radius:6px;padding:4px 10px">';
        h+='<span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--run);letter-spacing:.04em">'+esc(intervalRest.restTime)+'</span>';
        h+='<span style="font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.05em;text-transform:uppercase">'+esc(intervalRest.restType)+'</span>';
        h+='</div>';
      }
      chips.forEach(function(x){ h+='<div class="chip">'+esc(x)+'</div>'; });
      h+='</div>';
    }

    // Coaching note — own row, breathing room
    if(intervalRest&&intervalRest.recoveryNote&&!_ovHasStructure){
      h+='<div style="border-left:3px solid var(--run);padding:8px 12px;background:var(--surface2);border-radius:0 6px 6px 0">';
      h+='<div style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:5px">Coach Note</div>';
      h+='<div style="font-size:12px;color:var(--text);line-height:1.6">'+esc(intervalRest.recoveryNote)+'</div>';
      h+='</div>';
    }

    // Warm up + Cool down — skip for easy/recovery/long runs (and overridden sessions which render their own)
    var isLowIntensity=/\beasy\b|\brecovery\b|\blong run\b|\blong\b/.test(zHaystack);
    if(!isLowIntensity&&!_ovHasStructure){
      h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
      h+='<div><div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Warm up</div>';
      h+='<div style="font-size:12px;color:var(--text);line-height:1.45">'+esc(warmUp)+'</div></div>';
      h+='<div><div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Cool down</div>';
      h+='<div style="font-size:12px;color:var(--text);line-height:1.45">'+esc(coolDown)+'</div></div>';
      h+='</div>';
    }

    // Alternative
    h+='<div class="run-alternative" style="border-top:1px solid var(--border);padding-top:10px;margin-top:-2px">';
    h+='<div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Alternative</div>';
    h+='<div style="font-size:13px;font-weight:700;color:var(--run);margin-bottom:3px">'+esc(altInfo.title)+'</div>';
    h+='<div style="font-size:12px;color:var(--muted);line-height:1.45">'+esc(altInfo.description)+'</div>';
    h+='</div>';

    h+='</div></div>'; // end body + card
    h+='<div class="run-log">';
    if(sl.__stravaMatch&&hasSaved&&typeof stravaFeedbackFormHtml==='function'){
      h+=stravaFeedbackFormHtml(s,i);
      h+='</div></div>';
      return h;
    }
    h+='<div id="saved_run_'+i+'" class="saved-data" style="display:'+(hasSaved?'block':'none')+';">';
    h+='<div class="saved-label"><svg class="icon"><use href="#i-check"/></svg>Session submitted to your coaches</div>';
    h+='<div class="saved-grid">';
    h+='<div class="saved-item"><div class="saved-item-label">Distance</div><div class="saved-item-value" id="saved_run_'+i+'_distance">'+esc(sl.distance?sl.distance+'km':'-')+'</div></div>';
    h+='<div class="saved-item"><div class="saved-item-label">Duration</div><div class="saved-item-value" id="saved_run_'+i+'_duration">'+esc(sl.duration?sl.duration+'min':'-')+'</div></div>';
    h+='<div class="saved-item"><div class="saved-item-label">Avg Pace</div><div class="saved-item-value" id="saved_run_'+i+'_pace">'+esc(sl.pace||'-')+'</div></div>';
    h+='<div class="saved-item"><div class="saved-item-label">RPE</div><div class="saved-item-value" id="saved_run_'+i+'_rpe">'+esc(sl.rpe?sl.rpe+'/10':'-')+'</div></div>';
    h+='</div>';
    h+='<div class="saved-feeling" id="saved_run_'+i+'_feel" style="display:'+(sl.feel?'block':'none')+';">'+esc(stripFeelGlyph(sl.feel)||'')+'</div>';
    h+='<div class="saved-notes" id="saved_run_'+i+'_notes" style="display:'+(sl.notes?'block':'none')+';">'+esc(sl.notes||'')+'</div>';
    h+='<button class="savebtn" style="margin-top:10px" onclick="editRun('+i+')">Edit Session</button>';
    h+='</div>';
    h+='<div id="run_form_'+i+'" style="display:'+(hasSaved?'none':'block')+';">';
    h+='<div style="background:rgba(255,170,0,.07);border:1px solid rgba(255,170,0,.35);border-radius:8px;padding:10px 12px;margin-bottom:12px"><label style="color:#ffaa00;font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px;margin-bottom:6px"><span><svg class="icon icon-sm icon-dim"><use href="#i-calendar"/></svg></span> Session Date <span style="font-size:10px;font-weight:400;color:rgba(255,170,0,.6);font-family:var(--mono)">— change if you did this on a different day</span></label><input type="date" class="li" id="run_date_'+i+'" value="'+esc(s.date||'')+'" style="border-color:rgba(255,170,0,.4);width:100%;box-sizing:border-box" /></div>';
    h+='<div class="run-log-title">Log your session</div><div class="run-inputs">';
    h+='<div class="run-field"><label>Distance (km)</label><input type="number" step="0.1" id="rd_'+i+'" placeholder="0.0" value="'+esc(sl.distance||'')+'" oninput="draftRun('+i+')" /></div>';
    h+='<div class="run-field"><label>Duration (min)</label><input type="number" step="1" id="rdur_'+i+'" placeholder="30" value="'+esc(sl.duration||'')+'" oninput="draftRun('+i+')" /></div>';
    h+='<div class="run-field"><label>Avg Pace (min/km)</label><input type="text" id="rp_'+i+'" placeholder="6:00" value="'+esc(sl.pace||'')+'" oninput="draftRun('+i+')" /></div>';
    h+='<div class="run-field"><label>RPE /10</label><input type="number" min="1" max="10" id="rr_'+i+'" placeholder="..." value="'+esc(sl.rpe||'')+'" oninput="draftRun('+i+')" /></div>';
    h+='</div>';
    h+='<div class="run-field run-input-full" style="margin-bottom:8px"><label>How did it feel?</label><select id="rf_'+i+'" class="li" onchange="draftRun('+i+')"><option value="">Select feeling...</option>';
    ['Awful','Struggling','Average','Feeling Strong','Crushing It'].forEach(function(f){h+='<option'+(stripFeelGlyph(sl.feel)===f?' selected':'')+'>'+esc(f)+'</option>';});
    h+='</select></div>';
    h+='<div class="run-field run-input-full" style="margin-bottom:8px"><label>Notes (Optional)</label><textarea id="rn_'+i+'" class="li" placeholder="Any additional thoughts..." oninput="draftRun('+i+')">'+esc(sl.notes||'')+'</textarea></div>';
    h+='<button class="savebtn" id="sb_'+i+'" onclick="saveRun('+i+')">Save Session</button>';
    if(isSessionLogged(s.id)){setTimeout(function(idx){showRunSaved(idx);}(i),0);}
    h+='</div>';
    h+='</div>';
    h+='</div>';
  }else if(type==='strength'){

    var splitKey=GYM_KEYS.find(function(k){return(s.name||'').indexOf(k)>=0;})||'Upper A';
    var exercises=getSplit(splitKey),sl2=logs[s.id]||{};
    h+='<div style="background:rgba(255,170,0,.07);border:1px solid rgba(255,170,0,.35);border-radius:8px;padding:10px 12px;margin-bottom:12px"><label style="color:#ffaa00;font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px;margin-bottom:6px"><span><svg class="icon icon-sm icon-dim"><use href="#i-calendar"/></svg></span> Session Date <span style="font-size:10px;font-weight:400;color:rgba(255,170,0,.6);font-family:var(--mono)">— change if you did this on a different day</span></label><input type="date" class="li" id="gym_date_'+i+'" value="'+esc(s.date||'')+'" style="border-color:rgba(255,170,0,.4);width:100%;box-sizing:border-box" /></div>';
    if(exercises.length){
      var restTimerOn=typeof restTimerEnabled==='function'?restTimerEnabled():true;
      var strengthRpeOn=typeof strengthRpeEnabled==='function'?strengthRpeEnabled():true;
      h+='<div class="strength-log-heading"><div class="ltitle">Log your sets</div><div class="strength-log-prefs"><button type="button" class="rest-pref-toggle'+(strengthRpeOn?' is-on':'')+'" data-strength-rpe-toggle aria-pressed="'+(strengthRpeOn?'true':'false')+'" onclick="toggleStrengthRpePreference()"><span class="rest-pref-dot"></span><span>RPE</span><strong class="rest-pref-state">'+(strengthRpeOn?'On':'Off')+'</strong></button><button type="button" class="rest-pref-toggle'+(restTimerOn?' is-on':'')+'" data-rest-timer-toggle aria-pressed="'+(restTimerOn?'true':'false')+'" onclick="toggleRestTimerPreference()"><span class="rest-pref-dot"></span><span>Rest timer</span><strong class="rest-pref-state">'+(restTimerOn?'On':'Off')+'</strong></button></div></div>';
      if(isFemaleSplit(splitKey)){
        h+='<div class="female-priority-note"><span class="female-priority-note-badge">Priority</span><div><strong>Short on time?</strong><span>Complete the priority exercises first to cover the session’s main muscle groups. Keep going through the full session whenever time allows.</span></div></div>';
      }
      h+='<div class="exlist">';
      exercises.forEach(function(ex,ei){
        var isTimeCrunchPriority=isFemalePriorityExercise(splitKey,ex.exercise);
        var resolvedEx=exPicks[ex.exercise]||ex.exercise;
        var isAssisted=_isAssistedExercise(resolvedEx);
        var safeKey=ex.exercise.replace(/[^a-z0-9]/gi,'_');
	        var savedEx=getExerciseSetsFromLog(sl2,resolvedEx)||getExerciseSetsFromLog(sl2,ex.exercise)||[],sets=parseInt(ex.sets)||2;
	        var prevEffort=getExercisePreviousEffort(s.id,resolvedEx);
	        savedEx=displaySavedStrengthSets(s.id,savedEx,prevEffort);
	        // Preserve each set's original form row when restoring a draft. This
	        // keeps bonus rows visible after reload and prevents a blank earlier
	        // row from shifting later work into the wrong progression slot.
	        var savedByRow={},maxSavedRow=sets-1;
	        (savedEx||[]).forEach(function(sv,savedIndex){
	          var savedRow=parseInt(sv&&sv._rowIndex,10);
	          if(isNaN(savedRow)||savedRow<0) savedRow=savedIndex;
	          savedByRow[savedRow]=sv;
	          if(savedRow>maxSavedRow) maxSavedRow=savedRow;
	        });
	        var renderSets=Math.max(sets,maxSavedRow+1);
	        var stored=pbComputeStored(resolvedEx,s.id);
        var isSingleLeg=usesLeftRightReps(resolvedEx,ex);
        var initVol=0;(savedEx||[]).forEach(function(sv){var w=parseFloat(sv.weight),r=parseInt(sv.reps,10);if(!isNaN(w)&&w>0&&!isNaN(r)&&r>0&&r<=PB_REP_CAP) initVol+=w*r;});
        var isVolPB=!!(stored.volume&&initVol>stored.volume.value);
        var isBarbell=/\bsquat\b|deadlift|\brdl\b|romanian|bench press|barbell|overhead press|\bohp\b|hip thrust/i.test(resolvedEx)&&!/machine|cable|smith|dumbbell|\bdb\b|goblet|kettlebell|band|bodyweight|leg press/i.test(resolvedEx);
        var _ovHistory=getExerciseHistory(s.id,resolvedEx);
        var _ov=_nsRecommendation(ex,prevEffort,resolvedEx,_ovHistory);
        _ov.live=_nsLiveProgress(ex,savedEx,_ov,resolvedEx,_ovHistory,prevEffort);
        var hasExerciseData=!!savedEx.length;
	        var renderedRows=[];for(var renderedIndex=0;renderedIndex<renderSets;renderedIndex++) renderedRows.push(savedByRow[renderedIndex]||{});
	        var exerciseIsComplete=hasExerciseData&&renderedRows.every(function(set){return !!set.done&&strengthSavedSetHasRequiredInputs(set,isSingleLeg);});
	        var _nsState=exerciseIsComplete?'done':(hasExerciseData?'prog':'todo');
	        var _nsDone=0,_nsParts=[],_nsTopW=null;
	        getWorkingSlice(ex,savedEx||[]).forEach(function(sv){
	          if(sv.done) _nsDone++;
          var wv=parseFloat(sv.weight);
          var rep=(sv.reps!=null&&String(sv.reps).trim()!=='')?sv.reps:((sv.repsLeft||sv.repsRight)?((sv.repsLeft||'-')+'/'+(sv.repsRight||'-')):'');
          if(!isNaN(wv)&&(_nsTopW==null||(isAssisted?wv<_nsTopW:wv>_nsTopW))) _nsTopW=wv;
          if(!isNaN(wv)||String(rep).replace(/[-\/]/g,'').trim()!=='') _nsParts.push(rep!==''?rep:'-');
        });
        var _nsSummary=(_nsTopW!=null?_nsBare(_nsTopW)+(isAssisted?'kg assist × ':'kg × '):'')+_nsParts.join(' · ');
        var _nsStateCls=exerciseIsComplete?' ns-logged':(hasExerciseData?' ns-inprogress':' ns-t-'+_ov.tone);
        h+='<div class="exc'+_nsStateCls+(ei===0&&!exerciseIsComplete?' open':'')+(hasExerciseData?' has-entry':'')+(exerciseIsComplete?' exercise-complete':'')+(isTimeCrunchPriority?' female-priority-exercise':'')+'" data-session-index="'+i+'" data-exercise-index="'+ei+'" data-split-key="'+esc(splitKey)+'" data-assisted="'+(isAssisted?'true':'false')+'" data-ns-action="'+esc(_ov.action)+'" data-ns-tone="'+_ov.tone+'">';
        h+='<div class="exc-summary" onclick="toggleExc(this)">'+_nsStateIcon(_nsState)+'<div class="exc-sum-main"><div class="exn-row"><div class="exn" id="exn_'+safeKey+'">'+esc(resolvedEx)+'</div>'+(isTimeCrunchPriority?'<span class="female-priority-badge">Priority</span>':'')+'</div><div class="exc-why ns-sub">'+_nsSubtitle(_ov,_nsState,_nsSummary,_nsDone,sets)+'</div></div>'+_nsChip(_ov)+'<div class="exc-chev">▾</div></div>';
        h+='<div class="exc-body">'+_nsBody(_ov);
        h+='<div class="exh">';
        h+='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">';
        h+='<div style="min-width:0;flex:1">';
        h+='<div class="exm">'+esc(ex.sets)+' sets'+(ex.rest?' · '+formatRest(ex.rest):'')+'</div>';
        if(ex.notes) h+='<div class="exnotes">'+esc(ex.notes)+'</div>';
        h+='</div>';
        h+='<div id="exstat_'+i+'_'+ei+'" style="text-align:right;flex-shrink:0">';
          if(!isAssisted&&stored.load) h+='<div class="ex-stat ex-stat-pb"><svg class="icon"><use href="#i-trophy"/></svg> PB '+esc(pbRound1(pbNum(stored.load.weight)))+'kg</div>';
          if(!isAssisted&&!isSingleLeg&&stored.volume) h+='<div class="ex-stat ex-stat-vol-pb"><svg class="icon"><use href="#i-trophy"/></svg> Vol PB '+esc(Math.round(stored.volume.value).toLocaleString())+'kg</div>';
          if(!isAssisted&&stored.e1rm) h+='<div class="ex-stat ex-stat-e1rm">e1RM '+esc(pbRound1(stored.e1rm.value))+'kg</div>';
          if(!isAssisted&&!isSingleLeg) h+='<div id="vol_'+i+'_'+ei+'" class="ex-stat ex-stat-vol'+(isVolPB?' pb':'')+'">'+(isVolPB?'<svg class="icon"><use href="#i-trophy"/></svg> ':'')+'Vol '+Math.round(initVol).toLocaleString()+'kg</div>';
          h+='</div>';
        h+='</div>';
        h+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center">';
        if(prevEffort){var prevStr=formatSetSummary(prevEffort,resolvedEx);h+='<div id="prev_'+i+'_'+ei+'" class="prev-effort has-last">LAST: '+esc(prevStr)+'</div>';}
        else{h+='<div id="prev_'+i+'_'+ei+'" class="prev-effort">TARGET: '+esc(ex.repRange||ex.reps)+'</div>';}
        h+='</div></div>';
        // Swap picker. The programmed exercise and the coach's alts stay on top
        // as the priority row; the wider same-muscle bank sits one tap away
        // behind "More options", grouped by equipment so a busy or under-kitted
        // gym never costs the athlete the muscle group the slot was written for.
        var swapOptions=(typeof getExerciseSwapOptions==='function')?getExerciseSwapOptions(ex):{priority:[ex.exercise].concat(ex.alts||[]),groups:[],patternLabel:''};
        var swapPriority=swapOptions.priority||[];
        var swapGroups=swapOptions.groups||[];
        if(swapPriority.length>1||swapGroups.length){
          var exNameSafe=ex.exercise.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
          var pickPill=function(opt,extraCls){
            var safeOpt=opt.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
            return '<button type="button" class="ex-pill'+(extraCls||'')+(opt===resolvedEx?' active':'')+'" onclick="pickEx(\''+exNameSafe+'\',\''+safeOpt+'\')" data-pg="'+safeKey+'" data-pv="'+esc(opt)+'">'+esc(opt)+'</button>';
          };
          // Is the athlete currently on something outside the coach's shortlist?
          var offProgramme=swapPriority.every(function(opt){return opt!==resolvedEx;});
          var swapPanelId='swaps_'+i+'_'+ei;
          // Overload needs repetition to read. An athlete on a different
          // variation every week never builds the history the engine compares
          // against, so their numbers look flat however hard they train — say
          // so here, where the swap is about to happen, rather than never.
          var churn=(typeof variationChurn==='function')?variationChurn(logs,ex.exercise):null;
          if(churn&&churn.churning){
            h+='<div class="swap-churn-note"><span class="swap-churn-badge">Heads up</span><div><strong>'+churn.distinct+' different variations in your last '+churn.sessions+' sessions here.</strong><span>Progress is measured against your own history, so it needs you to repeat a movement. Pick one and stay on it for about four weeks before switching again.</span></div></div>';
          }
          h+='<div class="ex-picker-label">Swap exercise</div>';
          h+='<div class="ex-picker">';
          swapPriority.forEach(function(opt){h+=pickPill(opt,'');});
          if(swapGroups.length){
            h+='<button type="button" class="ex-pill ex-pill-more'+(offProgramme?' is-swapped':'')+'" aria-expanded="'+(offProgramme?'true':'false')+'" aria-controls="'+swapPanelId+'" onclick="toggleSwapPanel(this,\''+swapPanelId+'\')"><span class="ex-more-caret">▾</span>More options</button>';
          }
          h+='</div>';
          if(swapGroups.length){
            h+='<div class="ex-swaps'+(offProgramme?' open':'')+'" id="'+swapPanelId+'"'+(offProgramme?'':' hidden')+'>';
            h+='<div class="ex-swaps-note"><strong>'+esc(swapOptions.patternLabel)+'</strong><span>Every option below trains the same muscle group as the programmed exercise — pick whatever you can get on. Stick to the sets, reps and effort as written.</span></div>';
            swapGroups.forEach(function(group){
              h+='<div class="ex-swap-group"><div class="ex-swap-group-label">'+esc(group.label)+'</div><div class="ex-swap-pills">';
              group.options.forEach(function(opt){h+=pickPill(opt,' ex-pill-alt');});
              h+='</div></div>';
            });
            h+='</div>';
          }
        }
        var isSingleLeg=usesLeftRightReps(resolvedEx,ex);
        var warmupSets=parseInt(ex.warmupSets,10)||0;
        if(warmupSets){
          h+='<div class="working-set-note"><span>WU</span><div><strong>Warm-up first</strong><small>Keep the warm-up controlled. Working sets 1–'+(parseInt(ex.workingSets,10)||Math.max(1,sets-warmupSets))+' determine today’s progression.</small></div></div>';
        }
        if(isSingleLeg){
          h+='<div class="slbls-single"><div class="slbl"></div><div class="slbl">'+(isAssisted?'Assist kg':'kg')+'</div><div class="slbl">Left</div><div class="slbl">Right</div><div class="slbl slbl-tick"><svg class="icon"><use href="#i-check"/></svg></div></div>';
          h+='<div class="exsets" id="sets_'+i+'_'+ei+'">';
	          for(var si=0;si<renderSets;si++){var sv=savedByRow[si]||{};var prevSet=prevEffort&&prevEffort[si]?prevEffort[si]:null;var isWarmup=si<warmupSets;var isExtra=si>=sets;var bonusSet=si-sets+1;var displaySet=isExtra?('B'+bonusSet):(isWarmup?'WU':(si-warmupSets+1));var setLabel=isExtra?('Bonus set '+bonusSet):(isWarmup?'Warm-up set':'Working set '+displaySet);var delSet=isExtra?'<button class="del-set" onclick="deleteSet(this,'+i+','+ei+',\''+esc(splitKey)+'\')" title="Remove bonus set">×</button>':'';
	            h+='<div class="setrow-single'+(isWarmup?' is-warmup':'')+(isExtra?' extra':'')+'" id="sr_'+i+'_'+ei+'_'+si+'"><div class="snum" aria-label="'+setLabel+'">'+displaySet+'</div>';
	            h+='<input type="number" class="sin" id="w_'+i+'_'+ei+'_'+si+'" placeholder="'+esc(prevSet&&prevSet.weight?prevSet.weight:'—')+'" min="0" step="0.5" value="'+esc(sv.weight||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" onchange="autoCompleteStrengthSet('+i+','+ei+','+si+')" />';
	            h+='<input type="number" class="sin" id="rL_'+i+'_'+ei+'_'+si+'" placeholder="'+esc(prevSet&&prevSet.repsLeft?prevSet.repsLeft:'L')+'" min="0" value="'+esc(sv.repsLeft||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" onchange="autoCompleteStrengthSet('+i+','+ei+','+si+')" />';
	            h+='<input type="number" class="sin" id="rR_'+i+'_'+ei+'_'+si+'" placeholder="'+esc(prevSet&&prevSet.repsRight?prevSet.repsRight:'R')+'" min="0" value="'+esc(sv.repsRight||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" onchange="autoCompleteStrengthSet('+i+','+ei+','+si+')" />';
	            h+='<button class="st'+(sv.done?' on':'')+' " id="st_'+i+'_'+ei+'_'+si+'" aria-label="Mark '+setLabel.toLowerCase()+' complete" aria-pressed="'+(sv.done?'true':'false')+'" onclick="togSet('+i+','+ei+','+si+')">';
	            h+='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button>'+delSet+'</div>';
	          }
	        }else{
	          h+='<div class="slbls"><div class="slbl"></div><div class="slbl">'+(isAssisted?'Assist kg':'kg')+'</div><div class="slbl">reps</div><div class="slbl">RPE</div><div class="slbl slbl-tick"><svg class="icon"><use href="#i-check"/></svg></div></div>';
	          h+='<div class="exsets" id="sets_'+i+'_'+ei+'">';
	          for(var si=0;si<renderSets;si++){var sv=savedByRow[si]||{};var prevSet=prevEffort&&prevEffort[si]?prevEffort[si]:null;var isWarmup=si<warmupSets;var isExtra=si>=sets;var bonusSet=si-sets+1;var displaySet=isExtra?('B'+bonusSet):(isWarmup?'WU':(si-warmupSets+1));var setLabel=isExtra?('Bonus set '+bonusSet):(isWarmup?'Warm-up set':'Working set '+displaySet);var delSet=isExtra?'<button class="del-set" onclick="deleteSet(this,'+i+','+ei+',\''+esc(splitKey)+'\')" title="Remove bonus set">×</button>':'';
	            h+='<div class="setrow'+(isWarmup?' is-warmup':'')+(isExtra?' extra':'')+'" id="sr_'+i+'_'+ei+'_'+si+'"><div class="snum" aria-label="'+setLabel+'">'+displaySet+'</div>';
	            h+='<input type="number" class="sin" id="w_'+i+'_'+ei+'_'+si+'" placeholder="'+(prevSet&&prevSet.weight?prevSet.weight:'—')+'" min="0" step="0.5" value="'+esc(sv.weight||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" onchange="autoCompleteStrengthSet('+i+','+ei+','+si+')" />';
	            h+='<input type="number" class="sin" id="r_'+i+'_'+ei+'_'+si+'" placeholder="'+esc((prevSet&&prevSet.reps)?prevSet.reps:'—')+'" min="0" value="'+esc(sv.reps||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" onchange="autoCompleteStrengthSet('+i+','+ei+','+si+')" />';
	            h+='<input type="number" class="rpe-in'+(sv.rpe?' filled':'')+'" id="rpe_'+i+'_'+ei+'_'+si+'" placeholder="—" min="1" max="10" step="0.5" value="'+esc(sv.rpe||'')+'" oninput="draftGym('+i+',\''+esc(splitKey)+'\')" onchange="autoCompleteStrengthSet('+i+','+ei+','+si+')" />';
	            h+='<button class="st'+(sv.done?' on':'')+' " id="st_'+i+'_'+ei+'_'+si+'" aria-label="Mark '+setLabel.toLowerCase()+' complete" aria-pressed="'+(sv.done?'true':'false')+'" onclick="togSet('+i+','+ei+','+si+')">';
	            h+='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button>'+delSet+'</div>';
	          }
	        }
        h+='</div>';
        var _restSec=parseInt(ex.rest,10);
        if(!isNaN(_restSec)&&_restSec>0) h+='<div class="rest-timer" id="rest_'+i+'_'+ei+'" data-rest="'+_restSec+'" style="display:none"><div><div class="rt-label">Rest</div><div class="rt-count" id="rtc_'+i+'_'+ei+'">0:00</div></div><div class="rt-wrap"><div class="rt-fill" id="rtf_'+i+'_'+ei+'"></div></div><button class="rt-skip" onclick="skipRest('+i+','+ei+')">Skip</button></div>';
	        h+='<button class="addset" onclick="addSet('+i+','+ei+',\'—\',\''+esc(splitKey)+'\')">+ Add bonus set</button>';
        if(isBarbell){var topW=0;(savedEx||[]).forEach(function(sv){var w=parseFloat(sv.weight);if(!isNaN(w)&&w>topW)topW=w;});if(!topW&&prevEffort){prevEffort.forEach(function(p){var w=parseFloat(p.weight);if(!isNaN(w)&&w>topW)topW=w;});}h+='<div class="plate-calc" id="plate_'+i+'_'+ei+'">'+platesHtml(topW)+'</div>';}
        h+='</div>';
        h+='</div>';
      });
      h+='</div>';
      // Coverage lives under the exercise list and refreshes on every keystroke
      // through refreshStrengthFeedback, so it answers "have I trained what this
      // session was for?" while there is still time to act on the answer.
      h+='<div class="muscle-coverage" id="mcov_'+i+'"></div>';
      setTimeout(function(idx,key){return function(){refreshMuscleCoverage(idx,key);};}(i,splitKey),0);
    }
    var sl2notes=(logs[s.id]&&logs[s.id].__notes)||'';
    h+='<div class="run-field run-input-full" style="margin-top:12px;margin-bottom:8px"><label>Session notes <span style="font-family:var(--mono);font-size:10px;font-weight:400;color:var(--dim)">(PRs, wins, niggles, anything worth logging)</span></label><textarea id="gn_'+i+'" class="li" placeholder="e.g. Hit a new squat PR, left knee felt a bit off on lunges..." oninput="draftGym('+i+',\''+esc(splitKey)+'\')" style="min-height:70px;resize:vertical;font-size:13px">'+esc(sl2notes)+'</textarea></div>';
    var gymSubmitted=isSessionLogged(s.id),gymHasDraft=gymDraftHasData(sl2);
    h+='<div id="gym_saved_'+i+'" class="session-submit-status '+(gymSubmitted?'is-submitted':'is-draft')+'" style="display:'+(gymSubmitted||gymHasDraft?'flex':'none')+';">';
    if(gymSubmitted) h+='<span class="submit-status-icon"><svg class="icon"><use href="#i-check"/></svg></span><span><strong>Session submitted</strong><small>Your coaches can now review this data.</small></span>';
    else h+='<span class="submit-status-icon">•••</span><span><strong>Draft saved on this device</strong><small>Press Save session below to submit it to your coaches.</small></span>';
    h+='</div>';
    h+='<button class="savebtn" id="sb_'+i+'" onclick="saveGym('+i+',\''+esc(splitKey)+'\')">Save session</button>';
    if(isSessionLogged(s.id)){setTimeout(function(idx){lockSaveButton(idx,'Save session');}(i),0);}
    setTimeout(function(){updateStrengthRpeControls();if(typeof restoreRestTimer==='function')restoreRestTimer();},0);
  }else if(type==='note'){
    var sl3=logs[s.id]||{};
    var noteVal=(typeof sl3.__notes==='string')?sl3.__notes:(sl3.notes||'');
    var instruction=s.runDetails||(_sessionOverrides[s.id]&&_sessionOverrides[s.id].notes)||'';
    h+='<div style="background:rgba(255,255,255,.03);border:1px solid var(--border-mid);border-radius:8px;padding:12px 14px">';
    if(instruction) h+='<div style="font-size:13px;color:var(--text);line-height:1.55;margin-bottom:12px">'+esc(instruction)+'</div>';
    h+='<div class="run-field run-input-full" style="margin-bottom:10px"><label>What did you do? <span style="font-family:var(--mono);font-size:10px;font-weight:400;color:var(--dim)">(training + how it felt, anything worth logging)</span></label><textarea id="nt_'+i+'" class="li" placeholder="e.g. 45min easy run + mobility, legs felt good. Hit chest at the gym, normal week..." oninput="draftNote('+i+')" style="min-height:90px;resize:vertical;font-size:13px">'+esc(noteVal)+'</textarea></div>';
    h+='<div id="note_saved_'+i+'" class="saved-data" style="display:'+(isSessionLogged(s.id)?'block':'none')+';"><div class="saved-label"><svg class="icon"><use href="#i-check"/></svg>Submitted to your coaches</div></div>';
    h+='<button class="savebtn" id="sb_'+i+'" onclick="saveNote('+i+')">Save</button>';
    if(isSessionLogged(s.id)){setTimeout(function(idx){lockSaveButton(idx,'Save');}(i),0);}
    h+='</div>';
  }else{h+='<div style="font-family:var(--mono);font-size:12px;color:var(--dim);padding:8px 0">Rest up. Recovery is training too.</div>';}
  return h;
}

var focusedSessionIndex=null,focusedSessionGenerated=false;
function ensureFocusOverlay(){
  var ov=document.getElementById('focusOverlay');
  if(ov)return ov;
  ov=document.createElement('div');ov.id='focusOverlay';ov.className='focus-overlay';
  ov.innerHTML='<div class="focus-overlay-bar"><button class="focus-close" onclick="closeFocusedSession()" aria-label="Close session">&times;</button><div class="focus-overlay-title"><small>Session</small><strong id="focusOverlayName">Workout</strong></div><span id="focusOverlayMeta"></span></div><div class="focus-overlay-scroll" id="focusOverlayScroll"></div><div class="focus-overlay-foot"><button class="focus-done-btn" onclick="closeFocusedSession()">Done — back to plan</button></div>';
  document.body.appendChild(ov);
  return ov;
}
function startFocusedSession(i){
  var card=document.getElementById('sc_'+i),body=document.getElementById('scb_'+i),generated=false;
  // The mobile month calendar intentionally renders compact day cells rather
  // than every full workout card. Build the selected card on demand so the
  // Home "Open session" action does not depend on hidden calendar markup.
  if((!card||!body)&&sessions[i]){
    var staging=document.createElement('div');
    staging.innerHTML=buildCard(sessions[i],i);
    card=staging.querySelector('#sc_'+i);
    body=staging.querySelector('#scb_'+i);
    generated=!!(card&&body);
  }
  if(!card||!body)return;
  if(focusedSessionIndex!=null&&focusedSessionIndex!==i)closeFocusedSession();
  if(!body.classList.contains('open'))body.classList.add('open');
  focusedSessionIndex=i;focusedSessionGenerated=generated;
  var ov=ensureFocusOverlay(),scroll=document.getElementById('focusOverlayScroll');
  if(!scroll.contains(card)){
    if(!generated){
      var ph=document.getElementById('focusCardPlaceholder');
      if(!ph){ph=document.createElement('div');ph.id='focusCardPlaceholder';ph.style.display='none';}
      card.parentNode.insertBefore(ph,card);
    }
    scroll.appendChild(card);
  }
  card.classList.add('in-focus-overlay');
  var nameEl=document.getElementById('focusOverlayName');if(nameEl)nameEl.textContent=(sessions[i]&&sessions[i].name)||'Workout';
  var exCount=card.querySelectorAll('.exc').length,metaEl=document.getElementById('focusOverlayMeta');
  if(metaEl)metaEl.textContent=exCount?exCount+(exCount===1?' exercise':' exercises'):'';
  document.body.classList.add('focus-session-open');
  void ov.offsetHeight;ov.classList.add('open');scroll.scrollTop=0;
}
function closeFocusedSession(){
  if(focusedSessionIndex!=null){
    var card=document.getElementById('sc_'+focusedSessionIndex),ph=document.getElementById('focusCardPlaceholder');
    if(card){
      card.classList.remove('in-focus-overlay');
      if(focusedSessionGenerated)card.remove();
      else if(ph&&ph.parentNode){ph.parentNode.insertBefore(card,ph);ph.parentNode.removeChild(ph);}
    }
  }
  var ov=document.getElementById('focusOverlay');if(ov)ov.classList.remove('open');
  document.body.classList.remove('focus-session-open');focusedSessionIndex=null;focusedSessionGenerated=false;
}
document.addEventListener('keydown',function(e){if(e.key!=='Escape')return;if(focusedSessionIndex!=null)closeFocusedSession();else if(dayPlanDateISO)closeDayPlan();});
function togS(i){var el=document.getElementById('scb_'+i);if(el) el.classList.toggle('open');}
async function tickS(i){
  var s=sessions[i],on=!ticked[s.id];
  ticked[s.id]=on;localStorage.setItem('dp_ticked_'+athlete.code,JSON.stringify(ticked));
  portalStateWrite('ticked',ticked).catch(function(){});
  var hasData=logHasRealData(logs[s.id]);
  var card=document.getElementById('sc_'+i),btn=document.getElementById('tick_'+i);
  if(card){card.classList.toggle('done',on&&hasData);card.classList.toggle('marked',on&&!hasData);}
  if(btn){btn.classList.toggle('on',on&&hasData);btn.classList.toggle('marked',on&&!hasData);btn.setAttribute('aria-pressed',on?'true':'false');btn.querySelector('svg').style.opacity=on?1:0;}
  // Toggle the inline "tap to log" nudge for the marked (ticked-but-unlogged) state
  var nudge=document.getElementById('nudge_'+i);
  if(on&&!hasData){
    if(!nudge&&card){nudge=document.createElement('div');nudge.id='nudge_'+i;nudge.className='sc-nudge';nudge.innerHTML='Marked — tap to open &amp; log your data';var scb=document.getElementById('scb_'+i);card.insertBefore(nudge,scb);}
  }else if(nudge){nudge.remove();}
  updateSessionCounter();
  // NOTE: a bare tick must NOT set Notion Status='Completed' — the coaches dashboard
  // treats Completed as Done. Only saveRun/saveGym mark a session Completed in Notion.
}
async function markSessionDone(i){
  var s=sessions[i];if(!s) return;
  ticked[s.id]=true;localStorage.setItem('dp_ticked_'+athlete.code,JSON.stringify(ticked));
  try{await portalStateWrite('ticked',ticked);}catch(e){}
  var card=document.getElementById('sc_'+i),btn=document.getElementById('tick_'+i);
  if(card){card.classList.remove('marked');card.classList.add('done');}
  if(btn){btn.classList.remove('marked');btn.classList.add('on');var sv=btn.querySelector('svg');if(sv) sv.style.opacity=1;}
  var nudge=document.getElementById('nudge_'+i);if(nudge) nudge.remove();
  updateSessionCounter();
  // Completion lives in Supabase: the ticked state is saved to athlete_data above,
  // and the saved run/gym log is the source-of-truth record the coach dashboard reads.
}
function autoCompleteStrengthSet(i,ei,si){
  var row=document.getElementById('sr_'+i+'_'+ei+'_'+si),btn=document.getElementById('st_'+i+'_'+ei+'_'+si);
  if(!row||!btn||!strengthSetHasRequiredInputs(row))return;
  if(!btn.classList.contains('on')){togSet(i,ei,si);return;}
  settleStrengthExerciseCompletion(btn.closest('.exc'));
}
function settleStrengthExerciseCompletion(card){
  if(!card)return;
  refreshStrengthExerciseState(card);
  if(!strengthExerciseIsComplete(card))return;
  setTimeout(function(){
    if(!card||!strengthExerciseIsComplete(card))return;
    card.classList.remove('open');refreshStrengthExerciseState(card);
  },320);
}
function togSet(i,ei,si){
  var btn=document.getElementById('st_'+i+'_'+ei+'_'+si);if(!btn) return;
  var on=!btn.classList.contains('on');btn.classList.toggle('on',on);btn.setAttribute('aria-pressed',on?'true':'false');btn.style.background=on?'var(--ok)':'transparent';btn.style.borderColor=on?'var(--ok)':'var(--border-mid)';
  var card=btn.closest('.exc');
  if(card){
    var splitKey=card.getAttribute('data-split-key')||'Upper A';
    draftGym(i,splitKey);
    if(on)settleStrengthExerciseCompletion(card);else refreshStrengthExerciseState(card);
  }
  if(on){
    var exerciseName=card&&typeof card.querySelector==='function'?card.querySelector('.exn'):null;
    startRest(i,ei,exerciseName?exerciseName.textContent.trim():'');
  }
}
