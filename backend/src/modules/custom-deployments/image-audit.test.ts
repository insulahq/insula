import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordImageAudit, _resetAuditFlagCache } from './image-audit.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function podWith(containers: Array<{ image: string; imageID: string }>): { items: unknown[] } {
  return {
    items: [{
      status: {
        containerStatuses: containers.map((c) => ({ name: 'c', image: c.image, imageID: c.imageID })),
      },
    }],
  };
}

function stubK8s(podList: unknown): K8sClients {
  return {
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue(podList),
    } as unknown as K8sClients['core'],
    apps: {} as K8sClients['apps'],
    networking: {} as K8sClients['networking'],
  };
}

function stubDb(flagEnabled: boolean, sentinelExists = false): {
  db: Database;
  inserts: unknown[];
  updates: unknown[];
} {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{ enabled: flagEnabled }]),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (v: unknown) => { inserts.push(v); }),
    })),
    // The writer clears NULL sentinels once a digest is known. This stub has no
    // rows, so nothing is deleted — it exists so the call is not a TypeError.
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            updates.push('updated');
            // Default: NO sentinel row exists (production-most-common
            // path) → returns empty → forces the insert branch.
            // Pass `sentinelExists=true` to simulate a real sentinel
            // present in the table (used in the sentinel-conversion
            // test specifically).
            return sentinelExists ? [{ id: 'audit-1' }] : [];
          }),
        })),
      })),
    })),
  } as unknown as Database;
  return { db, inserts, updates };
}

beforeEach(() => {
  _resetAuditFlagCache();
});

describe('recordImageAudit — flag gating', () => {
  it('no-ops when system_settings has audit disabled', async () => {
    const { db, inserts } = stubDb(false);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: 'docker-pullable://nginx@sha256:' + 'a'.repeat(64) }]));
    const n = await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(n).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(k8s.core.listNamespacedPod).not.toHaveBeenCalled();
  });

  it('queries pods when audit is enabled', async () => {
    const { db } = stubDb(true);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: 'nginx@sha256:' + 'a'.repeat(64) }]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(k8s.core.listNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'ns', labelSelector: 'app=my-app' }),
    );
  });
});

describe('recordImageAudit — digest parsing', () => {
  it('records resolved digest from docker-pullable:// imageID', async () => {
    const { db, inserts } = stubDb(true);
    const digest = 'sha256:' + 'a'.repeat(64);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: `docker-pullable://nginx@${digest}` }]));
    const n = await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(n).toBeGreaterThan(0);
    expect(inserts[0]).toMatchObject({
      deploymentId: 'dep-1',
      image: 'nginx:1.27',
      resolvedDigest: digest,
    });
  });

  it('records resolved digest from containerd:// imageID', async () => {
    const { db, inserts } = stubDb(true);
    const digest = 'sha256:' + 'b'.repeat(64);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: `containerd://nginx@${digest}` }]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect((inserts[0] as { resolvedDigest: string }).resolvedDigest).toBe(digest);
  });

  it('records sentinel row when imageID has no digest', async () => {
    const { db, inserts } = stubDb(true);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: '' }]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect((inserts[0] as { resolvedDigest: string | null }).resolvedDigest).toBe(null);
  });

  it('records sentinel row when imageID format is unexpected', async () => {
    const { db, inserts } = stubDb(true);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: 'somerandomstring' }]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect((inserts[0] as { resolvedDigest: string | null }).resolvedDigest).toBe(null);
  });
});

describe('recordImageAudit — dedupe', () => {
  it('returns 0 when no pods match (no audit rows touched)', async () => {
    const { db, inserts } = stubDb(true);
    const k8s = stubK8s({ items: [] });
    const n = await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(n).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('records all distinct images across containers', async () => {
    const { db, inserts } = stubDb(true);
    const digestA = 'sha256:' + 'a'.repeat(64);
    const digestB = 'sha256:' + 'b'.repeat(64);
    const k8s = stubK8s(podWith([
      { image: 'app:1.0', imageID: `app@${digestA}` },
      { image: 'sidecar:1.0', imageID: `sidecar@${digestB}` },
    ]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(inserts.length).toBe(2);
  });

  it('swallows 23505 unique violations (concurrent insert race)', async () => {
    // Simulate the DB throwing on the resolved insert path. The
    // stubDb update path returns empty (forcing insert), but we
    // override insert to throw a pg unique-violation.
    const { db } = stubDb(true);
    (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn().mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' })),
    }));
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: '' }]));
    await expect(recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app')).resolves.not.toThrow();
  });
});

// ── getRunningDigest — canonical image matching (2026-08-24) ────────────────
//
// Audit rows carry the image AS THE KUBELET REPORTS IT (containerd
// normalises `nginx:latest` → `docker.io/library/nginx:latest`), while the
// caller passes the deployment's SPEC string. A literal string match made
// every Docker Hub short ref miss → running digest "never observed" →
// `:latest` deployments pinned on `unknown` forever.

import { getRunningDigest } from './image-audit.js';

function stubRowsDb(rows: Array<{ image: string; digest: string }>): Database {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => rows),
        })),
      })),
    })),
  } as unknown as Database;
}

describe('getRunningDigest — canonical image matching', () => {
  const DIG_A = 'sha256:' + 'a'.repeat(64);
  const DIG_B = 'sha256:' + 'b'.repeat(64);

  it('matches a short spec ref against the kubelet-normalised row', async () => {
    const db = stubRowsDb([{ image: 'docker.io/library/nginx:latest', digest: DIG_A }]);
    expect(await getRunningDigest(db, 'dep-1', 'nginx:latest')).toBe(DIG_A);
  });

  it('matches a fully-qualified spec ref against a short kubelet row', async () => {
    const db = stubRowsDb([{ image: 'nginx:latest', digest: DIG_A }]);
    expect(await getRunningDigest(db, 'dep-1', 'docker.io/library/nginx:latest')).toBe(DIG_A);
  });

  it('scopes by repository — another service in the compose stack never matches', async () => {
    const db = stubRowsDb([
      { image: 'docker.io/library/redis:7', digest: DIG_B },
      { image: 'docker.io/library/nginx:latest', digest: DIG_A },
    ]);
    expect(await getRunningDigest(db, 'dep-1', 'nginx:latest')).toBe(DIG_A);
  });

  it('falls back to repo-level match when the kubelet reports a sibling tag or digest form', async () => {
    const db = stubRowsDb([{ image: 'docker.io/library/nginx@' + DIG_A, digest: DIG_A }]);
    expect(await getRunningDigest(db, 'dep-1', 'nginx:latest')).toBe(DIG_A);
  });

  it('prefers the exact tag match over a repo-only match', async () => {
    const db = stubRowsDb([
      { image: 'docker.io/library/nginx:1.27', digest: DIG_B },
      { image: 'docker.io/library/nginx:latest', digest: DIG_A },
    ]);
    expect(await getRunningDigest(db, 'dep-1', 'nginx:latest')).toBe(DIG_A);
  });

  it('returns null when nothing for the repository was observed', async () => {
    const db = stubRowsDb([{ image: 'docker.io/library/redis:7', digest: DIG_B }]);
    expect(await getRunningDigest(db, 'dep-1', 'nginx:latest')).toBeNull();
  });
});

describe('getRunningDigest — compose same-repo safety (review 2026-08-24)', () => {
  const DIG_A = 'sha256:' + 'a'.repeat(64);
  const DIG_B = 'sha256:' + 'b'.repeat(64);

  it('never returns a SIBLING TAG row of the same repo (other compose service)', async () => {
    // web=app:v1, worker=app:v2 — checking v1 with only v2 observed must
    // NOT borrow v2's digest and fake an update state.
    const db = stubRowsDb([{ image: 'docker.io/library/app:v2', digest: DIG_B }]);
    expect(await getRunningDigest(db, 'dep-1', 'app:v1')).toBeNull();
  });

  it('still accepts the tagless digest-pinned kubelet form for the same repo', async () => {
    const db = stubRowsDb([{ image: 'docker.io/library/app@' + DIG_A, digest: DIG_A }]);
    expect(await getRunningDigest(db, 'dep-1', 'app:v1')).toBe(DIG_A);
  });
});
