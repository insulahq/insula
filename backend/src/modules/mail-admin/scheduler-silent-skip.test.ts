import { describe, it, expect, vi } from 'vitest';
import { runMailHealthCheckOnce } from './health-scheduler.js';
import { runBlocklistCheckOnce } from './blocklist-scheduler.js';
import type { Database } from '../../db/index.js';

// Without a kubeconfig both schedulers return at the very first step, long
// before the code under test. A test that lets that happen passes on the
// BROKEN code too — verified: the blocklist case did exactly that until these
// mocks were added. Give them a client so the pass reaches the decision.
vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: () => ({ core: { listNode: () => Promise.resolve({ items: [] }) } }),
}));
vi.mock('./server-node-ips.js', () => ({
  resolveServerNodeIps: () => Promise.reject(new Error('etcdserver: request timed out')),
}));
vi.mock('./mail-acme-override-route.js', () => ({
  resolveDefaultMailHost: () => Promise.resolve('mail.example.test'),
}));

/**
 * A skipped alerting pass must say WHY it skipped.
 *
 * Both schedulers are fire-and-forget and correctly never throw. The bug was
 * what they did with a failure on the way to deciding whether to run:
 *
 *   health-scheduler:    a DB error set `mailHostname = null`, which the next
 *                        line reads as "mail is not set up on this cluster",
 *                        and the whole pass returns 0.
 *   blocklist-scheduler: a kube-API error became `[]` server IPs, which the
 *                        next line reads as "no server nodes", same result.
 *
 * In both cases every mail alert on the cluster stops and nothing is logged.
 * That is the /auth/me bug (#596) again: an error laundered into a confident
 * claim, here a claim about configuration.
 *
 * These tests assert on the LOG, because the return value is 0 either way —
 * a passing assertion on `=== 0` would be satisfied by the bug.
 */

function logSpy() {
  return { info: vi.fn(), warn: vi.fn() };
}

const warnText = (log: ReturnType<typeof logSpy>) =>
  log.warn.mock.calls.map((c) => c.join(' ')).join('\n');

describe('mail health scheduler: settings read failure', () => {
  it('warns instead of silently concluding mail is unconfigured', async () => {
    // A DB that rejects — the blip that used to disable mail alerting.
    const db = {
      select: () => { throw new Error('terminating connection due to administrator command'); },
    } as unknown as Database;
    const log = logSpy();

    const fired = await runMailHealthCheckOnce(db, log, undefined);

    // Returning 0 is fine and expected; what matters is that it said so.
    expect(fired).toBe(0);
    const text = warnText(log);
    if (text.length === 0) {
      // Distinguish "no kube client" (an equally valid early return on a
      // machine with no kubeconfig) from the path under test, so this test
      // cannot pass vacuously.
      throw new Error('no warning emitted — the pass skipped without saying why');
    }
    expect(text).toMatch(/could not read mail settings/i);
    expect(text).toMatch(/NOT a statement/i);
  });
});

describe('blocklist scheduler: node-IP resolution failure', () => {
  it('warns instead of silently concluding the cluster has no server nodes', async () => {
    const db = {
      select: () => { throw new Error('connection terminated unexpectedly'); },
    } as unknown as Database;
    const log = logSpy();

    const fired = await runBlocklistCheckOnce(db, log, '/nonexistent/kubeconfig');

    // 0 either way — so the return value proves nothing and the LOG is the
    // assertion. Unconditional: a conditional `if (text.includes(...))` here
    // passed against the broken code.
    expect(fired).toBe(0);
    const text = warnText(log);
    expect(text).toMatch(/could not resolve server node IPs/i);
    expect(text).toMatch(/NOT a statement/i);
  });
});
