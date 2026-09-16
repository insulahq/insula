import { describe, it, expect, vi } from 'vitest';
import { scanTenantOom } from './oom-scan.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * "Never throws" must not mean "never says anything".
 *
 * `scanTenantOom` swallowed every failure and returned `[]`, which the caller
 * in metrics-scheduler.ts reads as "this tenant had no OOM kills". The caller
 * wraps the call in its own try/catch that logs "OOM scan failed" — and that
 * catch could NEVER fire, because nothing ever propagated. So a persistent
 * kube-API problem stopped every OOM alert with no log line anywhere.
 *
 * Same shape as the /auth/me session bug (#596): a catch that converts an
 * error into a confident claim. Here the claim is "zero OOM kills".
 */

function k8sThatFails(err: Error): K8sClients {
  return {
    core: { listNamespacedPod: () => Promise.reject(err) },
  } as unknown as K8sClients;
}

function k8sThatReturns(items: unknown[]): K8sClients {
  return {
    core: { listNamespacedPod: () => Promise.resolve({ items }) },
  } as unknown as K8sClients;
}

describe('scanTenantOom failure reporting', () => {
  it('still does not throw (the fire-and-forget contract is preserved)', async () => {
    const onError = vi.fn();
    await expect(
      scanTenantOom(k8sThatFails(new Error('etcdserver: request timed out')), 'tenant-a', Date.now(), 90_000, onError),
    ).resolves.toEqual([]);
  });

  it('reports the failure instead of silently claiming zero OOM kills', async () => {
    const onError = vi.fn();
    await scanTenantOom(k8sThatFails(new Error('connect ECONNREFUSED')), 'tenant-a', Date.now(), 90_000, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    const [namespace, message] = onError.mock.calls[0] ?? [];
    expect(namespace).toBe('tenant-a');
    expect(String(message)).toMatch(/ECONNREFUSED/);
  });

  it('stays quiet when the scan genuinely succeeds with no OOM kills', async () => {
    // A real empty result must remain indistinguishable from today's
    // behaviour — the point is to separate "none" from "could not look",
    // not to start crying wolf on every quiet tenant.
    const onError = vi.fn();
    const out = await scanTenantOom(k8sThatReturns([]), 'tenant-a', Date.now(), 90_000, onError);
    expect(out).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('works without the reporter (it stays optional)', async () => {
    await expect(scanTenantOom(k8sThatFails(new Error('boom')), 'tenant-a')).resolves.toEqual([]);
  });
});
