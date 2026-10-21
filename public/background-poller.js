/* Background polling for the coaches dashboard.
 *
 * Two loops used to call the API every 12 seconds from every open tab, visible
 * or not, online or not, with no limit on overlapping requests and no deadline
 * on the browser fetch. During the October 2026 Supabase incident that turned
 * one outage into 962 Vercel timeouts. This module is the one place the rules
 * live:
 *
 *   - polls only while the tab is visible and the browser is online;
 *   - at most one request in flight per poller (per source, per tab);
 *   - healthy interval of at least 60 seconds (plus a little jitter so tabs
 *     opened together do not stay in lock-step);
 *   - after a failure, exponential backoff with jitter, capped at 5 minutes,
 *     reset by the next success;
 *   - one refresh when the tab becomes visible, comes back online or regains
 *     focus, with those events coalesced into a single request;
 *   - every request carries an AbortSignal that fires after requestTimeoutMs,
 *     so a browser fetch cannot hang forever;
 *   - everything stops on pagehide.
 *
 * Callers own their UI: `run` receives { signal, reason } and should throw on
 * failure without clearing what is already on screen.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    intervalMs: 60000,
    maxBackoffMs: 300000,
    requestTimeoutMs: 20000,
    // Healthy polls wait intervalMs plus up to this fraction more.
    healthyJitter: 0.1,
    // Backoff delays are spread across ±this fraction of the nominal delay.
    backoffJitter: 0.2,
    // visibilitychange + focus (and online) arrive within a few ms of each
    // other when a coach switches back to the tab.
    coalesceMs: 250,
    // A wake event shortly after a refresh adds nothing.
    minWakeGapMs: 5000,
    // While failing, a wake event may jump the backoff queue at most this often.
    minWakeGapFailingMs: 30000,
  };

  function defaultEnv() {
    return {
      document: root.document,
      window: root,
      navigator: root.navigator,
      setTimeout: root.setTimeout.bind(root),
      clearTimeout: root.clearTimeout.bind(root),
      now: function () { return Date.now(); },
      random: Math.random,
      AbortController: root.AbortController,
    };
  }

  function createPoller(options) {
    var opts = Object.assign({}, DEFAULTS, options || {});
    if (typeof opts.run !== 'function') throw new Error('createPoller needs a run({ signal }) function');
    // The 60-second floor is the contract, not a suggestion.
    opts.intervalMs = Math.max(60000, Number(opts.intervalMs) || DEFAULTS.intervalMs);
    opts.maxBackoffMs = Math.min(300000, Math.max(opts.intervalMs, Number(opts.maxBackoffMs) || DEFAULTS.maxBackoffMs));
    var env = Object.assign(defaultEnv(), opts.env || {});

    var timer = null;
    var wakeTimer = null;
    var inFlight = null;
    var controller = null;
    var failures = 0;
    var lastSettledAt = -Infinity;
    var started = false;
    var stopped = false;
    var pendingWakeReason = null;

    function isVisible() {
      return !env.document || env.document.visibilityState === 'visible';
    }
    function isOnline() {
      return !env.navigator || env.navigator.onLine !== false;
    }
    function canPoll() {
      return started && !stopped && isVisible() && isOnline();
    }

    function nextDelay() {
      if (!failures) {
        return Math.round(opts.intervalMs * (1 + opts.healthyJitter * env.random()));
      }
      var nominal = Math.min(opts.maxBackoffMs, opts.intervalMs * Math.pow(2, failures));
      var spread = 1 - opts.backoffJitter + 2 * opts.backoffJitter * env.random();
      return Math.round(Math.max(opts.intervalMs, Math.min(opts.maxBackoffMs, nominal * spread)));
    }

    function clearTimer() {
      if (timer !== null) { env.clearTimeout(timer); timer = null; }
    }

    function schedule() {
      clearTimer();
      if (!canPoll() || inFlight) return;
      timer = env.setTimeout(function () { timer = null; tick('interval'); }, nextDelay());
    }

    function tick(reason) {
      if (!canPoll()) { clearTimer(); return Promise.resolve(false); }
      if (inFlight) return inFlight;
      clearTimer();
      controller = env.AbortController ? new env.AbortController() : null;
      var signal = controller ? controller.signal : undefined;
      var deadline = env.setTimeout(function () {
        if (controller) controller.abort();
      }, opts.requestTimeoutMs);
      var run;
      try {
        run = Promise.resolve(opts.run({ signal: signal, reason: reason }));
      } catch (error) {
        run = Promise.reject(error);
      }
      inFlight = run.then(function () {
        failures = 0;
        return true;
      }, function (error) {
        failures += 1;
        if (typeof opts.onError === 'function') {
          try { opts.onError(error, { failures: failures, reason: reason }); } catch (e) { /* never break the loop */ }
        }
        return false;
      }).then(function (ok) {
        env.clearTimeout(deadline);
        controller = null;
        inFlight = null;
        lastSettledAt = env.now();
        schedule();
        return ok;
      });
      return inFlight;
    }

    // visibilitychange, focus and online collapse into one request.
    function wake(reason) {
      if (!canPoll()) { clearTimer(); return; }
      pendingWakeReason = pendingWakeReason || reason;
      if (wakeTimer !== null) return;
      wakeTimer = env.setTimeout(function () {
        wakeTimer = null;
        var why = pendingWakeReason;
        pendingWakeReason = null;
        if (!canPoll() || inFlight) return;
        var gap = failures ? opts.minWakeGapFailingMs : opts.minWakeGapMs;
        if (env.now() - lastSettledAt < gap) { if (!timer) schedule(); return; }
        tick(why);
      }, opts.coalesceMs);
    }

    function onVisibility() {
      if (isVisible()) wake('visible');
      else clearTimer();
    }
    function onFocus() { wake('focus'); }
    function onOnline() { wake('online'); }
    function onOffline() { clearTimer(); }
    function onPageHide(event) {
      // A page restored from the back/forward cache fires pageshow; only stop
      // for good when the page is really going away.
      if (event && event.persisted) { clearTimer(); return; }
      stop();
    }
    function onPageShow(event) {
      if (event && event.persisted && !stopped) wake('visible');
    }

    function listen(add) {
      var method = add ? 'addEventListener' : 'removeEventListener';
      if (env.document && env.document[method]) env.document[method]('visibilitychange', onVisibility);
      if (env.window && env.window[method]) {
        env.window[method]('focus', onFocus);
        env.window[method]('online', onOnline);
        env.window[method]('offline', onOffline);
        env.window[method]('pagehide', onPageHide);
        env.window[method]('pageshow', onPageShow);
      }
    }

    function start(startOptions) {
      if (started || stopped) return api;
      started = true;
      listen(true);
      if (startOptions && startOptions.immediate) tick('start');
      else {
        // The caller just loaded this data itself; the first poll is one
        // interval away.
        lastSettledAt = env.now();
        schedule();
      }
      return api;
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimer();
      if (wakeTimer !== null) { env.clearTimeout(wakeTimer); wakeTimer = null; }
      if (controller) controller.abort();
      listen(false);
    }

    // Explicit refresh (after a save, or a button). Never overlaps a running
    // request, never polls a hidden or offline tab.
    function refreshNow(reason) {
      return tick(reason || 'manual');
    }

    var api = {
      start: start,
      stop: stop,
      refreshNow: refreshNow,
      // For tests and debugging.
      state: function () {
        return {
          name: opts.name || null,
          failures: failures,
          inFlight: Boolean(inFlight),
          scheduled: timer !== null,
          stopped: stopped,
          nextDelayMs: nextDelay,
        };
      },
    };
    return api;
  }

  root.DPPoller = { createPoller: createPoller, DEFAULTS: DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
