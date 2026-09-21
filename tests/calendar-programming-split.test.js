// Calendar and Programming are two tabs over one content div. A tab-key
// comparison in the visibility loop would let the second pass hide the panel
// the first had just shown, so this drives the real switchTab against a stub
// DOM rather than asserting on its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync('public/index.html', 'utf8');
function src(name){const s=html.indexOf(`function ${name}(`);let d=0;const o=html.indexOf('{',s);
  for(let i=o;i<html.length;i++){if(html[i]==='{')d++;if(html[i]==='}')d--;if(!d)return html.slice(s,i+1);}}

const nodes = new Map();
const el = id => { if(!nodes.has(id)) nodes.set(id,{id,style:{},cls:new Set(),attrs:{},
  classList:{toggle(c,on){on?nodes.get(id).cls.add(c):nodes.get(id).cls.delete(c)},contains:c=>nodes.get(id).cls.has(c)},
  setAttribute(k,v){nodes.get(id).attrs[k]=v}}); return nodes.get(id); };
['tab-triage-content','tab-athletes-content','tab-programming-content','tab-coaches-content','tab-sync-content',
 'tab-apps-content','tab-notif-content','tab-send-content','tab-calendar-btn','tab-programming-btn',
 'tab-triage-btn','tab-athletes-btn','tab-pipeline-btn','settings-btn','pipeline-subnav','filter-bar','gen-btn'].forEach(el);

let rendered = [];
const ctx = vm.createContext({
  document:{ getElementById:id=>nodes.get(id)||null },
  localStorage:{ getItem:()=>'block', setItem(){} },
  console, _allAthletes:[], _fullDashboardLoaded:true, _fullDashboardLoading:false,
  closeSettingsMenu(){}, load(){}, cnPopulate(){},
  renderProgramming(){ rendered.push(view()); },
});
vm.runInContext(
  `let _progView='block';`
  + `const PIPELINE_TABS=['applications','notifications','send'];`
  + `const ALL_TABS=['triage','athletes','calendar','programming','coaches','sync',...PIPELINE_TABS];`
  + `const TAB_CONTENT_ID={applications:'apps',notifications:'notif',calendar:'programming'};`
  + `const PROG_TABS=['calendar','programming'];`
  + `let _pipelineView='applications';`
  + `const PROG_VIEWS=new Set(['week','squad','block']);`
  + `${src('primaryTabFor')} ${src('_progDetailView')} ${src('switchTab')} ${src('goProgView')}`, ctx);

const view = () => vm.runInContext('_progView', ctx);
const panel = () => nodes.get('tab-programming-content').style.display;
const lit = id => nodes.get(id).cls.has('active');
const check = (label, ok, got) => test(label, () => assert.ok(ok, String(got)));

ctx.switchTab('calendar');
check('Calendar shows the panel',            panel()==='',        panel());
check('Calendar selects the squad board',    view()==='squad', view());
check('Calendar button is lit, not Programming', lit('tab-calendar-btn') && !lit('tab-programming-btn'),
      `cal=${lit('tab-calendar-btn')} prog=${lit('tab-programming-btn')}`);

ctx.switchTab('programming');
check('Programming keeps the panel visible', panel()==='',        panel());
check('Programming restores the stored view', view()==='block', view());
check('Programming button is lit, not Calendar', lit('tab-programming-btn') && !lit('tab-calendar-btn'),
      `cal=${lit('tab-calendar-btn')} prog=${lit('tab-programming-btn')}`);

ctx.switchTab('triage');
check('Leaving hides the shared panel',      panel()==='none',    panel());

ctx.switchTab('nutrition');
check('legacy nutrition → Weekly Targets',   view()==='block' && panel()==='', view());
ctx.switchTab('planning');
check('legacy planning → Sessions',          view()==='week', view());
check('both tabs rendered the panel',        rendered.length===4, JSON.stringify(rendered));

// The view switch and the tab bar are one choice with two affordances. Driving
// the switch must move the tab, not leave the two disagreeing.
const go = v => vm.runInContext(`goProgView(${JSON.stringify(v)})`, ctx);

go('squad');
check('switch → Calendar selects the squad board', view()==='squad', view());
check('switch → Calendar lights the Calendar tab', lit('tab-calendar-btn') && !lit('tab-programming-btn'),
      `cal=${lit('tab-calendar-btn')} prog=${lit('tab-programming-btn')}`);
check('switch → Calendar keeps the panel up',      panel()==='', panel());

go('block');
check('switch → Weekly Targets from the board',    view()==='block', view());
check('switch → Weekly Targets lights Programming', lit('tab-programming-btn') && !lit('tab-calendar-btn'),
      `cal=${lit('tab-calendar-btn')} prog=${lit('tab-programming-btn')}`);

let stored = null;
ctx.localStorage.setItem = (k, v) => { if (k === 'dp_prog_view') stored = v; };
go('week');  check('switch → Sessions is remembered',        stored==='week', stored);
go('squad'); check('the squad board is never remembered',    stored==='week', stored);
