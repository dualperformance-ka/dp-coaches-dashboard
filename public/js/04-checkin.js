// ── CHECK-IN WIZARD ───────────────────────────────────────────────────────────
var CI_STEP=1,CI_TOTAL=5;
function ciGoStep(n){
  if(n<1||n>CI_TOTAL) return;
  document.querySelectorAll('.ci-step-panel').forEach(function(p){p.classList.remove('active');});
  var panel=document.querySelector('.ci-step-panel[data-step="'+n+'"]');
  if(panel) panel.classList.add('active');
  CI_STEP=n;
  document.querySelectorAll('.ci-sdot').forEach(function(dot,i){
    dot.classList.remove('active','done');
    if(i+1===n){dot.classList.add('active');dot.setAttribute('aria-current','step');}
    else{dot.removeAttribute('aria-current');if(i+1<n)dot.classList.add('done');}
  });
  var counter=document.getElementById('ciStepCounter');
  if(counter) counter.textContent='Step '+n+' of '+CI_TOTAL;
  var back=document.getElementById('ciBtnBack'),next=document.getElementById('ciBtnNext');
  var navRow=document.getElementById('ciNavRow');
  var isLast=n===CI_TOTAL;
  if(back){back.style.display=n>1?'':'none';}
  if(next){next.style.display=isLast?'none':'';}
  if(navRow){navRow.classList.toggle('solo',n===1||isLast);}
  var tab=document.getElementById('tab-checkin');
  var y=tab?tab.getBoundingClientRect().top+window.scrollY-70:0;
  window.scrollTo({top:Math.max(0,y),behavior:'smooth'});
}
function ciStep(dir){ciGoStep(CI_STEP+dir);}

// ── CHECK-IN DRAFTS + CONSENT ─────────────────────────────────────────────────
var CI_DRAFT_FIELDS=['ciName','ciWeekEnding','ciRunComp','ciRunPlan','ciRunKm','ciRunFeel','ciRunWins','ciRunNiggles','ciLiftComp','ciLiftPlan','ciLiftFeel','ciLiftWins','ciLiftNiggles','ciSleep','ciEnergy','ciSoreness','ciNut','ciFuelling','ciStress','ciMot','ciSocial','ciNotes','ciTestimonial'];
var _ciDraftTimer=null,_ciDraftHooked=false;
function ciDraftKey(){return 'dp_ci_draft_'+((athlete&&athlete.code)||'default')+'_'+checkinWeekSuffix();}
function draftCheckin(){
  if(_ciDraftTimer)clearTimeout(_ciDraftTimer);
  _ciDraftTimer=setTimeout(saveCiDraft,400);
}
function saveCiDraft(){
  var d={_savedAt:Date.now()};
  CI_DRAFT_FIELDS.forEach(function(id){
    var el=document.getElementById(id);if(!el)return;
    // Untouched sliders are still at their default — don't bake 5s into the draft
    if(el.type==='range'&&el.classList.contains('sl-untouched'))return;
    d[id]=el.value;
  });
  try{localStorage.setItem(ciDraftKey(),JSON.stringify(d));}catch(e){}
}
function restoreCiDraft(){
  var d=null;try{d=JSON.parse(localStorage.getItem(ciDraftKey())||'null');}catch(e){}
  if(!d||!d._savedAt||Date.now()-d._savedAt>8*24*60*60*1000)return;
  CI_DRAFT_FIELDS.forEach(function(id){
    if(d[id]==null||d[id]==='')return;
    var el=document.getElementById(id);if(!el)return;
    el.value=d[id];
    if(el.type==='range'){
      el.classList.remove('sl-untouched');
      var valEl=document.getElementById(id+'Val');if(valEl)valEl.textContent=d[id];
    }
  });
}
function clearCiDraft(){
  try{localStorage.removeItem(ciDraftKey());}catch(e){}
  if(_ciDraftTimer){clearTimeout(_ciDraftTimer);_ciDraftTimer=null;}
}

function initCheckin(){
  renderBookingPrompts();
  restoreCiDraft();
  if(!_ciDraftHooked){
    var fc=document.getElementById('ciFormContent');
    if(fc){fc.addEventListener('input',draftCheckin);fc.addEventListener('change',draftCheckin);}
    _ciDraftHooked=true;
  }
  var nameEl=document.getElementById('ciName');if(nameEl&&!nameEl.value) nameEl.value=athlete.name;
  var weEl=document.getElementById('ciWeekEnding');
  if(weEl&&!weEl.value){
    // Default the Week Ending to the Sunday of the week being reported on.
    // Sun -> today. Mon/Tue -> previous Sunday (grace window for day-after
    // submissions, so a late check-in still counts toward the week just
    // finished). Wed-Sat -> the upcoming Sunday. Uses local date (not UTC)
    // to avoid the default drifting a day near midnight.
    var d=new Date(),day=d.getDay(),sun=new Date(d);
    if(day===0){/* today is Sunday — week ends today */}
    else if(day<=2){sun.setDate(d.getDate()-day);}   // Mon/Tue -> last Sunday
    else{sun.setDate(d.getDate()+(7-day));}            // Wed-Sat -> next Sunday
    weEl.value=localISO(sun);
  }
  // Prefill session counts from the plan the portal already tracks — the
  // athlete can still edit them if the numbers look wrong. Always uses the
  // CURRENT week regardless of which week the calendar is browsing.
  try{
    var mon=getMon(new Date()),end=new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+6);
    var monISO=localISO(mon),endISO=localISO(end);
    var wk=(allSessions||[]).filter(function(s){return s.date&&s.date>=monISO&&s.date<=endISO;});
    var wkRuns=wk.filter(function(s){return getType(s)==='run';});
    var wkLifts=wk.filter(function(s){return getType(s)==='strength';});
    var isDone=function(s){return logHasRealData(logs[s.id])||s.status==='Completed'||ticked[s.id];};
    var setIfEmpty=function(id,v){var el=document.getElementById(id);if(el&&el.value==='')el.value=v;};
    if(wk.length){
      setIfEmpty('ciRunPlan',wkRuns.length);
      setIfEmpty('ciRunComp',wkRuns.filter(isDone).length);
      setIfEmpty('ciLiftPlan',wkLifts.length);
      setIfEmpty('ciLiftComp',wkLifts.filter(isDone).length);
    }
  }catch(e){}
}

async function submitCheckin(){
  var btn=document.getElementById('ciSubmitBtn');
  var name=document.getElementById('ciName').value.trim();
  if(!name){showToast('Please enter your name');return;}
  btn.textContent='Submitting...';btn.disabled=true;
  var weekEndVal=document.getElementById('ciWeekEnding').value;
  var wkNum=1;
  if(athlete&&athlete.startDate&&athlete.startDate!=='—'&&weekEndVal){
    var _s=localDateFromISO(athlete.startDate);var _w=localDateFromISO(weekEndVal);
    wkNum=Math.max(1,Math.min(12,Math.floor((_w-_s)/(7*24*60*60*1000))+1));
  }else{wkNum=getCurrentProgrammeWeek();}
  var notionTitle=name.toUpperCase().trim()+' — Week '+wkNum;
  var payload={name:notionTitle,athleteName:name,athleteCode:athlete&&athlete.code||'',athleteId:athlete&&athlete.notionPageId||'',weekEnding:weekEndVal,submittedAt:new Date().toISOString(),
    runCompleted:document.getElementById('ciRunComp').value||'0',runPlanned:document.getElementById('ciRunPlan').value||'0',
    runKm:document.getElementById('ciRunKm').value||'0',runFeel:document.getElementById('ciRunFeel').value,
    runWins:document.getElementById('ciRunWins').value||'None',runNiggles:document.getElementById('ciRunNiggles').value||'None',
    liftCompleted:document.getElementById('ciLiftComp').value||'0',liftPlanned:document.getElementById('ciLiftPlan').value||'0',
    liftFeel:document.getElementById('ciLiftFeel').value,liftWins:document.getElementById('ciLiftWins').value||'None',
    liftNiggles:document.getElementById('ciLiftNiggles').value||'None',sleep:document.getElementById('ciSleep').value,
    energy:document.getElementById('ciEnergy').value,soreness:document.getElementById('ciSoreness').value,
    nutrition:document.getElementById('ciNut').value,fuelling:document.getElementById('ciFuelling').value||'Not selected',
    socialEating:document.getElementById('ciSocial').value||'None',stress:document.getElementById('ciStress').value,
    motivation:document.getElementById('ciMot').value,upcomingImpact:document.getElementById('ciNotes').value||'',
    testimonial:document.getElementById('ciTestimonial').value||''};
  try{
    var checkinResult=await coachWrite(CHECKIN_WEBHOOK,Object.assign({type:'weekly_checkin'},payload));
    // Mark completion only after the form has been accepted or safely queued.
    // Previously the cache was written before /api/ingest ran, so a failed or
    // abandoned submission could suppress the nudge without a real check-in.
    hideCheckinNudge();
    clearCiDraft();
    document.getElementById('ciFormContent').style.display='none';document.getElementById('ciSuccess').style.display='block';
    showToast(checkinResult.queued?'Check-in saved - coach dashboard sync pending':'Check-in submitted ✓');
  }catch(e){btn.textContent='Submit Check-in';btn.disabled=false;showToast('Could not submit your check-in — please try again','error');}
}
function resetCheckin(){
  clearCiDraft();
  var tEl=document.getElementById('ciTestimonial');if(tEl)tEl.value='';
  document.getElementById('ciFormContent').style.display='block';document.getElementById('ciSuccess').style.display='none';
  var btn=document.getElementById('ciSubmitBtn');btn.textContent='Submit Check-in';btn.disabled=false;ciGoStep(1);
}
function todayISO2(){return localISO(new Date());}
// ── SESSION COUNTER ───────────────────────────────────────────────────────────
function renderGymTracker(){
  var bar=document.getElementById('gymBar');
  if(!bar) return;
  var lifts=(sessions||[]).filter(function(s){return getType(s)==='strength';});
  if(!lifts.length){bar.style.display='none';return;}
  var done=lifts.filter(function(s){return logHasRealData(logs[s.id])||s.status==='Completed'||ticked[s.id];}).length;
  document.getElementById('gymTargetVal').textContent=lifts.length;
  document.getElementById('gymDoneVal').textContent=done;
  var progress=document.getElementById('gymProgress');
  var progressFill=document.getElementById('gymProgressFill');
  var pct=lifts.length?Math.min(100,Math.round(done/lifts.length*100)):0;
  if(progress){
    progress.setAttribute('aria-valuenow',String(done));
    progress.setAttribute('aria-valuemax',String(lifts.length));
  }
  if(progressFill) progressFill.style.width=pct+'%';
  bar.classList.toggle('km-hit',done>=lifts.length);
  bar.style.display='';
  buildGymGauge(done,lifts.length);
}
function updateSessionCounter(){
  try{renderGymTracker();}catch(e){}
  var total=sessions.length;
  var done=sessions.filter(function(s){return logHasRealData(logs[s.id])||s.status==='Completed';}).length;
  var marked=sessions.filter(function(s){return !(logHasRealData(logs[s.id])||s.status==='Completed')&&ticked[s.id];}).length;
  var el=document.getElementById('heroSessionsDone');
  var val=document.getElementById('heroSessionsDoneVal');
  if(!el||!val) return;
  if(total>0){val.textContent=done+' / '+total+' done'+(marked>0?' · '+marked+' marked':'');el.style.display='';}
  else{el.style.display='none';}
}

// ── QUICK LOG ─────────────────────────────────────────────────────────────────
function openQuickLog(type){
  var today=todayISO2();
  if(type==='body'){
    var dateEl=document.getElementById('qlbDate');
    if(dateEl&&!dateEl.value) dateEl.value=today;
    // Load previous day body data for reference
    (function(){
      var prevPanel=document.getElementById('qlbPrevDay');
      if(!prevPanel||!athlete||!athlete.code) return;
      var d=new Date(today+'T00:00:00');
      d.setDate(d.getDate()-1);
      var yest=localISO(d);
      var raw=null;
      try{raw=localStorage.getItem('dp_daily_body_'+athlete.code+'_'+yest);}catch(e){}
      if(!raw){prevPanel.style.display='none';return;}
      var prev=null;try{prev=JSON.parse(raw);}catch(e){}
      if(!prev){prevPanel.style.display='none';return;}
      var days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var dd=new Date(yest+'T00:00:00');
      var lbl='Yesterday ('+days[dd.getDay()]+' '+dd.getDate()+' '+months[dd.getMonth()]+')';
      document.getElementById('qlbPrevDayLabel').textContent=lbl;
      document.getElementById('qlbPrevWeight').textContent=prev.weight?prev.weight+'kg':'—';
      document.getElementById('qlbPrevSleep').textContent=prev.sleep?prev.sleep+'/10':'—';
      document.getElementById('qlbPrevEnergy').textContent=prev.energy?prev.energy+'/10':'—';
      document.getElementById('qlbPrevStress').textContent=prev.stress?prev.stress+'/10':'—';
      document.getElementById('qlbPrevSore').textContent=prev.soreness?prev.soreness+'/10':'—';
      var notesEl=document.getElementById('qlbPrevNotes');
      if(prev.notes){notesEl.textContent='"'+prev.notes+'"';notesEl.style.display='block';}
      else{notesEl.style.display='none';}
      prevPanel.style.display='block';
    })();
    document.getElementById('qlBodyModal').classList.add('open');
    document.body.style.overflow='hidden';
  } else {
    var dateEl=document.getElementById('qlnDate');
    if(dateEl&&!dateEl.value) dateEl.value=today;
    // Load previous day nutrition for reference
    (function(){
      var prevPanel=document.getElementById('qlnPrevDay');
      if(!prevPanel||!athlete||!athlete.code) return;
      // Calculate yesterday's date
      var d=new Date(today+'T00:00:00');
      d.setDate(d.getDate()-1);
      var yest=localISO(d);
      var raw=null;
      // Check Supabase-synced localStorage first
      try{raw=localStorage.getItem('dp_daily_nut_'+athlete.code+'_'+yest);}catch(e){}
      if(!raw){prevPanel.style.display='none';return;}
      var prev=null;try{prev=JSON.parse(raw);}catch(e){}
      if(!prev){prevPanel.style.display='none';return;}
      // Format label e.g. "Yesterday (Mon 27 Apr)"
      var days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var dd=new Date(yest+'T00:00:00');
      var lbl='Yesterday ('+days[dd.getDay()]+' '+dd.getDate()+' '+months[dd.getMonth()]+')';
      document.getElementById('qlnPrevDayLabel').textContent=lbl;
      document.getElementById('qlnPrevCal').textContent=prev.calories||'—';
      document.getElementById('qlnPrevPro').textContent=prev.protein?prev.protein+'g':'—';
      document.getElementById('qlnPrevCarb').textContent=prev.carbs?prev.carbs+'g':'—';
      document.getElementById('qlnPrevFat').textContent=prev.fat?prev.fat+'g':'—';
      document.getElementById('qlnPrevFibre').textContent=prev.fibre?prev.fibre+'g':'—';
      var notesEl=document.getElementById('qlnPrevNotes');
      if(prev.notes){notesEl.textContent='"'+prev.notes+'"';notesEl.style.display='block';}
      else{notesEl.style.display='none';}
      prevPanel.style.display='block';
    })();
    // Populate target badges in form labels
    (function(){
      function setTgt(id,val,unit){
        var el=document.getElementById(id);
        if(!el) return;
        if(val!=null){el.textContent='target · '+val.display+unit;el.style.display='inline';}
        else{el.style.display='none';}
      }
      var t=currentNutTargets||{};
      setTgt('qlnTgtCal',t.cal,' kcal');
      setTgt('qlnTgtPro',t.pro,'g');
      setTgt('qlnTgtCarb',t.carb,'g');
      setTgt('qlnTgtFat',t.fat,'g');
      setTgt('qlnTgtFibre',t.fibre,'g');
    })();
    updateNutFeedback();
    document.getElementById('qlNutModal').classList.add('open');
    document.body.style.overflow='hidden';
  }
}
function closeQuickLog(type){
  var id=type==='body'?'qlBodyModal':'qlNutModal';
  var el=document.getElementById(id);if(el) el.classList.remove('open');
  document.body.style.overflow='';
}
function updateNutFeedback(){
  var fb=document.getElementById('qlnFeedback');
  if(!fb) return;
  var t=currentNutTargets;
  var cal=parseFloat(document.getElementById('qlnCal').value)||0;
  var pro=parseFloat(document.getElementById('qlnPro').value)||0;
  var carb=parseFloat(document.getElementById('qlnCarbs').value)||0;
  var fat=parseFloat(document.getElementById('qlnFat').value)||0;
  var fibre=parseFloat(document.getElementById('qlnFibre').value)||0;
  var hasAny=cal||pro||carb||fat||fibre;
  if(!t||!hasAny){fb.style.display='none';return;}
  function chip(label,val,tgt,unit){
    if(tgt==null) return '';
    var pct=tgt.min>0?Math.round(val/tgt.min*100):0;
    var color,status,barColor;
    if(val===0){color='var(--dim)';status='not entered';barColor='var(--border-mid)';}
    else if(pct>=100){color='#15803d';status='✓ on target';barColor='#22c55e';}
    else if(pct>=90){color='#b45309';status='close — '+pct+'%';barColor='#2a3342';}
    else if(pct>=75){color='#b45309';status='almost — '+pct+'%';barColor='#2a3342';}
    else{color='#dc2626';status='under — '+pct+'%';barColor='#f87171';}
    var fillW=Math.min(pct,100);
    return '<div class="qln-fb-item">'
      +'<div class="qln-fb-label">'+label+'</div>'
      +'<div class="qln-fb-val" style="color:'+color+'">'+(val||0)+unit
        +'<span style="font-family:var(--mono);font-size:9px;color:var(--dim);font-weight:400"> / '+tgt.display+unit+'</span></div>'
      +'<div class="qln-fb-bar"><div class="qln-fb-fill" style="width:'+fillW+'%;background:'+barColor+'"></div></div>'
      +'<div class="qln-fb-status" style="color:'+color+'">'+status+'</div>'
      +'</div>';
  }
  var html='<div class="qln-fb-title">vs. this week\'s targets</div><div class="qln-fb-grid">'
    +chip('Calories',cal,t.cal,' kcal')
    +chip('Protein',pro,t.pro,'g')
    +chip('Carbs',carb,t.carb,'g')
    +chip('Fat',fat,t.fat,'g')
    +chip('Fibre',fibre,t.fibre,'g')
    +'</div>';
  fb.innerHTML=html;
  fb.style.display='block';
}
async function submitQuickBody(){
  var btn=document.getElementById('qlbSubmitBtn');btn.textContent='Logging...';btn.disabled=true;
  var bodyDate=document.getElementById('qlbDate').value||todayISO2();
  var pain=document.getElementById('qlbPain').value||'0',painLocation=document.getElementById('qlbPainLocation').value||'',notes=document.getElementById('qlbNotes').value||'';
  if(Number(pain)>0)notes=('Pain '+pain+'/10'+(painLocation?' · '+painLocation:'')+(notes?' · '+notes:''));
  var payload={type:'daily_body',athleteName:athlete.name,athleteCode:athlete.code,athleteId:athlete.notionPageId,
    date:bodyDate,weight:document.getElementById('qlbWeight').value||'',
    sleep:document.getElementById('qlbSleep').value,energy:document.getElementById('qlbEnergy').value,
    stress:document.getElementById('qlbStress').value,soreness:document.getElementById('qlbSore').value,pain:pain,painLocation:painLocation,coachAlert:Number(pain)>=5,notes:notes};
  localStorage.setItem('dp_daily_body_'+athlete.code+'_'+payload.date,JSON.stringify(payload));
  try{syncQuickLogDock();}catch(e){}
  var bodyResult=await coachWrite(DAILY_BODY_WEBHOOK,payload);
  closeQuickLog('body');
  showToast(bodyResult.queued?'Body logged - coach dashboard sync pending':'Body logged ✓');
  btn.textContent='Log Body';btn.disabled=false;
  // Reset for next use
  document.getElementById('qlbDate').value='';document.getElementById('qlbWeight').value='';
  document.getElementById('qlbSleep').value='5';document.getElementById('qlbSleepVal').textContent='5';
  document.getElementById('qlbEnergy').value='5';document.getElementById('qlbEnergyVal').textContent='5';
  document.getElementById('qlbStress').value='5';document.getElementById('qlbStressVal').textContent='5';
  document.getElementById('qlbSore').value='5';document.getElementById('qlbSoreVal').textContent='5';
  document.getElementById('qlbPain').value='0';document.getElementById('qlbPainVal').textContent='0';document.getElementById('qlbPainLocation').value='';document.getElementById('qlbPainLocationWrap').style.display='none';
  document.getElementById('qlbNotes').value='';
  var prevPanel=document.getElementById('qlbPrevDay');if(prevPanel) prevPanel.style.display='none';
  if(weekOffset===0&&document.getElementById('tab-training').classList.contains('active'))renderTodaySection();
}
async function submitQuickNut(){
  var btn=document.getElementById('qlnSubmitBtn');btn.textContent='Logging...';btn.disabled=true;
  var nutDate=document.getElementById('qlnDate').value||todayISO2();
  var payload={type:'daily_nutrition',athleteName:athlete.name,athleteCode:athlete.code,athleteId:athlete.notionPageId,
    date:nutDate,notes:document.getElementById('qlnNotes').value||''};
  // Only send numeric macros that actually have a value — empty strings break Notion number fields
  [['calories','qlnCal'],['protein','qlnPro'],['carbs','qlnCarbs'],['fat','qlnFat'],['fibre','qlnFibre']].forEach(function(_f){
    var _v=document.getElementById(_f[1]).value;
    if(_v!==''&&_v!=null) payload[_f[0]]=_v;
  });
  localStorage.setItem('dp_daily_nut_'+athlete.code+'_'+nutDate,JSON.stringify(payload));
  try{syncQuickLogDock();}catch(e){}
  var nutResult=await coachWrite(DAILY_NUT_WEBHOOK,payload);
  closeQuickLog('nut');
  showToast(nutResult.queued?'Nutrition logged - coach dashboard sync pending':'Nutrition logged ✓');
  btn.textContent='Log Nutrition';btn.disabled=false;
  // Reset for next use
  document.getElementById('qlnDate').value='';document.getElementById('qlnCal').value='';
  document.getElementById('qlnPro').value='';document.getElementById('qlnCarbs').value='';
  document.getElementById('qlnFat').value='';document.getElementById('qlnFibre').value='';
  document.getElementById('qlnNotes').value='';
  var prevPanel=document.getElementById('qlnPrevDay');if(prevPanel) prevPanel.style.display='none';
}
