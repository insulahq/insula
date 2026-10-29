// The route gate driven over real HTTP against a stand-in oauth2-proxy that
// answers the way oauth2-proxy's proxy endpoint does: 302 (with the CSRF
// cookie) to a signed-out browser, 401 to an XHR, 202 with the identity
// headers to a signed-in visitor.
//
// Run with: node --test images/claim-validator/server.test.mjs

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  applyRule, compilePolicy, createGate, decodeJwtPayload, emailDomain, evaluate, parsePolicyFile,
} from './server.mjs';

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

let proxy; let proxyPort; let gate; let gatePort;
let proxyAnswer; // (req) => { status, headers }
let lastProxyRequest;
let policies;

before(async () => {
  proxy = createServer((req, res) => {
    lastProxyRequest = { url: req.url, method: req.method, headers: req.headers };
    const { status, headers = {} } = proxyAnswer(req);
    res.writeHead(status, headers).end(status === 302 ? 'Found' : '');
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  proxyPort = proxy.address().port;
  gate = createServer(createGate({ oauth2ProxyHost: '127.0.0.1', oauth2ProxyPort: proxyPort, getPolicy: () => policies }));
  gate.listen(0, '127.0.0.1');
  await once(gate, 'listening');
  gatePort = gate.address().port;
});

after(() => { proxy.close(); gate.close(); });

beforeEach(() => {
  lastProxyRequest = null;
  policies = new Map([['route-1', compilePolicy({})]]);
});

const signedIn = (extra = {}) => () => ({
  status: 202,
  headers: {
    'x-auth-request-user': 'u-1',
    'x-auth-request-email': 'Alice@Example.Test',
    'x-auth-request-preferred-username': 'alice',
    'x-auth-request-groups': 'staff, admins',
    'x-auth-request-access-token': 'at-1',
    authorization: `Bearer ${jwt({ email: 'alice@example.test', membership: ['paid'], plan: 'gold' })}`,
    ...extra,
  },
});

async function ask(route = 'route-1', headers = {}) {
  const res = await fetch(`http://127.0.0.1:${gatePort}/auth?route=${route}`, { headers, redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

test('a signed-out browser gets oauth2-proxy\'s redirect to the IdP, cookie included', async () => {
  proxyAnswer = () => ({ status: 302, headers: { location: 'https://idp.example.test/auth?x=1', 'set-cookie': '_insula_gate_csrf=abc; Path=/' } });
  const r = await ask();
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://idp.example.test/auth?x=1');
  assert.match(r.headers.get('set-cookie'), /_insula_gate_csrf=abc/);
  // It asked the PROXY endpoint, not /oauth2/auth (which only answers 401).
  assert.equal(lastProxyRequest.url, '/');
});

test('an XHR without a session gets 401, not a redirect', async () => {
  proxyAnswer = () => ({ status: 401 });
  assert.equal((await ask('route-1', { accept: 'application/json' })).status, 401);
});

test('★ a signed-in visitor (oauth2-proxy answers 202) passes, with only the headers the route passes on', async () => {
  proxyAnswer = signedIn();
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-auth-request-email'), 'Alice@Example.Test');
  assert.equal(r.headers.get('x-auth-request-groups'), 'staff, admins');
  // Off by default: tokens, and the Authorization header the app may use itself.
  assert.equal(r.headers.get('x-auth-request-access-token'), null);
  assert.equal(r.headers.get('x-auth-request-id-token'), null);
  assert.equal(r.headers.get('authorization'), null);
});

test('the ID token header comes from oauth2-proxy\'s Authorization header when the route passes it', async () => {
  proxyAnswer = signedIn();
  policies = new Map([['route-1', compilePolicy({ headers: { idToken: true, authorization: true, accessToken: true } })]]);
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(decodeJwtPayload(r.headers.get('x-auth-request-id-token')).plan, 'gold');
  assert.match(r.headers.get('authorization'), /^Bearer /);
  assert.equal(r.headers.get('x-auth-request-access-token'), 'at-1');
});

test('★ an allow list refuses everyone not on it, with a page naming the account', async () => {
  proxyAnswer = signedIn({ 'x-auth-request-email': 'mallory@evil.test', 'x-auth-request-groups': '' });
  policies = new Map([['route-1', compilePolicy({ emails: ['alice@example.test'] })]]);
  const r = await ask();
  assert.equal(r.status, 403);
  assert.match(r.body, /mallory@evil\.test/);
  assert.match(r.body, /\/oauth2\/sign_out/);
  const json = await ask('route-1', { accept: 'application/json' });
  assert.equal(json.status, 403);
  assert.equal(JSON.parse(json.body).error, 'forbidden');
});

test('allow lists match an email case-insensitively, a domain, or any group', async () => {
  proxyAnswer = signedIn();
  for (const p of [{ emails: ['ALICE@example.test'] }, { emailDomains: ['@example.test'] }, { groups: ['admins'] }]) {
    policies = new Map([['route-1', compilePolicy(p)]]);
    assert.equal((await ask()).status, 200, JSON.stringify(p));
  }
});

test('a multi-@ address never matches an allowed domain', async () => {
  proxyAnswer = signedIn({ 'x-auth-request-email': 'mallory@evil.test@example.test', 'x-auth-request-groups': '' });
  policies = new Map([['route-1', compilePolicy({ emailDomains: ['example.test'] })]]);
  assert.equal((await ask()).status, 403);
  assert.equal(emailDomain('a@b@c'), null);
  assert.equal(emailDomain('a@Example.Test'), 'example.test');
});

test('★ claim rules are evaluated against the ID token', async () => {
  proxyAnswer = signedIn();
  policies = new Map([['route-1', compilePolicy({ claimRules: [{ claim: 'membership', operator: 'contains', value: 'paid' }] })]]);
  assert.equal((await ask()).status, 200);
  policies = new Map([['route-1', compilePolicy({ claimRules: [{ claim: 'plan', operator: 'equals', value: 'silver' }] })]]);
  assert.equal((await ask()).status, 403);
});

test('claim rules without an ID token refuse', async () => {
  proxyAnswer = signedIn({ authorization: '' });
  policies = new Map([['route-1', compilePolicy({ claimRules: [{ claim: 'plan', operator: 'exists' }] })]]);
  assert.equal((await ask()).status, 403);
});

test('a malformed rule refuses instead of passing', () => {
  const claims = { plan: 'gold' };
  assert.equal(applyRule(claims, { claim: 'plan', operator: 'not_in', value: 'gold' }), false);
  assert.equal(applyRule(claims, { claim: 'plan', operator: 'not_contains', value: 5 }), false);
  assert.equal(applyRule(claims, { claim: 'plan', operator: 'bogus', value: 'x' }), false);
  const bad = compilePolicy({ claimRules: [{ claim: 'plan', operator: 'regex', value: '(' }] });
  assert.equal(evaluate(bad, { email: 'a@b.test', groups: [], idToken: jwt(claims) }).ok, false);
});

test('rule operators', () => {
  const c = { email: 'a@example.test', groups: ['x', 'y'], nested: { country: 'NA' } };
  assert.equal(applyRule(c, { claim: 'nested.country', operator: 'equals', value: 'NA' }), true);
  assert.equal(applyRule(c, { claim: 'groups', operator: 'in', value: ['y', 'z'] }), true);
  assert.equal(applyRule(c, { claim: 'groups', operator: 'not_in', value: ['z'] }), true);
  assert.equal(applyRule(c, { claim: 'email', operator: 'regex', value: '' }, /@example\.test$/), true);
  assert.equal(applyRule(c, { claim: 'missing', operator: 'exists' }), false);
  assert.equal(applyRule(c, { claim: 'email', operator: 'not_equals', value: 'b@example.test' }), true);
});

test('an unknown route is refused, an unreadable policy file is a 503', async () => {
  proxyAnswer = signedIn();
  assert.equal((await ask('route-x')).status, 403);
  policies = null;
  assert.equal((await ask()).status, 503);
});

test('the visitor cannot choose the post-login redirect; the route can', async () => {
  proxyAnswer = () => ({ status: 302, headers: { location: 'https://idp.example.test/' } });
  await ask('route-1', { 'x-auth-request-redirect': 'https://evil.test/' });
  assert.equal(lastProxyRequest.headers['x-auth-request-redirect'], undefined);
  policies = new Map([['route-1', compilePolicy({ redirect: 'https://app.example.test/home' })]]);
  await ask('route-1', { 'x-auth-request-redirect': 'https://evil.test/' });
  assert.equal(lastProxyRequest.headers['x-auth-request-redirect'], 'https://app.example.test/home');
});

test('cookies and the forwarded request headers reach oauth2-proxy', async () => {
  proxyAnswer = signedIn();
  await ask('route-1', { cookie: '_insula_gate=s', 'x-forwarded-host': 'app.example.test', 'x-forwarded-uri': '/photos?x=1' });
  assert.equal(lastProxyRequest.headers.cookie, '_insula_gate=s');
  assert.equal(lastProxyRequest.headers['x-forwarded-host'], 'app.example.test');
  assert.equal(lastProxyRequest.headers['x-forwarded-uri'], '/photos?x=1');
});

test('oauth2-proxy down → 502', async () => {
  const dead = createServer(createGate({ oauth2ProxyHost: '127.0.0.1', oauth2ProxyPort: 1, getPolicy: () => policies }));
  dead.listen(0, '127.0.0.1');
  await once(dead, 'listening');
  const res = await fetch(`http://127.0.0.1:${dead.address().port}/auth?route=route-1`);
  assert.equal(res.status, 502);
  dead.close();
});

test('the policy file must be an object', () => {
  assert.throws(() => parsePolicyFile('[]'));
  assert.equal(parsePolicyFile('{"r":{"emails":["A@B.test"]}}').get('r').emails[0], 'a@b.test');
});

test('a refreshed session cookie is passed on with the 2xx answer', async () => {
  proxyAnswer = signedIn({ 'set-cookie': '_insula_gate=refreshed; Path=/; Secure; HttpOnly' });
  const r = await ask();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /_insula_gate=refreshed/);
});

test('readiness fails while no policy is loaded', async () => {
  policies = null;
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/ready`)).status, 503);
  policies = new Map();
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/ready`)).status, 200);
});
