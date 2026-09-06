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
// ── NUDGE PRIORITY ────────────────────────────────────────────────────────────
// The card could stack five demands above today's session. On a first login
// that is five things we want FROM the athlete before one thing we are giving
// them. So: one due nudge stays in place, everything else due collapses behind
// a single summary row, closed on every load.
//
// The rows cannot move in index.html — check-portal.mjs asserts #goalsBanner's
// position inside .top-shell-priority — so the ordering happens here, at
// runtime, on the live nodes.
//
// Collapsing uses a class, never an inline style. Each nudge's own init writes
// el.style.display and must stay the single authority on whether it is due at
// all; this pass only decides whether a due row is shown now or folded away.
var NUDGE_PRIORITY=['callNudge','goalsBanner','checkinNudge','photoNudge'];
var _nudgeSummaryOpen=false,_nudgeSummaryHidden=0,_nudgePriorityPass=false;
function nudgeSummaryRow(card){
  var row=document.getElementById('nudgeSummaryRow');
  if(row) return row;
  row=document.createElement('button');
  row.type='button';
  row.id='nudgeSummaryRow';
  row.className='nudge-strip nudge-summary';
  row.style.display='none';
  row.setAttribute('aria-expanded','false');
  row.innerHTML='<span class="nudge-strip-inner"><span class="nudge-strip-text"><span class="nudge-strip-title" id="nudgeSummaryLabel"></span></span><span class="nudge-strip-arr"><svg class="icon"><use href="#i-chevron-right"/></svg></span></span>';
  row.addEventListener('click',toggleNudgeSummary);
  card.appendChild(row);
  return row;
}
function toggleNudgeSummary(){
  _nudgeSummaryOpen=!_nudgeSummaryOpen;
  if(_nudgeSummaryOpen) track('nudge_summary_expanded',{hidden:_nudgeSummaryHidden});
  syncWeekCardState();
}
function applyNudgePriority(card){
  var row=nudgeSummaryRow(card);
  var nodes=NUDGE_PRIORITY.map(function(id){return document.getElementById(id);});
  // A confirmed call is useful status rather than another demand, but it still
  // answers the most important weekly question. Pin it above the collapsed
  // demand stack; when no call is booked, callNudge leads NUDGE_PRIORITY.
  var confirmed=document.getElementById('callConfirmedNudge');
  if(confirmed&&!confirmed.classList.contains('is-clearing')&&nudgeVisible(confirmed)&&card.firstElementChild!==confirmed){
    card.insertBefore(confirmed,card.firstElementChild);
  }
  // Start from each row's own state. Reading dueness through our own collapse
  // would fold the same rows away permanently after the first pass.
  nodes.forEach(function(el){if(el) el.classList.remove('nudge-collapsed');});
  var due=nodes.filter(function(el){
    return el&&el.classList.contains('is-due')&&!el.classList.contains('is-clearing')&&nudgeVisible(el);
  });
  // One demand needs no summary row, and none needs nothing at all.
  if(due.length<2){
    row.style.display='none';
    _nudgeSummaryOpen=false;_nudgeSummaryHidden=0;
    return;
  }
  var hidden=due.slice(1);
  _nudgeSummaryHidden=hidden.length;
  row.style.display='';
  // The summary row sits directly under the nudge that stayed, and the folded
  // rows sit under the summary row, so expanding reads top to bottom instead
  // of revealing rows above the control that opened them. #callConfirmedNudge
  // is a done state rather than a demand, so it is left exactly where it is.
  if(due[0].nextSibling!==row) card.insertBefore(row,due[0].nextSibling);
  var anchor=row;
  hidden.forEach(function(el){
    if(anchor.nextSibling!==el) card.insertBefore(el,anchor.nextSibling);
    anchor=el;
    if(!_nudgeSummaryOpen) el.classList.add('nudge-collapsed');
  });
  var label=document.getElementById('nudgeSummaryLabel');
  if(label) label.textContent=_nudgeSummaryOpen?'Show less':(hidden.length+(hidden.length===1?' more thing':' more things')+' this week');
  row.setAttribute('aria-expanded',_nudgeSummaryOpen?'true':'false');
  row.classList.toggle('is-open',_nudgeSummaryOpen);
}
function syncWeekCardState(){
  var card=document.querySelector('.top-shell-priority');
  if(!card) return;
  // Priority runs first so the row count below reflects what is actually on
  // screen. Guarded because the pass itself must never re-enter this.
  if(!_nudgePriorityPass){
    _nudgePriorityPass=true;
    try{applyNudgePriority(card);}catch(e){console.warn('Nudge priority pass failed',e);}
    _nudgePriorityPass=false;
  }
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
// The portal's current week still resets at Monday midnight. Appointment dates
// use a separate booking-cycle helper below because Saturday, Sunday and Monday
// calls all review the week that just finished.
function callAdelaideDate(date){
  var p={};
  try{
    new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Adelaide',year:'numeric',month:'2-digit',day:'2-digit'})
      .formatToParts(date).forEach(function(x){p[x.type]=x.value;});
    return new Date(Number(p.year),Number(p.month)-1,Number(p.day));
  }catch(e){return new Date(date);}
}
function callIsoWeekSuffix(localDate){
  var d=new Date(localDate);d.setHours(0,0,0,0);
  d.setDate(d.getDate()+3-(d.getDay()+6)%7);
  var w1=new Date(d.getFullYear(),0,4);
  var isoWeek=1+Math.round(((d-w1)/86400000-3+(w1.getDay()+6)%7)/7);
  return d.getFullYear()+'_'+(isoWeek<10?'0':'')+isoWeek;
}
function callWeekSuffix(date){
  return callIsoWeekSuffix(callAdelaideDate(new Date(date||new Date())));
}
function callBookingWeekSuffix(date){
  var d=callAdelaideDate(new Date(date||new Date()));
  if(d.getDay()===1)d.setDate(d.getDate()-1);
  return callIsoWeekSuffix(d);
}
function callBookedPrefix(){
  var acode=(athlete&&athlete.code)?athlete.code.toUpperCase()+'_':'';
  return 'dp_call_booked_'+acode;
}
function callNudgeWeekKey(date){return callBookedPrefix()+callBookingWeekSuffix(date);}
// Three stored shapes, all still in the wild:
//   {time,startsAt,eventId,calendarId}  current — written by the webhook/sync
//   "Tue 15 Jul · 6:30 pm"  older server rows and portal self-reports
//   "1"              legacy flag: booked, but the time was never captured
function parseBookedValue(raw){
  if(!raw) return null;
  var parsed=raw;
  try{parsed=JSON.parse(raw);}catch(e){}
  if(parsed&&typeof parsed==='object'){
    var startsAt=parsed.startsAt||parsed.startTime||parsed.start_time||'';
    return {
      time:String(parsed.time||parsed.displayTime||dpFormatBookedTime(startsAt)||''),
      startsAt:startsAt,
      eventId:String(parsed.eventId||parsed.event_id||''),
      calendarId:String(parsed.calendarId||parsed.calendar_id||'')
    };
  }
  var t=(parsed==='1'||parsed===1)?'':String(parsed||'');
  var d=/^\d{4}-\d{2}-\d{2}T/.test(t)?new Date(t):null;
  return {time:(d&&!isNaN(d))?dpFormatBookedTime(d):t,startsAt:(d&&!isNaN(d))?d.toISOString():'',eventId:'',calendarId:''};
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
      if(!upcoming||suffix<upcoming.week) upcoming={week:suffix,displayTime:v.time,startsAt:v.startsAt,eventId:v.eventId,calendarId:v.calendarId};
    }
  }catch(e){}
  return {
    booked:!!current,
    displayTime:(current&&current.time)||'',
    startsAt:(current&&current.startsAt)||'',
    eventId:(current&&current.eventId)||'',
    calendarId:(current&&current.calendarId)||'',
    storageKey:current?(prefix+thisWeek):'',
    upcoming:upcoming
  };
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
  try{if(document.getElementById('callsSurface'))renderCallsTab();}catch(e){}
  return st;
}
var _callBookingRefreshTimer=null,_callBookingLastSyncAt=0;
function applyCloudBookingRows(rows,authoritative){
  var prefix=callBookedPrefix();
  var cloudKeys={};
  (rows||[]).forEach(function(row){
    var key=String(row&&row.key||'');
    if(!/^call_booked_\d{4}_\d{2}$/.test(key))return;
    var suffix=key.slice('call_booked_'.length);
    cloudKeys[prefix+suffix]=true;
    localStorage.setItem(prefix+suffix,JSON.stringify(row.value));
  });
  // booking-sync has just reconciled Supabase with GHL, so absence is
  // authoritative. Remove local weekly rows that no longer exist in cloud;
  // booking-read alone never prunes because a webhook may still be arriving.
  if(authoritative){
    var stale=[];
    try{
      for(var i=0;i<localStorage.length;i++){
        var localKey=localStorage.key(i);
        if(localKey&&localKey.indexOf(prefix)===0&&/^\d{4}_\d{2}$/.test(localKey.slice(prefix.length))&&!cloudKeys[localKey])stale.push(localKey);
      }
      stale.forEach(function(key){localStorage.removeItem(key);});
    }catch(e){}
  }
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
async function refreshCallBookingsFromCloud(attempt,forceSync){
  attempt=attempt||0;
  if(!_authToken||!athlete||!athlete.code)return;
  try{
    var before=getCallBookedState();
    // Repair historic placeholder rows immediately. The server resolves this
    // authenticated athlete only and pulls their real appointment from GHL;
    // later retries stay cheap and read Supabase only.
    var action=(attempt===0&&(forceSync||(before.booked&&!before.displayTime)))?'booking-sync':'booking-read';
    var result=await portalRequest(action);
    if(action==='booking-sync')_callBookingLastSyncAt=Date.now();
    applyCloudBookingRows(result.rows||[],action==='booking-sync');
    var state=renderBookingPrompts();
    if((state.booked&&state.displayTime)||(!state.booked&&state.upcoming&&state.upcoming.displayTime))return;
    if(action==='booking-sync'&&!state.booked&&!state.upcoming)return;
  }catch(e){console.warn('Booking time refresh failed',e);}
  if(attempt<2){
    if(_callBookingRefreshTimer)clearTimeout(_callBookingRefreshTimer);
    _callBookingRefreshTimer=setTimeout(function(){refreshCallBookingsFromCloud(attempt+1,false);},attempt===0?2500:6000);
  }
}
function initCallNudge(){
  renderBookingPrompts();
  // Always reconcile in the background on entry. This is deliberately after
  // the primary week render, so cancellation/reschedule accuracy never blocks
  // the athlete from seeing today's training.
  refreshCallBookingsFromCloud(0,true);
}
function refreshCallBookingsOnResume(){
  if(typeof document!=='undefined'&&document.visibilityState&&document.visibilityState!=='visible')return;
  if(Date.now()-_callBookingLastSyncAt<30000)return;
  refreshCallBookingsFromCloud(0,true);
}
document.addEventListener('visibilitychange',refreshCallBookingsOnResume);
window.addEventListener('focus',refreshCallBookingsOnResume);
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
  var moreDue=document.getElementById('moreCheckinDue');if(moreDue)moreDue.classList.toggle('visible',!done);
  syncWeekCardState();
}
function hideCheckinNudge(){
  localStorage.setItem(checkinWeekKey(),'1');
  dismissNudge(document.getElementById('checkinNudge'));
  var mobileDot=document.getElementById('mobileCheckinDot');if(mobileDot)mobileDot.classList.remove('visible');
  var moreDue=document.getElementById('moreCheckinDue');if(moreDue)moreDue.classList.remove('visible');
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
function callWidgetUrl(base,state){
  if(!base)return '';
  if(!state||!state.booked)return base;
  if(!state.eventId)return '';
  return base+(base.indexOf('?')>=0?'&':'?')+'event_id='+encodeURIComponent(state.eventId);
}
var _activeCallReschedule=null;
function showCallModalStatus(message){
  var status=document.getElementById('callModalStatus');
  var frame=document.getElementById('WRivrNxfNTVER2xMit1z_1782710919820');
  if(status){status.textContent=message||'';status.style.display=message?'flex':'none';}
  if(frame)frame.style.display=message?'none':'block';
}
async function openCallModal(){
  var m=document.getElementById('callModal');
  var f=document.getElementById('WRivrNxfNTVER2xMit1z_1782710919820');
  var title=document.getElementById('callModalTitle');
  var state=renderBookingPrompts();
  if(m) m.classList.add('open');
  document.body.style.overflow='hidden';
  if(title)title.textContent=state.booked?'Reschedule Your Call':'Book Your Call';
  if(state.booked&&!state.eventId){
    showCallModalStatus('Finding your confirmed booking…');
    try{
      var result=await portalRequest('booking-sync');
      applyCloudBookingRows(result.rows||[]);
      state=renderBookingPrompts();
    }catch(e){console.warn('Booking reschedule lookup failed',e);}
  }
  var base=f&&f.getAttribute('data-src');
  var url=callWidgetUrl(base,state);
  if(state.booked&&!url){
    _activeCallReschedule=null;
    showCallModalStatus('We could not safely open this appointment for rescheduling. Please use the reschedule link in your confirmation email or contact Karl & Alex. No new booking has been created.');
    return;
  }
  _activeCallReschedule=state.booked?{eventId:state.eventId,calendarId:state.calendarId,storageKey:state.storageKey}:null;
  showCallModalStatus('');
  if(f&&url&&f.src!==url)f.src=url;
}
function closeCallModal(){
  var m=document.getElementById('callModal');
  if(m) m.classList.remove('open');
  _activeCallReschedule=null;
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
  // A real Monday appointment reviews the preceding week. If the widget does
  // not expose its selected time, keep the temporary marker on the portal's
  // current week until the authoritative GHL sync supplies the real date.
  var wkey=start?callNudgeWeekKey(start):(callBookedPrefix()+callWeekSuffix());
  var saveVal=start?{time:dpFormatBookedTime(start),startsAt:start.toISOString()}:'1';
  var reschedule=_activeCallReschedule;
  if(start&&reschedule&&reschedule.eventId){
    saveVal.eventId=reschedule.eventId;
    if(reschedule.calendarId)saveVal.calendarId=reschedule.calendarId;
    if(reschedule.storageKey&&reschedule.storageKey!==wkey)localStorage.removeItem(reschedule.storageKey);
  }
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
    // The reschedule widget updates the same GHL event. Ask the server to pull
    // that event again so its old weekly marker is removed if the week moved.
    if(reschedule)setTimeout(function(){refreshCallBookingsFromCloud(0,true);},1800);
    else refreshCallBookingsFromCloud(0);
  }
  _activeCallReschedule=null;
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
  track('tab_viewed',{tab:tab});
  document.body.setAttribute('data-active-tab',tab); // desktop: hero shows on Today only
  document.querySelectorAll('.tab').forEach(function(t){var active=t.dataset.tab===tab;t.classList.toggle('active',active);t.setAttribute('aria-selected',active?'true':'false');});
  document.querySelectorAll('.tab-content').forEach(function(c){c.classList.toggle('active',c.id==='tab-'+tab);});
  document.querySelectorAll('[data-portal-dest]').forEach(function(item){item.classList.toggle('active',item.dataset.portalDest===tab);});
  var sectionLabel=document.getElementById('portalSectionLabel');
  if(sectionLabel){
    var labels={training:'Today\'s Plan',weekly:'Weekly Plan',nutrition:'Nutrition',checkin:'Weekly Check-in',progress:'Progress',calls:'Calls',goals:'Goals',handbook:'Athlete Guide',comms:'Contact'};
    sectionLabel.textContent=labels[tab]||'Athlete Portal';
  }
  toggleMoreMenu(false);
  var isDesktop=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  var secondaryTabs=['nutrition','goals','handbook','comms'];
  var isMobileSecondary=!isDesktop&&secondaryTabs.indexOf(tab)>=0;
  setMobileNav(tab==='weekly'?'training':(tab==='training'?'home':(tab==='nutrition'?'nutrition':(tab==='checkin'||isMobileSecondary?'more':tab))));
  var showWeekBar=(tab==='weekly')||(!isDesktop&&tab==='training'&&trainingView==='plan');
  document.body.classList.toggle('mobile-training-calendar',!isDesktop&&tab==='training'&&trainingView==='plan');
  document.body.classList.toggle('mobile-portal-home',!isDesktop&&tab==='training'&&trainingView==='home');
  document.body.classList.toggle('mobile-checkin-tab',!isDesktop&&tab==='checkin');
  document.body.classList.toggle('mobile-progress-tab',!isDesktop&&tab==='progress');
  document.body.classList.toggle('mobile-calls-tab',!isDesktop&&tab==='calls');
  document.body.classList.toggle('mobile-secondary-tab',isMobileSecondary);
  syncMobileHomePlacement();
  document.getElementById('wbar').style.display=showWeekBar?'':'none';
  if(tab==='nutrition'&&Date.now()-_nutLastLoad>60000) loadNutrition(); // skip refetch if loaded <60s ago (week shifts & post-save always reload directly)
  if(tab==='checkin'){
    track('weekly_checkin_started');
    initCheckin();
    if(!isDesktop) window.scrollTo({top:0,behavior:'smooth'});
  }
  if(isMobileSecondary) window.scrollTo({top:0,behavior:'smooth'});
  if(tab==='calls') renderCallsTab();
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
    // Instrument composition: the hero leads with TODAY'S SESSION, not the
    // athlete's name. The session sits directly under the greeting and above
    // the week metrics, so the first thing on screen is what to do today.
    // The name moves to the header (see renderHeroGreeting). Done here at
    // runtime rather than in index.html, which check-portal asserts.
    var heroMain=document.querySelector('.hero-main');
    var greeting=heroMain?heroMain.querySelector('.hi'):null;
    if(heroMain&&greeting){
      if(today.parentNode!==heroMain||today.previousElementSibling!==greeting){
        heroMain.insertBefore(today,greeting.nextSibling);
      }
    }else if(today.parentNode!==topShell){
      topShell.insertBefore(today,priority);
    }
  }else if(anchor.parentNode&&today.parentNode!==anchor.parentNode){
    anchor.parentNode.insertBefore(today,anchor.nextSibling);
  }
}
function applyTrainingView(){
  try{renderHeroGreeting();}catch(e){}
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
// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
// Reminders are part of the coaching, not a feature athletes opt into, so this
// list describes what arrives — it is not a set of switches. The only choice
// left is the one we cannot take away: the operating system's own permission
// prompt. Per-athlete exemptions live server-side
// (athletes.notifications_managed), never in the portal UI.
var REMINDER_OPTIONS=[
  {key:'sessions',icon:'calendar',label:"Today's training",sub:'5:30 am when you have a planned session'},
  {key:'logging',icon:'check',label:'Session not logged',sub:'7:30 pm when today’s training is still open'},
  {key:'checkins',icon:'clipboard',label:'Weekly check-ins',sub:'Sunday, until your review is in'},
  {key:'photos',icon:'camera',label:'Progress photos',sub:'Monday on photo weeks'},
  {key:'calls',icon:'chat',label:'Coaching calls',sub:'Morning of, then two hours before'},
  {key:'coach',icon:'chat',label:'Programme changes',sub:'When we update your plan'}
];
function getReminderPreferences(){try{return JSON.parse(localStorage.getItem('dp_reminders_'+((athlete&&athlete.code)||'default'))||'{}');}catch(e){return{};}}
function reminderStorageKey(){return'dp_reminders_'+((athlete&&athlete.code)||'default');}
function notificationOnboardingKey(){return'dp_notification_onboarding_'+((athlete&&athlete.code)||'default');}
function isInstalledPortalPwa(){
  return !!((window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true);
}
function setAllReminderPreferences(enabled){
  var prefs={};REMINDER_OPTIONS.forEach(function(o){prefs[o.key]=!!enabled;});
  localStorage.setItem(reminderStorageKey(),JSON.stringify(prefs));
  return prefs;
}
var _notificationOnboardingOpen=false;
// Shown until the athlete has granted permission. There is nothing to enable
// afterwards, so the panel becomes a plain description of what they receive.
function notificationsGranted(){
  return 'Notification'in window&&Notification.permission==='granted';
}
function renderReminderPreferences(showOnboarding){
  var list=document.getElementById('notificationPreferences');if(!list)return;
  var granted=notificationsGranted();
  var blocked='Notification'in window&&Notification.permission==='denied';
  var prompt='';
  if(!granted&&!blocked&&'Notification'in window){
    prompt='<div class="notification-onboarding"><span class="preference-icon"><svg class="icon"><use href="#i-alert"/></svg></span><div><strong>Turn on portal notifications</strong><p>Your training reminders, check-in prompts and programme updates come through here. Your phone will ask you to confirm.</p><button id="enableAllNotificationsBtn" type="button" onclick="enableAllReminderNotifications()">Enable notifications</button></div></div>';
  }else if(blocked){
    prompt='<div class="notification-onboarding"><span class="preference-icon"><svg class="icon"><use href="#i-alert"/></svg></span><div><strong>Notifications are blocked</strong><p>Your coaching reminders can\'t reach you. Allow notifications for the portal in your phone settings to turn them back on.</p></div></div>';
  }
  list.innerHTML=prompt
    +'<div class="preference-note">'+(granted
      ?'You\'ll receive these from your coach:'
      :'Once enabled, you\'ll receive these from your coach:')+'</div>'
    +REMINDER_OPTIONS.map(function(o){return '<div class="preference-row is-static"><span class="preference-icon"><svg class="icon"><use href="#i-'+o.icon+'"/></svg></span><span><strong>'+o.label+'</strong><small>'+o.sub+'</small></span></div>';}).join('')
    +'<div id="pushStatus" class="push-status">Notifications · '+(localStorage.getItem('dp_push_status')||'not set up yet')+'</div>';
}
function openPreferences(options){
  options=options||{};toggleMoreMenu(false);_notificationOnboardingOpen=!!options.onboarding;
  renderReminderPreferences(_notificationOnboardingOpen);
  syncPushSubscription();
  setMobileNav('more');document.getElementById('preferencesModal').classList.add('open');document.body.style.overflow='hidden';
}
function closePreferences(){
  if(_notificationOnboardingOpen){localStorage.setItem(notificationOnboardingKey(),'dismissed');_notificationOnboardingOpen=false;}
  document.getElementById('preferencesModal').classList.remove('open');document.body.style.overflow='';restoreMobileNavContext();
}
function maybePromptPwaNotifications(){
  if(!athlete||!isInstalledPortalPwa()||!('Notification'in window)||!('PushManager'in window))return;
  if(Notification.permission==='denied'||localStorage.getItem(notificationOnboardingKey()))return;
  // Permission itself is the only thing left to ask for.
  if(notificationsGranted())return;
  openPreferences({onboarding:true});
}
async function enableAllReminderNotifications(){
  var btn=document.getElementById('enableAllNotificationsBtn');
  if(btn){btn.disabled=true;btn.textContent='Waiting for permission…';}
  var permission=Notification.permission;
  if(permission==='default'){try{permission=await Notification.requestPermission();}catch(e){permission='denied';}}
  if(permission!=='granted'){
    track('push_permission_denied');
    localStorage.setItem(notificationOnboardingKey(),'declined');
    _notificationOnboardingOpen=false;renderReminderPreferences(false);
    showToast('Notifications were not enabled — you can allow them later in phone settings','error');
    return;
  }
  // Kept only so an exported copy of the athlete's data still reflects what
  // they receive; delivery itself is decided server-side.
  track('push_permission_granted');
  setAllReminderPreferences(true);
  localStorage.setItem(notificationOnboardingKey(),'enabled');
  _notificationOnboardingOpen=false;renderReminderPreferences(false);
  await syncPushSubscription();
  showToast('Notifications enabled ✓');
}

// ── DURABLE NOTIFICATION INBOX ──────────────────────────────────────────────
// Push is only a courtesy copy. The Supabase-backed inbox is the record, so an
// OS permission denial, stale endpoint or daily-cap suppression loses nothing.
var _notificationInbox=[];
var _notificationInboxMutating=false;
function updateNotificationBadge(unread){
  var badge=document.getElementById('notificationCount'),bell=document.getElementById('notificationBell');
  unread=Math.max(0,Number(unread)||0);
  if(badge){badge.textContent=unread>99?'99+':String(unread);badge.hidden=unread===0;}
  if(bell)bell.setAttribute('aria-label',unread?('Open notifications, '+unread+' unread'):'Open notifications');
}
function notificationTime(value){
  var date=new Date(value);if(isNaN(date.getTime()))return'';
  return date.toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'});
}
function renderNotificationInbox(){
  var list=document.getElementById('notificationInboxList'),clearAll=document.getElementById('clearAllNotificationsBtn');if(!list)return;
  if(clearAll){clearAll.hidden=!_notificationInbox.length;clearAll.disabled=_notificationInboxMutating;}
  if(!_notificationInbox.length){list.innerHTML='<div class="notification-empty"><strong>You’re all caught up</strong><span>Programme changes and coaching reminders will stay here for 30 days.</span></div>';return;}
  list.innerHTML=_notificationInbox.map(function(item){
    var id=esc(item.id),title=esc(item.title);
    return '<div class="notification-item'+(item.read_at?'':' is-unread')+'">'
      +'<button class="notification-item-open" type="button" onclick="openNotificationItem(\''+id+'\',decodeURIComponent(\''+encodeURIComponent(String(item.url||'/'))+'\'))">'
      +'<span class="notification-item-dot"></span><span class="notification-item-copy"><strong>'+title+'</strong><span>'+esc(item.body)+'</span><small>'+esc(notificationTime(item.created_at))+(item.pushed_at?' · Sent to your device':' · Inbox')+'</small></span><b>›</b></button>'
      +'<button class="notification-item-clear" type="button" onclick="clearNotification(\''+id+'\')" aria-label="Clear '+title+' notification"'+(_notificationInboxMutating?' disabled':'')+'>×</button></div>';
  }).join('');
}
function applyNotificationInboxResponse(data){
  _notificationInbox=Array.isArray(data.notifications)?data.notifications:[];
  updateNotificationBadge(data.unread);renderNotificationInbox();
}
async function mutateNotificationInbox(action,id){
  if(_notificationInboxMutating)return false;
  _notificationInboxMutating=true;renderNotificationInbox();
  try{
    var response=await fetch('/api/reminders',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({action:action,id:id})});
    var data=await response.json();if(!response.ok||data.ok===false)throw new Error(data.error||'Notification update failed');
    applyNotificationInboxResponse(data);return true;
  }catch(e){showToast(e&&e.message?e.message:'Couldn’t clear notifications','error');return false;}
  finally{_notificationInboxMutating=false;renderNotificationInbox();}
}
async function clearNotification(id){
  if(await mutateNotificationInbox('dismiss-notification',id))showToast('Notification cleared');
}
async function clearAllNotifications(){
  if(!_notificationInbox.length||_notificationInboxMutating)return;
  if(!window.confirm('Clear all notifications from your inbox?'))return;
  if(await mutateNotificationInbox('clear-notifications'))showToast('Notifications cleared');
}
// Single implementation of the inbox read POST. Used by an inbox tap and by a
// push tap arriving with ?n=<id>; there is deliberately no second code path.
async function markNotificationRead(id){
  try{
    var response=await fetch('/api/reminders',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({action:'read-notification',id:id})});
    var data=await response.json();if(response.ok&&data.ok)applyNotificationInboxResponse(data);
  }catch(e){}
}
// A push tap lands on the session with ?n=<id>. Mark it read, then take the
// parameter back out of the URL so it never survives a reload, a bookmark or
// a screenshot. tab/date deep links are preserved.
async function consumeNotificationReadParam(){
  var params;try{params=new URLSearchParams(location.search);}catch(e){return;}
  var id=params.get('n');if(!id)return;
  await markNotificationRead(id);
  params.delete('n');
  var query=params.toString();
  try{history.replaceState(null,'',location.pathname+(query?'?'+query:'')+location.hash);}catch(e){}
}
async function refreshNotificationInbox(){
  if(!_authToken||!athlete)return;
  await consumeNotificationReadParam();
  try{
    var response=await fetch('/api/reminders?portal=1',{headers:authHeaders({}),cache:'no-store'});
    var data=await response.json();if(!response.ok||data.ok===false)throw new Error(data.error||'Inbox unavailable');
    applyNotificationInboxResponse(data);
  }catch(e){
    var list=document.getElementById('notificationInboxList');if(list)list.innerHTML='<div class="notification-empty"><strong>Couldn’t load notifications</strong><span>Check your connection and try again.</span></div>';
  }
}
function openNotificationInbox(){
  var modal=document.getElementById('notificationInboxModal');if(!modal)return;
  modal.classList.add('open');document.body.style.overflow='hidden';refreshNotificationInbox();
}
function closeNotificationInbox(){var modal=document.getElementById('notificationInboxModal');if(modal)modal.classList.remove('open');document.body.style.overflow='';}
async function openNotificationItem(id,url){
  await markNotificationRead(id);
  closeNotificationInbox();
  window.location.href=url||'/';
}
function getWeeklySummary(){
  var insight=getHomeInsights(),volume=0,wins=[];
  sessions.forEach(function(s){var entry=logs[s.id];if(!entry||typeof entry!=='object')return;Object.keys(entry).forEach(function(k){if(!Array.isArray(entry[k]))return;entry[k].forEach(function(set){var w=parseFloat(set.weight),r=parseInt(set.reps,10);if(!isNaN(w)&&!isNaN(r))volume+=w*r;});});if(isSessionLogged(s.id))wins.push(s.name);});
  return {insight:insight,volume:Math.round(volume),wins:wins};
}
function openWeeklySummary(){
  toggleMoreMenu(false);var s=getWeeklySummary(),i=s.insight,body=document.getElementById('weeklySummaryBody');
  body.innerHTML='<div class="summary-week-label">Programme · '+(isDiscoveryWeek(getCurrentProgrammeWeek())?'Discovery Week':'Week '+getCurrentProgrammeWeek())+'</div><div class="summary-hero"><div class="summary-ring" style="--value:'+i.compliance+'"><strong>'+i.compliance+'%</strong></div><div><strong>Week completion</strong><small>'+i.completed+' of '+i.planned+' planned sessions complete'+(i.completed<i.planned?' · still underway':' · week complete')+'</small></div></div><div class="summary-grid"><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-barbell"/></svg></span><small>Training volume</small><strong>'+s.volume.toLocaleString()+'kg</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-pulse"/></svg></span><small>Readiness</small><strong>'+(i.readiness==null?'Not logged':i.readiness+'/100')+'</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-run"/></svg></span><small>Running</small><strong>'+(i.kmTarget?i.kmDone.toFixed(1)+' / '+i.kmTarget.toFixed(1)+'km':'No target')+'</strong></div><div><span class="summary-metric-icon"><svg class="icon"><use href="#i-trophy"/></svg></span><small>PB history</small><strong>'+i.pbs+' exercises</strong></div></div><div class="summary-wins"><span class="summary-metric-icon"><svg class="icon"><use href="#i-trophy"/></svg></span><div><strong>Wins this week</strong><p>'+(s.wins.length?s.wins.map(esc).join(' · '):'Log your first completed session to start building the week.')+'</p></div></div>'+renderCoachMoment(sessions.filter(function(x){return x.date===localISO(new Date());}),i);
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
// ── DATA EXPORT ───────────────────────────────────────────────────────────────
// This used to serialise localStorage and call it the athlete's data. It was a
// partial device mirror — whatever this one browser happened to have cached —
// and an athlete asking what we hold on them deserves the real answer.
//
// The server export is the answer. The device copy stays as the offline
// fallback so the button still does something useful on a dead connection, and
// it says which one you got.
function localAthleteExport(){
  return {exportedAt:new Date().toISOString(),source:'device-cache-only',athlete:{name:athlete.name,code:athlete.code},logs:logs,goals:JSON.parse(localStorage.getItem('dp_goals_'+athlete.code)||'{}'),photos:getPhotos(),reminders:getReminderPreferences()};
}
function downloadAthleteJson(data){
  var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='dual-performance-'+athlete.code+'-data.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
async function exportAthleteData(){
  track('export_requested');
  var data=null;
  try{
    var result=await portalRequest('export-data');
    if(result&&result.export) data=result.export;
  }catch(e){console.warn('Server export unavailable; falling back to the device copy',e);}
  if(!data){
    data=localAthleteExport();
    showToast('Could not reach the server. Exported this device\u2019s copy instead.');
  }
  downloadAthleteJson(data);
}

// ── DATA RIGHTS REQUESTS ──────────────────────────────────────────────────────
// dualperformance.au/support tells athletes they can request deletion from
// inside the portal. This is that control. It deletes nothing locally — it
// raises a recorded request, because the support page also commits to a 30-day
// turnaround and that clock has to start somewhere a coach can see.
var DATA_REQUEST_COPY={
  account_deletion:{
    title:'Request account deletion',
    subtitle:'This removes you from Dual Performance.',
    explain:'We will delete your athlete account and the training, check-in, nutrition and photo history attached to it. Your coaches are notified straight away, and verified requests are completed within 30 days. Some records are kept where the law requires it. This cannot be undone.',
    confirm:'Request account deletion',
    contact:'delete@dualperformance.au'
  },
  wearable_deletion:{
    title:'Delete my wearable data',
    subtitle:'This removes synced activity data only.',
    explain:'We will delete the activity data synced from your connected wearables. Your account, training plan and logged sessions stay exactly as they are. Verified requests are completed within 30 days.',
    confirm:'Request wearable data deletion',
    contact:'data@dualperformance.au'
  }
};
var _dataRequestKind=null;
function dataRequestStateKey(kind){return 'dp_data_request_'+((athlete&&athlete.code)||'default')+'_'+kind;}
function setDataRequestStatus(text,state){
  var el=document.getElementById('dataRequestStatus');if(!el)return;
  el.textContent=text||'';
  el.className='data-request-status'+(state?' is-'+state:'');
}
function openDataRequest(kind){
  var copy=DATA_REQUEST_COPY[kind];if(!copy)return;
  _dataRequestKind=kind;
  var modal=document.getElementById('dataRequestModal');if(!modal)return;
  document.getElementById('dataRequestTitle').textContent=copy.title;
  document.getElementById('dataRequestSubtitle').textContent=copy.subtitle;
  document.getElementById('dataRequestExplain').textContent=copy.explain;
  var note=document.getElementById('dataRequestNote');if(note){note.value='';note.disabled=false;}
  var btn=document.getElementById('dataRequestConfirm');
  if(btn){btn.disabled=false;btn.textContent=copy.confirm;btn.classList.toggle('is-danger',kind==='account_deletion');}
  // An outstanding request is shown rather than silently allowing a duplicate,
  // so nobody is left wondering whether the first one landed.
  var prior=null;try{prior=JSON.parse(localStorage.getItem(dataRequestStateKey(kind))||'null');}catch(e){}
  if(prior&&prior.at){
    var when=new Date(prior.at);
    var stamp=isNaN(when.getTime())?'':when.toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'});
    setDataRequestStatus('You already asked for this'+(stamp?' on '+stamp:'')+'. Your coaches have it. You can send it again if something has changed.','sent');
  }else{
    setDataRequestStatus('');
  }
  modal.classList.add('open');modal.setAttribute('aria-hidden','false');
  track('data_request_opened',{kind:kind});
}
function closeDataRequest(){
  var modal=document.getElementById('dataRequestModal');if(!modal)return;
  modal.classList.remove('open');modal.setAttribute('aria-hidden','true');
  _dataRequestKind=null;
}
async function submitDataRequest(){
  var kind=_dataRequestKind,copy=DATA_REQUEST_COPY[kind];
  if(!kind||!copy)return;
  var btn=document.getElementById('dataRequestConfirm'),note=document.getElementById('dataRequestNote');
  if(!btn)return;
  btn.disabled=true;btn.textContent='Sending\u2026';setDataRequestStatus('');
  try{
    var res=await portalRequest('data-request',{kind:kind,note:(note&&note.value.trim())||''});
    var at=(res&&res.requested_at)||new Date().toISOString();
    try{localStorage.setItem(dataRequestStateKey(kind),JSON.stringify({at:at}));}catch(e){}
    if(note){note.value='';note.disabled=true;}
    btn.textContent='Request sent \u2713';
    setDataRequestStatus('Received. Your coaches have been notified and will complete this within 30 days. Questions go to '+copy.contact+'.','sent');
    track('data_request_sent',{kind:kind});
    showToast('Request sent \u2713');
    setTimeout(closeDataRequest,3000);
  }catch(e){
    btn.disabled=false;btn.textContent=copy.confirm;
    setDataRequestStatus((e&&e.message)||('Could not send that just now. You can email '+copy.contact+' instead.'),'error');
  }
}
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape')return;
  var modal=document.getElementById('dataRequestModal');
  if(modal&&modal.classList.contains('open')) closeDataRequest();
});

// ── PRIVATE NOTE TO COACH ─────────────────────────────────────────────────────
// A composer, not a messaging system. One direction, no threads, no inbox.
// Discord covers community and general questions; an athlete will not post
// "I think I'm injured" or "I'm thinking of quitting" in a group channel, and
// those are the messages worth catching.
//
// Nothing here interpolates athlete text into HTML: the draft goes back into a
// textarea value and every status line is set with textContent.
var COACH_NOTE_MAX=2000;
function coachNoteDraftKey(){return 'dp_coach_note_draft_'+((athlete&&athlete.code)||'default');}
function syncCoachNoteMeta(){
  var box=document.getElementById('coachNoteBody'),count=document.getElementById('coachNoteCount');
  if(box&&count) count.textContent=box.value.length+' / '+COACH_NOTE_MAX;
}
function setCoachNoteStatus(message,tone){
  var el=document.getElementById('coachNoteStatus');if(!el)return;
  el.textContent=message||'';
  el.classList.toggle('is-error',tone==='error');
  el.classList.toggle('is-sent',tone==='sent');
}
// The same draft contract as every other form in the portal: nothing typed is
// lost by closing the app, and the draft is cleared only once the server has
// confirmed the note landed.
function draftCoachNote(){
  var box=document.getElementById('coachNoteBody');if(!box)return;
  try{
    if(box.value.trim()) localStorage.setItem(coachNoteDraftKey(),box.value);
    else localStorage.removeItem(coachNoteDraftKey());
  }catch(e){}
  var note=document.getElementById('coachNoteDraft');
  if(note) note.textContent=box.value.trim()?'Draft saved on this device':'';
  syncCoachNoteMeta();
}
function openCoachNote(){
  toggleMoreMenu(false);
  var modal=document.getElementById('coachNoteModal');if(!modal)return;
  var box=document.getElementById('coachNoteBody');
  if(box){
    var draft='';try{draft=localStorage.getItem(coachNoteDraftKey())||'';}catch(e){}
    box.disabled=false;
    box.value=String(draft).slice(0,COACH_NOTE_MAX);
  }
  var send=document.getElementById('coachNoteSend');
  if(send){send.disabled=false;send.textContent='Send to your coaches';}
  var note=document.getElementById('coachNoteDraft');
  if(note) note.textContent=(box&&box.value.trim())?'Draft saved on this device':'';
  setCoachNoteStatus('');
  syncCoachNoteMeta();
  modal.classList.add('open');document.body.style.overflow='hidden';
  track('contact_opened');
  if(box) setTimeout(function(){try{box.focus();}catch(e){}},120);
}
function closeCoachNote(){
  var modal=document.getElementById('coachNoteModal');if(!modal)return;
  modal.classList.remove('open');document.body.style.overflow='';restoreMobileNavContext();
}
async function sendCoachNote(){
  var box=document.getElementById('coachNoteBody'),send=document.getElementById('coachNoteSend');
  if(!box||!send)return;
  var message=box.value.trim();
  if(message.length<2){setCoachNoteStatus('Write a message first.','error');return;}
  send.disabled=true;send.textContent='Sending\u2026';setCoachNoteStatus('');
  try{
    await portalRequest('contact-coach',{message:message.slice(0,COACH_NOTE_MAX)});
    try{localStorage.removeItem(coachNoteDraftKey());}catch(e){}
    box.value='';box.disabled=true;
    var note=document.getElementById('coachNoteDraft');if(note) note.textContent='';
    syncCoachNoteMeta();
    send.textContent='Sent \u2713';
    setCoachNoteStatus('Sent. Karl and Alex have it and will come back to you directly.','sent');
    track('contact_message_sent');
    showToast('Note sent to your coaches \u2713');
    setTimeout(closeCoachNote,2200);
  }catch(e){
    // The draft is still on the device, so say so rather than implying it went.
    send.disabled=false;send.textContent='Send to your coaches';
    setCoachNoteStatus((e&&e.message)||'Could not send that just now. Your draft is saved on this device.','error');
  }
}
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape')return;
  var modal=document.getElementById('coachNoteModal');
  if(modal&&modal.classList.contains('open')) closeCoachNote();
});
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
  if(tab==='nutrition'){setMobileNav('nutrition');return;}
  if(tab==='checkin'||['goals','handbook','comms'].indexOf(tab)>=0){setMobileNav('more');return;}
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

// ══════════════════════════════════════════════════════════════════════════
// CALLS SURFACE
// ══════════════════════════════════════════════════════════════════════════
// fetchCallsSurfaceData() is the ONLY place the Calls tab reads data.
//
// LIVE:  `next` — getCallBookedState(), kept current by the GHL webhook and
//        the booking-sync action.
//        Read from the same completion cache the check-in nudge uses.
// LIVE:  `checkin` — whether this week's weekly check-in has been submitted.
// STUB:  `last` — the previous call's recap and action items have no
//        backend yet; returning null omits the card rather than drawing an
//        empty one. Replace the marked block below with a real read.
//
//   { next: { booked, displayTime, startsAt, eventId },
//     checkin: { done },
//     last: null | { when, quote, actions: [{ text, done, due }] } }
//
// The Calls tab used to carry three free-text prep questions of its own. Two
// duplicated the weekly check-in's Wins and Niggles fields, the third moved
// into the check-in's final step as ciCallDecision, and the whole thing synced
// through a calls_prep_* state key that never once reached the database. So the
// tab now reports the check-in's status instead of collecting a second,
// competing answer to the same questions.
function callsCheckinState(){
  var done=false;
  try{done=!!localStorage.getItem(checkinWeekKey());}catch(e){done=false;}
  return {done:done};
}

function fetchCallsSurfaceData(){
  var next=(typeof getCallBookedState==='function')?getCallBookedState():{booked:false,displayTime:'',startsAt:'',eventId:''};
  var checkin=callsCheckinState();
  // ── BEGIN STUB ──────────────────────────────────────────────────────────
  // The previous call's recap and its action items have no backend yet, so
  // there is nothing to show. Returning null omits the card entirely rather
  // than rendering an empty one. Replace with a real read; see the shape above.
  var last=null;
  // ── END STUB ────────────────────────────────────────────────────────────
  return {next:next,checkin:checkin,last:last};
}


// Whole days and hours until the call. Returns null when there is no dated
// booking, which is a real state: the widget can confirm before the webhook
// has supplied a timestamp.
function callsCountdown(startsAt){
  if(!startsAt) return null;
  var when=new Date(startsAt);
  if(isNaN(when)) return null;
  var ms=when.getTime()-Date.now();
  if(ms<=0) return null;
  return {days:Math.floor(ms/86400000),hours:Math.floor((ms%86400000)/3600000)};
}

function renderCallsTab(){
  var mount=document.getElementById('callsSurface');
  if(!mount) return;
  var data=fetchCallsSurfaceData();
  var next=data.next||{},count=callsCountdown(next.startsAt);
  var html='';

  html+='<div class="calls-card calls-next">';
  html+='<div class="calls-head"><span class="calls-label">Next call</span><span class="calls-label calls-label-dim">Karl &amp; Alex</span></div>';
  if(next.booked){
    html+='<div class="calls-well calls-countdown">';
    if(count){
      html+='<div><div class="calls-label">Countdown</div><div class="calls-readout"><span>'+count.days+'</span><i>d</i><span>'+count.hours+'</span><i>h</i></div></div>';
    }else{
      html+='<div><div class="calls-label">Confirmed</div><div class="calls-readout calls-readout-soft">Time pending</div></div>';
    }
    html+='<div class="calls-when">'+(next.displayTime?'<div class="calls-when-main">'+esc(next.displayTime)+'</div>':'')+'<div class="calls-label calls-label-dim">30 min</div></div>';
    html+='</div>';
    html+='<div class="calls-actions"><button type="button" class="calls-btn calls-btn-primary" onclick="openCallBooking()">View booking</button><button type="button" class="calls-btn" onclick="openCallBooking()">Reschedule</button></div>';
  }else{
    html+='<div class="calls-well calls-empty">No call booked for this week.</div>';
    html+='<div class="calls-actions"><button type="button" class="calls-btn calls-btn-primary" onclick="openCallBooking()">Book your call</button></div>';
  }
  html+='</div>';

  // One weekly ritual, one place. The card routes to the check-in rather than
  // reproducing any of its questions here.
  var checkin=data.checkin||{done:false};
  html+='<div class="calls-card"><div class="calls-head"><span class="calls-label">Weekly check-in</span>'+
        (checkin.done?'<span class="calls-label calls-label-ok">Submitted</span>':'<span class="calls-label calls-label-dim">Not yet</span>')+'</div>';
  html+='<div class="calls-well'+(checkin.done?'':' calls-empty')+'">'+
        (checkin.done
          ? 'Karl and Alex have your week. They\'ll work from it on the call.'
          : 'Fill this in before your call so the 30 minutes go on decisions, not catch-up.')+'</div>';
  html+='<div class="calls-actions"><button type="button" class="calls-btn'+(checkin.done?'':' calls-btn-primary')+'" onclick="openCheckinSheet()">'+
        (checkin.done?'Review your check-in':'Complete your check-in')+'</button></div>';
  html+='</div>';

  var last=data.last;
  if(last){
    html+='<div class="calls-card"><div class="calls-head"><span class="calls-label">Last call · '+esc(last.when)+'</span></div>';
    if(last.quote) html+='<div class="calls-quote">'+esc(last.quote)+'</div>';
    (last.actions||[]).forEach(function(a){
      html+='<div class="calls-action'+(a.done?' is-done':'')+'"><span class="calls-bullet"></span><span class="calls-action-text">'+esc(a.text)+'</span>'+
            (a.due?'<span class="calls-label calls-label-dim">'+esc(a.due)+'</span>':'')+'</div>';
    });
    html+='</div>';
  }

  mount.innerHTML=html;
  var dot=document.getElementById('mobileCallsDot');
  if(dot) dot.classList.toggle('visible',!next.booked);
  var railDot=document.getElementById('tabDotCalls');
  if(railDot) railDot.classList.toggle('visible',!next.booked);
}
