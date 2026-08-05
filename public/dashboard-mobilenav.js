/* ============================================================
   DP Coaches Dashboard — mobile bottom nav (portal-style)
   Mirrors the athlete portal architecture: a fixed bottom bar
   with 4 primary destinations + a "More" sheet for the rest.
   Additive only — wraps the existing global switchTab(), never
   replaces it. Desktop keeps the top tab bar untouched.
   ============================================================ */
(function () {
  'use strict';

  // Primary destinations shown in the bar. Everything else lives in More.
  // key = the arg passed to switchTab(); label = short thumb-friendly name.
  var PRIMARY = [
    { key: 'triage',    label: 'Today',  icon: 'today'  },
    { key: 'planning',  label: 'Plan',   icon: 'plan'   },
    { key: 'nutrition', label: 'Fuel',   icon: 'fuel'   },
    { key: 'send',      label: 'Notify', icon: 'send'   }
  ];
  var MORE = [
    { key: 'athletes',      label: 'Squad',    icon: 'squad'    },
    { key: 'applications',  label: 'Pipeline', icon: 'pipeline' },
    { key: 'notifications', label: 'New',      icon: 'bell'     },
    { key: 'coaches',       label: 'Coaches',  icon: 'coaches'  },
    { key: 'sync',          label: 'Sync',     icon: 'sync'     },
    { key: 'lock',          label: 'Lock app', icon: 'lock'     }
  ];

  // Maps a tab key to its existing top-bar badge id (for live count mirror).
  var BADGE_SRC = {
    triage:       'tab-triage-count',
    athletes:     'tab-ath-count',
    planning:     'tab-planning-count',
    nutrition:    'tab-nut-count',
    sync:         'tab-sync-count',
    applications: 'tab-apps-count',
    notifications:'tab-notif-count'
  };

  var ICONS = {
    today:   '<path d="M12 3 3.5 19h17L12 3Z"/><path d="M12 9v4M12 16.5h.01"/>',
    squad:   '<path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M17 11a3 3 0 1 0 0-6"/><path d="M3 20c0-3 2.7-5 6-5s6 2 6 5"/><path d="M17 15c2.5.4 4 2.2 4 5"/>',
    plan:    '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/><path d="M7.5 13h3M7.5 16.5h6"/>',
    fuel:    '<path d="M7 3v8M4 3v4a3 3 0 0 0 3 3M10 3v4a3 3 0 0 1-3 3M7 11v10"/><path d="M17 3c-1.6 0-3 2-3 5s1.4 4 3 4v9"/>',
    pipeline:'<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>',
    coaches: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M5 21c0-3.3 3.1-6 7-6s7 2.7 7 6"/>',
    sync:    '<path d="M20 11a8 8 0 0 0-14-4.5L3 9"/><path d="M4 13a8 8 0 0 0 14 4.5L21 15"/><path d="M3 5v4h4M21 19v-4h-4"/>',
    bell:    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8Z"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    send:    '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
    lock:    '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    more:    '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
  };

  function svg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function navItem(entry, isMore) {
    var btn = document.createElement('button');
    btn.className = 'dp-mnav-item';
    btn.type = 'button';
    btn.dataset.navKey = isMore ? 'more' : entry.key;
    btn.setAttribute('aria-label', entry.label);
    btn.innerHTML =
      '<span class="dp-mnav-ic">' + svg(entry.icon) +
        '<span class="dp-mnav-badge" hidden></span></span>' +
      '<span class="dp-mnav-lbl">' + entry.label + '</span>';
    return btn;
  }

  function build() {
    if (document.querySelector('.dp-mobilenav')) return;

    /* ---- bottom bar ---- */
    var nav = document.createElement('nav');
    nav.className = 'dp-mobilenav';
    nav.setAttribute('aria-label', 'Primary');

    PRIMARY.forEach(function (e) {
      var btn = navItem(e, false);
      btn.addEventListener('click', function () {
        closeSheet();
        if (typeof window.switchTab === 'function') window.switchTab(e.key);
        setActive(e.key);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      nav.appendChild(btn);
    });

    var moreBtn = navItem({ label: 'More', icon: 'more' }, true);
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.addEventListener('click', toggleSheet);
    nav.appendChild(moreBtn);

    document.body.appendChild(nav);

    /* ---- More sheet ---- */
    var backdrop = document.createElement('div');
    backdrop.className = 'dp-sheet-backdrop';
    backdrop.addEventListener('click', closeSheet);

    var sheet = document.createElement('div');
    sheet.className = 'dp-sheet';
    sheet.setAttribute('role', 'menu');
    sheet.setAttribute('aria-hidden', 'true');

    var grip = document.createElement('div');
    grip.className = 'dp-sheet-grip';
    sheet.appendChild(grip);

    var title = document.createElement('div');
    title.className = 'dp-sheet-title';
    title.textContent = 'More';
    sheet.appendChild(title);

    var grid = document.createElement('div');
    grid.className = 'dp-sheet-grid';
    MORE.forEach(function (e) {
      var cell = document.createElement('button');
      cell.className = 'dp-sheet-cell';
      cell.type = 'button';
      cell.dataset.navKey = e.key;
      cell.innerHTML =
        '<span class="dp-sheet-ic">' + svg(e.icon) +
          '<span class="dp-mnav-badge" hidden></span></span>' +
        '<span>' + e.label + '</span>';
      cell.addEventListener('click', function () {
        closeSheet();
        if (e.key === 'lock') {
          if (window.DP_COACH_AUTH?.logout) window.DP_COACH_AUTH.logout();
          return;
        }
        if (typeof window.switchTab === 'function') window.switchTab(e.key);
        setActive(e.key);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      grid.appendChild(cell);
    });
    sheet.appendChild(grid);

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
  }

  /* ---- sheet open/close ---- */
  function toggleSheet() {
    var sheet = document.querySelector('.dp-sheet');
    if (!sheet) return;
    sheet.classList.contains('open') ? closeSheet() : openSheet();
  }
  function openSheet() {
    document.querySelector('.dp-sheet').classList.add('open');
    document.querySelector('.dp-sheet').setAttribute('aria-hidden', 'false');
    document.querySelector('.dp-sheet-backdrop').classList.add('open');
    var mb = document.querySelector('.dp-mnav-item[data-nav-key="more"]');
    if (mb) { mb.classList.add('active'); mb.setAttribute('aria-expanded', 'true'); }
  }
  function closeSheet() {
    var sheet = document.querySelector('.dp-sheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    document.querySelector('.dp-sheet-backdrop').classList.remove('open');
    var mb = document.querySelector('.dp-mnav-item[data-nav-key="more"]');
    if (mb) mb.setAttribute('aria-expanded', 'false');
  }

  /* ---- active-state sync ---- */
  var MORE_KEYS = MORE.map(function (e) { return e.key; });
  function setActive(tab) {
    var inMore = MORE_KEYS.indexOf(tab) > -1;
    document.querySelectorAll('.dp-mnav-item').forEach(function (item) {
      var k = item.dataset.navKey;
      var on = k === tab || (k === 'more' && inMore);
      item.classList.toggle('active', on);
      if (on) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    document.querySelectorAll('.dp-sheet-cell').forEach(function (cell) {
      cell.classList.toggle('active', cell.dataset.navKey === tab);
    });
  }

  // Wrap the existing switchTab so ANY caller (cc-action buttons, deep links,
  // the top bar on tablet) keeps the bottom nav in sync.
  function wrapSwitchTab() {
    if (typeof window.switchTab !== 'function' || window.switchTab.__dpWrapped) return true;
    var original = window.switchTab;
    var wrapped = function (tab) {
      var r = original.apply(this, arguments);
      try { setActive(tab); } catch (e) {}
      return r;
    };
    wrapped.__dpWrapped = true;
    window.switchTab = wrapped;
    return true;
  }

  /* ---- badge mirroring ---- */
  function mirrorBadges() {
    Object.keys(BADGE_SRC).forEach(function (key) {
      var src = document.getElementById(BADGE_SRC[key]);
      var raw = src ? src.textContent.trim() : '';
      var show = raw && raw !== '—' && raw !== '0';
      document
        .querySelectorAll('[data-nav-key="' + key + '"] .dp-mnav-badge')
        .forEach(function (b) {
          b.textContent = raw;
          b.hidden = !show;
        });
    });
    // "More" gets a dot if any of its hidden tabs has a live count.
    var moreHasCount = MORE_KEYS.some(function (k) {
      var el = BADGE_SRC[k] && document.getElementById(BADGE_SRC[k]);
      var v = el ? el.textContent.trim() : '';
      return v && v !== '—' && v !== '0';
    });
    var moreDot = document.querySelector('.dp-mnav-item[data-nav-key="more"] .dp-mnav-badge');
    if (moreDot) { moreDot.hidden = !moreHasCount; moreDot.textContent = ''; moreDot.classList.toggle('dot', moreHasCount); }
  }

  /* ---- table → card labels ----
     The athlete Table has 13 columns; on mobile CSS collapses each row
     into a card and shows these labels above each metric. We stamp them
     as data-label since the table markup doesn't carry them. */
  var TABLE_LABELS = ['', 'Wk', 'Recovery', 'Weekly KM', 'Comp', 'Weight',
    'Energy', 'Sleep', 'Stress', 'Calories', 'Run', 'Str', 'Status'];
  function stampTableLabels() {
    var rows = document.querySelectorAll('#grid.table-mode .dash-trow');
    rows.forEach(function (row) {
      var cells = row.children;
      for (var i = 1; i < cells.length && i < TABLE_LABELS.length; i++) {
        if (cells[i] && !cells[i].getAttribute('data-label')) {
          cells[i].setAttribute('data-label', TABLE_LABELS[i]);
        }
      }
    });
  }

  /* ---- compact mobile controls ------------------------------------------ */
  function enhanceMobileControls() {
    var filter = document.getElementById('filter-bar');
    var search = document.getElementById('search-input');
    if (filter && search && !document.getElementById('dp-mobile-filter-toggle')) {
      var toggle = document.createElement('button');
      toggle.id = 'dp-mobile-filter-toggle';
      toggle.className = 'dp-mobile-filter-toggle';
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'Filters';
      toggle.addEventListener('click', function () {
        var open = filter.classList.toggle('mobile-expanded');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Less' : 'Filters';
      });
      search.insertAdjacentElement('afterend', toggle);
    }

    var headerControls = document.querySelector('.h-right');
    if (headerControls && !document.getElementById('dp-theme-switch')) {
      var theme = document.createElement('button');
      theme.id = 'dp-theme-switch';
      theme.className = 'dp-theme-switch';
      theme.type = 'button';
      theme.setAttribute('aria-label', 'Switch colour theme');
      theme.innerHTML = '<span aria-hidden="true">◐</span>';
      theme.addEventListener('click', function () {
        var next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
        if (typeof window.setTheme === 'function') window.setTheme(next);
      });
      headerControls.appendChild(theme);
    }
  }

  function addMobileSectionTitles() {
    var sections = {
      'tab-planning-content': ['Programming', 'Build and adjust the week'],
      'tab-nut-content': ['Nutrition', 'Targets and weekly progression'],
      'tab-coaches-content': ['Coaches', 'Karl and Alex training'],
      'tab-sync-content': ['Data health', 'Spot gaps before coaching decisions'],
      'tab-apps-content': ['Pipeline', 'Review every application'],
      'tab-notif-content': ['Applications', 'New decisions waiting'],
      'tab-send-content': ['Notify', 'Message the athlete portal']
    };
    Object.keys(sections).forEach(function (id) {
      var section = document.getElementById(id);
      if (!section || section.querySelector(':scope > .dp-mobile-section-head')) return;
      var copy = sections[id];
      var head = document.createElement('div');
      head.className = 'dp-mobile-section-head';
      head.innerHTML = '<div class="dp-mobile-section-kicker">Dual Performance</div>' +
        '<h1>' + copy[0] + '</h1><p>' + copy[1] + '</p>';
      section.insertBefore(head, section.firstChild);
    });
  }

  /* ---- boot ---- */
  function init() {
    build();
    enhanceMobileControls();
    addMobileSectionTitles();

    // Reflect whichever tab is active on load.
    var current = document.querySelector('.tab.active');
    var onload = current && current.id ? current.id.replace('tab-', '').replace('-btn', '') : 'triage';
    var keyFix = { triage: 'triage', ath: 'athletes', athletes: 'athletes', planning: 'planning', nut: 'nutrition', coaches: 'coaches', sync: 'sync', apps: 'applications', notif: 'notifications', send: 'send' };
    setActive(keyFix[onload] || 'triage');

    // switchTab is defined in a later inline script; wait for it.
    var tries = 0;
    var t = setInterval(function () {
      if (wrapSwitchTab() || ++tries > 40) clearInterval(t);
    }, 250);

    // Keep counts fresh: observe the top bar (it's the data source) + poll softly.
    var bar = document.querySelector('.tab-bar');
    if (bar && 'MutationObserver' in window) {
      new MutationObserver(mirrorBadges).observe(bar, {
        subtree: true, childList: true, characterData: true
      });
    }
    mirrorBadges();
    stampTableLabels();
    var pt = 0;
    var pi = setInterval(function () { mirrorBadges(); if (++pt > 20) clearInterval(pi); }, 500);

    // Re-stamp table labels whenever the grid re-renders (sort/filter/view switch).
    var grid = document.getElementById('grid');
    if (grid && 'MutationObserver' in window) {
      new MutationObserver(function () { stampTableLabels(); })
        .observe(grid, { childList: true, subtree: true });
    }

    // Close the sheet on Escape.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheet();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
