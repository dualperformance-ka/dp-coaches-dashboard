/* Dual Performance Coaches Dashboard — safe DOM enhancements */
(() => {
  'use strict';

  const qs = (s, root = document) => root.querySelector(s);
  const qsa = (s, root = document) => [...root.querySelectorAll(s)];

  function formatToday() {
    try {
      return new Intl.DateTimeFormat('en-AU', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      }).format(new Date());
    } catch (_) {
      return '';
    }
  }

  function coachName() {
    const select = qs('.coach-select');
    const raw = select?.selectedOptions?.[0]?.textContent?.trim();
    if (!raw || /all/i.test(raw)) return 'Coaches';
    return raw.replace(/coach/ig, '').trim() || 'Coach';
  }

  function addPageIntro() {
    const content = qs('#content');
    const anchor = qs('#dash-week-nav');
    if (!content || !anchor || qs('.dp-page-intro')) return;

    const intro = document.createElement('section');
    intro.className = 'dp-page-intro';
    intro.setAttribute('aria-labelledby', 'dp-page-title');
    intro.innerHTML = `
      <div>
        <div class="dp-eyebrow">Coach overview</div>
        <h1 class="dp-page-title" id="dp-page-title">Good morning, <span id="dp-intro-coach">${coachName()}</span></h1>
        <p class="dp-page-subtitle">Start with the athletes who need a decision, then review squad adherence and recent activity.</p>
      </div>
      <div class="dp-intro-date">${formatToday()}</div>`;
    content.insertBefore(intro, anchor);
  }

  function improveNavigationLabels() {
    const tabs = qsa('.tab');
    tabs.forEach(tab => {
      const text = tab.childNodes[0]?.textContent?.trim()?.toLowerCase() || tab.textContent.trim().toLowerCase();
      if (text === 'dashboard' || text === 'athletes') tab.childNodes[0].textContent = 'Overview ';
      if (text === 'planning') tab.childNodes[0].textContent = 'Programming ';
      if (text === 'new') tab.childNodes[0].textContent = 'Applications ';
    });

    const search = qs('#search-input');
    if (search) search.placeholder = 'Search athletes by name…';

    qsa('.sf').forEach(btn => {
      const status = btn.dataset.status;
      if (status === 'red') btn.childNodes[0].textContent = 'Critical ';
      if (status === 'amber') btn.childNodes[0].textContent = 'Review ';
      if (status === 'green') btn.childNodes[0].textContent = 'On track ';
    });
  }

  function improveCommandCentre() {
    const title = qs('.cc-title');
    const kicker = qs('.cc-kicker');
    if (title && /command/i.test(title.textContent)) title.textContent = 'Priority actions';
    if (kicker) kicker.textContent = 'What needs attention now';

    qsa('.cc-list-title').forEach(el => {
      const t = el.textContent.toLowerCase();
      if (t.includes('red') || t.includes('alert') || t.includes('urgent')) {
        el.childNodes[0].textContent = 'Critical review ';
      } else if (t.includes('amber') || t.includes('watch')) {
        el.childNodes[0].textContent = 'Coach review ';
      }
    });
  }

  function improveSquadBrief() {
    const title = qs('.sb-title');
    if (title) title.textContent = 'Squad brief';
  }

  function updateCoachGreeting() {
    const el = qs('#dp-intro-coach');
    if (el) el.textContent = coachName();
  }

  function applyEnhancements() {
    addPageIntro();
    improveNavigationLabels();
    improveCommandCentre();
    improveSquadBrief();
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyEnhancements();
    qs('.coach-select')?.addEventListener('change', updateCoachGreeting);

    // Existing dashboard content is rendered asynchronously. Keep enhancements in sync
    // without touching its data or event handlers.
    const target = qs('#tab-athletes-content') || document.body;
    const observer = new MutationObserver(() => applyEnhancements());
    observer.observe(target, { childList: true, subtree: true });
  });
})();
