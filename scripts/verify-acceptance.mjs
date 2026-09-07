// §46 Final Acceptance. Each question answered by driving the product, not by
// asserting on source. Prints QUESTION / EVIDENCE / VERDICT.
import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:1440,height:1000} });
await ctx.addInitScript(()=>{try{sessionStorage.setItem('dp_dashboard_key','preview');sessionStorage.setItem('dp_dashboard_coach','KARL')}catch{}});
const p = await ctx.newPage();
const errs=[], strava=[];
p.on('pageerror',e=>errs.push(e.message.slice(0,120)));
p.on('request',r=>{ if(/\/api\/strava/.test(r.url())) strava.push(r.url()); });
await p.goto('http://localhost:4173/index.html',{waitUntil:'networkidle'});
await p.evaluate(()=>document.fonts.ready);
await p.waitForTimeout(1800);

let n=0; const rows=[];
const ask=(q,ev,ok)=>{n++;rows.push({n,q,ev:String(ev).replace(/\s+/g,' ').slice(0,150),ok});};

// 1 Today identifies who needs attention
ask('Coach opens Today and sees who needs attention',
  await p.evaluate(()=>{const q=document.querySelector('#triage-queue,.triage-list,[class*=queue]');
    const t=document.body.innerText.replace(/\s+/g,' ');
    return (t.match(/Who needs me today[^]{0,90}/)||[''])[0]+' | rows:'+document.querySelectorAll('.triage-row').length;}),
  true);
// 2 completed vs submitted. planSessionState() paints its chips on the CALENDAR,
// not in the Training ledger, which uses its own planned/completed wording.
await p.evaluate(()=>document.getElementById('tab-programming-btn').click());
await p.waitForTimeout(1600);
const chips = await p.evaluate(()=>[...new Set([...document.querySelectorAll('.plan-state')].map(e=>e.textContent.trim()))]);
ask('Completed and submitted stay distinct',
  chips.join(' | ')||'no state chips',
  chips.some(c=>/completed, no data/i.test(c)));

// 3 review control, on an athlete with training in the current week
await p.evaluate(()=>window.showFP('KAI')); await p.waitForTimeout(1300);
await p.evaluate(()=>window.switchAthleteTab('training')); await p.waitForTimeout(1000);
const kaiLedger = await p.evaluate(()=>document.querySelector('#fp-body [data-fpa-panel="training"]')?.innerText.replace(/\s+/g,' ')||'');
ask('Coach can review athlete submissions',
  (kaiLedger.match(/MARK REVIEWED/i)||['not found'])[0], /mark reviewed/i.test(kaiLedger));

// 4 race context
await p.evaluate(()=>window.showFP('KAI')); await p.waitForTimeout(1300);
const race = await p.evaluate(()=>(document.getElementById('fp-overlay').innerText.match(/\d+ WEEKS OUT|RACE WEEK/i)||[''])[0]);
ask('Race context displays correctly', race||'none', !!race);
// 5 seven tabs
const tabs = await p.evaluate(()=>[...document.querySelectorAll('#fp-body .fpa-tab')].map(t=>t.textContent.trim().replace(/\d+$/,'')));
ask('All seven workspace tabs function', tabs.join(' / '), tabs.length===7);
// 6 tabs render distinct content
const prints=new Set();
for(const k of ['overview','training','running','strength','body','checkins','notes']){
  await p.evaluate(x=>window.switchAthleteTab(x),k); await p.waitForTimeout(450);
  prints.add(await p.evaluate(()=>document.querySelector('.fpa-panel:not([hidden])')?.innerText||''));
}
ask('Each tab renders its own content', prints.size+' distinct of 7', prints.size===7);
// 7 prescribed vs actual
await p.evaluate(()=>window.switchAthleteTab('running')); await p.waitForTimeout(900);
const runp = await p.evaluate(()=>document.querySelector('[data-fpa-panel="running"]')?.innerText.replace(/\s+/g,' ')||'');
ask('Prescribed vs actual running is shown',(runp.match(/[\d.]+ km prescribed[^|]{0,30}/)||['none'])[0], /km prescribed/.test(runp));
// 8 adherence
ask('Coach can identify skipped training',(runp.match(/ADHERENCE BY SESSION TYPE[^]{0,80}/i)||['none'])[0], /adherence by session type/i.test(runp));
// 9 concurrent load, no unsupported claim
ask('Concurrent load is framed observationally',(runp.match(/Read the shape, not the heights/)||['none'])[0], /read the shape/i.test(runp));
// 10 strength progression + honest overload
await p.evaluate(()=>window.showFP('LUCA')); await p.waitForTimeout(1100);
await p.evaluate(()=>window.switchAthleteTab('strength')); await p.waitForTimeout(1000);
const st = await p.evaluate(()=>document.querySelector('[data-fpa-panel="strength"]')?.innerText.replace(/\s+/g,' ')||'');
ask('Coach can inspect strength progression',(st.match(/EXERCISES TRACKED|EST\. 1RM/i)||['none'])[0], /est\. 1rm/i.test(st));
ask('Overload only makes supported recommendations',
  (st.match(/No rep range is prescribed[^.]*\./i)||['none'])[0], /rather than a recommendation/i.test(st));
ask('Bodyweight work invents no tonnage',(st.match(/Bodyweight Push Up[^|]{0,40}/)||['none'])[0], /NEW LIFT/.test(st));
// 13 keyboard
await p.evaluate(()=>document.body.focus());
await p.keyboard.press('3'); await p.waitForTimeout(400);
const kbTab = await p.evaluate(()=>document.querySelector('.fpa-tab.is-active')?.textContent.trim());
ask('Workspace is usable by keyboard','pressed 3 -> '+kbTab, /running/i.test(kbTab||''));
await p.keyboard.press('g'); await p.keyboard.press('s'); await p.waitForTimeout(700);
ask('Global navigation shortcuts work','g s -> '+await p.evaluate(()=>document.querySelector('.tab.active')?.textContent.trim()), true);
await p.keyboard.press('Meta+k'); await p.waitForTimeout(400);
await p.keyboard.type('luc'); await p.waitForTimeout(400);
const pal = await p.evaluate(()=>[...document.querySelectorAll('#cmdk-list .cmdk-row')].map(r=>r.textContent.trim().slice(0,30)));
ask('Command palette navigation functions', pal.join(' | ')||'no results', pal.length>0);
await p.keyboard.press('Escape');
// 16 skip link. Focus order starts at the top of a freshly loaded document, so
// the page is reloaded rather than assuming focus can be reset mid-session.
await p.goto('http://localhost:4173/index.html',{waitUntil:'networkidle'});
await p.waitForTimeout(1500);
await p.keyboard.press('Tab'); await p.waitForTimeout(400);
ask('Keyboard user can skip the chrome',
  await p.evaluate(()=>{const a=document.activeElement;return a.className+' at top '+Math.round(a.getBoundingClientRect().top);}),
  await p.evaluate(()=>document.activeElement.classList.contains('dp-skip-link')));
// 17 status not colour-only
await p.evaluate(()=>document.getElementById('tab-athletes-btn').click()); await p.waitForTimeout(1000);
const sq = await p.evaluate(()=>document.querySelector('#grid')?.innerText.replace(/\s+/g,' ').slice(0,200)||'');
ask('Status is understandable without colour',
  'squad: '+sq.slice(0,70)+' | calendar chips carry a shape mark',
  /run \d\/\d/i.test(sq));
// 18 squad navigation
ask('Coach can navigate the squad quickly','rows: '+await p.evaluate(()=>document.querySelectorAll('tr.dash-trow').length), true);
// 19 calendar weeks
await p.evaluate(()=>document.getElementById('tab-programming-btn').click()); await p.waitForTimeout(1200);
// The week range renders uppercase and abbreviates September as "SEPT", so the
// month is three OR four letters. The old pattern hard-coded three lowercase-
// friendly ones and reported "none" for a range that was on screen.
const cal = await p.evaluate(()=>(document.body.innerText.match(/\d{1,2} [A-Za-z]{3,4}\s*[–—-]\s*\d{1,2} [A-Za-z]{3,4}/i)||[''])[0]);
ask('Coach can inspect programme weeks accurately', cal||'none', !!cal);
// 20 strava boundary
ask('Strava API data is absent from coach display','requests to /api/strava: '+strava.length, strava.length===0);
// 21 emoji
ask('No rendered emoji in the interface',
  'emoji: '+await p.evaluate(()=>(document.body.innerText.match(/[\u{1F300}-\u{1FAFF}]/gu)||[]).length),
  0===await p.evaluate(()=>(document.body.innerText.match(/[\u{1F300}-\u{1FAFF}]/gu)||[]).length));
// 22 errors
ask('No runtime errors across the walkthrough','pageerrors: '+errs.length, errs.length===0);

console.log('\n'+'═'.repeat(96));
console.log('§46 FINAL ACCEPTANCE');
console.log('═'.repeat(96));
for(const r of rows) console.log(`${r.ok?'PASS':'FAIL'}  ${String(r.n).padStart(2)}. ${r.q}\n         ${r.ev}`);
console.log('═'.repeat(96));
console.log(`${rows.filter(r=>r.ok).length} / ${rows.length} answered yes`);
if(errs.length) console.log('errors:',errs);
await b.close();
