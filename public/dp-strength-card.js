/**
 * dp-strength-card.js
 * ---------------------------------------------------------------------------
 * Drop-in renderer for the Dual Performance athlete portal strength tracker.
 * Turns each prescribed exercise into a compact, scannable row that expands
 * into a progressive-overload coaching card.
 *
 * Design goals (agreed with Karl):
 *   - Collapsed by default: one line of truth (name + why + target chip).
 *   - Expands on tap to show the progression ladder, PB, set inputs, and a tip.
 *   - Teaching (ladder + tip) only appears when a card is open, so a full
 *     session of 6 to 8 exercises stays scannable on a 430px phone.
 *   - Colour AND an arrow icon carry the meaning (accessible without colour).
 *
 * Depends on: progressive-overload.js (same folder).
 * Styles: call injectStrengthCardStyles() once, or paste the CSS into the app.
 *
 * No em dashes anywhere in output copy (per house style).
 */

import { computeTarget } from './progressive-overload.js';

/* Map the engine's `lever` / `status` to a visual state. */
function stateFor(card) {
  switch (card.status) {
    case 'progress_load': return { key: 'go',   cls: 'state-go',   chip: 'go',   arrow: '↗' }; // up-right
    case 'stalled':       return { key: 'warn', cls: 'state-warn', chip: 'warn', arrow: '↻' }; // reset
    case 'first_time':    return { key: 'base', cls: '',           chip: 'hold', arrow: '' };
    case 'hold':          return { key: 'hold', cls: '',           chip: 'hold', arrow: '→' }; // right
    default:              return { key: 'hold', cls: '',           chip: 'hold', arrow: '→' }; // add reps
  }
}

/* Short "why" line for the collapsed row. Kept under ~6 words. */
function whyLine(card) {
  const t = card.target;
  switch (card.status) {
    case 'progress_load': return { text: 'Maxed reps at ' + fmt(card.lastSummary.weightKg) + '. Level up.', cls: 'go' };
    case 'stalled':       return { text: 'Stuck a few weeks. Reset to ' + fmt(t.weightKg) + '.', cls: 'warn' };
    case 'first_time':    return { text: 'First time. Find your weight.', cls: '' };
    case 'hold':          return { text: 'Hold ' + fmt(card.lastSummary.weightKg) + ', clean it up.', cls: '' };
    default:              return { text: 'Hold ' + fmt(card.lastSummary.weightKg) + ', add a rep.', cls: '' };
  }
}

/* The three-rung progression ladder shown inside the open card. */
function ladderHTML(card) {
  if (card.status === 'first_time') return '';
  if (card.status === 'stalled') {
    return rungs([
      ['Reset', 'active warn'], ['Rebuild', 'upcoming'], ['Push on', 'upcoming']
    ]);
  }
  const onLoad = card.status === 'progress_load';
  return rungs([
    ['Own reps', onLoad ? 'done' : 'active'],
    ['Add load', onLoad ? 'active' : 'upcoming'],
    ['New base', 'upcoming']
  ]);
}
function rungs(list) {
  return '<div class="dpsc-ladder">' + list.map(function (s) {
    const done = s[1].indexOf('done') > -1 ? '<svg class="icon"><use href="#i-check"/></svg> ' : '';
    return '<div class="dpsc-rung ' + s[1] + '"><div class="dpsc-rl">' + done + '</div><div class="dpsc-rt">' + s[0] + '</div></div>';
  }).join('') + '</div>';
}

function setsHTML(card, id) {
  const kg = card.target.weightKg == null ? '--' : card.target.weightKg;
  let rows = '';
  const n = card.target.sets || (card.lastSummary ? card.lastSummary.sets : 2) || 2;
  for (let i = 1; i <= n; i++) {
    rows +=
      '<div class="dpsc-set"><span class="dpsc-n">' + i + '</span>' +
      '<input class="dpsc-cell" inputmode="decimal" placeholder="' + kg + '" data-ex="' + id + '" data-set="' + i + '" data-f="kg">' +
      '<input class="dpsc-cell" inputmode="numeric" placeholder="' + card.target.reps + '" data-ex="' + id + '" data-set="' + i + '" data-f="reps">' +
      '<div class="dpsc-cell dpsc-rpe">--</div>' +
      '<button class="dpsc-tick" aria-label="Mark set ' + i + ' done" data-ex="' + id + '" data-set="' + i + '"><svg class="icon"><use href="#i-check"/></svg></button></div>';
  }
  return '<div class="dpsc-set-head"><span></span><span>Kg</span><span>Reps</span><span>RPE</span><span><svg class="icon"><use href="#i-check"/></svg></span></div>' + rows;
}

/**
 * Render one exercise.
 * @param {object} prescription  { exercise, workingSets, repRange, rest }
 * @param {object[]} sessions    athlete session history
 * @param {object} [opts]        { id, open, lastRpe, config }
 * @returns {string} HTML
 */
export function renderExerciseCard(prescription, sessions, opts) {
  opts = opts || {};
  const id = opts.id != null ? opts.id : slug(prescription.exercise);
  const card = computeTarget(prescription, sessions, { lastRpe: opts.lastRpe, config: opts.config });
  const st = stateFor(card);
  const why = whyLine(card);
  const chipText = card.target.weightKg == null
    ? (card.status === 'first_time' ? 'Set base' : card.target.reps + ' reps')
    : fmt(card.target.weightKg, true);
  const pb = opts.pbKg ? '<div class="dpsc-pb">PB <b>' + fmt(opts.pbKg) + '</b></div>' : '';

  return '' +
    '<div class="dpsc-ex ' + st.cls + (opts.open ? ' open' : '') + '" data-ex="' + id + '" data-status="' + card.status + '">' +
      '<div class="dpsc-row" role="button" tabindex="0" data-toggle="' + id + '">' +
        '<div class="dpsc-main"><div class="dpsc-name">' + esc(prescription.exercise) + '</div>' +
          '<div class="dpsc-why ' + why.cls + '">' + esc(why.text) + '</div></div>' +
        '<div class="dpsc-chip ' + st.chip + '">' + (st.arrow ? '<span class="dpsc-ar">' + st.arrow + '</span> ' : '') + chipText + '</div>' +
        '<div class="dpsc-chev">▾</div>' +
      '</div>' +
      '<div class="dpsc-body">' +
        ladderHTML(card) + pb + setsHTML(card, id) +
        '<div class="dpsc-tip"><span class="dpsc-i"><svg class="icon"><use href="#i-check"/></svg></span><span>' + esc(card.coaching) + '</span></div>' +
        '<button class="dpsc-add">+ Add set</button>' +
      '</div>' +
    '</div>';
}

/**
 * Render a whole session and wire up tap-to-expand + set ticking.
 * @param {HTMLElement} mount
 * @param {object} session  { day, exercises:[{prescription, sessions, pbKg, open, lastRpe}] }
 */
export function mountSession(mount, session) {
  const total = session.exercises.length;
  const body = session.exercises.map(function (e, i) {
    return renderExerciseCard(e.prescription, e.sessions, {
      id: i, open: !!e.open, pbKg: e.pbKg, lastRpe: e.lastRpe, config: e.config
    });
  }).join('');
  mount.innerHTML =
    '<div class="dpsc-day"><div class="dpsc-dayname">' + esc(session.day || 'Session') + '</div>' +
    '<div class="dpsc-prog" data-prog>0 / ' + total + ' done</div></div>' + body;

  mount.addEventListener('click', function (e) {
    const tick = e.target.closest('.dpsc-tick');
    if (tick) { e.stopPropagation(); tick.classList.toggle('on'); updateProgress(mount, total); return; }
    const row = e.target.closest('[data-toggle]');
    if (row) { row.closest('.dpsc-ex').classList.toggle('open'); }
  });
  mount.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-toggle]')) {
      e.preventDefault(); e.target.closest('.dpsc-ex').classList.toggle('open');
    }
  });
}

function updateProgress(mount, total) {
  let done = 0;
  mount.querySelectorAll('.dpsc-ex').forEach(function (ex) {
    const ticks = [].slice.call(ex.querySelectorAll('.dpsc-tick'));
    const all = ticks.length && ticks.every(function (t) { return t.classList.contains('on'); });
    ex.classList.toggle('done', all); if (all) done++;
  });
  const el = mount.querySelector('[data-prog]');
  if (el) el.textContent = done + ' / ' + total + ' done';
}

/* helpers */
function fmt(kg, bare) {
  if (kg == null) return '--';
  const n = Math.round(kg * 100) / 100;
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return bare ? s : s + 'kg';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

/* One-time style injection. Colours tuned for the DP dark theme. */
export function injectStrengthCardStyles() {
  if (document.getElementById('dpsc-styles')) return;
  const css = `
  .dpsc-day{display:flex;align-items:center;justify-content:space-between;margin:6px 2px 14px}
  .dpsc-dayname{font-size:12px;letter-spacing:.07em;color:#8595ab;text-transform:uppercase}
  .dpsc-prog{font-size:11px;color:#6f7f96;font-variant-numeric:tabular-nums}
  .dpsc-ex{border:1px solid #1f2b3d;background:#131c2b;border-radius:12px;margin-bottom:8px;overflow:hidden}
  .dpsc-ex.state-go{border-color:#2f7a54}.dpsc-ex.state-warn{border-color:#5a3f1f}.dpsc-ex.done{opacity:.55}
  .dpsc-row{display:flex;align-items:center;gap:9px;padding:12px 13px;cursor:pointer}
  .dpsc-main{flex:1;min-width:0}
  .dpsc-name{font-size:14px;font-weight:500;line-height:1.2;color:#e8edf4}
  .dpsc-why{font-size:11px;color:#8595ab;margin-top:3px;line-height:1.3}
  .dpsc-why.go{color:#7f9d8b}.dpsc-why.warn{color:#c9a86a}
  .dpsc-chip{display:flex;align-items:center;gap:5px;border-radius:8px;padding:6px 10px;font-size:13px;
    white-space:nowrap;font-variant-numeric:tabular-nums;border:1px solid #2b3a4f;background:#182433;color:#9fb0c7}
  .dpsc-chip.go{border-color:#2f7a54;background:#12291f;color:#7bedb4}
  .dpsc-chip.warn{border-color:#6b4f1f;background:#2a2113;color:#e0b64d}
  .dpsc-ar{font-size:14px;line-height:1}
  .dpsc-chip.hold .dpsc-ar{color:#7aa0cc}
  .dpsc-chev{font-size:12px;color:#6f7f96;width:14px;text-align:center;transition:transform .18s}
  .dpsc-ex.open .dpsc-chev{transform:rotate(180deg)}
  .dpsc-body{display:none;padding:0 13px 13px}.dpsc-ex.open .dpsc-body{display:block}
  .dpsc-ladder{display:flex;gap:5px;margin:4px 0 11px}
  .dpsc-rung{flex:1;border:1px solid #263449;background:#0f1826;border-radius:8px;padding:7px 4px;text-align:center}
  .dpsc-rl{font-size:10px;text-transform:uppercase;color:#6f7f96}
  .dpsc-rt{font-size:11px;color:#9fb0c7;margin-top:3px}
  .dpsc-rung.done{opacity:.7}
  .dpsc-rung.active{border-color:#2f7a54;background:#12291f}
  .dpsc-rung.active .dpsc-rl{color:#5fae82}.dpsc-rung.active .dpsc-rt{color:#7bedb4;font-weight:500}
  .dpsc-rung.upcoming{opacity:.5}
  .dpsc-rung.active.warn{border-color:#6b4f1f;background:#2a2113}
  .dpsc-rung.active.warn .dpsc-rl,.dpsc-rung.active.warn .dpsc-rt{color:#e0b64d}
  .dpsc-pb{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#6f7f96;margin-bottom:10px}
  .dpsc-pb b{color:#b9a6ee;font-weight:600}
  .dpsc-set-head,.dpsc-set{display:grid;grid-template-columns:20px 1fr 1fr 46px 40px;gap:6px;align-items:center}
  .dpsc-set-head{font-size:9px;letter-spacing:.06em;color:#6f7f96;text-transform:uppercase;margin-bottom:5px}
  .dpsc-set-head span{text-align:center}.dpsc-set{margin-top:6px}
  .dpsc-n{font-size:12px;color:#6f7f96;text-align:center}
  .dpsc-cell{height:42px;border:1px solid #263449;background:#0f1826;border-radius:8px;text-align:center;
    font-size:16px;color:#e8edf4;width:100%;font-variant-numeric:tabular-nums;outline:none}
  .dpsc-cell::placeholder{color:#4c5f79}.dpsc-cell:focus{border-color:#2f7a54}
  .dpsc-rpe{display:flex;align-items:center;justify-content:center;color:#6f7f96;font-size:14px}
  .dpsc-tick{justify-self:center;width:26px;height:26px;border-radius:50%;border:1.6px solid #2b3a4f;
    background:transparent;color:transparent;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.12s}
  .dpsc-tick.on{background:#12291f;border-color:#2f7a54;color:#7bedb4}
  .dpsc-tip{font-size:11px;color:#8fa2bd;line-height:1.5;margin-top:10px;display:flex;gap:6px}
  .dpsc-i{color:#e0b64d;flex-shrink:0}
  .dpsc-add{margin-top:11px;width:100%;text-align:center;font-size:12px;color:#8595ab;background:transparent;
    border:1px dashed #263449;border-radius:8px;padding:9px;cursor:pointer}
  `;
  const tag = document.createElement('style');
  tag.id = 'dpsc-styles'; tag.textContent = css;
  document.head.appendChild(tag);
}

export default { renderExerciseCard, mountSession, injectStrengthCardStyles };
