/**
 * Image-audit writes against a fake table that ENFORCES the real unique
 * constraint — `UNIQUE (deployment_id, resolved_digest) NULLS NOT DISTINCT`.
 *
 * Why a separate harness from image-audit.test.ts: that file's stub returns
 * canned values from `update().set().where().returning()`, so a thrown
 * unique-violation is unrepresentable in it. Twenty-six tests passed against
 * that stub while production had 64 audit rows and not one resolved digest,
 * and the same bug was reported and "fixed" three times — each fix landing in
 * the comparison logic, downstream of data the writer never managed to store.
 *
 * The failure it could not see:
 *   1. A pod observed before the kubelet reports an imageID writes a NULL
 *      "sentinel" row. The production index lacked NULLS NOT DISTINCT, so
 *      every redeploy appended another instead of being rejected.
 *   2. The fill-in step was `UPDATE … WHERE deployment_id = $1 AND
 *      resolved_digest IS NULL` with no LIMIT — with N sentinels it set them
 *      ALL to the same digest and violated the constraint for N > 1.
 *   3. The reconciler called the recorder as `.catch(() => 0)`, so that throw
 *      was swallowed every 15 seconds, forever.
 *
 * Net effect: `getRunningDigest` (filters on NOT NULL) always returned null,
 * and a moving-tag update check can only answer "unknown" without it — never
 * "update available", never "up to date".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// drizzle's and()/eq()/isNull() build opaque SQL objects, so a fake table
// cannot tell WHICH rows a where() targets. Replace them with transparent
// descriptors — the fake then applies the predicate honestly, which is the
// whole point: the bug was a where() that matched more rows than intended.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: { name?: string }, val: unknown) => ({ kind: 'eq', col: col?.name, val }),
    isNull: (col: { name?: string }) => ({ kind: 'isNull', col: col?.name }),
    isNotNull: (col: { name?: string }) => ({ kind: 'isNotNull', col: col?.name }),
    and: (...parts: unknown[]) => ({ kind: 'and', parts: parts.filter(Boolean) }),
  };
});

const { recordImageAudit, _resetAuditFlagCache } = await import('./image-audit.js');
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface AuditRow {
  id: string;
  deploymentId: string;
  image: string;
  resolvedDigest: string | null;
  pulledAt: Date;
}

class UniqueViolation extends Error {
  readonly code = '23505';
  constructor() {
    super('duplicate key value violates unique constraint '
      + '"custom_deployment_image_audit_deployment_digest_unique"');
  }
}

/**
 * Minimal Drizzle-shaped fake over a real array, enforcing the production
 * unique index. Only the query shapes recordImageAudit actually uses are
 * implemented; anything else throws loudly rather than silently passing.
 */
function fakeDb(rows: AuditRow[], flagEnabled = true) {
  // NULLS NOT DISTINCT: two rows with the same (deploymentId, null) collide.
  const collides = (d: string, dig: string | null, exceptId?: string) =>
    rows.some((r) => r.deploymentId === d && r.resolvedDigest === dig && r.id !== exceptId);

  // Column name → row field. Only the two columns the writer filters on.
  const FIELD: Record<string, keyof AuditRow> = {
    deployment_id: 'deploymentId',
    resolved_digest: 'resolvedDigest',
  };

  type Cond = { kind: string; col?: string; val?: unknown; parts?: Cond[] };
  const evalCond = (r: AuditRow, c: Cond | undefined): boolean => {
    if (!c) return true;
    switch (c.kind) {
      case 'and': return (c.parts ?? []).every((p) => evalCond(r, p));
      case 'eq': return r[FIELD[c.col ?? '']] === c.val;
      case 'isNull': return r[FIELD[c.col ?? '']] === null;
      case 'isNotNull': return r[FIELD[c.col ?? '']] !== null;
      default: throw new Error(`fake db: unsupported condition ${c.kind}`);
    }
  };

  let pendingWhere: Cond | undefined;
  const matches = (r: AuditRow) => evalCond(r, pendingWhere);

  const db = {
    // flag read
    select: () => ({ from: () => ({ limit: async () => [{ enabled: flagEnabled }] }) }),

    insert: () => ({
      values: async (v: AuditRow) => {
        if (collides(v.deploymentId, v.resolvedDigest)) throw new UniqueViolation();
        rows.push({ ...v, pulledAt: v.pulledAt ?? new Date() });
      },
    }),

    update: () => ({
      set: (patch: Partial<AuditRow>) => ({
        where: (w: Cond) => {
          pendingWhere = w;
          const target = rows.filter(matches);
          return {
            returning: async () => {
              for (const r of target) {
                const nextDigest = patch.resolvedDigest !== undefined ? patch.resolvedDigest : r.resolvedDigest;
                if (collides(r.deploymentId, nextDigest, r.id)) throw new UniqueViolation();
                Object.assign(r, patch);
              }
              return target.map((r) => ({ id: r.id }));
            },
            then: undefined,
          };
        },
      }),
    }),

    delete: () => ({
      where: (w: Cond) => {
        pendingWhere = w;
        const doomed = rows.filter(matches);
        return {
          returning: async () => {
            for (const r of doomed) rows.splice(rows.indexOf(r), 1);
            return doomed.map((r) => ({ id: r.id }));
          },
        };
      },
    }),
  };
  return db as unknown as Database;
}

function stubK8s(containers: Array<{ image: string; imageID: string }>): K8sClients {
  return {
    core: {
      listNamespacedPod: async () => ({
        items: [{
          status: {
            containerStatuses: containers.map((c) => ({ name: 'c', image: c.image, imageID: c.imageID })),
          },
        }],
      }),
    } as unknown as K8sClients['core'],
    apps: {} as K8sClients['apps'],
    networking: {} as K8sClients['networking'],
  };
}

const DIGEST = 'sha256:' + '8f'.repeat(32);
const DEP = 'dep-1';

function sentinel(n: number): AuditRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `sentinel-${i}`,
    deploymentId: DEP,
    image: 'ghcr.io/acme/app:latest',
    resolvedDigest: null,
    pulledAt: new Date(Date.now() - (n - i) * 1000),
  }));
}

beforeEach(() => { _resetAuditFlagCache(); });

describe('recordImageAudit under the real unique constraint', () => {
  it('resolves the digest when a SINGLE sentinel exists', async () => {
    const rows = sentinel(1);
    const db = fakeDb(rows);
    const k8s = stubK8s([{ image: 'ghcr.io/acme/app:latest', imageID: `ghcr.io/acme/app@${DIGEST}` }]);

    await recordImageAudit(db, k8s, DEP, 'ns', 'app');

    expect(rows.filter((r) => r.resolvedDigest === DIGEST)).toHaveLength(1);
    expect(rows.filter((r) => r.resolvedDigest === null)).toHaveLength(0);
  });

  it('resolves the digest when MANY sentinels exist — the production shape', async () => {
    // 64 sentinels is what production had accumulated. The old no-LIMIT UPDATE
    // threw here, the reconciler swallowed it, and the digest never landed.
    const rows = sentinel(64);
    const db = fakeDb(rows);
    const k8s = stubK8s([{ image: 'ghcr.io/acme/app:latest', imageID: `ghcr.io/acme/app@${DIGEST}` }]);

    await recordImageAudit(db, k8s, DEP, 'ns', 'app');

    expect(rows.filter((r) => r.resolvedDigest === DIGEST)).toHaveLength(1);
    expect(rows.filter((r) => r.resolvedDigest === null)).toHaveLength(0);
  });

  it('does not throw when the digest is already recorded (every reconcile tick)', async () => {
    const rows: AuditRow[] = [
      { id: 'a', deploymentId: DEP, image: 'ghcr.io/acme/app:latest', resolvedDigest: DIGEST, pulledAt: new Date(0) },
      ...sentinel(3),
    ];
    const db = fakeDb(rows);
    const k8s = stubK8s([{ image: 'ghcr.io/acme/app:latest', imageID: `ghcr.io/acme/app@${DIGEST}` }]);

    await expect(recordImageAudit(db, k8s, DEP, 'ns', 'app')).resolves.toBeGreaterThanOrEqual(0);
    expect(rows.filter((r) => r.resolvedDigest === DIGEST)).toHaveLength(1);
    expect(rows.filter((r) => r.resolvedDigest === null)).toHaveLength(0);
  });

  it('is idempotent across repeated ticks', async () => {
    const rows = sentinel(5);
    const db = fakeDb(rows);
    const k8s = stubK8s([{ image: 'ghcr.io/acme/app:latest', imageID: `ghcr.io/acme/app@${DIGEST}` }]);

    for (let i = 0; i < 4; i++) {
      await recordImageAudit(db, k8s, DEP, 'ns', 'app');
    }
    expect(rows.filter((r) => r.resolvedDigest === DIGEST)).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it('still records a sentinel when the pod has not reported an imageID yet', async () => {
    const rows: AuditRow[] = [];
    const db = fakeDb(rows);
    const k8s = stubK8s([{ image: 'ghcr.io/acme/app:latest', imageID: '' }]);

    await recordImageAudit(db, k8s, DEP, 'ns', 'app');
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedDigest).toBeNull();
  });
});
