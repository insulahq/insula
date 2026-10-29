// Route sign-in gate — the per-route policy in front of a tenant's oauth2-proxy.
//
// Traefik's ForwardAuth Middleware on a protected route asks
//   GET :4181/auth?route=<ingress route id>
// for every request, with the visitor's cookies and Traefik's own
// X-Forwarded-Proto/-Host/-Uri. This forwards them to oauth2-proxy's PROXY
// endpoint (`/`, whose upstream is `static://202`) on the same pod and:
//
//   2xx  signed in → apply the route's policy (allowed emails, email domains,
//        groups, claim rules). Allowed → 200 with the identity headers the
//        route passes on; refused → 403.
//   else oauth2-proxy's answer unchanged: a signed-out browser gets its 302 to
//        the identity provider (with the CSRF cookie), an XHR its 401.
//
// The proxy endpoint, not `/oauth2/auth`: the latter only ever answers 401 to
// a signed-out visitor, and Traefik hands that 401 to the browser as is
// ("Unauthorized"). oauth2-proxy signals a valid session with 202, not 200.
//
// Policy file (POLICY_PATH, written by platform-api):
//   { "<ingress route id>": {
//       "emails": ["a@example.test"], "emailDomains": ["example.test"],
//       "groups": ["staff"],
//       "claimRules": [{"claim":"membership","operator":"contains","value":"paid"}],
//       "redirect": "https://app.example.test/after-login" | null,
//       "headers": {"user":true,"groups":true,"accessToken":false,"idToken":false,"authorization":false} } }
//
// A visitor passes when the allow lists are all empty or any entry matches
// (an email, the email's domain, or a group), AND every claim rule holds.
// Fail closed: an unknown route, an unreadable policy file or a malformed rule
// refuses the request.

import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

/** Identity headers from oauth2-proxy, by the route setting that passes them on. */
const IDENTITY_HEADERS = {
  user: ['x-auth-request-user', 'x-auth-request-email', 'x-auth-request-preferred-username'],
  groups: ['x-auth-request-groups'],
  accessToken: ['x-auth-request-access-token'],
  idToken: ['x-auth-request-id-token'],
  authorization: ['authorization'],
};

export function log(event, fields = {}) {
  // Single-line JSON. Never log claim values or addresses — they identify people.
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
}

/** Payload of a JWT oauth2-proxy has already verified; null when unreadable. */
export function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** Dotted path into the claims ("address.country"); undefined when missing. */
export function getClaim(payload, path) {
  let cur = payload;
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

const isStr = (v) => typeof v === 'string';
const isStrList = (v) => Array.isArray(v) && v.every(isStr);

/**
 * One rule against the claims. A rule whose value has the wrong shape for its
 * operator never passes — a typo must not open the site.
 */
export function applyRule(payload, rule, compiledRegex) {
  const v = getClaim(payload, rule.claim);
  switch (rule.operator) {
    case 'exists':
      return v !== undefined && v !== null;
    case 'equals':
      return isStr(rule.value) && isStr(v) && v === rule.value;
    case 'not_equals':
      return isStr(rule.value) && !(isStr(v) && v === rule.value);
    case 'contains':
      if (!isStr(rule.value)) return false;
      if (isStr(v)) return v.includes(rule.value);
      if (Array.isArray(v)) return v.includes(rule.value);
      return false;
    case 'not_contains':
      if (!isStr(rule.value)) return false;
      if (isStr(v)) return !v.includes(rule.value);
      if (Array.isArray(v)) return !v.includes(rule.value);
      return true;
    case 'in':
      if (!isStrList(rule.value)) return false;
      if (isStr(v)) return rule.value.includes(v);
      if (Array.isArray(v)) return v.some((x) => rule.value.includes(x));
      return false;
    case 'not_in':
      if (!isStrList(rule.value)) return false;
      if (isStr(v)) return !rule.value.includes(v);
      if (Array.isArray(v)) return !v.some((x) => rule.value.includes(x));
      return true;
    case 'regex':
      return compiledRegex instanceof RegExp && isStr(v) && compiledRegex.test(v);
    default:
      return false;
  }
}

/** The email's domain, or null unless it has exactly one '@' with text on both sides. */
export function emailDomain(email) {
  if (!isStr(email)) return null;
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return parts[1].toLowerCase();
}

/** Normalised, ready-to-evaluate policy for one route. Pure. */
export function compilePolicy(raw) {
  const lower = (xs) => (isStrList(xs) ? xs.map((x) => x.trim().toLowerCase()).filter(Boolean) : []);
  const claimRules = Array.isArray(raw?.claimRules) ? raw.claimRules : [];
  return {
    emails: lower(raw?.emails),
    emailDomains: lower(raw?.emailDomains).map((d) => d.replace(/^@/, '')),
    groups: isStrList(raw?.groups) ? raw.groups.map((g) => g.trim()).filter(Boolean) : [],
    claimRules: claimRules.map((r) => {
      let regex = null;
      if (r?.operator === 'regex' && isStr(r.value)) {
        try { regex = new RegExp(r.value); } catch { regex = null; }
      }
      return { rule: r, regex };
    }),
    redirect: isStr(raw?.redirect) && raw.redirect ? raw.redirect : null,
    headers: {
      user: raw?.headers?.user !== false,
      groups: raw?.headers?.groups !== false,
      accessToken: raw?.headers?.accessToken === true,
      idToken: raw?.headers?.idToken === true,
      authorization: raw?.headers?.authorization === true,
    },
  };
}

/** Parse the whole policy file; throws on anything but a JSON object. */
export function parsePolicyFile(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('policy file is not an object');
  return new Map(Object.entries(raw).map(([routeId, p]) => [routeId, compilePolicy(p)]));
}

/**
 * Does this signed-in visitor pass the route's policy? `identity` holds what
 * oauth2-proxy vouched for. Returns { ok: true } or { ok: false, reason }.
 */
export function evaluate(policy, identity) {
  const email = isStr(identity.email) ? identity.email.trim().toLowerCase() : '';
  const lists = policy.emails.length + policy.emailDomains.length + policy.groups.length;
  if (lists > 0) {
    const domain = emailDomain(email);
    const listed =
      (email && policy.emails.includes(email))
      || (domain !== null && policy.emailDomains.includes(domain))
      || identity.groups.some((g) => policy.groups.includes(g));
    if (!listed) return { ok: false, reason: 'not-listed' };
  }
  if (policy.claimRules.length > 0) {
    const claims = decodeJwtPayload(identity.idToken);
    if (!claims) return { ok: false, reason: 'no-id-token' };
    for (const { rule, regex } of policy.claimRules) {
      if (!applyRule(claims, rule, regex)) return { ok: false, reason: 'claim-rule', claim: String(rule?.claim ?? '') };
    }
  }
  return { ok: true };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The refusal a signed-in but not-allowed visitor sees. */
export function deniedResponse(email, wantsJson) {
  if (wantsJson) {
    return {
      type: 'application/json',
      body: JSON.stringify({ error: 'forbidden', message: 'Your account may not open this site.' }),
    };
  }
  const who = email ? `You are signed in as <strong>${escapeHtml(email)}</strong>, which` : 'Your account';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access denied</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}a{color:#8ab4f8}}</style></head>
<body><h1>Access denied</h1><p>${who} may not open this site.</p>
<p><a href="/oauth2/sign_out?rd=%2F">Sign out</a> to sign in with a different account.</p></body></html>`;
  return { type: 'text/html; charset=utf-8', body };
}

function firstHeader(v) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The gate's request handler. `getPolicy()` returns the current Map or null
 * when the policy file could not be read.
 */
export function createGate({ oauth2ProxyHost, oauth2ProxyPort, getPolicy }) {
  return function handle(req, res) {
    const url = new URL(req.url, 'http://gate.invalid');
    if (url.pathname === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    // Readiness: not ready while no policy is loaded (every request would be
    // refused), so the pod does not count as serving and the platform says so.
    if (url.pathname === '/ready') {
      const ready = getPolicy() !== null;
      res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' }).end(ready ? 'ok' : 'no policy');
      return;
    }
    if (url.pathname !== '/auth') {
      res.writeHead(404).end();
      return;
    }
    const routeId = url.searchParams.get('route') ?? '';
    const policies = getPolicy();
    const policy = policies?.get(routeId);
    if (!policy) {
      log(policies ? 'unknown-route' : 'policy-unavailable', { route: routeId });
      res.writeHead(policies ? 403 : 503, { 'content-type': 'text/plain' })
        .end(policies ? 'This site has no sign-in policy.' : 'Sign-in policy unavailable.');
      return;
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      // A redirect target is the route's to decide, never the visitor's.
      if (HOP_BY_HOP.has(lk) || lk === 'x-auth-request-redirect') continue;
      headers[lk] = v;
    }
    if (policy.redirect) headers['x-auth-request-redirect'] = policy.redirect;

    const upstream = httpRequest(
      { host: oauth2ProxyHost, port: oauth2ProxyPort, path: '/', method: 'GET', headers },
      (up) => {
        const status = up.statusCode ?? 502;
        if (status < 200 || status > 299) {
          // Not signed in (302 to the IdP, 401 for XHR) or an oauth2-proxy
          // error: hand it back as is, cookies and Location included.
          const out = {};
          for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
          res.writeHead(status, out);
          up.pipe(res);
          return;
        }
        up.resume();
        const bearer = firstHeader(up.headers.authorization);
        const idToken = isStr(bearer) && bearer.startsWith('Bearer ') ? bearer.slice(7) : null;
        const groupsHeader = firstHeader(up.headers['x-auth-request-groups']);
        const identity = {
          email: firstHeader(up.headers['x-auth-request-email']) ?? '',
          groups: isStr(groupsHeader) ? groupsHeader.split(',').map((g) => g.trim()).filter(Boolean) : [],
          idToken,
        };
        const verdict = evaluate(policy, identity);
        if (!verdict.ok) {
          log('deny', { route: routeId, reason: verdict.reason, ...(verdict.claim ? { claim: verdict.claim } : {}) });
          const wantsJson = String(req.headers.accept ?? '').includes('application/json');
          const denied = deniedResponse(identity.email, wantsJson);
          res.writeHead(403, { 'content-type': denied.type, 'cache-control': 'no-store' }).end(denied.body);
          return;
        }
        // Only the headers this route passes on. Traefik removes every name
        // the Middleware lists from the visitor's request before copying
        // these, so a header left out here cannot be spoofed either.
        const out = { 'cache-control': 'no-store' };
        // A refreshed session: Traefik copies these cookies onto the app's
        // response (addAuthCookiesToResponse on the Middleware).
        if (up.headers['set-cookie']) out['set-cookie'] = up.headers['set-cookie'];
        for (const [setting, names] of Object.entries(IDENTITY_HEADERS)) {
          if (!policy.headers[setting]) continue;
          for (const name of names) {
            const value = name === 'x-auth-request-id-token' ? idToken : firstHeader(up.headers[name]);
            if (isStr(value) && value) out[name] = value;
          }
        }
        res.writeHead(200, out).end();
      },
    );
    upstream.setTimeout(10_000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (err) => {
      log('oauth2-proxy-error', { route: routeId, error: err.message });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('Sign-in service unavailable.');
    });
    upstream.end();
  };
}

/** Load POLICY_PATH now and on every change of its directory (a ConfigMap mount swaps a symlink). */
export function watchPolicy(path) {
  let current = null;
  const load = () => {
    try {
      current = parsePolicyFile(readFileSync(path, 'utf8'));
      log('policy-loaded', { routes: current.size });
    } catch (err) {
      // Keep serving the last good policy; with none, refuse (fail closed).
      log('policy-load-error', { error: err.message });
    }
  };
  load();
  try {
    watch(dirname(path), { persistent: false }, () => load());
  } catch (err) {
    log('policy-watch-error', { error: err.message });
  }
  return () => current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4181);
  const getPolicy = watchPolicy(process.env.POLICY_PATH ?? '/etc/route-gate/policy.json');
  const handle = createGate({
    oauth2ProxyHost: process.env.OAUTH2_PROXY_HOST ?? '127.0.0.1',
    oauth2ProxyPort: Number(process.env.OAUTH2_PROXY_PORT ?? 4180),
    getPolicy,
  });
  createServer(handle).listen(port, () => log('startup', { port }));
}
