/**
 * Tests for the mail-stack co-location helpers in migration.ts.
 *
 * Validates that:
 *   1. applyDeploymentAffinity patches BOTH stalwart-mail AND bulwark
 *      with the same nodeSelector in one call (failover atomic).
 *   2. The `allow-restore` annotation is stamped ONLY on stalwart-mail
 *      (Bulwark has no restore-state init container today; A2 will
 *      give it one consuming the same annotation).
 *   3. MAIL_STACK_DEPLOYMENTS is the canonical co-location list — adding
 *      a new mail-stack workload requires updating this constant.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyDeploymentAffinity,
  MAIL_STACK_DEPLOYMENTS,
} from './migration.js';

type AppsV1Api = import('@kubernetes/client-node').AppsV1Api;

interface PatchCall {
  namespace: string;
  name: string;
  body: {
    spec?: {
      template?: {
        metadata?: { annotations?: Record<string, string | null | undefined> };
        spec?: { nodeSelector?: Record<string, string> };
      };
    };
  };
}

function makeAppsMock(): {
  apps: AppsV1Api;
  calls: PatchCall[];
} {
  const calls: PatchCall[] = [];
  const apps = {
    patchNamespacedDeployment: vi.fn(async (args: PatchCall) => {
      calls.push(args);
      return { metadata: { name: args.name } };
    }),
  } as unknown as AppsV1Api;
  return { apps, calls };
}

describe('applyDeploymentAffinity (mail-stack co-location)', () => {
  it('exports the co-location list with stalwart-mail and bulwark', () => {
    expect(MAIL_STACK_DEPLOYMENTS).toEqual(['stalwart-mail', 'bulwark']);
  });

  it('patches BOTH deployments with the same nodeSelector', async () => {
    const { apps, calls } = makeAppsMock();
    await applyDeploymentAffinity(apps, 'staging2', false);
    expect(calls).toHaveLength(2);
    const names = calls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['stalwart-mail', 'bulwark']));
    for (const c of calls) {
      expect(c.namespace).toBe('mail');
      expect(c.body.spec?.template?.spec?.nodeSelector).toEqual({
        'kubernetes.io/hostname': 'staging2',
      });
    }
  });

  it('stamps the allow-restore annotation in spec.template.metadata.annotations on stalwart-mail ONLY', async () => {
    // Fix #4: the annotation must live in the POD template (spec.template.metadata.annotations),
    // not the Deployment object (metadata.annotations). The restore-state init container reads
    // /podinfo via downwardAPI which mounts pod.metadata.annotations (inherited from template).
    //
    // 2026-05-28: both annotations (`allow-restore`, `restore-snapshot-id`) are ALWAYS set in
    // the patch — null when absent — so a regular migration explicitly clears any stale
    // restore-snapshot-id left over from a prior operator-initiated per-snapshot restore
    // (strategic-merge-patch interprets null as "delete this key"). Bulwark only ever gets
    // null for both (it has no restore-state init container today).
    const { apps, calls } = makeAppsMock();
    await applyDeploymentAffinity(apps, 'staging2', /* allowRestore */ true);
    const stalwart = calls.find((c) => c.name === 'stalwart-mail');
    const bulwark = calls.find((c) => c.name === 'bulwark');
    expect(stalwart?.body.spec?.template?.metadata?.annotations).toEqual({
      'mail.platform/allow-restore': 'true',
      'mail.platform/restore-snapshot-id': null,
    });
    expect(bulwark?.body.spec?.template?.metadata?.annotations).toEqual({
      'mail.platform/allow-restore': null,
      'mail.platform/restore-snapshot-id': null,
    });
  });

  it('clears both annotations when allowRestore=false (regular migration / DR cleanup)', async () => {
    const { apps, calls } = makeAppsMock();
    await applyDeploymentAffinity(apps, 'staging2', false);
    for (const c of calls) {
      expect(c.body.spec?.template?.metadata?.annotations).toEqual({
        'mail.platform/allow-restore': null,
        'mail.platform/restore-snapshot-id': null,
      });
    }
  });

  it('stamps restore-snapshot-id ONLY on stalwart-mail (Bulwark has no restore-state)', async () => {
    const { apps, calls } = makeAppsMock();
    await applyDeploymentAffinity(apps, 'staging2', /* allowRestore */ true, 'abc12345');
    const stalwart = calls.find((c) => c.name === 'stalwart-mail');
    const bulwark = calls.find((c) => c.name === 'bulwark');
    expect(stalwart?.body.spec?.template?.metadata?.annotations).toEqual({
      'mail.platform/allow-restore': 'true',
      'mail.platform/restore-snapshot-id': 'abc12345',
    });
    expect(bulwark?.body.spec?.template?.metadata?.annotations).toEqual({
      'mail.platform/allow-restore': null,
      'mail.platform/restore-snapshot-id': null,
    });
  });

  it('re-throws on partial failure (first patch ok, second throws) without rolling back the first', async () => {
    // Documents the explicit "partial state is intentional" contract:
    // when Bulwark's patch fails after Stalwart's succeeds, the wrapper
    // re-throws so the caller marks the migration as failed. The next
    // tick (manual or dr-watcher) re-invokes applyDeploymentAffinity
    // and merge-patch idempotency repairs Bulwark.
    const calls: PatchCall[] = [];
    let invocations = 0;
    const apps = {
      patchNamespacedDeployment: vi.fn(async (args: PatchCall) => {
        invocations++;
        calls.push(args);
        // First call (stalwart-mail) succeeds; second (bulwark) throws.
        if (invocations === 2) throw new Error('simulated bulwark patch failure');
        return { metadata: { name: args.name } };
      }),
    } as unknown as AppsV1Api;
    await expect(applyDeploymentAffinity(apps, 'staging2', false))
      .rejects.toThrow(/simulated bulwark patch failure/);
    // Stalwart was patched; we don't try to undo it.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe('stalwart-mail');
    expect(calls[1]!.name).toBe('bulwark');
  });
});
