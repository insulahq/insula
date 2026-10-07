import { describe, it, expect } from 'vitest';
import { appNameFromPodName, diskLimitFromMessage, summarizeTenantDiskEvictions } from './tenant-disk-evictions.js';
import type { NormalizedMemoryEvent } from './memory-events.js';

function ev(over: Partial<NormalizedMemoryEvent>): NormalizedMemoryEvent {
  return {
    dedupeKey: 'k', kind: 'pod-evicted', cause: 'pod-storage-limit', nodeName: 'node-a',
    namespace: 'tenant-acme', podName: 'blog-7d4b9c8f6-x2x9z', containerName: null,
    systemWorkload: false,
    message: 'Container wordpress exceeded its local ephemeral storage limit "2048Mi". ',
    occurredAt: new Date('2026-10-07T10:00:00Z'),
    ...over,
  };
}

const acme = { id: 't-acme', name: 'Acme' };
const tenantFor = (ns: string) => (ns === 'tenant-acme' ? acme : undefined);

describe('appNameFromPodName', () => {
  it('strips the ReplicaSet and pod hashes of a Deployment pod', () => {
    expect(appNameFromPodName('blog-7d4b9c8f6-x2x9z')).toBe('blog');
    expect(appNameFromPodName('my-site-mariadb-5f9c7b6d4-xb24c')).toBe('my-site-mariadb');
  });
  it('strips the schedule stamp and hash of a CronJob pod, and the hash of a Job pod', () => {
    expect(appNameFromPodName('blog-wp-cron-29345760-k7q2m')).toBe('blog-wp-cron');
    expect(appNameFromPodName('blog-wp-install-k7q2m')).toBe('blog-wp-install');
  });
  it('leaves a name it does not recognise alone', () => {
    expect(appNameFromPodName('standalone')).toBe('standalone');
    // A word is never a generated hash, whatever its length.
    expect(appNameFromPodName('blog-install')).toBe('blog-install');
  });
});

describe('diskLimitFromMessage', () => {
  it('reads the limit from each kubelet message shape', () => {
    expect(diskLimitFromMessage('Container wordpress exceeded its local ephemeral storage limit "2048Mi". ')).toBe('2048Mi');
    expect(diskLimitFromMessage('Pod ephemeral local storage usage exceeds the total limit of containers 8192Mi. ')).toBe('8192Mi');
    expect(diskLimitFromMessage('Usage of EmptyDir volume "multihost-sessions" exceeds the limit "256Mi". ')).toBe('256Mi');
    expect(diskLimitFromMessage('something else')).toBeNull();
  });
});

describe('summarizeTenantDiskEvictions', () => {
  it('groups a tenant\'s storage-limit evictions into one list of distinct apps', () => {
    const out = summarizeTenantDiskEvictions([
      ev({}),
      ev({ podName: 'blog-7d4b9c8f6-b8b8b' }), // same app restarted again
      ev({ podName: 'shop-6c5d4f7b8-q4q4q', message: 'Pod ephemeral local storage usage exceeds the total limit of containers 2048Mi. ' }),
    ], tenantFor);
    expect(out).toEqual([{ tenantId: 't-acme', apps: ['blog (2048Mi limit)', 'shop (2048Mi limit)'] }]);
  });

  it('ignores other causes, platform pods and namespaces that are not a tenant\'s', () => {
    expect(summarizeTenantDiskEvictions([
      ev({ cause: 'node-disk-pressure' }),
      ev({ cause: 'node-memory-pressure' }),
      ev({ systemWorkload: true }),
      ev({ namespace: 'platform' }),
      ev({ kind: 'container-oom', cause: 'memory-limit' }),
      ev({ namespace: null }),
    ], tenantFor)).toEqual([]);
  });

  it('still names the app when the message carries no limit', () => {
    expect(summarizeTenantDiskEvictions([ev({ message: 'evicted' })], tenantFor))
      .toEqual([{ tenantId: 't-acme', apps: ['blog'] }]);
  });
});
