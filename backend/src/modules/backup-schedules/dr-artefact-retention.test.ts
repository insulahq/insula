/**
 * Days + keep-last for the DR artefacts, applied to what is on the target.
 */
import { describe, it, expect, vi } from 'vitest';
import { TargetFrozenError } from '../backup-config/writable-guard.js';
import {
  enforceDrArtefactRetention,
  planArtefactRemoval,
  stampOf,
  type DrArtefactRetentionDeps,
  type DrArtefactSpec,
  type StoredObject,
} from './dr-artefact-retention.js';
import type { RetentionPolicy } from './retention-policy.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
/** The UTC stamp a Job puts in an artefact's name, `days` before NOW. */
const stamp = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const secrets = (days: number) => ({ key: `dr/secrets/secrets-${stamp(days)}.tar.age` });

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

describe('stampOf', () => {
  it('reads the UTC stamp each Job puts in the name', () => {
    expect(stampOf('dr/secrets/secrets-20261016T031505Z.tar.age')?.toISOString()).toBe('2026-10-16T03:15:05.000Z');
    expect(stampOf('etcd/cid/etcd-snap-via-shim-29868540-g8cxv-20261016T010001Z-etcd-snapshot-lab-1-1792108804.db')?.toISOString())
      .toBe('2026-10-16T01:00:01.000Z');
    expect(stampOf('dr/secrets/secrets-old.tar.age')).toBeNull();
  });
});

describe('planArtefactRemoval', () => {
  it('removes by days and takes each copy\'s companion with it', () => {
    const k = (d: number) => `etcd/cid/n1-${stamp(d)}-snap.db`;
    const objects: StoredObject[] = [
      { key: k(0) }, { key: `${k(0)}.meta` },
      { key: k(10) }, { key: `${k(10)}.meta` },
      { key: k(20) }, // no .meta — nothing extra to delete
    ];
    expect(planArtefactRemoval(ETCD, objects, { days: 7, count: null }, NOW))
      .toEqual([k(10), `${k(10)}.meta`, k(20)]);
  });

  it('applies whichever of days and count removes first', () => {
    const objects = [0, 1, 2, 3, 4].map(secrets);
    expect(planArtefactRemoval(SECRETS, objects, { days: 30, count: 2 }, NOW)).toEqual([2, 3, 4].map((d) => secrets(d).key));
  });

  it('ages a copy by its NAME — the shim lists every object with one placeholder time', () => {
    // Seen live on the first run: a 5-day limit removed every secrets bundle
    // but the newest, because the listing said they were all decades old.
    const objects = [0, 1, 4, 6, 9].map(secrets);
    expect(planArtefactRemoval(SECRETS, objects, { days: 5, count: null }, NOW)).toEqual([6, 9].map((d) => secrets(d).key));
  });

  it('never touches what is not a copy of this artefact, nor a copy whose age it cannot read', () => {
    const objects: StoredObject[] = [
      secrets(0),
      { key: 'dr/secrets/README' },
      { key: `dr/secrets/nested/secrets-${stamp(99)}.tar.age` },
      { key: 'dr/secrets/secrets-unstamped.tar.age' },
      secrets(99),
    ];
    expect(planArtefactRemoval(SECRETS, objects, { days: 7, count: 1 }, NOW)).toEqual([secrets(99).key]);
  });

  it('keeps the newest copy when every copy is past the window', () => {
    const objects = [40, 41].map(secrets);
    expect(planArtefactRemoval(SECRETS, objects, { days: 7, count: null }, NOW)).toEqual([secrets(41).key]);
  });
});

function deps(over: Partial<DrArtefactRetentionDeps> & { objects?: StoredObject[]; policy?: RetentionPolicy } = {}) {
  const removed: string[] = [];
  const objects = over.objects ?? [0, 1, 2].map(secrets);
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
    expect(removed).toEqual([secrets(1).key, secrets(2).key]);
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
      return { store: { ...store, remove: async (_b, k) => { if (k === secrets(1).key) throw new Error('busy'); } }, close };
    };
    const res = await enforceDrArtefactRetention(d, ['secrets_bundle']);
    expect(res).toMatchObject({ state: 'ran', outcomes: [{ removed: 1, failed: 1 }] });
  });
});
