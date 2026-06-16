import { describe, it, expect } from 'vitest';
import { buildResticRestoreJobSpec, reapPreResizeBundle, resolveTenantBundleTarget } from './prebundle.js';
import { backupJobs, backupConfigurations } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Properties of the pre-resize/archive restore Job that silently break the
 * destructive shrink + archive restore if they regress, and none of which a
 * typecheck catches — pin them here:
 *
 *   1. label `platform.io/component: restore-files` — the label the shim
 *      NetworkPolicy admits for the restore Job.
 *   2. restic-NATIVE restore restored DIRECTLY into the PVC
 *      (`restic restore <snap> --target /`), NOT the old `restic dump | tar x`
 *      stream and NOT staged through a node-ephemeral `/restore-tmp` emptyDir +
 *      `cp` (that ENOSPC'd the worker root disk on multi-GiB tenants — the
 *      restore Job runs where the RWO PVC attaches, so it can't pick a roomier
 *      node). The files bundle is restic-native since #105.
 *   3. the target PVC is mounted RW at /source (the capture root), and the
 *      per-Job creds Secret is mounted read-only.
 */
describe('buildResticRestoreJobSpec', () => {
  const spec = buildResticRestoreJobSpec({
    jobName: 'rs-preresize-bkp123',
    namespace: 'tenant-abc',
    pvcName: 'tenant-abc-storage',
    tenantId: 'abc',
    bundleId: 'bkp-123',
    credsSecretName: 'rs-preresize-creds-bkp123',
    snapshotId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  }) as {
    metadata: { labels: Record<string, string> };
    spec: {
      template: {
        metadata: { labels: Record<string, string> };
        spec: {
          containers: Array<{ command: string[]; volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
          volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string }; secret?: { secretName: string } }>;
        };
      };
    };
  };

  it('labels the Job restore-files (shim NetworkPolicy egress)', () => {
    expect(spec.metadata.labels['platform.io/component']).toBe('restore-files');
    expect(spec.spec.template.metadata.labels['platform.io/component']).toBe('restore-files');
  });

  it('mounts the target PVC read-write at /source + the creds Secret read-only', () => {
    const c = spec.spec.template.spec.containers[0];
    const src = c.volumeMounts.find((m) => m.mountPath === '/source');
    expect(src?.readOnly).toBe(false);
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'source');
    expect(vol?.persistentVolumeClaim?.claimName).toBe('tenant-abc-storage');
    const creds = spec.spec.template.spec.volumes.find((v) => v.name === 'restic-creds');
    expect(creds?.secret?.secretName).toBe('rs-preresize-creds-bkp123');
    // No node-ephemeral staging volume — restore writes straight to the PVC.
    expect(c.volumeMounts.find((m) => m.name === 'restore-tmp')).toBeFalsy();
    expect(spec.spec.template.spec.volumes.find((v) => v.name === 'restore-tmp')).toBeFalsy();
    expect(c.volumeMounts.find((m) => m.name === 'scratch')).toBeTruthy();
  });

  it('restores restic-native DIRECTLY into the PVC (--target /), NOT via /restore-tmp + cp', () => {
    const script = spec.spec.template.spec.containers[0].command.join('\n');
    expect(script).toContain('restic -r "$REPO" restore a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 --target / --no-lock');
    // The fix: no node-ephemeral /restore-tmp staging and no cp overlay.
    expect(script).not.toContain('--target /restore-tmp');
    expect(script).not.toContain('cp -a /restore-tmp');
    expect(script).not.toContain('restic dump');
    expect(script).not.toContain('tar xf');
    expect(script).not.toContain('/archive.tar');
  });
});

/**
 * DR safety: reapPreResizeBundle must NOT prune a backup target that is
 * frozen (read_only) — e.g. the target a freshly DR-restored cluster
 * restored FROM. The reap is best-effort (never throws), so a frozen
 * target simply retains the bundle until its 7-day expiry: the remote
 * `store.delete` is skipped AND the backup_jobs row is left in place.
 *
 * This pins the requireWritableTarget(...) guard the
 * ci-backup-target-ro-check.sh enforcement registers for prebundle.ts.
 */
describe('reapPreResizeBundle — frozen-target DR guard', () => {
  // Minimal drizzle stand-in: requireWritableTarget awaits `.where()`
  // directly (no .limit), while reapPreResizeBundle awaits `.limit(1)`.
  function makeDb(opts: { job: { id: string; targetConfigId: string | null }; cfg: Record<string, unknown> | null; readOnly: boolean }) {
    const deletes: string[] = [];
    const db = {
      select(_proj?: unknown) {
        return {
          from(table: unknown) {
            const chain = {
              where(_cond?: unknown) {
                return {
                  // reapPreResizeBundle: .where().limit(1)
                  limit(_n: number) {
                    if (table === backupJobs) return Promise.resolve([opts.job]);
                    if (table === backupConfigurations) return Promise.resolve(opts.cfg ? [opts.cfg] : []);
                    return Promise.resolve([]);
                  },
                  // requireWritableTarget: await db.select({...}).from(backupConfigurations).where(...)
                  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
                    return Promise.resolve([{ name: 'frozen-target', readOnly: opts.readOnly }]).then(resolve, reject);
                  },
                };
              },
            };
            return chain;
          },
        };
      },
      delete(table: unknown) {
        return {
          where(_cond?: unknown) {
            if (table === backupJobs) deletes.push('backupJobs');
            return Promise.resolve();
          },
        };
      },
    } as unknown as Database;
    return { db, deletes };
  }

  const k8s = {} as unknown as K8sClients;

  it('skips the remote delete AND the backup_jobs row delete when the target is read_only (never throws)', async () => {
    const { db, deletes } = makeDb({
      job: { id: 'bkp-frozen', targetConfigId: 'tgt-1' },
      cfg: { id: 'tgt-1', storageType: 's3', readOnly: true },
      readOnly: true,
    });
    // Must resolve (best-effort), not reject — the frozen guard throws
    // internally and is swallowed.
    await expect(reapPreResizeBundle({ db, k8s, bundleId: 'bkp-frozen' })).resolves.toBeUndefined();
    // The throw aborts before resolveBundleStore/store.delete AND before
    // the backup_jobs row delete, so nothing is pruned.
    expect(deletes).not.toContain('backupJobs');
  });

  it('returns early (no target work) when the bundle row is gone', async () => {
    const { db, deletes } = makeDb({ job: { id: 'gone', targetConfigId: null }, cfg: null, readOnly: false });
    // No job row → makeDb returns [job] though; emulate "missing" via a db
    // whose backupJobs select yields []:
    const emptyDb = {
      select() { return { from() { return { where() { return { limit() { return Promise.resolve([]); }, then(r: (v: unknown) => unknown) { return Promise.resolve([]).then(r); } }; } }; } }; },
      delete() { return { where() { deletes.push('backupJobs'); return Promise.resolve(); } }; },
    } as unknown as Database;
    await expect(reapPreResizeBundle({ db: emptyDb, k8s, bundleId: 'gone' })).resolves.toBeUndefined();
    expect(deletes).not.toContain('backupJobs');
  });
});

/**
 * The destructive-shrink pre-flight (resizeTenant) resolves this BEFORE any
 * quiesce/PVC delete, so a tenant with no off-site target fails fast with a
 * clear NO_SNAPSHOT_TARGET instead of being quiesced then aborting.
 */
describe('resolveTenantBundleTarget — fail-fast when no target', () => {
  // Minimal drizzle stand-in: every query resolves to [] (no assignment, no
  // legacy active target).
  function emptyTargetsDb(): Database {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy']) chain[m] = () => chain;
    chain.limit = () => Promise.resolve([]);
    (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve([]).then(r);
    return chain as unknown as Database;
  }

  it('throws NO_SNAPSHOT_TARGET (HTTP 400) when no tenant-class target is configured', async () => {
    await expect(resolveTenantBundleTarget(emptyTargetsDb())).rejects.toMatchObject({
      code: 'NO_SNAPSHOT_TARGET',
      status: 400,
    });
  });
});
