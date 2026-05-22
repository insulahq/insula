/**
 * Unit tests for the IMAP-concurrency elevator + reverter.
 *
 * These exercise the JMAP-call contract (idempotency, threshold
 * checks, error propagation) using an injected `jmapPost` stub. The
 * reverter additionally needs a `Database` stub that mocks the
 * `tenant_bundle_in_flight` count query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ensureImapMaxConcurrentAtLeast,
  setImapMaxConcurrent,
  runImapConcurrencyReverterTick,
  IMAP_MAX_CONCURRENT_DEFAULT,
  IMAP_MAX_CONCURRENT_MIGRATION,
  type ImapConcurrencyDeps,
  type JmapResponseShape,
} from './imap-concurrency.js';

function makeFakeJmap(initialMaxConcurrent: number): {
  deps: ImapConcurrencyDeps;
  getCurrent: () => number;
  callLog: Array<{ method: string; args: unknown }>;
} {
  let current = initialMaxConcurrent;
  const callLog: Array<{ method: string; args: unknown }> = [];
  const jmapPost: ImapConcurrencyDeps['jmapPost'] = async (
    _auth: string,
    body: unknown,
  ): Promise<JmapResponseShape> => {
    const call = (body as { methodCalls: [[string, Record<string, unknown>, string]] }).methodCalls[0];
    const [method, args] = call;
    callLog.push({ method, args });
    if (method === 'x:Imap/get') {
      return {
        methodResponses: [
          ['x:Imap/get', { list: [{ maxConcurrent: current }] }, 'c0'],
        ],
      };
    }
    if (method === 'x:Imap/set') {
      const update = (args as { update: { singleton: { maxConcurrent: number } } }).update;
      current = update.singleton.maxConcurrent;
      return {
        methodResponses: [
          ['x:Imap/set', { updated: { singleton: {} } }, 'c0'],
        ],
      };
    }
    throw new Error(`unexpected method: ${method}`);
  };
  return {
    deps: { jmapPost, authHeader: 'Basic test', baseUrl: 'http://test' },
    getCurrent: () => current,
    callLog,
  };
}

describe('ensureImapMaxConcurrentAtLeast', () => {
  it('skips write when current >= target (default 16, target 16)', async () => {
    const fake = makeFakeJmap(IMAP_MAX_CONCURRENT_DEFAULT);
    const result = await ensureImapMaxConcurrentAtLeast(
      IMAP_MAX_CONCURRENT_DEFAULT,
      fake.deps,
    );
    expect(result.bumped).toBe(false);
    expect(result.prior).toBe(16);
    expect(result.current).toBe(16);
    expect(fake.callLog.length).toBe(1);
    expect(fake.callLog[0]?.method).toBe('x:Imap/get');
  });

  it('elevates 16 → 64 when target is migration cap', async () => {
    const fake = makeFakeJmap(IMAP_MAX_CONCURRENT_DEFAULT);
    const result = await ensureImapMaxConcurrentAtLeast(
      IMAP_MAX_CONCURRENT_MIGRATION,
      fake.deps,
    );
    expect(result.bumped).toBe(true);
    expect(result.prior).toBe(16);
    expect(result.current).toBe(64);
    expect(fake.getCurrent()).toBe(64);
    expect(fake.callLog.map((c) => c.method)).toEqual(['x:Imap/get', 'x:Imap/set']);
  });

  it('skips write when already at/above target (e.g. another job elevated)', async () => {
    const fake = makeFakeJmap(IMAP_MAX_CONCURRENT_MIGRATION);
    const result = await ensureImapMaxConcurrentAtLeast(
      IMAP_MAX_CONCURRENT_MIGRATION,
      fake.deps,
    );
    expect(result.bumped).toBe(false);
    expect(fake.callLog.length).toBe(1);
  });

  it('propagates JMAP method-level errors', async () => {
    const failJmap: ImapConcurrencyDeps = {
      jmapPost: async () => ({
        methodResponses: [
          ['error', { type: 'forbidden', description: 'denied' }, 'c0'],
        ],
      }),
      authHeader: 'Basic test',
      baseUrl: 'http://test',
    };
    await expect(ensureImapMaxConcurrentAtLeast(64, failJmap)).rejects.toThrow(/x:Imap\/get/);
  });
});

describe('setImapMaxConcurrent', () => {
  it('writes exact value', async () => {
    const fake = makeFakeJmap(64);
    const result = await setImapMaxConcurrent(16, fake.deps);
    expect(result.prior).toBe(64);
    expect(result.current).toBe(16);
    expect(fake.getCurrent()).toBe(16);
  });

  it('no-ops when already at value', async () => {
    const fake = makeFakeJmap(16);
    const result = await setImapMaxConcurrent(16, fake.deps);
    expect(result.prior).toBe(16);
    expect(result.current).toBe(16);
    expect(fake.callLog.length).toBe(1); // get only, no set
  });

  it('rejects notUpdated', async () => {
    const failJmap: ImapConcurrencyDeps = {
      jmapPost: async (_a, body) => {
        const method = (body as { methodCalls: [[string]] }).methodCalls[0][0];
        if (method === 'x:Imap/get') {
          return { methodResponses: [[method, { list: [{ maxConcurrent: 16 }] }, 'c0']] };
        }
        return {
          methodResponses: [[method, { notUpdated: { singleton: { type: 'invalidProperties' } } }, 'c0']],
        };
      },
      authHeader: 'Basic test',
      baseUrl: 'http://test',
    };
    await expect(setImapMaxConcurrent(64, failJmap)).rejects.toThrow(/notUpdated/);
  });
});

describe('runImapConcurrencyReverterTick', () => {
  function makeDb(activeJobs: number) {
    return {
      execute: vi.fn().mockResolvedValue({ rows: [{ n: activeJobs }] }),
    } as unknown as Parameters<typeof runImapConcurrencyReverterTick>[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when in-flight jobs exist', async () => {
    const db = makeDb(1);
    const fake = makeFakeJmap(64);
    await runImapConcurrencyReverterTick(db, fake.deps);
    expect(fake.getCurrent()).toBe(64);
    expect(fake.callLog.length).toBe(0); // never even called x:Imap/get
  });

  it('no-ops when already at default (no jobs in-flight, current=16)', async () => {
    const db = makeDb(0);
    const fake = makeFakeJmap(IMAP_MAX_CONCURRENT_DEFAULT);
    await runImapConcurrencyReverterTick(db, fake.deps);
    expect(fake.callLog.length).toBe(1); // get only, no set
    expect(fake.getCurrent()).toBe(16);
  });

  it('reverts 64 → 16 when no jobs in-flight', async () => {
    const db = makeDb(0);
    const fake = makeFakeJmap(IMAP_MAX_CONCURRENT_MIGRATION);
    await runImapConcurrencyReverterTick(db, fake.deps);
    expect(fake.getCurrent()).toBe(IMAP_MAX_CONCURRENT_DEFAULT);
    expect(fake.callLog.map((c) => c.method)).toEqual(['x:Imap/get', 'x:Imap/set']);
  });

  it('swallows Stalwart errors (never throws)', async () => {
    const db = makeDb(0);
    const failJmap: ImapConcurrencyDeps = {
      jmapPost: async () => { throw new Error('Stalwart unreachable'); },
      authHeader: 'Basic test',
      baseUrl: 'http://test',
    };
    await expect(runImapConcurrencyReverterTick(db, failJmap)).resolves.toBeUndefined();
  });

  it('swallows DB errors (never throws)', async () => {
    const failingDb = {
      execute: vi.fn().mockRejectedValue(new Error('DB down')),
    } as unknown as Parameters<typeof runImapConcurrencyReverterTick>[0];
    const fake = makeFakeJmap(IMAP_MAX_CONCURRENT_MIGRATION);
    await expect(runImapConcurrencyReverterTick(failingDb, fake.deps)).resolves.toBeUndefined();
    expect(fake.getCurrent()).toBe(64); // not reverted
  });

  it('aborts revert when a new job acquires its slot between checks', async () => {
    // First SELECT returns 0 (idle), second SELECT returns 1 (a new
    // job acquired in the window). The reverter must NOT write 16.
    let call = 0;
    const racyDb = {
      execute: vi.fn().mockImplementation(async () => {
        call += 1;
        return { rows: [{ n: call === 1 ? 0 : 1 }] };
      }),
    } as unknown as Parameters<typeof runImapConcurrencyReverterTick>[0];
    const fake = makeFakeJmap(IMAP_MAX_CONCURRENT_MIGRATION);
    await runImapConcurrencyReverterTick(racyDb, fake.deps);
    expect(fake.getCurrent()).toBe(64); // race detected, no revert
    // Should have done x:Imap/get but NOT x:Imap/set
    expect(fake.callLog.map((c) => c.method)).toEqual(['x:Imap/get']);
  });
});

describe('readMaxConcurrent (via ensureImapMaxConcurrentAtLeast) edge cases', () => {
  it('floors a fractional return (defensive against Stalwart shape drift)', async () => {
    const transport: ImapConcurrencyDeps = {
      authHeader: 'Basic test',
      baseUrl: 'http://test',
      jmapPost: async (_a, body) => {
        const method = (body as { methodCalls: [[string]] }).methodCalls[0][0];
        if (method === 'x:Imap/get') {
          return { methodResponses: [[method, { list: [{ maxConcurrent: 16.7 }] }, 'c0']] };
        }
        // Should never be reached because 16 (floored from 16.7) < 64 → write happens
        return { methodResponses: [[method, { updated: { singleton: {} } }, 'c0']] };
      },
    };
    const result = await ensureImapMaxConcurrentAtLeast(64, transport);
    // prior is floor(16.7) = 16, bumped to 64
    expect(result.prior).toBe(16);
    expect(result.bumped).toBe(true);
  });

  it('rejects non-positive maxConcurrent (malformed response)', async () => {
    const transport: ImapConcurrencyDeps = {
      authHeader: 'Basic test',
      baseUrl: 'http://test',
      jmapPost: async () => ({
        methodResponses: [['x:Imap/get', { list: [{ maxConcurrent: 0 }] }, 'c0']],
      }),
    };
    await expect(ensureImapMaxConcurrentAtLeast(64, transport)).rejects.toThrow(/non-positive/);
  });
});
