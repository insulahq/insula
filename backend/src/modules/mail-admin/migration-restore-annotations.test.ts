import { describe, it, expect, vi } from 'vitest';
import type { AppsV1Api } from '@kubernetes/client-node';
import { clearRestoreAnnotations } from './migration.js';

/**
 * Step 7 of a migration clears the restore annotations. Clearing only
 * allow-restore left a restic escalation's `restore-snapshot-id: latest` on the
 * pod template; the next Stalwart start wiped the just-restored DataStore and,
 * without allow-restore, fresh-started an empty mail store (VM failover drill).
 */
describe('clearRestoreAnnotations', () => {
  it('removes allow-restore AND restore-snapshot-id from the pod template in one patch', async () => {
    const patch = vi.fn().mockResolvedValue({});
    await clearRestoreAnnotations({ patchNamespacedDeployment: patch } as unknown as AppsV1Api);
    expect(patch).toHaveBeenCalledTimes(1);
    const [{ body, namespace, name }] = patch.mock.calls[0] as [{ body: { spec: { template: { metadata: { annotations: Record<string, unknown> } } }; metadata: { annotations: Record<string, unknown> } }; namespace: string; name: string }];
    expect({ namespace, name }).toEqual({ namespace: 'mail', name: 'stalwart-mail' });
    expect(body.spec.template.metadata.annotations).toEqual({
      'mail.platform/allow-restore': null,
      'mail.platform/restore-snapshot-id': null,
    });
    expect(body.metadata.annotations).toEqual({
      'mail.platform/allow-restore': null,
      'mail.platform/restore-snapshot-id': null,
    });
  });
});
