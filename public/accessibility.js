(function () {
  var generatedId = 0;
  var activeModal = null;
  var returnFocus = null;
  var modalSelector = '.hb-modal,.ql-modal,.photo-modal,.focus-overlay,.day-plan-overlay,.more-menu';
  var focusableSelector = 'button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function visible(element) {
    if (!element) return false;
    var style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function labelControls(root) {
    (root || document).querySelectorAll('label:not([for])').forEach(function (label) {
      var control = label.querySelector('input,select,textarea');
      if (!control) {
        var field = label.closest('.lf,.stat-field,.milestone-field,.run-field,.pain-log-block');
        if (field) control = field.querySelector('input,select,textarea');
      }
      if (!control && label.nextElementSibling && /^(INPUT|SELECT|TEXTAREA)$/.test(label.nextElementSibling.tagName)) {
        control = label.nextElementSibling;
      }
      if (!control) return;
      if (!control.id) control.id = 'dp-field-' + (++generatedId);
      label.htmlFor = control.id;
    });

    (root || document).querySelectorAll('input,select,textarea').forEach(function (control) {
      if (control.type === 'hidden' || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return;
      if (control.id && document.querySelector('label[for="' + CSS.escape(control.id) + '"]')) return;
      var placeholder = control.getAttribute('placeholder');
      var setMatch = control.id.match(/^(w|r|rL|rR|rpe)_\d+_\d+_(\d+)$/);
      if (setMatch) {
        var setNumber = Number(setMatch[2]) + 1;
        var setLabels = { w:'Weight', r:'Repetitions', rL:'Left-side repetitions', rR:'Right-side repetitions', rpe:'RPE' };
        control.setAttribute('aria-label', setLabels[setMatch[1]] + ' for set ' + setNumber);
      }
      else if (placeholder) control.setAttribute('aria-label', placeholder);
      else if (/^reschedule_/.test(control.id)) control.setAttribute('aria-label', 'Reschedule session date');
      else if (control.id === 'angleInput') control.setAttribute('aria-label', 'Upload progress photo');
    });
  }

  function enhanceTabs(root) {
    (root || document).querySelectorAll('[role="tab"][data-tab]').forEach(function (tab) {
      var panel = document.getElementById('tab-' + tab.dataset.tab);
      if (!panel) return;
      if (!tab.id) tab.id = 'dp-tab-' + tab.dataset.tab;
      tab.setAttribute('aria-controls', panel.id);
      tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.tabIndex = -1;
    });
  }

  function enhanceClickTargets(root) {
    (root || document).querySelectorAll('div[onclick]:not([role]),span[onclick]:not([role])').forEach(function (element) {
      if (element.querySelector('button,a[href],input,select,textarea,[tabindex]')) return;
      element.setAttribute('role', 'button');
      element.tabIndex = 0;
      element.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          element.click();
        }
      });
    });
  }

  function labelIconButtons(root) {
    (root || document).querySelectorAll('button').forEach(function (button) {
      if (button.getAttribute('aria-label') || button.getAttribute('aria-labelledby') || button.textContent.trim()) return;
      var setMatch = button.id.match(/^st_\d+_\d+_(\d+)$/);
      if (setMatch) {
        button.setAttribute('aria-label', 'Mark set ' + (Number(setMatch[1]) + 1) + ' complete');
        button.setAttribute('aria-pressed', button.classList.contains('on') ? 'true' : 'false');
      } else if (/^tick_\d+$/.test(button.id)) {
        button.setAttribute('aria-label', 'Mark session complete');
        button.setAttribute('aria-pressed', button.classList.contains('on') || button.classList.contains('marked') ? 'true' : 'false');
      }
    });
  }

  function titleFor(modal) {
    return modal.querySelector('.ql-modal-title,.hb-modal-title,.photo-modal-title,.focus-overlay-title,.day-plan-title,.more-menu-title');
  }

  function enhanceModals() {
    document.querySelectorAll(modalSelector).forEach(function (modal) {
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      var title = titleFor(modal);
      if (title) {
        if (!title.id) title.id = modal.id + '-title';
        modal.setAttribute('aria-labelledby', title.id);
      } else if (!modal.getAttribute('aria-label')) {
        modal.setAttribute('aria-label', 'Dialog');
      }
      var isOpen = modal.classList.contains('open');
      modal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    });
  }

  function syncModalState() {
    var open = Array.from(document.querySelectorAll(modalSelector)).filter(function (modal) {
      return modal.classList.contains('open') && visible(modal);
    }).pop() || null;

    document.querySelectorAll(modalSelector).forEach(function (modal) {
      modal.setAttribute('aria-hidden', modal === open ? 'false' : 'true');
    });

    if (open && open !== activeModal) {
      returnFocus = document.activeElement;
      activeModal = open;
      setTimeout(function () {
        var first = open.querySelector(focusableSelector);
        if (first) first.focus();
      }, 30);
    } else if (!open && activeModal) {
      activeModal = null;
      if (returnFocus && document.contains(returnFocus) && visible(returnFocus)) returnFocus.focus();
      returnFocus = null;
    }
  }

  document.addEventListener('keydown', function (event) {
    if (!activeModal) return;
    if (event.key === 'Escape') {
      var close = activeModal.querySelector('[aria-label^="Close"],.focus-close,.day-plan-close,.more-menu-close');
      if (close) {
        event.preventDefault();
        close.click();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    var controls = Array.from(activeModal.querySelectorAll(focusableSelector)).filter(visible);
    if (!controls.length) return;
    var first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  function enhance(root) {
    labelControls(root);
    enhanceTabs(root);
    enhanceClickTargets(root);
    labelIconButtons(root);
    enhanceModals();
    syncModalState();
  }

  var toast = document.getElementById('toast');
  if (toast) {
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');
  }

  enhance(document);
  var observer = new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) {
        if (node.nodeType === 1) enhance(node);
      });
    });
    enhanceTabs(document);
    enhanceModals();
    syncModalState();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-selected'] });
})();
