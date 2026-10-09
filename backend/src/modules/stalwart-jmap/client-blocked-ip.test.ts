/**
 * Wire shape of the ban-list helpers (x:BlockedIp/*, ReloadBlockedIps) — the
 * exact JMAP request each sends, and how it reads the answer. Registry objects
 * are account-agnostic in this client (no accountId), like x:Security.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actionReloadBlockedIps,
  blockedIpGet,
  blockedIpQuery,
  blockedIpUpdate,
} from './client.js';

const opts = {
  baseUrl: 'http://stalwart-test:8080',
  env: { STALWART_ADMIN_USER: 'admin', STALWART_ADMIN_PASSWORD: 'test-password' } as NodeJS.ProcessEnv,
};

let fetchMock: ReturnType<typeof vi.fn>;
const sent = () => JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
  using: string[]; methodCalls: Array<[string, Record<string, unknown>, string]>;
};
function answer(method: string, args: Record<string, unknown>): void {
  const payload = { methodResponses: [[method, args, 'c0']], sessionState: 's' };
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 200, statusText: 'OK',
    text: () => Promise.resolve(JSON.stringify(payload)),
    json: () => Promise.resolve(payload),
  });
}

beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('ban-list helpers — wire shape', () => {
  it('blockedIpQuery pages by position/limit and returns the ids', async () => {
    answer('x:BlockedIp/query', { ids: ['a', 'b'], position: 200, total: 202 });
    expect(await blockedIpQuery({ position: 200, limit: 200, ...opts })).toEqual(['a', 'b']);
    const req = sent();
    expect(req.using).toContain('urn:stalwart:jmap');
    expect(req.methodCalls).toEqual([['x:BlockedIp/query', { position: 200, limit: 200 }, 'c0']]);
  });

  it('blockedIpGet asks for exactly the given ids and returns the list', async () => {
    const row = { id: 'a', reason: 'portScanning', createdAt: '2026-10-01T00:00:00Z', expiresAt: null };
    answer('x:BlockedIp/get', { list: [row], notFound: [] });
    expect(await blockedIpGet({ ids: ['a'], ...opts })).toEqual([row]);
    expect(sent().methodCalls).toEqual([['x:BlockedIp/get', { ids: ['a'] }, 'c0']]);
  });

  it('blockedIpUpdate sends the per-id patches and hands back the set response', async () => {
    answer('x:BlockedIp/set', { updated: { a: null }, notUpdated: null });
    const res = await blockedIpUpdate({ update: { a: { expiresAt: '2026-10-02T00:00:00Z' } }, ...opts });
    expect(res.updated).toEqual({ a: null });
    expect(sent().methodCalls).toEqual([
      ['x:BlockedIp/set', { update: { a: { expiresAt: '2026-10-02T00:00:00Z' } } }, 'c0'],
    ]);
  });

  it('actionReloadBlockedIps creates the ReloadBlockedIps action', async () => {
    answer('x:Action/set', { created: { reload: { id: 'x' } } });
    await actionReloadBlockedIps(opts);
    expect(sent().methodCalls).toEqual([
      ['x:Action/set', { create: { reload: { '@type': 'ReloadBlockedIps' } } }, 'c0'],
    ]);
  });

  it('actionReloadBlockedIps throws when Stalwart refuses the action', async () => {
    answer('x:Action/set', { notCreated: { reload: { type: 'forbidden' } } });
    await expect(actionReloadBlockedIps(opts)).rejects.toThrow(/ReloadBlockedIps rejected/);
  });
});
