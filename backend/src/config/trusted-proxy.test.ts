import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { resolveTrustedProxyCidrs, DEFAULT_TRUSTED_PROXY_CIDRS } from './trusted-proxy.js';

describe('resolveTrustedProxyCidrs', () => {
  it('defaults to the RFC1918 super-set + loopback', () => {
    expect(resolveTrustedProxyCidrs(undefined)).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS]);
  });

  it('honours a comma-separated operator override', () => {
    expect(resolveTrustedProxyCidrs('10.42.0.0/16, 100.64.0.0/10')).toEqual([
      '10.42.0.0/16', '100.64.0.0/10',
    ]);
  });

  it('falls back to the default for an empty / whitespace override', () => {
    // Degrading to [] would pin request.ip to the nginx pod IP for every
    // request — silently destroying rate-limit fairness and audit fidelity.
    expect(resolveTrustedProxyCidrs('')).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS]);
    expect(resolveTrustedProxyCidrs('   ')).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS]);
    expect(resolveTrustedProxyCidrs(',,')).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS]);
  });

  it('never returns an empty list', () => {
    for (const raw of [undefined, '', ' ', ',', ', ,']) {
      expect(resolveTrustedProxyCidrs(raw).length).toBeGreaterThan(0);
    }
  });
});

/**
 * Behavioural contract against a real Fastify instance: the bounded list
 * must (a) keep resolving the true client IP for the shapes the platform
 * actually produces, and (b) refuse to adopt a public IP a client prepends.
 *
 * Fastify's socket peer in `inject()` is 127.0.0.1, which IS in the trusted
 * list — exactly like the real deployment where the peer is the nginx pod IP
 * inside 10.0.0.0/8.
 */
describe('trustProxy with the bounded CIDR list', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ trustProxy: resolveTrustedProxyCidrs(undefined) });
    app.get('/whoami', async (request) => ({ ip: request.ip, protocol: request.protocol }));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  const ipFor = async (headers: Record<string, string>) => {
    const res = await app.inject({ method: 'GET', url: '/whoami', headers });
    return res.json() as { ip: string; protocol: string };
  };

  it('resolves the real client IP from the chain nginx actually emits', async () => {
    // Traefik stamps the true client; nginx appends its own resolved peer.
    const { ip } = await ipFor({ 'x-forwarded-for': '203.0.113.10, 10.42.0.5' });
    expect(ip).toBe('203.0.113.10');
  });

  it('resolves a single-entry chain (Traefik → nginx → api)', async () => {
    const { ip } = await ipFor({ 'x-forwarded-for': '203.0.113.10' });
    expect(ip).toBe('203.0.113.10');
  });

  it('IGNORES a public IP the client prepends (the hardening)', async () => {
    // Client wrote "198.51.100.99"; Traefik would normally strip it, but if
    // an operator widens Traefik's trustedIPs it would pass through. The
    // right-to-left walk stops at the first UNtrusted hop — the real client
    // — and never reaches the attacker-controlled left-most entry.
    const { ip } = await ipFor({ 'x-forwarded-for': '198.51.100.99, 203.0.113.10, 10.42.0.5' });
    expect(ip).toBe('203.0.113.10');
    expect(ip).not.toBe('198.51.100.99');
  });

  it('still trusts X-Forwarded-Proto (the OIDC redirect_uri dependency)', async () => {
    // Regression guard for integration-oidc-dex.sh: losing this makes Dex
    // reject the redirect_uri as unregistered.
    const { protocol } = await ipFor({ 'x-forwarded-proto': 'https' });
    expect(protocol).toBe('https');
  });

  it('a private-sourced client (mesh VPN) still resolves to its own address', async () => {
    const { ip } = await ipFor({ 'x-forwarded-for': '10.8.0.7, 10.42.0.5' });
    expect(ip).toBe('10.8.0.7');
  });
});

/**
 * Negative control: this is what `trustProxy: true` did. Kept so the
 * difference the hardening makes is visible and can't silently regress.
 */
describe('trustProxy: true (the pre-2026-07-28 behaviour)', () => {
  let permissive: FastifyInstance;

  beforeAll(async () => {
    permissive = Fastify({ trustProxy: true });
    permissive.get('/whoami', async (request) => ({ ip: request.ip }));
    await permissive.ready();
  });

  afterAll(async () => { await permissive.close(); });

  it('ADOPTS the client-prepended public IP', async () => {
    const res = await permissive.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10, 10.42.0.5' },
    });
    expect((res.json() as { ip: string }).ip).toBe('198.51.100.99');
  });
});
