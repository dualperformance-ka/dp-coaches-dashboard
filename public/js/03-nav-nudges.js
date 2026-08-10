// ── TABS ──────────────────────────────────────────────────────────────────────
// ── WEEK CARD STATE ───────────────────────────────────────────────────────────
// Every home nudge carries one of two classes: `is-due` (still to do) or
// `is-done` (completed, quiet). The card itself lights up only while at least
// one visible row is still due, so the urgency glow is earned, never ambient.
function nudgeVisible(el){
  if(!el) return false;
  // Computed display, not the inline style: the goals row is hidden by its
  // stylesheet rather than by an inline value.
  try{return window.getComputedStyle(el).display!=='none';}catch(e){return el.style.display!=='none';}
}
function syncWeekCardState(){
  var card=document.querySelector('.top-shell-priority');
  if(!card) return;
  var due=0,rows=0;
  Array.prototype.forEach.call(card.querySelectorAll('.nudge-strip,#strava-ack-banner'),function(el){
    if(el.classList.contains('is-clearing')||!nudgeVisible(el)) return;
    rows++;
    if(el.classList.contains('is-due')) due++;
  });
  card.classList.toggle('has-due',due>0);
  // With every row completed the card has nothing to frame, so it goes too —
  // otherwise mobile is left with an empty bordered sliver under the hero.
  card.classList.toggle('has-rows',rows>0);
}
// Completed rows leave rather than switching to a done state. The collapse is
// short enough to read as "that's handled" without holding up the screen.
function dismissNudge(el,done){
  if(!el||!nudgeVisible(el)){if(el)el.style.display='none';if(done)done();syncWeekCardState();return;}
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  if(reduce){el.style.display='none';if(done)done();syncWeekCardState();return;}
  el.style.height=el.offsetHeight+'px';
  el.classList.add('is-clearing');
  syncWeekCardState();
  requestAnimationFrame(function(){el.style.height='0px';});
  setTimeout(function(){
    el.classList.remove('is-clearing');
    el.style.height='';el.style.display='none';
    if(done)done();
    syncWeekCardState();
  },300);
}
// ── CALL NUDGE ────────────────────────────────────────────────────────────────
// ISO week suffix ("2026_31"). Zero-padded so week keys sort chronologically
// as plain strings — that is what lets us find the next booked call.
//
// Weeks reset at Monday midnight. A booking from Sunday belongs only to the
// week that just ended, so Monday always starts with a fresh booking prompt.
function callAdelaideDate(date){
  var p={};
  try{
    new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Adelaide',year:'numeric',month:'2-digit',day:'2-digit'})
      .formatToParts(date).forEach(function(x){p[x.type]=x.value;});
    return new Date(Number(p.year),Number(p.month)-1,Number(p.day));
  }catch(e){return new Date(date);}
}
function callWeekSuffix(date){
  var d=callAdelaideDate(new Date(date||new Date()));d.setHours(0,0,0,0);
  d.setDate(d.getDate()+3-(d.getDay()+6)%7);
  var w1=new Date(d.getFullYear(),0,4);
  var isoWeek=1+Math.round(((d-w1)/86400000-3+(w1.getDay()+6)%7)/7);
  return d.getFullYear()+'_'+(isoWeek<10?'0':'')+isoWeek;
}
function callBookedPrefix(){
  var acode=(athlete&&athlete.code)?athlete.code.toUpperCase()+'_':'';
  return 'dp_call_booked_'+acode;
}
function callNudgeWeekKey(date){return callBookedPrefix()+callWeekSuffix(date);}
// Three stored shapes, all still in the wild:
//   {time,startsAt}  current — written by the webhook and the backlog sync
//   "Tue 15 Jul · 6:30 pm"  older server rows and portal self-reports
//   "1"              legacy flag: booked, but the time was never captured
function parseBookedValue(raw){
  if(!raw) return null;
  var parsed=raw;
  try{parsed=JSON.parse(raw);}catch(e){}
  if(parsed&&typeof parsed==='object'){
    var startsAt=parsed.startsAt||parsed.startTime||parsed.start_time||'';
    return {time:String(parsed.time||parsed.displayTime||dpFormatBookedTime(startsAt)||''),startsAt:startsAt};
  }
  var t=(parsed==='1'||parsed===1)?'':String(parsed||'');
  var d=/^\d{4}-\d{2}-\d{2}T/.test(t)?new Date(t):null;
  return {time:(d&&!isNaN(d))?dpFormatBookedTime(d):t,startsAt:(d&&!isNaN(d))?d.toISOString():''};
}
function getCallBookedState(){
  var prefix=callBookedPrefix(),thisWeek=callWeekSuffix();
  var current=parseBookedValue(localStorage.getItem(prefix+thisWeek));
  // Backlogged bookings: a call already sitting in a later week should never be
  // hidden behind a "book your call" prompt, so surface the soonest one.
  var upcoming=null;
  try{
    for(var i=0;i<localStorage.length;i++){
      var k=localStorage.key(i);
      if(!k||k.indexOf(prefix)!==0) continue;
      var suffix=k.slice(prefix.length);
      if(!/^\d{4}_\d{2}$/.test(suffix)||suffix<=thisWeek) continue;
      var v=parseBookedValue(localStorage.getItem(k));
      if(!v) continue;
      if(!upcoming||suffix<upcoming.week) upcoming={week:suffix,displayTime:v.time,startsAt:v.startsAt};
    }
  }catch(e){}
  return {booked:!!current,displayTime:(current&&current.time)||'',upcoming:upcoming};
}
// SINGLE source of truth for every booking prompt in the app: the home nudge,
// the confirmed strip, the check-in Step 1 card and the tab dot all render
// from the same state, so they can never disagree.
function renderBookingPrompts(){
  var st=getCallBookedState();
  var nudge=document.getElementById('callNudge');
  var confirmed=document.getElementById('callConfirmedNudge');
  var dot=document.getElementById('tabDotCheckin');
  if(nudge){
    nudge.style.display=st.booked?'none':'';
    var sub=nudge.querySelector('.nudge-strip-sub');
    var hasNext=!!(st.upcoming&&st.upcoming.displayTime);
    if(sub) sub.textContent=hasNext?('Next call '+st.upcoming.displayTime+' · book this week too'):'30 min · Karl & Alex';
    nudge.classList.toggle('show-sub',hasNext);
  }
  if(confirmed) confirmed.style.display=st.booked?'':'none';
  var titleEl=document.getElementById('callConfirmedTitle');
  var subEl=document.getElementById('callConfirmedSub');
  if(titleEl) titleEl.textContent='Call booked';
  if(subEl) subEl.textContent=st.displayTime?(st.displayTime+' · Karl & Alex'):'Confirming date and time…';
  if(dot) dot.classList.toggle('visible',!st.booked);
  var card=document.getElementById('ciBookCard');
  if(card){
    card.classList.toggle('booked',st.booked);
    card.style.borderColor=st.booked?'rgba(34,197,94,.35)':'rgba(245,158,11,.22)';
    var k=document.getElementById('ciBookKicker'),t=document.getElementById('ciBookTitle'),s=document.getElementById('ciBookSub'),a=document.getElementById('ciBookArrow');
    if(k) k.textContent=st.booked?'Step 1 — Done':'Step 1 — Do this first';
    if(t) t.textContent=st.booked?'Call booked':'Book your coaching call';
    var nextNote=(st.upcoming&&st.upcoming.displayTime)?('Next call '+st.upcoming.displayTime+' · '):'';
    if(s) s.textContent=st.booked?((st.displayTime?st.displayTime+' · ':'')+'Tap to view or rebook'):(nextNote+'30 min with Karl & Alex · Tap to open booking');
    if(a) a.style.color=st.booked?'#22c55e':'#f59e0b';
  }
  syncWeekCardState();
  return st;
}
var _callBookingRefreshTimer=null;
function applyCloudBookingRows(rows){
  var prefix=callBookedPrefix();
  (rows||[]).forEach(function(row){
    var key=String(row&&row.key||'');
    if(!/^call_booked_\d{4}_\d{2}$/.test(key))return;
    var suffix=key.slice('call_booked_'.length);
    localStorage.setItem(prefix+suffix,JSON.stringify(row.value));
  });
  // If the widget could not expose a timestamp, it temporarily marked the
  // current week locally. Once the webhook supplies an authoritative booking
  // in another week, remove that optimistic flag rather than showing a
  // timeless confirmation in the wrong week.
  var currentSuffix=callWeekSuffix(),currentRaw=parseBookedValue(localStorage.getItem(prefix+currentSuffix));
  var hasDatedFuture=(rows||[]).some(function(row){
    var key=String(row&&row.key||''),suffix=key.slice('call_booked_'.length),v=parseBookedValue(JSON.stringify(row&&row.value));
    return /^call_booked_\d{4}_\d{2}$/.test(key)&&suffix>currentSuffix&&v&&v.time;
  });
  // Older builds accidentally uploaded the timestamp-free flag too. A dated
  // future row is more authoritative and must displace that stale placeholder.
  if(currentRaw&&!currentRaw.time&&hasDatedFuture)localStorage.removeItem(prefix+currentSuffix);
}
async function refreshCallBookingsFromCloud(attempt){
  attempt=attempt||0;
  if(!_authToken||!athlete||!athlete.code)return;
  try{
    var before=getCallBookedState();
    // Repair historic placeholder rows immediately. The server resolves this
    // authenticated athlete only and pulls their real appointment from GHL;
    // later retries stay cheap and read Supabase only.
    var action=(attempt===0&&before.booked&&!before.displayTime)?'booking-sync':'booking-read';
    var result=await portalRequest(action);
    applyCloudBookingRows(result.rows||[]);
    var state=renderBookingPrompts();
    if((state.booked&&state.displayTime)||(!state.booked&&state.upcoming&&state.upcoming.displayTime))return;
  }catch(e){console.warn('Booking time refresh failed',e);}
  if(attempt<2){
    if(_callBookingRefreshTimer)clearTimeout(_callBookingRefreshTimer);
    _callBookingRefreshTimer=setTimeout(function(){refreshCallBookingsFromCloud(attempt+1);},attempt===0?2500:6000);
  }
}
function initCallNudge(){
  var state=renderBookingPrompts();
  if(state.booked&&!state.displayTime)refreshCallBookingsFromCloud(0);
}
function checkinWeekSuffix(date){
  var d=new Date(date||new Date());d.setHours(0,0,0,0);
  // Weeks reset at Monday midnight. The form's completion state is therefore
  // never carried into the new week, even when last week's form was submitted
  // late on Sunday.
  d.setDate(d.getDate()+3-(d.getDay()+6)%7);
  var w1=new Date(d.getFullYear(),0,4);
  var isoWeek=1+Math.round(((d-w1)/86400000-3+(w1.getDay()+6)%7)/7);
  var isoYear=d.getFullYear();
  return isoYear+'_'+(isoWeek<10?'0':'')+isoWeek;
}
function checkinStateKey(date){return'checkin_'+checkinWeekSuffix(date);}
function checkinWeekKey(date){
  // The browser cache must be athlete-scoped. Coaches commonly open several
  // client portals on one device; the old unscoped dp_checkin_2026_31 key let
  // one athlete's submission hide every other athlete's nudge that week.
  var acode=(athlete&&athlete.code)?String(athlete.code).toUpperCase()+'_':'';
  return'dp_checkin_'+acode+checkinWeekSuffix(date);
}
function initCheckinNudge(){
  var nudge=document.getElementById('checkinNudge');
  if(!nudge) return;
  // Once this week's form is submitted the row has nothing left to say, so it
  // unmounts rather than lingering as a completed state.
  var done=!!localStorage.getItem(checkinWeekKey());
  nudge.style.display=done?'none':'';
  var mobileDot=document.getElementById('mobileCheckinDot');if(mobileDot)mobileDot.classList.toggle('visible',!done);
  syncWeekCardState();
}
function hideCheckinNudge(){
  localStorage.setItem(checkinWeekKey(),'1');
  dismissNudge(document.getElementById('checkinNudge'));
  var mobileDot=document.getElementById('mobileCheckinDot');if(mobileDot)mobileDot.classList.remove('visible');
}
function initPhotoNudge(){
  var nudge=document.getElementById('photoNudge');
  if(!nudge) return;
  var week=getCurrentProgrammeWeek();
  var photos=JSON.parse(localStorage.getItem('dp_photos_'+athlete.code)||'{}');
  var angleKeys=['front','side','back','front_flexed','back_flexed'];
  var weekPhotos=photos['week'+week]||{};
  var complete=angleKeys.every(function(key){return !!weekPhotos[key];});
  // Completing the set while the athlete is looking at the row collapses it
  // out; on a fresh load there is nothing to animate, so it is simply absent.
  if(complete&&nudgeVisible(nudge)) dismissNudge(nudge);
  else nudge.style.display=complete?'none':'';
  var dot=document.getElementById('tabDotProgress');
  if(dot) dot.classList.toggle('visible',!complete);
  var mobileDot=document.getElementById('mobileProgressDot');if(mobileDot)mobileDot.classList.toggle('visible',!complete);
  syncWeekCardState();
}
function hidePhotoNudge(){
  dismissNudge(document.getElementById('photoNudge'));
  var dot=document.getElementById('tabDotProgress');
  if(dot) dot.classList.remove('visible');
  var mobileDot=document.getElementById('mobileProgressDot');if(mobileDot)mobileDot.classList.remove('visible');
  syncWeekCardState();
}
function openCallBooking(){
  switchTab('checkin');
  setTimeout(function(){ openCallModal(); },180);
}
function openCallModal(){
  var m=document.getElementById('callModal');
  var f=document.getElementById('WRivrNxfNTVER2xMit1z_1782710919820');
  if(f){var ds=f.getAttribute('data-src'); if(ds&&f.src.indexOf('leadconnectorhq')===-1) f.src=ds;}
  if(m) m.classList.add('open');
  document.body.style.overflow='hidden';
}
function closeCallModal(){
  var m=document.getElementById('callModal');
  if(m) m.classList.remove('open');
  document.body.style.overflow='';
}
// ---- Booking confirmation (GHL / LeadConnector, with legacy Calendly fallback) ----
function dpFormatBookedTime(iso){
  try{
    if(!iso) return '';
    var d=new Date(iso);
    if(isNaN(d)) return '';
    return d.toLocaleDateString('en-AU',{timeZone:'Australia/Adelaide',weekday:'short',day:'numeric',month:'short'}).replace(',','')+
      ' · '+d.toLocaleTimeString('en-AU',{timeZone:'Australia/Adelaide',hour:'numeric',minute:'2-digit',hour12:true}).toLowerCase();
  }catch(ex){return '';}
}
function dpBookingStart(value){
  if(value==null||value==='')return null;
  var d=new Date(typeof value==='number'?value:String(value));
  return isNaN(d)?null:d;
}
function dpExtractBookingStart(data,payloadStr){
  var d=(data&&typeof data==='object')?data:{};
  var direct=[d.startTime,d.start_time,d.appointment_start_time,d.selectedSlot,d.selected_slot,
    d.appointment&&(d.appointment.startTime||d.appointment.start_time),
    d.payload&&(d.payload.startTime||d.payload.start_time||d.payload.selectedSlot||d.payload.selected_slot),
    d.data&&(d.data.startTime||d.data.start_time||d.data.selectedSlot||d.data.selected_slot)];
  for(var i=0;i<direct.length;i++){var found=dpBookingStart(direct[i]);if(found)return found;}
  var queue=[d],seen=[],depth=0;
  while(queue.length&&depth<80){
    var obj=queue.shift();depth++;
    if(!obj||typeof obj!=='object'||seen.indexOf(obj)>=0)continue;seen.push(obj);
    Object.keys(obj).forEach(function(key){
      var value=obj[key];
      if(/(?:start.*time|appointment.*start|selected.*slot|slot.*time)/i.test(key))direct.push(value);
      if(value&&typeof value==='object')queue.push(value);
    });
  }
  for(var j=0;j<direct.length;j++){var nested=dpBookingStart(direct[j]);if(nested)return nested;}
  var matches=String(payloadStr||'').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g)||[];
  for(var k=0;k<matches.length;k++){var fallback=dpBookingStart(matches[k]);if(fallback)return fallback;}
  return null;
}
function dpMarkCallBooked(startTime){
  var start=dpBookingStart(startTime);
  var wkey=callNudgeWeekKey(start||new Date());
  var saveVal=start?{time:dpFormatBookedTime(start),startsAt:start.toISOString()}:'1';
  localStorage.setItem(wkey,JSON.stringify(saveVal));
  renderBookingPrompts();
  setTimeout(function(){try{closeCallModal();}catch(ex){}},1500);
  if(_authToken&&athlete&&athlete.code){
    var _wkpfx='dp_call_booked_'+athlete.code.toUpperCase()+'_';
    var sbKey='call_booked_'+wkey.slice(_wkpfx.length);
    // Never let a timestamp-free widget success overwrite the authoritative
    // webhook value. When a real start is available both paths store the same
    // dated shape; otherwise the portal waits for booking-read to hydrate it.
    if(start)portalStateWrite(sbKey,saveVal).catch(function(err){console.warn('Call booked sync failed:',err);});
    refreshCallBookingsFromCloud(0);
  }
}
var _progressModulePromise=null;
function ensureProgressModule(){
  if(typeof loadProgress==='function')return Promise.resolve();
  if(_progressModulePromise)return _progressModulePromise;
  _progressModulePromise=new Promise(function(resolve,reject){
    var mount=document.getElementById('progressModuleAsset');
    var src=mount&&mount.getAttribute('data-src');
    if(!src){reject(new Error('Progress module asset is missing'));return;}
    var script=document.createElement('script');script.src=src;script.async=true;
    script.onload=function(){typeof loadProgress==='function'?resolve():reject(new Error('Progress module did not initialise'));};
    script.onerror=function(){reject(new Error('Progress module failed to load'));};
    document.body.appendChild(script);
  });
  return _progressModulePromise;
}
window.addEventListener('message',function(e){
  if(!e.data) return;
  // GHL / LeadConnector booking confirmation
  var fromGhl=(typeof e.origin==='string')&&/(leadconnectorhq|msgsndr)\.com/i.test(e.origin);
  if(fromGhl){
    var payloadStr='';
    try{payloadStr=(typeof e.data==='string')?e.data:JSON.stringify(e.data);}catch(ex){}
    if(/appointment|booking/i.test(payloadStr)&&/(book|confirm|success|created|scheduled|complete)/i.test(payloadStr)){
      var d=(typeof e.data==='object')?e.data:{};
      dpMarkCallBooked(dpExtractBookingStart(d,payloadStr));
      return;
    }
  }
  // Legacy Calendly fallback
  if(e.data.event&&e.data.event==='calendly.event_scheduled'){
    var startTime=e.data.payload&&e.data.payload.event&&e.data.payload.event.start_time;
    dpMarkCallBooked(startTime);
  }
});

function switchTab(tab){
  document.body.setAttribute('data-active-tab',tab); // desktop: hero shows on Today only
  document.querySelectorAll('.tab').forEach(function(t){var active=t.dataset.tab===tab;t.classList.toggle('active',active);t.setAttribute('aria-selected',active?'true':'false');});
  document.querySelectorAll('.tab-content').forEach(function(c){c.classList.toggle('active',c.id==='tab-'+tab);});
  document.querySelectorAll('[data-portal-dest]').forEach(function(item){item.classList.toggle('active',item.dataset.portalDest===tab);});
  var sectionLabel=document.getElementById('portalSectionLabel');
  if(sectionLabel){
    var labels={training:'Today\'s Plan',weekly:'Weekly Plan',nutrition:'Nutrition',checkin:'Weekly Check-in',progress:'Progress',goals:'Goals',handbook:'Athlete Guide',comms:'Contact'};
    sectionLabel.textContent=labels[tab]||'Athlete Portal';
  }
  toggleMoreMenu(false);
  var isDesktop=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  var secondaryTabs=['nutrition','goals','handbook','comms'];
  var isMobileSecondary=!isDesktop&&secondaryTabs.indexOf(tab)>=0;
  setMobileNav(tab==='weekly'?'training':(tab==='training'?'home':(isMobileSecondary?'more':tab)));
  var showWeekBar=(tab==='weekly')||(!isDesktop&&tab==='training'&&trainingView==='plan');
  document.body.classList.toggle('mobile-training-calendar',!isDesktop&&tab==='training'&&trainingView==='plan');
  document.body.classList.toggle('mobile-portal-home',!isDesktop&&tab==='training'&&trainingView==='home');
  document.body.classList.toggle('mobile-checkin-tab',!isDesktop&&tab==='checkin');
  document.body.classList.toggle('mobile-progress-tab',!isDesktop&&tab==='progress');
  document.body.classList.toggle('mobile-secondary-tab',isMobileSecondary);
  syncMobileHomePlacement();
  document.getElementById('wbar').style.display=showWeekBar?'':'none';
  if(tab==='nutrition'&&Date.now()-_nutLastLoad>60000) loadNutrition(); // skip refetch if loaded <60s ago (week shifts & post-save always reload directly)
  if(tab==='checkin'){
    initCheckin();
    if(!isDesktop) window.scrollTo({top:0,behavior:'smooth'});
  }
  if(isMobileSecondary) window.scrollTo({top:0,behavior:'smooth'});
  if(tab==='progress')ensureProgressModule().then(function(){loadProgress();}).catch(function(){showToast('Progress is unavailable — check your connection');});
  if(tab==='training'||tab==='weekly') applyTrainingView();
}

function setMobileNav(tab){
  document.querySelectorAll('.mobile-nav-item').forEach(function(item){
    var active=item.dataset.mobileTab===tab;
    item.classList.toggle('active',active);
    if(active) item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');
  });
}
// Mobile keeps the home/training split inside one tab. Desktop now has
// separate tabs: Today's Plan and Weekly Plan.
var trainingView='home';
function syncMobileHomePlacement(){
  var today=document.getElementById('todayEl');
  var anchor=document.getElementById('todayHomeAnchor');
  var topShell=document.querySelector('.top-shell');
  var priority=document.querySelector('.top-shell-priority');
  if(!today||!anchor||!topShell||!priority)return;
  if(document.body.classList.contains('mobile-portal-home')){
    if(today.parentNode!==topShell)topShell.insertBefore(today,priority);
  }else if(anchor.parentNode&&today.parentNode!==anchor.parentNode){
    anchor.parentNode.insertBefore(today,anchor.nextSibling);
  }
}
function applyTrainingView(){
  var t=document.getElementById('todayEl');
  var c=document.getElementById('calEl');
  var wc=document.getElementById('weeklyCalEl');
  var wb=document.getElementById('wbar');
  // The volume strip sits with #calEl on mobile and #weeklyCalEl on desktop,
  // so it follows the plan view's visibility.
  var vs=document.getElementById('trainingVolumeStrip');
  var trainingTab=document.getElementById('tab-training');
  var weeklyTab=document.getElementById('tab-weekly');
  var isDesktop=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  var trainingActive=!!(trainingTab&&trainingTab.classList.contains('active'));
  document.body.classList.toggle('mobile-portal-home',!isDesktop&&trainingActive&&trainingView==='home');
  syncMobileHomePlacement();
  if(isDesktop){
    var weeklyActive=!!(weeklyTab&&weeklyTab.classList.contains('active'));
    if(t&&t.innerHTML)t.style.display=trainingActive?'block':'none';
    if(c&&c.innerHTML)c.style.display='none';
    if(wc&&wc.innerHTML)wc.style.display=weeklyActive?'block':'none';
    if(wb)wb.style.display=weeklyActive?'':'none';
    if(vs)vs.style.display='none';
    return;
  }
  if(!trainingTab||!trainingTab.classList.contains('active'))return;
  if(t&&t.innerHTML)t.style.display=(trainingView==='plan')?'none':'block';
  if(c&&c.innerHTML)c.style.display=(trainingView==='home')?'none':'block';
  if(vs&&vs.innerHTML)vs.style.display=(trainingView==='home')?'none':'block';
  if(wc&&wc.innerHTML)wc.style.display='none';
  if(wb)wb.style.display=(trainingView==='home')?'none':'';
}
if(window.matchMedia){
  var portalDesktopQuery=window.matchMedia('(min-width:900px)');
  if(portalDesktopQuery.addEventListener)portalDesktopQuery.addEventListener('change',applyTrainingView);
  else if(portalDesktopQuery.addListener)portalDesktopQuery.addListener(applyTrainingView);
}
function goPortalHome(){
  // Home = TODAY: current week, today panel, nothing else.
  trainingView='home';
  switchTab('training');setMobileNav('home');
  if(weekOffset!==0){weekOffset=0;loadWeek();}
  applyTrainingView();
  window.scrollTo({top:0,behavior:'smooth'});
}
function goTrainingPlan(){
  // Desktop jumps to the dedicated Weekly Plan tab. Mobile keeps the original
  // single-tab split and opens the plan view inside Training.
  trainingView='plan';
  var isDesktop=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  switchTab(isDesktop?'weekly':'training');setMobileNav('training');
  if(typeof collapseTrainingVolumeStrips==='function')collapseTrainingVolumeStrips();
  applyTrainingView();
  window.scrollTo({top:0,behavior:'smooth'});
}
function openReschedule(i){
  var input=document.getElementById('reschedule_'+i);if(!input)return;
  if(input.showPicker)input.showPicker();else input.click();
}
function setSessionDateOverride(sessionId,date,options){
  options=options||{};
  if(!sessionId||!/^\d{4}-\d{2}-\d{2}$/.test(String(date||'')))return false;
  var match=allSessions.find(function(s){return s.id===sessionId;});if(!match)return false;
  var map={};try{map=JSON.parse(localStorage.getItem('dp_reschedules_'+athlete.code)||'{}');}catch(e){}
  if(match.plannedDate&&date===match.plannedDate)delete map[sessionId];else map[sessionId]=date;
  localStorage.setItem('dp_reschedules_'+athlete.code,JSON.stringify(map));
  match.date=date;match.rescheduled=!!(match.plannedDate&&date!==match.plannedDate);
  var ws=getWS(),we=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+6),wsISO=localISO(ws),weISO=localISO(we);
  sessions=allSessions.filter(function(s){return s.date&&s.date>=wsISO&&s.date<=weISO;});
  renderTodaySection();renderCal(ws);
  if(dayPlanDateISO)renderDayPlanDate(dayPlanDateISO);
  if(!options.silent)showToast('Session moved to '+localDateFromISO(date).toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})+' · syncing');
  return true;
}
function rescheduleSession(i,date,options){
  var s=sessions[i];if(!s)return false;
  return setSessionDateOverride(s.id,date,options);
}
var REMINDER_OPTIONS=[
  {key:'sessions',icon:'calendar',label:'Training sessions',sub:'Before planned training'},
  {key:'checkins',icon:'clipboard',label:'Weekly check-ins',sub:'When your review is due'},
  {key:'photos',icon:'camera',label:'Progress photos',sub:'On your scheduled photo week'},
  {key:'coach',icon:'chat',label:'Coach replies',sub:'When coaching feedback arrives'}
];
function getReminderPreferences(){try{return JSON.parse(localStorage.getItem('dp_reminders_'+((athlete&&athlete.code)||'default'))||'{}');}catch(e){return{};}}
function openPreferences(){
  toggleMoreMenu(false);var prefs=getReminderPreferences(),list=document.getElementById('notificationPreferences');
  list.innerHTML=REMINDER_OPTIONS.map(function(o){return '<label class="preference-row"><span class="preference-icon"><svg class="icon"><use href="#i-'+o.icon+'"/></svg></span><span><strong>'+o.label+'</strong><small>'+o.sub+'</small></span><input type="checkbox" '+(prefs[o.key]?'checked':'')+' onchange="setReminderPreference(\''+o.key+'\',this.checked)"><i></i></label>';}).join('')
    +'<div id="pushStatus" class="push-status">Notifications · '+(localStorage.getItem('dp_push_status')||'not set up yet')+'</div>';
  syncPushSubscription();
  setMobileNav('more');document.getElementById('preferencesModal').classList.add('open');document.body.style.overflow='hidden';
}
function closePreferences(){document.getElementById('preferencesModal').classList.remove('open');document.body.style.overflow='';restoreMobileNavContext();}
async function setReminderPreference(key,enabled){
  var wanted=enabled;
  if(enabled&&'Notification'in window&&Notification.permission==='default'){try{var permission=await Notification.requestPermission();if(permission!=='granted')enabled=false;}catch(e){enabled=false;}}
  if(enabled&&'Notification'in window&&Notification.permission==='denied')enabled=false;
  var prefs=getReminderPreferences();prefs[key]=enabled;localStorage.setItem('dp_reminders_'+athlete.code,JSON.stringify(prefs));
  if(wanted&&!enabled){
    // Permission was refused — keep the toggle honest.
    var idx=REMINDER_OPTIONS.map(function(o){return o.key;}).indexOf(key);
    var inputs=document.querySelectorAll('#notificationPreferences input');
    if(idx>-1&&inputs[idx])inputs[idx].checked=false;
    showToast('Notifications are blocked — allow them in your browser or phone settings','error');
  } else {
    showToast(enabled?'Reminder enabled':'Reminder disabled');
  }
  syncPushSubscription();
}
function getWeeklySummary(){
  var insight=getHomeInsights(),volume=0,wins=[];
  sessions.forEach(function(s){var entry=logs[s.id];if(!entry||typeof entry!=='object')return;Object.keys(entry).forEach(function(k){if(!Array.isArray(entry[k]))return;entry[k].forEach(function(set){var w=parseFloat(set.weight),r=parseInt(set.reps,10);if(!isNaN(w)&&!isNaN(r))volume+=w*r;});});if(isSessionLogged(s.id))wins.push(s.name);});
  return {insight:insight,volume:Math.round(volume),wins:wins};
}
function openWeeklySummary(){
  toggleMoreMenu(false);var s=getWeeklySummary(),i=s.insight,body=document.getElementById('weeklySummaryBody');
  body.innerHTML='<div class="summary-week-label">Programme · Week '+getCurrentProgrammeWeek()+'</div><div class="summary-hero"><div class="summary-ring" style="--value:'+i.compliance+'"><strong>'+i.compliance+'%</strong></div><div><strong>Week completion</strong><small>'+i.completed+' of '+i.planned+' planned sessions complete'+(i.completed<i.planned?' · still underway':' · week complete')+'</small></div></div><div class="summary-grid"><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-barbell"/></svg></span><small>Training volume</small><strong>'+s.volume.toLocaleString()+'kg</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-pulse"/></svg></span><small>Readiness</small><strong>'+(i.readiness==null?'Not logged':i.readiness+'/100')+'</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-run"/></svg></span><small>Running</small><strong>'+(i.kmTarget?i.kmDone.toFixed(1)+' / '+i.kmTarget.toFixed(1)+'km':'No target')+'</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-trophy"/></svg></span><small>PB history</small><strong>'+i.pbs+' exercises</strong></div></div><div class="summary-wins"><span class="summary-metric-icon"><svg class="icon"><use href="#i-trophy"/></svg></span><div><strong>Wins this week</strong><p>'+(s.wins.length?s.wins.map(esc).join(' · '):'Log your first completed session to start building the week.')+'</p></div></div>'+renderCoachMoment([]);
  setMobileNav('more');document.getElementById('weeklySummaryModal').classList.add('open');document.body.style.overflow='hidden';
}
function closeWeeklySummary(){document.getElementById('weeklySummaryModal').classList.remove('open');document.body.style.overflow='';restoreMobileNavContext();}
function getPbHistoryData(){
  var exerciseMap={},sessionMap={};
  (allSessions||[]).concat(sessions||[]).forEach(function(s){if(s&&s.id)sessionMap[s.id]=s;});
  Object.keys(logs||{}).forEach(function(sessionId,order){
    if(sessionId.indexOf('__')===0)return;var entry=logs[sessionId];if(!entry||typeof entry!=='object'||Array.isArray(entry))return;
    Object.keys(entry).forEach(function(name){
      if(name.indexOf('__')===0||!Array.isArray(entry[name]))return;var clean=pbCleanSets(entry[name]);if(!clean.length)return;
      var key=pbNormName(name),item=exerciseMap[key]||(exerciseMap[key]={name:name,sessions:[]});
      var matched=sessionMap[sessionId],date=matched&&matched.date?matched.date:'';
      var load=Math.max.apply(null,clean.map(function(s){return s.weight;}));
      var e1rms=clean.map(function(s){return pbE1rm(s.weight,s.reps);}).filter(function(v){return v!=null;});
      var volume=clean.reduce(function(sum,s){return sum+(s.reps<=PB_REP_CAP?s.weight*s.reps:0);},0);
      item.sessions.push({id:sessionId,date:date,order:order,sets:clean,load:load,e1rm:e1rms.length?Math.max.apply(null,e1rms):null,volume:volume});
    });
  });
  return Object.keys(exerciseMap).map(function(key){
    var item=exerciseMap[key];item.sessions.sort(function(a,b){return(a.date||'9999').localeCompare(b.date||'9999')||a.order-b.order;});
    var best={load:0,e1rm:0,volume:0,date:'',previousLoad:null},records=[];
    item.sessions.forEach(function(s){if(s.load>best.load){records.push(s.load);best.previousLoad=records.length>1?records[records.length-2]:null;best.load=s.load;best.date=s.date||best.date;}best.e1rm=Math.max(best.e1rm,s.e1rm||0);best.volume=Math.max(best.volume,s.volume||0);});
    item.best=best;return item;
  }).sort(function(a,b){return a.name.localeCompare(b.name);});
}
function formatPbDate(value){if(!value)return'No date recorded';var d=localDateFromISO(value);return isNaN(d.getTime())?value:d.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'});}
function renderPbHistory(query){
  var list=document.getElementById('pbHistoryList');if(!list)return;var q=String(query||'').trim().toLowerCase();
  var data=getPbHistoryData().filter(function(item){return !q||item.name.toLowerCase().indexOf(q)>=0;});
  document.getElementById('pbHistorySubtitle').textContent=data.length+(data.length===1?' exercise':' exercises')+' with recorded history';
  if(!data.length){list.innerHTML='<div class="pb-history-empty">No matching exercise history yet.</div>';return;}
  list.innerHTML=data.map(function(item){
    var b=item.best,delta=b.previousLoad!=null?b.load-b.previousLoad:null;
    var history=item.sessions.slice().reverse().map(function(s){return '<div class="pb-session-row"><span>'+esc(formatPbDate(s.date))+'</span><strong>'+s.sets.map(function(set){return esc(set.weight)+'kg × '+esc(set.reps);}).join(' · ')+'</strong></div>';}).join('');
    return '<details class="pb-history-card"><summary><div class="pb-history-heading"><span>'+esc(item.name)+'</span><small>'+esc(formatPbDate(b.date))+'</small></div><div class="pb-load"><strong>'+esc(pbRound1(b.load))+'kg</strong><small>'+(delta!=null&&delta>0?'+'+esc(pbRound1(delta))+'kg from prior PB':'Load PB')+'</small></div></summary><div class="pb-metrics"><div><small>Estimated 1RM</small><strong>'+(b.e1rm?esc(pbRound1(b.e1rm))+'kg':'—')+'</strong></div><div><small>Volume PB</small><strong>'+(b.volume?esc(Math.round(b.volume).toLocaleString())+'kg':'—')+'</strong></div><div><small>Sessions</small><strong>'+item.sessions.length+'</strong></div></div><div class="pb-session-history"><div class="pb-session-title">Recorded sets</div>'+history+'</div></details>';
  }).join('');
}
function openPbHistory(){var modal=document.getElementById('pbHistoryModal'),search=document.getElementById('pbHistorySearch');if(search)search.value='';renderPbHistory('');modal.classList.add('open');document.body.style.overflow='hidden';setTimeout(function(){if(search)search.focus();},80);}
function closePbHistory(){document.getElementById('pbHistoryModal').classList.remove('open');document.body.style.overflow='';}
function exportAthleteData(){
  var data={exportedAt:new Date().toISOString(),athlete:{name:athlete.name,code:athlete.code},logs:logs,goals:JSON.parse(localStorage.getItem('dp_goals_'+athlete.code)||'{}'),photos:getPhotos(),reminders:getReminderPreferences()};
  var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='dual-performance-'+athlete.code+'-data.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function toggleMoreMenu(open){
  var menu=document.getElementById('moreMenu');if(!menu)return;
  var shouldOpen=typeof open==='boolean'?open:!menu.classList.contains('open');
  menu.classList.toggle('open',shouldOpen);menu.setAttribute('aria-hidden',shouldOpen?'false':'true');
  var button=document.querySelector('[data-mobile-tab="more"]');if(button)button.setAttribute('aria-expanded',shouldOpen?'true':'false');
  document.body.classList.toggle('menu-open',shouldOpen);
  if(shouldOpen)setMobileNav('more');else restoreMobileNavContext();
}
function restoreMobileNavContext(){
  var active=document.querySelector('.tab-content.active');if(!active)return;
  var tab=active.id.replace('tab-','');
  if(tab==='training'){setMobileNav(trainingView==='home'?'home':'training');return;}
  if(tab==='weekly'){setMobileNav('training');return;}
  if(['nutrition','goals','handbook','comms'].indexOf(tab)>=0){setMobileNav('more');return;}
  setMobileNav(tab);
}
function applyOutdoorMode(enabled){
  document.documentElement.classList.toggle('outdoor-mode',!!enabled);
  var button=document.getElementById('themeToggle');
  if(button){
    button.setAttribute('aria-pressed',enabled?'true':'false');
    var label=button.querySelector('.theme-toggle-label');if(label)label.textContent=enabled?'Indoor':'Outdoor';
    var hint=enabled?'Switch to indoor mode':'Switch to outdoor mode';
    button.title=hint;button.setAttribute('aria-label',hint);
  }
  var moreLabel=document.querySelector('.more-outdoor strong');if(moreLabel)moreLabel.textContent=enabled?'Indoor mode':'Outdoor mode';
  var moreSub=document.querySelector('.more-outdoor small');if(moreSub)moreSub.textContent=enabled?'Return to the dark indoor theme':'Use the light theme in bright conditions';
  try{localStorage.setItem('dp_outdoor_mode',enabled?'1':'0');}catch(e){}
}
function toggleOutdoorMode(){applyOutdoorMode(!document.documentElement.classList.contains('outdoor-mode'));}
try{applyOutdoorMode(localStorage.getItem('dp_outdoor_mode')==='1');}catch(e){applyOutdoorMode(false);}
