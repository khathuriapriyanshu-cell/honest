'use strict';

/**
 * CORS origin policy.
 *
 * `ALLOWED_ORIGINS` is a comma separated list. An entry may be:
 *
 *   *                                  any origin (default)
 *   https://honest.vercel.app          an exact origin
 *   https://*.vercel.app               any sub-domain (one or more labels)
 *   capacitor://localhost              a non-HTTP scheme (Capacitor / Android WebView)
 *   http://localhost:5173              an exact port
 *   http://localhost:*                 any port on that host
 *   *://localhost                     any scheme, that host
 *
 * Regular expressions are deliberately not supported: a hostile pattern must
 * never be able to widen the policy by accident.
 *
 * Matching is done on the parsed origin (scheme, host, port) rather than with
 * simple string prefixes, so `https://evil-vercel.app` can never satisfy
 * `https://*.vercel.app`.
 */

const WILDCARD = '*';

function isValidPattern(pattern) {
  return typeof pattern === 'string' && pattern.trim().length > 0;
}

function parsePattern(pattern) {
  const raw = pattern.trim();
  if (raw === WILDCARD) return { all: true };

  // Origin form: <scheme>://<host>[:<port>]  (a scheme is optional, e.g. "*.vercel.app")
  const match = /^(?:([A-Za-z][A-Za-z0-9+.-]*|\*):\/\/)?([^/:]+|\*)(?::(\*|\d+))?$/.exec(raw);
  if (!match) return null;

  return {
    all: false,
    scheme: match[1] ? match[1].toLowerCase() : null,
    host: match[2].toLowerCase(),
    port: match[3] === undefined ? null : match[3],
    raw,
  };
}

function parseAllowedOrigins(value) {
  const list = (value === undefined || value === null ? WILDCARD : String(value))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (list.length === 0) return { patterns: [{ all: true }], raw: WILDCARD, allowAll: true };

  const patterns = [];
  for (const entry of list) {
    const parsed = parsePattern(entry);
    if (parsed) patterns.push(parsed);
    else console.warn(`[honest] ALLOWED_ORIGINS: ignoring unparsable entry "${entry}".`);
  }
  if (patterns.length === 0) patterns.push({ all: true });

  return {
    patterns,
    raw: list.join(','),
    allowAll: patterns.some((p) => p.all),
  };
}

function parseOrigin(origin) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)$/.exec(String(origin).trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  let rest = match[2];
  // Strip any userinfo; it is never part of an origin comparison.
  const at = rest.lastIndexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);

  let host = rest;
  let port = null;
  if (rest.startsWith('[')) {
    // IPv6 literal.
    const close = rest.indexOf(']');
    host = rest.slice(0, close + 1);
    const tail = rest.slice(close + 1);
    if (tail.startsWith(':')) port = tail.slice(1);
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon !== -1) {
      host = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    }
  }

  return {
    scheme,
    host: host.toLowerCase(),
    // Undefined means "the default port for the scheme".
    port: port === null || port === '' ? null : port,
    origin: `${scheme}://${match[2]}`,
  };
}

function hostMatches(patternHost, originHost) {
  if (patternHost === WILDCARD) return true;
  if (patternHost === originHost) return true;
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2);
    // "*.vercel.app" matches "honest.vercel.app" and "a.b.vercel.app" but not
    // "vercel.app" and not "evil-vercel.app".
    return originHost.length > suffix.length + 1 && originHost.endsWith(`.${suffix}`);
  }
  return false;
}

function defaultPortFor(scheme) {
  if (scheme === 'https' || scheme === 'wss') return '443';
  if (scheme === 'http' || scheme === 'ws') return '80';
  return null;
}

function originMatchesPattern(parsed, pattern) {
  if (pattern.all) return true;
  if (!parsed) return false;

  // The scheme is always compared, even when the pattern omits it, so that
  // `http://localhost:*` can never authorise `https://localhost`.
  if (pattern.scheme && pattern.scheme !== WILDCARD && pattern.scheme !== parsed.scheme) return false;

  if (!hostMatches(pattern.host, parsed.host)) return false;

  const schemeDefault = defaultPortFor(parsed.scheme);
  const effectivePort = parsed.port === null ? schemeDefault : parsed.port;

  if (pattern.port === null) {
    // No port in the pattern: only the scheme's default port qualifies.
    return parsed.port === null || (schemeDefault !== null && parsed.port === schemeDefault);
  }
  if (pattern.port === WILDCARD) return true;
  return pattern.port === effectivePort;
}

/**
 * Builds a matcher for the configured policy.
 * @returns {{ allowAll: boolean, isAllowed(origin: string): boolean, describe(): string, raw: string }}
 */
function createOriginMatcher(value) {
  const policy = parseAllowedOrigins(value);
  return {
    allowAll: policy.allowAll,
    raw: policy.raw,
    isAllowed(origin) {
      if (!isValidPattern(origin)) return false;
      const parsed = parseOrigin(origin);
      if (!parsed) return false;
      return policy.patterns.some((pattern) => originMatchesPattern(parsed, pattern));
    },
    describe() {
      return policy.allowAll ? '*' : policy.patterns.map((p) => p.raw).join(', ');
    },
  };
}

/**
 * Builds the `origin` option for the `cors` middleware.
 *
 * Requests without an Origin header (curl, native Android clients, uptime
 * monitors, server-to-server cron) are always allowed through: CORS is a
 * browser protection, not an authentication mechanism.
 */
function createCorsOriginHandler(allowedOrigins) {
  const matcher = createOriginMatcher(allowedOrigins);

  const handler = (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (matcher.isAllowed(origin)) {
      callback(null, true);
      return;
    }
    // Deny by withholding the CORS headers rather than throwing: the request is
    // still served, but the browser will block the response from the caller.
    callback(null, false);
  };

  handler.matcher = matcher;
  return handler;
}

module.exports = {
  createOriginMatcher,
  createCorsOriginHandler,
  parseAllowedOrigins,
  parseOrigin,
};
