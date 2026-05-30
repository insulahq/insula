/**
 * Unit tests for applyMailServerHostnameToStalwart's Domain resolution,
 * focused on the self-heal-on-missing-Domain behaviour (the
 * rename-to-fresh-host flow).
 *
 * The service's private `postJmap` talks to Stalwart over `node:http`
 * via `http.request`, authenticating with `readStalwartCredentials`.
 * We mock both: `readStalwartCredentials` returns fixed creds, and
 * `node:http`'s `request` is replaced by a scriptable fake that
 * records every JMAP request body and replies with queued responses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── node:http mock ────────────────────────────────────────────────
//
// Each call to http.request consumes the next queued response. The
// fake captures the written request body so assertions can inspect
// the exact JMAP method calls the service emitted.

interface FakeHttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

const jmapRequestBodies: string[] = [];
let responseQueue: FakeHttpResponse[] = [];

function nextResponse(): FakeHttpResponse {
  const r = responseQueue.shift();
  if (!r) {
    throw new Error('fake http.request: response queue exhausted');
  }
  return r;
}

const requestMock = vi.fn(
  (
    _options: unknown,
    onResponse: (res: {
      statusCode: number;
      on: (event: string, cb: (chunk?: Buffer) => void) => void;
    }) => void,
  ) => {
    let capturedBody = '';
    const req = {
      setTimeout: vi.fn(),
      on: vi.fn(),
      write: (chunk: string) => {
        capturedBody += chunk;
      },
      end: () => {
        jmapRequestBodies.push(capturedBody);
        const { statusCode, body } = nextResponse();
        const handlers: Record<string, (chunk?: Buffer) => void> = {};
        const res = {
          statusCode,
          on: (event: string, cb: (chunk?: Buffer) => void) => {
            handlers[event] = cb;
          },
        };
        onResponse(res);
        // Drive the data/end events the service listens for.
        if (handlers.data) handlers.data(Buffer.from(body, 'utf8'));
        if (handlers.end) handlers.end();
      },
    };
    return req;
  },
);

vi.mock('node:http', () => ({
  default: { request: requestMock },
  request: requestMock,
}));

vi.mock('../mail-admin/credentials.js', () => ({
  readStalwartCredentials: () => ({ username: 'admin', password: 'secret' }),
}));

// Import AFTER the mocks are registered so the service's dynamic
// `import('node:http')` resolves to the mock.
const { applyMailServerHostnameToStalwart } = await import('./service.js');

// ── JMAP response builders ────────────────────────────────────────

function jmapBody(payload: Record<string, unknown>): string {
  return JSON.stringify({ methodResponses: [['x:Method', payload, 'c']] });
}

function ok(payload: Record<string, unknown>): FakeHttpResponse {
  return { statusCode: 200, body: jmapBody(payload) };
}

beforeEach(() => {
  jmapRequestBodies.length = 0;
  responseQueue = [];
  requestMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('applyMailServerHostnameToStalwart Domain resolution', () => {
  it('uses the existing Domain row when one matches (no create)', async () => {
    // Step 1: Domain/query → ids; Domain/get → list with matching apex.
    // Step 2: SystemSettings/get (previousHostname). Step 3:
    // SystemSettings/set (updated). previousHostname === trimmed so the
    // SAN-add + rollout steps are skipped.
    responseQueue = [
      ok({ ids: ['d1'] }),
      ok({ list: [{ id: 'd1', name: 'foo.com' }] }),
      ok({ list: [{ defaultHostname: 'mail.foo.com' }] }),
      ok({ updated: { singleton: {} } }),
    ];

    const result = await applyMailServerHostnameToStalwart('mail.foo.com');

    expect(result.defaultDomainId).toBe('d1');
    expect(result.previousHostname).toBe('mail.foo.com');
    // No x:Domain/set CREATE call should have been emitted.
    const createCalls = jmapRequestBodies.filter(
      (b) => b.includes('x:Domain/set') && b.includes('"create"'),
    );
    expect(createCalls).toHaveLength(0);
  });

  it('creates the cert-anchor Domain inline when none matches, then proceeds', async () => {
    // Step 1: Domain/query → ids; Domain/get → list with NO match for
    // mail.fresh.com. The self-heal then issues x:Domain/set create,
    // which returns the new id. Resolution continues:
    // SystemSettings/get, SystemSettings/set, and (since the hostname
    // changed) Domain/get(SAN) + Domain/set(SAN).
    responseQueue = [
      ok({ ids: ['d1'] }),
      ok({ list: [{ id: 'd1', name: 'other.com' }] }),
      // x:Domain/set create → created with new id.
      ok({ created: { newcertanchor: { id: 'd-new' } } }),
      // SystemSettings/get → previousHostname differs from target.
      ok({ list: [{ defaultHostname: 'mail.other.com' }] }),
      // SystemSettings/set → updated.
      ok({ updated: { singleton: {} } }),
      // addHostnameToDomainSANs: Domain/get (certificateManagement).
      ok({ list: [{ certificateManagement: { '@type': 'Automatic', subjectAlternativeNames: {} } }] }),
      // addHostnameToDomainSANs: Domain/set (SAN) → updated.
      ok({ updated: { 'd-new': {} } }),
    ];

    const result = await applyMailServerHostnameToStalwart('mail.fresh.com');

    // Did NOT throw "No Domain row matches" — instead resolved to the
    // freshly-created Domain.
    expect(result.defaultDomainId).toBe('d-new');
    expect(result.previousHostname).toBe('mail.other.com');
    expect(result.sanAdded).toBe(true);

    // A x:Domain/set CREATE call was emitted with the FULL hostname as
    // the Domain name (NOT the stripped apex `fresh.com`).
    const createCalls = jmapRequestBodies.filter(
      (b) => b.includes('x:Domain/set') && b.includes('"create"'),
    );
    expect(createCalls).toHaveLength(1);
    const parsed = JSON.parse(createCalls[0]) as {
      methodCalls: Array<[string, { accountId?: string; create?: Record<string, { name?: string }> }, string]>;
    };
    const [, args] = parsed.methodCalls[0];
    expect(args.accountId).toBe('d333333');
    const created = args.create ?? {};
    const createdNames = Object.values(created).map((c) => c.name);
    expect(createdNames).toContain('mail.fresh.com');
    expect(createdNames).not.toContain('fresh.com');
  });

  it('falls back to a Domain read-back when create omits the id', async () => {
    responseQueue = [
      ok({ ids: ['d1'] }),
      ok({ list: [{ id: 'd1', name: 'other.com' }] }),
      // x:Domain/set create → created shape WITHOUT an id.
      ok({ created: { newcertanchor: {} } }),
      // read-back: Domain/query.
      ok({ ids: ['d1', 'd-readback'] }),
      // read-back: Domain/get → includes the new Domain by exact name.
      ok({ list: [{ id: 'd1', name: 'other.com' }, { id: 'd-readback', name: 'mail.fresh2.com' }] }),
      // SystemSettings/get.
      ok({ list: [{ defaultHostname: 'mail.other.com' }] }),
      // SystemSettings/set.
      ok({ updated: { singleton: {} } }),
      // SAN get + set.
      ok({ list: [{ certificateManagement: { '@type': 'Automatic', subjectAlternativeNames: {} } }] }),
      ok({ updated: { 'd-readback': {} } }),
    ];

    const result = await applyMailServerHostnameToStalwart('mail.fresh2.com');

    expect(result.defaultDomainId).toBe('d-readback');
  });

  it('throws when the cert-anchor create is rejected by Stalwart', async () => {
    responseQueue = [
      ok({ ids: ['d1'] }),
      ok({ list: [{ id: 'd1', name: 'other.com' }] }),
      // x:Domain/set create → notCreated.
      ok({ notCreated: { newcertanchor: { type: 'invalidProperties', description: 'bad name' } } }),
    ];

    await expect(applyMailServerHostnameToStalwart('mail.bad.com')).rejects.toThrow(
      /cert-anchor Domain create/i,
    );
  });
});
