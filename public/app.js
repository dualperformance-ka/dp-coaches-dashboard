/* ============================================================
   DP Coaches Dashboard - PWA bootstrap
   - Registers /sw.js
   - Shows a toast when a new version is ready ("Refresh")
   - Captures beforeinstallprompt and offers a one-tap install
   No dependencies. Styling matches the dashboard token system.
   ============================================================ */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  /* ---------- shared toast UI ---------- */

  let toastEl = null;

  function dismissToast() {
    if (!toastEl) return;
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateY(6px)';
    const el = toastEl;
    toastEl = null;
    setTimeout(() => el.remove(), 200);
  }

  function showToast(message, actionLabel, onAction) {
    dismissToast();

    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.style.cssText = [
      'position:fixed', 'bottom:18px', 'right:18px', 'z-index:9999',
      'display:flex', 'align-items:center', 'gap:14px',
      'background:#161616',
      'border:1px solid rgba(121,195,232,.34)',
      'border-radius:8px', 'padding:12px 14px',
      'box-shadow:0 8px 30px rgba(0,0,0,.5)',
      "font-family:'Geist Mono','SF Mono',monospace",
      'font-size:11px', 'letter-spacing:.04em', 'color:#f0ede8',
      'opacity:0', 'transform:translateY(6px)',
      'transition:opacity .2s ease,transform .2s ease',
      'max-width:calc(100vw - 36px)'
    ].join(';');

    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.style.cssText = [
      'background:rgba(121,195,232,.10)',
      'border:1px solid rgba(121,195,232,.34)',
      'color:#a9dbf5', 'font:inherit', 'font-weight:600',
      'text-transform:uppercase', 'letter-spacing:.08em',
      'padding:6px 14px', 'border-radius:5px', 'cursor:pointer',
      'white-space:nowrap'
    ].join(';');
    btn.addEventListener('click', () => onAction(btn));
    toast.appendChild(btn);

    const close = document.createElement('button');
    close.textContent = '\u2715';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText =
      'background:none;border:none;color:#777;cursor:pointer;font:inherit;padding:2px 4px';
    close.addEventListener('click', dismissToast);
    toast.appendChild(close);

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });
    toastEl = toast;
  }

  /* ---------- service worker registration + updates ---------- */

  let refreshing = false;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // A waiting worker already exists (e.g. update found on a
        // previous visit but never applied).
        if (reg.waiting && navigator.serviceWorker.controller) {
          offerUpdate(reg.waiting);
        }

        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          if (!next) return;
          next.addEventListener('statechange', () => {
            if (
              next.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              offerUpdate(next);
            }
          });
        });
      })
      .catch((err) => console.warn('[pwa] sw registration failed:', err));

    // When the new worker takes over, reload once to load fresh assets.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });

  function offerUpdate(worker) {
    showToast('Update available', 'Refresh', (btn) => {
      btn.disabled = true;
      btn.textContent = 'Updating\u2026';
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  }

  /* ---------- install prompt ---------- */

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;

    // Don't nag: show once per session.
    if (sessionStorage.getItem('dp_install_dismissed')) return;

    showToast('Install DP Coaches', 'Install', async (btn) => {
      btn.disabled = true;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome !== 'accepted') {
        sessionStorage.setItem('dp_install_dismissed', '1');
      }
      dismissToast();
    });
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    dismissToast();
  });
})();
