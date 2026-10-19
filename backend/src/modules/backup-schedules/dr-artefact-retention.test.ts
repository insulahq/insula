/**
 * Days + keep-last for the DR artefacts, applied to what is on the target.
 */
import { describe, it, expect, vi } from 'vitest';
import { TargetFrozenError } from '../backup-config/writable-guard.js';
import {
  enforceDrArtefactRetention,
  planArtefactRemoval,
  type DrArtefactRetentionDeps,
  type DrArtefactSpec,
  type StoredObject,
} from './dr-artefact-retention.js';
import type { RetentionPolicy } from './retention-policy.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const ETCD: DrArtefactSpec = {
  subsystem: 'etcd_snapshot',
  bucket: 'system',
  prefix: 'etcd/cid/',
  isCopy: (k) => k.endsWith('.db'),
  companions: (k) => [`${k}.meta`],
};
const SECRETS: DrArtefactSpec = {
  subsystem: 'secrets_bundle',
  bucket: 'system',
  prefix: 'dr/secrets/',
  isCopy: (k) => /\/secrets-[^/]+\.tar\.age$/.test(k),
  companions: () => [],
};

describe('planArtefactRemoval', () => {
  it('removes by days and takes each copy\'s companion with it', () => {
    const objects: StoredObject[] = [
      { key: 'etcd/cid/n1-a.db', lastModified: ago(0) },
      { key: 'etcd/cid/n1-a.db.meta', lastModified: ago(0) },
      { key: 'etcd/cid/n1-b.db', lastModified: ago(10) },
      { key: 'etcd/cid/n1-b.db.meta', lastModified: ago(10) },
      { key: 'etcd/cid/n1-c.db', lastModified: ago(20) }, // no .meta — nothing extra to delete
    ];
    expect(planArtefactRemoval(ETCD, objects, { days: 7, count: null }, NOW))
      .toEqual(['etcd/cid/n1-b.db', 'etcd/cid/n1-b.db.meta', 'etcd/cid/n1-c.db']);
  });

  it('applies whichever of days and count removes first', () => {
    const objects = [0, 1, 2, 3, 4].map((d) => ({ key: `dr/secrets/secrets-${d}.tar.age`, lastModified: ago(d) }));
    expect(planArtefactRemoval(SECRETS, objects, { days: 30, count: 2 }, NOW))
      .toEqual(['dr/secrets/secrets-2.tar.age', 'dr/secrets/secrets-3.tar.age', 'dr/secrets/secrets-4.tar.age']);
  });

  it('never touches what is not a copy of this artefact', () => {
    const objects: StoredObject[] = [
      { key: 'dr/secrets/secrets-new.tar.age', lastModified: ago(0) },
      { key: 'dr/secrets/README', lastModified: ago(99) },
      { key: 'dr/secrets/nested/secrets-old.tar.age', lastModified: ago(99) },
      { key: 'dr/secrets/secrets-old.tar.age', lastModified: ago(99) },
    ];
    expect(planArtefactRemoval(SECRETS, objects, { days: 7, count: null }, NOW)).toEqual(['dr/secrets/secrets-old.tar.age']);
  });

  it('keeps the newest copy when every copy is past the window', () => {
    const objects = [40, 41].map((d) => ({ key: `dr/secrets/secrets-${d}.tar.age`, lastModified: ago(d) }));
    expect(planArtefactRemoval(SECRETS, objects, { days: 7, count: null }, NOW)).toEqual(['dr/secrets/secrets-41.tar.age']);
  });
});

function deps(over: Partial<DrArtefactRetentionDeps> & { objects?: StoredObject[]; policy?: RetentionPolicy } = {}) {
  const removed: string[] = [];
  const objects = over.objects ?? [0, 1, 2].map((d) => ({ key: `dr/secrets/secrets-${d}.tar.age`, lastModified: ago(d) }));
  const d: DrArtefactRetentionDeps = {
    specs: async () => [ETCD, SECRETS],
    loadPolicy: async () => over.policy ?? { days: null, count: 1 },
    findSystemTargetId: async () => 'tgt-1',
    requireWritable: async () => undefined,
    openStore: async () => ({
      store: {
        list: async (_b, prefix) => objects.filter((o) => o.key.startsWith(prefix)),
        remove: async (_b, key) => { removed.push(key); },
      },
      close: vi.fn(),
    }),
    now: () => NOW,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { d, removed };
}

describe('enforceDrArtefactRetention', () => {
  it('deletes what the policy removes, for the artefact asked', async () => {
    const { d, removed } = deps();
    const res = await enforceDrArtefactRetention(d, ['secrets_bundle']);
    expect(removed).toEqual(['dr/secrets/secrets-1.tar.age', 'dr/secrets/secrets-2.tar.age']);
    expect(res).toEqual({ state: 'ran', outcomes: [{ subsystem: 'secrets_bundle', state: 'applied', copies: 3, removed: 2, failed: 0 }] });
  });

  it('never writes to a frozen target', async () => {
    const { d, removed } = deps({ requireWritable: async () => { throw new TargetFrozenError('tgt-1', 'Box'); } });
    expect(await enforceDrArtefactRetention(d)).toEqual({ state: 'skipped', reason: 'frozen' });
    expect(removed).toEqual([]);
  });

  it('does nothing without a system target', async () => {
    const { d } = deps({ findSystemTargetId: async () => null });
    expect(await enforceDrArtefactRetention(d)).toEqual({ state: 'skipped', reason: 'no-target' });
  });

  it('one failed listing does not stop the other artefacts', async () => {
    const { d, removed } = deps();
    const real = d.openStore;
    d.openStore = async () => {
      const { store, close } = await real();
      return {
        store: { ...store, list: async (b, p) => { if (p.startsWith('etcd/')) throw new Error('shim down'); return store.list(b, p); } },
        close,
      };
    };
    const res = await enforceDrArtefactRetention(d);
    expect(res.state === 'ran' && res.outcomes.map((o) => o.state)).toEqual(['error', 'applied']);
    expect(removed).toHaveLength(2);
  });

  it('counts a failed delete and carries on', async () => {
    const { d } = deps();
    const real = d.openStore;
    d.openStore = async () => {
      const { store, close } = await real();
      return { store: { ...store, remove: async (_b, k) => { if (k.endsWith('-1.tar.age')) throw new Error('busy'); } }, close };
    };
    const res = await enforceDrArtefactRetention(d, ['secrets_bundle']);
    expect(res).toMatchObject({ state: 'ran', outcomes: [{ removed: 1, failed: 1 }] });
  });
});
