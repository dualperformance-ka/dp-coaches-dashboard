// Bounded Supabase REST requests for interactive Vercel functions.
//
// Why this exists: during the October 2026 incident Supabase stopped answering
// (PGRST002 schema-cache failures, statement timeouts) and every dashboard
// request sat on an un-timed fetch until Vercel killed the function at 15s or
// 30s. 962 requests died that way, and each one held a PostgREST connection the
// recovering database needed. A request that cannot be answered should say so
// quickly, with a status the browser can back off from.
//
// Rules this module enforces:
//   * Every request has an abort deadline. Defaults: 8s for light reads and
//     writes, HEAVY_TIMEOUT_MS for the dashboard's bulk load. A route can also
//     set a request budget; each call gets min(its own timeout, what is left).
//   * No automatic retries. An interactive request that failed once will fail
//     again while the database is unhealthy, and retrying multiplies the load.
//   * Failures are classified (see FAILURE). Outages become HTTP 503 with
//     Retry-After; expected 4xx responses keep the caller's existing handling.
//   * Telemetry is structured and carries no secrets, URLs, query strings,
//     request payloads or response bodies — only route, operation (method and
//     table name), elapsed time, upstream status, failure category and an
//     upstream error code such as PGRST002 or 57014.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const FAILURE = Object.freeze({
  TIMEOUT: 'upstream_timeout',
  NETWORK: 'upstream_network',
  SERVER: 'upstream_server_error',
  INVALID: 'upstream_invalid_response',
  CLIENT: 'upstream_client_error',
});

export const DEFAULT_TIMEOUT_MS = 8000;
export const HEAVY_TIMEOUT_MS = 11000;
export const RETRY_AFTER_SECONDS = 30;
// A successful call slower than this is logged, so creeping latency is visible
// before it becomes an outage.
export const SLOW_CALL_MS = 2000;
// Less budget than this left: do not start a request at all. A round trip from
// Sydney to Supabase in Singapore cannot finish in it, and timers fire a few
// milliseconds early, which would otherwise start a doomed 1ms request.
export const MIN_CALL_BUDGET_MS = 50;

const UNAVAILABLE = new Set([FAILURE.TIMEOUT, FAILURE.NETWORK, FAILURE.SERVER]);
// Postgres/PostgREST codes that mean "the database ran out of time", which a
// coach should see as a timeout rather than a generic server error.
const TIMEOUT_CODES = new Set(['57014', 'PGRST003']);

const context = new AsyncLocalStorage();

export class SupabaseRequestError extends Error {
  constructor({ category, operation, upstreamStatus = null, upstreamCode = null, elapsedMs = 0, message }) {
    super(message || defaultMessage(category, upstreamStatus));
    this.name = 'SupabaseRequestError';
    this.category = category;
    this.operation = operation;
    this.upstreamStatus = upstreamStatus;
    this.upstreamCode = upstreamCode;
    this.elapsedMs = elapsedMs;
    if (UNAVAILABLE.has(category)) {
      // Outage: the client should back off and retry later.
      this.status = 503;
      this.retryAfter = RETRY_AFTER_SECONDS;
      this.code = category === FAILURE.TIMEOUT ? 'upstream_timeout' : 'upstream_unavailable';
    } else if (category === FAILURE.INVALID) {
      this.status = 502;
      this.code = 'upstream_invalid_response';
    }
    // FAILURE.CLIENT deliberately sets no status: an expected PostgREST 4xx
    // (missing column during a migration, a constraint, an unknown table)
    // keeps whatever handling the calling route already had, and its message
    // is preserved because several callers match on it to fall back.
  }
}

function defaultMessage(category, status) {
  switch (category) {
    case FAILURE.TIMEOUT: return 'Supabase did not respond before the request deadline';
    case FAILURE.NETWORK: return 'Supabase could not be reached';
    case FAILURE.SERVER: return `Supabase returned ${status || 'a server error'}`;
    case FAILURE.INVALID: return 'Supabase returned an unreadable response';
    default: return `Supabase returned ${status || 'an error'}`;
  }
}

export function isUpstreamUnavailable(error) {
  return Boolean(error && error.name === 'SupabaseRequestError' && UNAVAILABLE.has(error.category));
}

// A source the dashboard treats as optional (a table that may not be migrated
// yet) may be skipped when it answers 4xx. An outage is never "optional": an
// empty list during an outage would render as "nothing to do" when the truth
// is "we could not look".
export function isOptionalSourceMiss(error) {
  return !isUpstreamUnavailable(error) && !(error && error.name === 'SupabaseRequestError' && error.category === FAILURE.INVALID);
}

function credentials() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase service credentials are not configured');
  return { url, key };
}

// "GET coach_actions", "POST rpc/rename_athlete_code". Only the path before
// the query string is kept: filters can carry athlete codes and dates.
export function operationName(method, path) {
  const table = String(path || '').split('?')[0].replace(/[^A-Za-z0-9_/.-]/g, '').slice(0, 80) || 'unknown';
  return `${String(method || 'GET').toUpperCase()} ${table}`;
}

function nowMs() {
  return performance.now();
}

function log(level, record) {
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function currentContext() {
  return context.getStore() || null;
}

function remainingBudget(ctx) {
  if (!ctx || !Number.isFinite(ctx.deadlineAt)) return Infinity;
  return ctx.deadlineAt - nowMs();
}

function record(ctx, outcome) {
  if (!ctx) return;
  ctx.calls += 1;
  ctx.upstreamMs += outcome.elapsedMs;
  if (!outcome.ok) {
    ctx.failures += 1;
    if (!ctx.failure) ctx.failure = outcome;
  }
}

function upstreamDetails(text) {
  try {
    const parsed = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === 'object') {
      return {
        code: typeof parsed.code === 'string' ? parsed.code.slice(0, 16) : null,
        message: typeof parsed.message === 'string' ? parsed.message.slice(0, 300)
          : typeof parsed.error === 'string' ? parsed.error.slice(0, 300) : null,
      };
    }
  } catch { /* non-JSON error page from a gateway */ }
  return { code: null, message: null };
}

function parseCount(contentRange) {
  const total = String(contentRange || '').split('/')[1];
  const n = Number(total);
  return Number.isFinite(n) ? n : null;
}

/**
 * One Supabase REST request with a deadline.
 *
 * @param {string} path  Path under /rest/v1/, e.g. "coach_actions?select=id".
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {*}      [options.body]      Serialised as JSON when defined.
 * @param {string} [options.prefer]    Prefer header.
 * @param {object} [options.headers]   Extra headers (Range, Accept…).
 * @param {number} [options.timeoutMs] Overrides the route/default timeout.
 * @param {AbortSignal} [options.signal] Caller signal; its abort is honoured and
 *                                    re-thrown as-is rather than reclassified.
 * @param {string} [options.operation] Telemetry label; defaults to method+table.
 * @param {boolean} [options.count]   Return { rows, count } using Content-Range.
 * @param {(text: string, status: number) => *} [options.parse] Custom body parser.
 */
export async function supabaseFetch(path, options = {}) {
  const {
    method = 'GET', body, prefer, headers = {}, timeoutMs, signal,
    operation = operationName(method, path), count = false, parse,
  } = options;
  const { url, key } = credentials();
  const ctx = currentContext();
  const started = nowMs();
  const fail = (category, extra = {}) => {
    const elapsedMs = Math.round(nowMs() - started);
    const error = new SupabaseRequestError({ category, operation, elapsedMs, ...extra });
    const outcome = {
      ok: false, operation, elapsedMs, upstreamStatus: extra.upstreamStatus ?? null,
      category, upstreamCode: extra.upstreamCode ?? null,
    };
    record(ctx, outcome);
    log(category === FAILURE.CLIENT ? 'warn' : 'error', {
      event: 'supabase_request',
      route: ctx?.route || null,
      requestId: ctx?.requestId || null,
      ...outcome,
    });
    return error;
  };

  const budget = remainingBudget(ctx);
  const perCall = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : (ctx?.timeoutMs || DEFAULT_TIMEOUT_MS);
  const effective = Math.min(perCall, budget);
  if (budget < MIN_CALL_BUDGET_MS || effective <= 0) throw fail(FAILURE.TIMEOUT);

  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(effective)));
  const signals = [timeoutSignal];
  if (signal) signals.push(signal);
  const combined = signals.length === 1 ? timeoutSignal : AbortSignal.any(signals);

  const requestHeaders = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(prefer || count ? { Prefer: [prefer, count ? 'count=exact' : null].filter(Boolean).join(',') } : {}),
    ...headers,
  };

  let response;
  let text;
  try {
    // globalThis.fetch is read per call so tests (and any instrumentation) can
    // substitute it.
    response = await globalThis.fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
    text = method === 'HEAD' ? '' : await response.text();
  } catch (error) {
    if (timeoutSignal.aborted) throw fail(FAILURE.TIMEOUT);
    if (signal?.aborted) throw signal.reason ?? error;
    throw fail(FAILURE.NETWORK);
  }

  const status = response.status;
  if (!response.ok) {
    const details = upstreamDetails(text);
    if (status >= 500 || status < 100) {
      const category = status === 504 || TIMEOUT_CODES.has(details.code) ? FAILURE.TIMEOUT : FAILURE.SERVER;
      throw fail(category, { upstreamStatus: status, upstreamCode: details.code });
    }
    throw fail(FAILURE.CLIENT, {
      upstreamStatus: status,
      upstreamCode: details.code,
      message: details.message || `Supabase returned ${status}`,
    });
  }

  let data;
  try {
    data = parse ? parse(text, status) : (text ? JSON.parse(text) : null);
  } catch {
    throw fail(FAILURE.INVALID, { upstreamStatus: status });
  }

  const elapsedMs = Math.round(nowMs() - started);
  record(ctx, { ok: true, operation, elapsedMs, upstreamStatus: status });
  if (elapsedMs >= SLOW_CALL_MS) {
    log('warn', {
      event: 'supabase_request', route: ctx?.route || null, requestId: ctx?.requestId || null,
      ok: true, slow: true, operation, elapsedMs, upstreamStatus: status, category: null,
    });
  }
  if (count) return { rows: data, count: parseCount(response.headers.get('content-range')) };
  return data;
}

// ── Route instrumentation ───────────────────────────────────────────────────

function requestIdFor(req) {
  // Vercel's own id correlates our log line with its request log. It is a
  // routing identifier, not user data.
  const vercelId = String(req?.headers?.['x-vercel-id'] || '').trim();
  return /^[\w:.-]{1,120}$/.test(vercelId) ? vercelId : randomUUID();
}

function serverTiming(ctx) {
  const dur = Math.round(ctx.upstreamMs * 10) / 10;
  return `supabase;dur=${dur};desc="${ctx.calls} call${ctx.calls === 1 ? '' : 's'}"`;
}

function attachServerTiming(res, ctx) {
  const applyHeaders = () => {
    if (res.headersSent || ctx.timingSent) return;
    ctx.timingSent = true;
    try {
      res.setHeader('Server-Timing', serverTiming(ctx));
      res.setHeader('X-Request-Id', ctx.requestId);
    } catch { /* headers already flushed by the platform */ }
  };
  for (const name of ['json', 'send', 'end']) {
    const original = res[name];
    if (typeof original !== 'function') continue;
    res[name] = function patched(...args) {
      applyHeaders();
      return original.apply(this, args);
    };
  }
}

/**
 * Sends the controlled outage response. Returns true when it handled the error.
 * `extra` lets a route keep its usual empty response shape so older clients
 * that read collection keys never see undefined.
 */
export function sendUpstreamUnavailable(res, error, extra = {}) {
  if (!isUpstreamUnavailable(error)) return false;
  const ctx = currentContext();
  res.setHeader('Retry-After', String(error.retryAfter || RETRY_AFTER_SECONDS));
  res.status(503).json({
    ...extra,
    ok: false,
    code: error.code,
    error: error.code === 'upstream_timeout'
      ? 'The database did not respond in time. Try again in a moment.'
      : 'The database is unavailable right now. Try again in a moment.',
    retryAfter: error.retryAfter || RETRY_AFTER_SECONDS,
    requestId: ctx?.requestId || null,
  });
  return true;
}

/**
 * Wraps a Vercel handler so every Supabase call inside it shares one request
 * budget, one correlation id and one summary log line.
 *
 * @param {string} route  e.g. "/api/actions"
 * @param {object} config
 * @param {number} config.budgetMs   Total time Supabase work may take. Keep it
 *                                   well inside the function's maxDuration.
 * @param {number} [config.timeoutMs] Per-call default for this route.
 * @param {(req) => string} [config.mode] Logical operation for the summary.
 * @param {(req) => {budgetMs?: number, timeoutMs?: number}} [config.select]
 *                                   Per-request override (e.g. heavy full load).
 */
export function withSupabaseRoute(route, config, handler) {
  return async function instrumentedHandler(req, res) {
    const override = typeof config.select === 'function' ? (config.select(req) || {}) : {};
    const budgetMs = override.budgetMs ?? config.budgetMs;
    const ctx = {
      route,
      mode: typeof config.mode === 'function' ? safeMode(config.mode(req)) : null,
      requestId: requestIdFor(req),
      timeoutMs: override.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      deadlineAt: Number.isFinite(budgetMs) ? nowMs() + budgetMs : Infinity,
      calls: 0,
      failures: 0,
      upstreamMs: 0,
      failure: null,
      timingSent: false,
    };
    const started = nowMs();
    attachServerTiming(res, ctx);
    try {
      return await context.run(ctx, () => handler(req, res));
    } catch (error) {
      // Handlers catch their own errors; this is the last line of defence so an
      // outage never becomes an unhandled rejection that Vercel turns into a
      // hung or 500 response.
      if (!res.headersSent) {
        if (!context.run(ctx, () => sendUpstreamUnavailable(res, error))) {
          res.status(500).json({ ok: false, error: 'The dashboard service could not complete that request' });
        }
      }
      return undefined;
    } finally {
      log(ctx.failure && ctx.failure.category !== FAILURE.CLIENT ? 'warn' : 'info', {
        event: 'route_complete',
        route,
        mode: ctx.mode,
        requestId: ctx.requestId,
        status: res.statusCode || null,
        ok: (res.statusCode || 200) < 400,
        elapsedMs: Math.round(nowMs() - started),
        supabaseCalls: ctx.calls,
        supabaseMs: Math.round(ctx.upstreamMs),
        upstreamStatus: ctx.failure?.upstreamStatus ?? null,
        category: ctx.failure?.category ?? null,
      });
    }
  };
}

function safeMode(value) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return clean || null;
}

// Exposed for tests and for code that must know the active request's id.
export function activeRequestContext() {
  const ctx = currentContext();
  return ctx ? { route: ctx.route, requestId: ctx.requestId, mode: ctx.mode } : null;
}
