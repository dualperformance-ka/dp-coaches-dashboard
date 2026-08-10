// ── DP INSTRUMENT GAUGES ─────────────────────────────────────────────────────
// Open arc: 264° sweep, gap at the bottom. SVG y-down: 90° points down.
var GAUGE_START=138, GAUGE_SWEEP=264, GAUGE_CX=36, GAUGE_CY=36;
function gaugePt(deg,r){var a=deg*Math.PI/180;return[GAUGE_CX+r*Math.cos(a),GAUGE_CY+r*Math.sin(a)];}
// KM: ticked tachometer arc. Ticks light up in a sweep; last tick = target notch.
function buildKmGauge(pct){
  var svg=document.getElementById('kmGauge');
  if(!svg) return;
  var N=36, lit=Math.round(Math.min(100,Math.max(0,pct))/100*N), html='';
  for(var i=0;i<N;i++){
    var a=GAUGE_START+(i/(N-1))*GAUGE_SWEEP;
    var isTgt=(i===N-1);
    var r1=isTgt?24.5:26, r2=isTgt?33:31.5;
    var p1=gaugePt(a,r1), p2=gaugePt(a,r2);
    html+='<line class="gauge-tick'+(isTgt?' tgt':'')+'" x1="'+p1[0].toFixed(2)+'" y1="'+p1[1].toFixed(2)+'" x2="'+p2[0].toFixed(2)+'" y2="'+p2[1].toFixed(2)+'" style="transition-delay:'+(i*16)+'ms"/>';
  }
  svg.innerHTML=html;
  var ticks=svg.querySelectorAll('.gauge-tick');
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    for(var i=0;i<lit;i++) ticks[i].classList.add('lit');
  });});
}
// GYM: one arc segment per session; completed sessions fill in.
function buildGymGauge(done,total){
  var svg=document.getElementById('gymGauge');
  if(!svg) return;
  total=Math.max(1,total);
  var gap=(total>1)?14:0, segSweep=(GAUGE_SWEEP-gap*(total-1))/total, R=28.5, html='';
  for(var i=0;i<total;i++){
    var a0=GAUGE_START+i*(segSweep+gap), a1=a0+segSweep;
    var p0=gaugePt(a0,R), p1=gaugePt(a1,R);
    var large=(segSweep>180)?1:0;
    html+='<path class="gauge-seg" d="M '+p0[0].toFixed(2)+' '+p0[1].toFixed(2)+' A '+R+' '+R+' 0 '+large+' 1 '+p1[0].toFixed(2)+' '+p1[1].toFixed(2)+'" style="transition-delay:'+(i*90)+'ms"/>';
  }
  svg.innerHTML=html;
  var segs=svg.querySelectorAll('.gauge-seg');
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    for(var i=0;i<Math.min(done,total);i++) segs[i].classList.add('done');
  });});
}
function renderKmTracker(kmData){
  var bar=document.getElementById('kmBar');
  if(!bar) return;
  if(!kmData || kmData.target==null || isNaN(kmData.target) || Number(kmData.target)<=0){
    bar.style.display='none';
    return;
  }
  var target=Number(kmData.target);
  var done=Number(kmData.completed||0);
  if(isNaN(done)||done<0) done=0;
  var pct=Math.min(100,Math.round(done/target*100));
  var fmt=function(n){return n.toFixed(1).replace(/\.0$/,'');};
  document.getElementById('kmTargetVal').textContent=fmt(target);
  var doneEl=document.getElementById('kmDoneVal');
  if(doneEl) doneEl.textContent=fmt(done);
  var progress=document.getElementById('kmProgress');
  var progressFill=document.getElementById('kmProgressFill');
  if(progress){
    progress.setAttribute('aria-valuenow',String(done));
    progress.setAttribute('aria-valuemax',String(target));
  }
  if(progressFill) progressFill.style.width=pct+'%';
  var srcEl=document.getElementById('kmSrcStrava');
  if(srcEl) srcEl.style.display=(kmData.source==='strava')?'':'none';
  bar.classList.toggle('km-hit',done>=target);
  bar.style.display='';
  buildKmGauge(pct);
}
// ── WEEKLY KM TARGET CARD ─────────────────────────────────────────────────────
// Same numbers as the home-screen km tracker, rendered as a standalone card
// under the Nutrition macros. Training keeps the lighter Volume by week strip.
// data = {target, completed, source, weekLabel}
function fmtKmVal(n){
  n=Number(n);
  if(isNaN(n)) return '0';
  return (Math.round(n*10)/10).toFixed(1).replace(/\.0$/,'');
}
var WKM_SOURCE_LABEL={strava:'Synced from Strava',portal:'From your logged sessions',local:'From your logged sessions',plan:'From your planned sessions'};
function weeklyKmCardHtml(data){
  var target=Number(data.target),done=Number(data.completed||0);
  if(isNaN(done)||done<0) done=0;
  var pct=Math.min(100,Math.round(done/target*100));
  var left=Math.round(Math.max(0,target-done)*10)/10;
  var hit=done>=target;
  var srcLabel=WKM_SOURCE_LABEL[data.source]||'';
  var footLeft=hit?'Target hit — nice work':(done>0?fmtKmVal(left)+' km to go':'Nothing logged yet this week');
  return '<div class="wkm-head">'
    +'<span class="wkm-ico"><svg class="icon"><use href="#i-shoe"/></svg></span>'
    +'<span class="wkm-headtext">'
      +'<span class="wkm-kicker">Weekly km target'+(data.weekLabel?' · '+esc(data.weekLabel):'')+'</span>'
      +'<span class="wkm-figure"><strong>'+fmtKmVal(done)+'</strong><small>/ '+fmtKmVal(target)+' km</small></span>'
    +'</span>'
    +'<span class="wkm-pct">'+pct+'%</span>'
  +'</div>'
  +'<div class="wkm-track" role="progressbar" aria-label="Weekly running volume" aria-valuemin="0" aria-valuenow="'+fmtKmVal(done)+'" aria-valuemax="'+fmtKmVal(target)+'"><span style="width:'+pct+'%"></span></div>'
  +'<div class="wkm-foot"><span>'+footLeft+'</span>'+(srcLabel?'<span class="wkm-src">'+srcLabel+'</span>':'')+'</div>';
}
// Renders into #id, or hides it when there's no usable target for the week.
function renderWeeklyKmCard(id,data){
  var el=document.getElementById(id);
  if(!el) return;
  var target=data&&data.target!=null?Number(data.target):NaN;
  if(!data||isNaN(target)||target<=0){el.style.display='none';el.innerHTML='';return;}
  var done=Number(data.completed||0);
  el.innerHTML=weeklyKmCardHtml(data);
  el.classList.toggle('wkm-done',!isNaN(done)&&done>=target);
  el.style.display='block';
}
// ── PROGRAMME VOLUME STRIP ────────────────────────────────────────────────────
// Every week of the programme as a mini bar: planned km as the column, actual km
// filled in over it. Tapping a week jumps the tab to it. Used under the km card
// on Weekly Plan and Nutrition; the Progress tab renders the same data larger.
function jumpToProgrammeWeek(wk,mode){
  var base=baseProgrammeWeek();
  if(mode==='nutrition'){nutWeekOffset=wk-base;loadNutrition();}
  else{weekOffset=wk-base;loadWeek();}
  var el=document.getElementById(mode==='nutrition'?'nutKmCard':(document.getElementById('trainingVolumeStrip')&&document.getElementById('trainingVolumeStrip').offsetParent?'trainingVolumeStrip':'weeklyVolumeStrip'));
  if(el&&el.scrollIntoView) el.scrollIntoView({behavior:'smooth',block:'center'});
}
// Collapsible on Training, where the week list is the point of the page.
// It starts closed every time the athlete opens Training, then expands on tap.
function collapseTrainingVolumeStrips(){
  ['trainingVolumeStrip','weeklyVolumeStrip'].forEach(function(id){
    var card=document.getElementById(id);if(!card)return;
    card.classList.remove('is-open');
    var toggle=card.querySelector('.vstrip-toggle');
    if(toggle)toggle.setAttribute('aria-expanded','false');
  });
}
function toggleVolumeStrip(btn){
  var card=btn&&btn.closest?btn.closest('.vstrip-card'):null;
  if(!card) return;
  var open=card.classList.toggle('is-open');
  btn.setAttribute('aria-expanded',open?'true':'false');
  if(open){
    var cur=card.querySelector('.vstrip-week.is-current'),sc=card.querySelector('.vstrip-scroll');
    if(cur&&sc) sc.scrollLeft=Math.max(0,cur.offsetLeft-sc.clientWidth/2+cur.offsetWidth/2);
  }
}
function volumeStripHtml(data,mode,collapsible){
  var weeks=(data&&data.weeks)||[];
  var withPlan=weeks.filter(function(w){return w.planned;});
  if(!withPlan.length) return '';
  var max=0;
  weeks.forEach(function(w){max=Math.max(max,w.planned||0,w.actual||0);});
  if(max<=0) return '';
  var peak=withPlan.reduce(function(a,b){return (b.planned>a.planned)?b:a;});
  var totalPlanned=Math.round(withPlan.reduce(function(t,w){return t+w.planned;},0));
  var bars='';
  weeks.forEach(function(w){
    var ph=w.planned?Math.max(6,Math.round(w.planned/max*100)):0;
    var ah=(w.actual!=null&&w.actual>0)?Math.max(4,Math.round(Math.min(w.actual,max)/max*100)):0;
    var cls='vstrip-week'+(w.isCurrent?' is-current':'')+(w.isPast?' is-past':'')+(w.isFuture?' is-future':'');
    if(!w.planned) cls+=' is-empty';
    if(w.actual!=null&&w.planned&&w.actual>=w.planned) cls+=' is-hit';
    var aria='Week '+w.week+(w.planned?', '+fmtKmVal(w.planned)+' km planned':', no target')
      +(w.actual!=null?', '+fmtKmVal(w.actual)+' km run':'');
    bars+='<button type="button" class="'+cls+'" onclick="jumpToProgrammeWeek('+w.week+',\''+mode+'\')" aria-label="'+esc(aria)+'">'
      +'<span class="vstrip-bar">'+(ph?'<i style="height:'+ph+'%"></i>':'')+(ah?'<b style="height:'+ah+'%"></b>':'')+'</span>'
      // No target for this week reads as broken with a dash, so leave it blank.
      +'<span class="vstrip-km">'+(w.planned?fmtKmVal(w.planned):'')+'</span>'
      +'<span class="vstrip-wk">W'+w.week+'</span>'
    +'</button>';
  });
  var summary='Peak W'+peak.week+' · '+fmtKmVal(peak.planned)+' km';
  var head=collapsible
    ? '<button type="button" class="vstrip-head vstrip-toggle" onclick="toggleVolumeStrip(this)" aria-expanded="false">'
        +'<span class="vstrip-title">Volume by week</span>'
        +'<span class="vstrip-sum">'+summary+'</span>'
        +'<svg class="icon vstrip-chev"><use href="#i-chevron-left"/></svg>'
      +'</button>'
    : '<div class="vstrip-head">'
        +'<span class="vstrip-title">Volume by week</span>'
        +'<span class="vstrip-legend"><span><i class="key-planned"></i>planned</span><span><i class="key-actual"></i>run</span></span>'
      +'</div>';
  return head
    +'<div class="vstrip-body">'
      +(collapsible?'<div class="vstrip-legend vstrip-legend-row"><span><i class="key-planned"></i>planned</span><span><i class="key-actual"></i>run</span></div>':'')
      +'<div class="vstrip-scroll">'+bars+'</div>'
      +'<div class="vstrip-foot"><span>Peak · Week '+peak.week+' at '+fmtKmVal(peak.planned)+' km</span><span>'+totalPlanned+' km planned across the block</span></div>'
    +'</div>';
}
// mode drives what a week tap navigates: 'training' or 'nutrition'.
// Training mounts collapse by default; Nutrition keeps it open next to the macros.
async function renderVolumeStrip(id,mode){
  var el=document.getElementById(id);
  if(!el) return;
  var data=null;
  try{data=await loadProgrammeVolume();}catch(e){}
  var collapsible=mode!=='nutrition';
  var html=data?volumeStripHtml(data,mode,collapsible):'';
  if(!html){el.style.display='none';el.innerHTML='';return;}
  el.innerHTML=html;
  el.classList.toggle('is-collapsible',collapsible);
  var open=!collapsible;
  el.classList.toggle('is-open',open);
  var tog=el.querySelector('.vstrip-toggle');
  if(tog) tog.setAttribute('aria-expanded',open?'true':'false');
  // Programme volume belongs to the Training plan, not the mobile Home view.
  // This render finishes asynchronously and used to turn the strip back on
  // after applyTrainingView() had hidden it, leaving it below the fixed nav.
  var hiddenOnMobileHome=id==='trainingVolumeStrip'&&document.body.classList.contains('mobile-portal-home');
  el.style.display=hiddenOnMobileHome?'none':'block';
  // Keep the current week in view without yanking the page around.
  if(open){
    var cur=el.querySelector('.vstrip-week.is-current'),scroller=el.querySelector('.vstrip-scroll');
    if(cur&&scroller) scroller.scrollLeft=Math.max(0,cur.offsetLeft-scroller.clientWidth/2+cur.offsetWidth/2);
  }
}
// ── LOAD NUTRITION + KM TRACKER ───────────────────────────────────────────────

async function loadNutrition(){
  var weekNum=getCurrentProgrammeWeek();
  var displayWeek=weekNum+nutWeekOffset;
  if(displayWeek<0) displayWeek=0;
  if(displayWeek>programmeWeeks) displayWeek=programmeWeeks;

  currentWeekKmData=null;
  document.getElementById('nutWLabel').textContent=isDiscoveryWeek(displayWeek)?'Discovery Week':'Week '+displayWeek;
  document.getElementById('nutLoadingEl').style.display='block';
  document.getElementById('nutContent').style.display='none';
  document.getElementById('nutNoplan').style.display='none';

  var weekLabel='Week '+displayWeek;

  // Kick off the completed-KM tracker scan now — it's the slowest fetch and is
  // independent of the nutrition row, so it runs in parallel.
  var trackerPromise=getWeeklyCompletedKmFromTracker(nutWeekOffset).catch(function(){return null;});

  // Nutrition plans now live in Supabase (nutrition_plans) — single source of
  // truth shared with the coaches dashboard. One row per athlete per week.
  var row=null;
  var nutritionPlanned=[];
  if(_authToken){
    try{
      var snapshot=window._trainingReadSnapshot;
      var freshSnapshot=!!(snapshot&&snapshot.ts&&(Date.now()-snapshot.ts)<60000&&Array.isArray(snapshot.nutritionRows)&&Array.isArray(snapshot.plannedRows));
      if(freshSnapshot){
        row=snapshot.nutritionRows.find(function(item){return String(item.week_label||'').toLowerCase()===weekLabel.toLowerCase();})||null;
        nutritionPlanned=snapshot.plannedRows.filter(function(item){return String(item.week_label||'').toLowerCase()===weekLabel.toLowerCase();});
      }else{
        var res=await portalRequest('nutrition-week',{weekLabel:weekLabel});
        row=res.plan||null;
        nutritionPlanned=res.planned||[];
      }
    }catch(e){console.warn('nutrition_plans load failed',e);}
  }

  _nutLastLoad=Date.now();
  document.getElementById('nutLoadingEl').style.display='none';

  if(!row){
    document.getElementById('nutNoplan').style.display='block';
    document.getElementById('kmBar').style.display='none';
    renderWeeklyKmCard('nutKmCard',null);
    // No nutrition row still leaves a planned-session km target for the week list.
    if(typeof renderTrainingVolumeStrips==='function') renderTrainingVolumeStrips();
    return;
  }

  currentWeekKmData={week:weekLabel,target:null,completed:null,source:'nutrition_row'};

  function getMacro(v){
    if(v==null) return '—';
    var s=String(v).trim();
    return s===''?'—':s;
  }

  var mCal=getMacro(row.calories);
  var mPro=getMacro(row.protein);
  var mCarb=getMacro(row.carbs);
  var mFat=getMacro(row.fats);
  var mFibre=getMacro(row.fibre);
  document.getElementById('nutCal').textContent=mCal;
  document.getElementById('nutPro').textContent=mPro;
  document.getElementById('nutCarb').textContent=mCarb;
  document.getElementById('nutFat').textContent=mFat;
  document.getElementById('nutFibre').textContent=mFibre;
  function toNutNum(v){
    if(typeof v==='number') return {display:String(v),min:v};
    if(!v||v==='—') return null;
    var s=String(v).trim();
    var n=parseFloat(s); // stops at first non-numeric char, so "35-38" → 35
    return isNaN(n)?null:{display:s,min:n};
  }
  currentNutTargets={cal:toNutNum(mCal),pro:toNutNum(mPro),carb:toNutNum(mCarb),fat:toNutNum(mFat),fibre:toNutNum(mFibre)};

  var note=(row.notes||'').trim();
  var noteEl=document.getElementById('nutCoachNote');
  if(note){
    noteEl.innerHTML='<svg class="icon icon-run"><use href="#i-chat"/></svg> '+esc(note);
    noteEl.style.display='block';
  }else{
    noteEl.style.display='none';
  }

  // Weekly KM: manual target wins; otherwise auto-sum this week's planned
  // session distances (with "Weekly KM Total: 65km" rows as a floor).
  var manualKmTarget=row.weekly_km_target!=null;
  var kmTarget=manualKmTarget?Number(row.weekly_km_target):null;
  if(kmTarget==null&&nutritionPlanned.length){
    try{
      if(nutritionPlanned.length){
        var sum=0,declared=0;
        nutritionPlanned.forEach(function(r2){
          if(r2.session_type==='Weekly KM Total'||/km total/i.test(r2.title||'')){
            var m=(r2.title||'').match(/(\d+(?:\.\d+)?)\s*km/i);
            if(m) declared=Math.max(declared,parseFloat(m[1]));
            return;
          }
          var d=parseFloat(r2.distance_km);
          if(isNaN(d)||d<=0){
            // Fall back to distance in the session title, e.g. "Easy Run — 12km"
            var tm=(r2.title||'').match(/(\d+(?:\.\d+)?)\s*km\b(?!\s*pace)/i);
            d=tm?parseFloat(tm[1]):0;
          }
          if(d>0) sum+=d;
        });
        var auto=Math.round(Math.max(sum,declared)*10)/10;
        if(auto>0) kmTarget=auto;
      }
    }catch(e){}
  }
  // No coach target: the Weekly Plan sum resolves library distances too, so it
  // reads distances this query misses. Take the higher of the two when both tabs
  // sit on the same week — one week must never show two different targets.
  if(!manualKmTarget&&nutWeekOffset===weekOffset&&typeof computeWeeklyPlanKm==='function'){
    var planTarget=computeWeeklyPlanKm();
    if(planTarget!=null&&(kmTarget==null||planTarget>kmTarget)) kmTarget=planTarget;
  }
  var nutritionCompleted=row.completed_km!=null?Number(row.completed_km):0;
  var trackerCompleted=await trackerPromise;
  var localCompleted=deriveCompletedKmFromSessions(sessions);
  var stravaResult=null;
  try{stravaResult=window._stravaLoadPromise ? await window._stravaLoadPromise : null;}catch(e){}
  var hasStrava=!!(stravaResult&&stravaResult.connected&&stravaResult.activitiesAvailable!==false);
  var stravaCompleted=hasStrava?deriveCompletedKmFromStrava(stravaResult.activities,nutWeekOffset):null;
  // One source only: Strava wins when connected, then submitted portal logs,
  // then this device's draft logs, and finally the legacy nutrition total.
  var kmCompleted=hasStrava ? stravaCompleted :
    (trackerCompleted!=null&&trackerCompleted>0 ? trackerCompleted :
      (localCompleted>0 ? localCompleted : nutritionCompleted));

  currentWeekKmData.target=kmTarget;
  currentWeekKmData.completed=kmCompleted;
  currentWeekKmData.source=hasStrava?'strava':(trackerCompleted>0?'portal':(localCompleted>0?'local':'nutrition_row'));

  if(kmTarget!=null){
    renderKmTracker({target:kmTarget,completed:kmCompleted,source:currentWeekKmData.source});
  }else{
    document.getElementById('kmBar').style.display='none';
  }
  renderWeeklyKmCard('nutKmCard',{target:kmTarget,completed:kmCompleted,source:currentWeekKmData.source,weekLabel:document.getElementById('nutWLabel').textContent});
  renderVolumeStrip('nutVolumeStrip','nutrition');
  // Keep the programme volume strip current when the selected week changes.
  if(typeof renderTrainingVolumeStrips==='function') renderTrainingVolumeStrips();

  document.getElementById('nutContent').style.display='block';
  if(weekOffset===0&&document.getElementById('tab-training').classList.contains('active'))renderTodaySection();
}
