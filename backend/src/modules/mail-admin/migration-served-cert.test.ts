/**
 * Unit tests for the post-failover served-cert verification added 2026-07-03
 * (issuance≠serving). Step 8b2 fires the ACME order; Step 8b3 must confirm the
 * new active node is actually SERVING a valid cert on :465 before the failover
 * is treated as fully healthy — Stalwart binds a freshly-issued cert on its own
 * reload cadence, so "order fired" ≠ "cert served".
 *
 * The recycle-and-retry + notification wiring inside runMigrationStateMachine is
 * exercised end-to-end by scripts/integration-mail-dr-dataplane.sh against a
 * live cluster; these guard the two pure decision inputs — the poll loop and
 * the admin alert fan-out.
 */

import { describe, expect, it, vi } from 'vitest';

// These fan-outs now DISPATCH through the categorised path instead of writing a
// row per admin straight into the notifications table. The old assertions read
// the INSERT values, which is exactly the coupling that let a data-loss alert
// exist with no category, no template, no email and no delivery audit.
const notifyOperationalMock = vi.fn(async () => undefined);
vi.mock('../notifications/events.js', () => ({
  notifyAdminOperationalEvent: (...a: unknown[]) => notifyOperationalMock(...(a as [])),
}));
import { notifyAdminsMailCertNotServing, waitForServedMailCert } from './migration.js';

type AnyCore = Parameters<typeof waitForServedMailCert>[0];
type AnyDb = Parameters<typeof notifyAdminsMailCertNotServing>[0];

const noopLog = { warn: () => {}, info: () => {} };

/** Deterministic virtual clock: sleep advances it so the loop deadline is real. */
function virtualClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
  };
}

describe('waitForServedMailCert (issuance≠serving poll)', () => {
  it('returns ok immediately when the served cert is already valid (LE)', async () => {
    const { now, sleep } = virtualClock();
    const probe = vi.fn().mockResolvedValue({ selfSigned: false, issuer: "CN=YE1, O=Let's Encrypt", error: null });
    const res = await waitForServedMailCert({} as AnyCore, undefined, 90_000, 6_000, noopLog, {
      probe,
      findPod: async () => 'stalwart-mail-abc',
      sleep,
      now,
    });
    expect(res.ok).toBe(true);
    expect(res.selfSigned).toBe(false);
    expect(res.issuer).toContain("Let's Encrypt");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while self-signed, then returns ok when the cert flips to valid', async () => {
    const { now, sleep } = virtualClock();
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ selfSigned: true, issuer: 'CN=rcgen self signed cert', error: null })
      .mockResolvedValueOnce({ selfSigned: true, issuer: 'CN=rcgen self signed cert', error: null })
      .mockResolvedValue({ selfSigned: false, issuer: "CN=YE1, O=Let's Encrypt", error: null });
    const res = await waitForServedMailCert({} as AnyCore, undefined, 1_000, 10, noopLog, {
      probe,
      findPod: async () => 'pod',
      sleep,
      now,
    });
    expect(res.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('returns not-ok + selfSigned when it stays self-signed until the deadline', async () => {
    const { now, sleep } = virtualClock();
    const probe = vi.fn().mockResolvedValue({ selfSigned: true, issuer: 'CN=rcgen self signed cert', error: null });
    const res = await waitForServedMailCert({} as AnyCore, undefined, 30, 10, noopLog, {
      probe,
      findPod: async () => 'pod',
      sleep,
      now,
    });
    expect(res.ok).toBe(false);
    expect(res.selfSigned).toBe(true);
    // A self-signed verdict must NEVER be reported as a valid served cert.
    expect(res.issuer).toContain('rcgen');
  });

  it('treats a probe error as "unknown, keep waiting" — never a false success', async () => {
    const { now, sleep } = virtualClock();
    const probe = vi.fn().mockResolvedValue({ selfSigned: false, issuer: null, error: 'exec failed: pod gone' });
    const res = await waitForServedMailCert({} as AnyCore, undefined, 30, 10, noopLog, {
      probe,
      findPod: async () => null,
      sleep,
      now,
    });
    expect(res.ok).toBe(false);
    expect(res.selfSigned).toBe(false);
    expect(res.issuer).toBeNull();
  });
});

describe('notifyAdminsMailCertNotServing (loud alert on a self-signed listener post-failover)', () => {
  function makeDb(adminIds: string[]) {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => adminIds.map((id) => ({ id })) }) }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return Promise.resolve();
        },
      }),
    } as unknown as AnyDb;
    return { db, inserted };
  }

  it('inserts an error-level notification for every admin, linked to the migration run', async () => {
    const { db } = makeDb(['admin-1', 'admin-2']);
    await notifyAdminsMailCertNotServing(db, 'run-42', 'staging3', 'CN=rcgen self signed cert');

    // ONE categorised event; the dispatcher owns recipient fan-out.
    expect(notifyOperationalMock).toHaveBeenCalledTimes(1);
    const [, subsystem, payload] = notifyOperationalMock.mock.calls[0] as unknown[];
    expect(subsystem).toBe('mail');
    const p = payload as Record<string, string>;
    expect(p.severityLabel.toLowerCase()).toContain('cert');
    expect(p.objectLabel).toContain('staging3');
    expect(p.detail).toContain('rcgen self signed cert');
  });

  it('renders unknown issuer safely and is a no-op with no admins', async () => {
    const { db, inserted } = makeDb([]);
    await expect(notifyAdminsMailCertNotServing(db, 'run-42', 'staging3', null)).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });

  it('swallows a failing admin query (alert fan-out must never block the migration)', async () => {
    const db = {
      select: () => ({ from: () => ({ where: async () => { throw new Error('db down'); } }) }),
      insert: () => ({ values: () => Promise.resolve() }),
    } as unknown as AnyDb;
    await expect(notifyAdminsMailCertNotServing(db, 'run-42', 'staging3', null)).resolves.toBeUndefined();
  });
});
