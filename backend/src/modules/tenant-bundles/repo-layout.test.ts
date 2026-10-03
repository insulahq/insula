import { describe, it, expect, vi } from 'vitest';
import {
  layoutFromRepoUri,
  normaliseRepoLayout,
  resolveBundleRepoLayout,
  resolveForeignBundleRepoLayout,
  CURRENT_REPO_LAYOUT,
  ALL_REPO_LAYOUTS,
} from './repo-layout.js';
import type { Database } from '../../db/index.js';

function dbReturning(rows: Array<Record<string, unknown>>): Database {
  const builder: Record<string, unknown> = {};
  builder.from = () => builder;
  builder.where = () => builder;
  builder.limit = async () => rows;
  return { select: () => builder } as unknown as Database;
}

describe('normaliseRepoLayout', () => {
  it('reads NULL as the historical split — the whole migration rests on this', () => {
    // Every bundle written before the column existed lives in
    // restic-<component>/<id>. If NULL ever resolved to 'per-tenant', each of
    // them would be read from a repository that does not hold it, and restic
    // reports that as "snapshot not found", i.e. as data loss.
    expect(normaliseRepoLayout(null)).toBe('per-component');
    expect(normaliseRepoLayout(undefined)).toBe('per-component');
    expect(normaliseRepoLayout('')).toBe('per-component');
  });

  it('reads an unrecognised value as the historical split, not as the new one', () => {
    expect(normaliseRepoLayout('per-region')).toBe('per-component');
  });

  it('honours the explicit merged layout', () => {
    expect(normaliseRepoLayout('per-tenant')).toBe('per-tenant');
  });
});

describe('resolveBundleRepoLayout', () => {
  it('returns the layout the bundle records', async () => {
    await expect(resolveBundleRepoLayout(dbReturning([{ repoLayout: 'per-tenant' }]), 'bkp-1'))
      .resolves.toBe('per-tenant');
  });

  it('returns the historical split for a bundle with no row', async () => {
    await expect(resolveBundleRepoLayout(dbReturning([]), 'bkp-gone'))
      .resolves.toBe('per-component');
  });

  it('returns the historical split for a pre-migration row', async () => {
    await expect(resolveBundleRepoLayout(dbReturning([{ repoLayout: null }]), 'bkp-old'))
      .resolves.toBe('per-component');
  });
});

describe('resolveForeignBundleRepoLayout', () => {
  // A bundle known only from its meta.json (DR re-create, cross-cluster
  // migration): the row registered for it must carry the layout its snapshots
  // were written to, or the restore opens the other repository.
  const restic = { files: { sizeBytes: 1, fileCount: 1, sha256: 'a'.repeat(64) } } as never;

  it('trusts meta.repoLayout and never probes', async () => {
    const probe = vi.fn(async () => false);
    await expect(resolveForeignBundleRepoLayout({ repoLayout: 'per-tenant', components: restic }, probe))
      .resolves.toBe('per-tenant');
    await expect(resolveForeignBundleRepoLayout({ repoLayout: 'per-component', components: restic }, probe))
      .resolves.toBe('per-component');
    expect(probe).not.toHaveBeenCalled();
  });

  it('without meta.repoLayout, a per-tenant snapshot of the bundle means per-tenant', async () => {
    // v2026.9.38 – v2026.10.3-rc.2 wrote per-tenant bundles with no
    // repoLayout in meta.json. Reading absence as per-component sent the
    // v2026.10.3-rc.2 VM migration restore to restic-files/<id>.
    await expect(resolveForeignBundleRepoLayout({ components: restic }, async () => true))
      .resolves.toBe('per-tenant');
  });

  it('without meta.repoLayout and no per-tenant snapshot, it is the historical split', async () => {
    await expect(resolveForeignBundleRepoLayout({ components: restic }, async () => false))
      .resolves.toBe('per-component');
  });

  it('mailboxes alone also count as restic data worth probing for', async () => {
    const probe = vi.fn(async () => true);
    const mail = { mailboxes: { sizeBytes: 1, mailboxCount: 1, addresses: [] } } as never;
    await expect(resolveForeignBundleRepoLayout({ components: mail }, probe)).resolves.toBe('per-tenant');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a bundle with no restic component does not probe', async () => {
    const probe = vi.fn(async () => true);
    const configOnly = { config: { sizeBytes: 1, rowCount: 1 } } as never;
    await expect(resolveForeignBundleRepoLayout({ components: configOnly }, probe)).resolves.toBe('per-component');
    expect(probe).not.toHaveBeenCalled();
  });

  it('a probe failure propagates — it is never read as an answer', async () => {
    await expect(resolveForeignBundleRepoLayout({ components: restic }, async () => {
      throw new Error('wrong password or no key found');
    })).rejects.toThrow(/wrong password/);
  });
});

describe('sweep coverage', () => {
  it('covers both layouts, since a tenant has snapshots in both mid-migration', () => {
    expect([...ALL_REPO_LAYOUTS].sort()).toEqual(['per-component', 'per-tenant']);
    expect(ALL_REPO_LAYOUTS).toContain(CURRENT_REPO_LAYOUT);
  });
});

describe('layoutFromRepoUri', () => {
  const T = 'tenant-abc';

  it('does NOT read restic-files/<id> as the merged repository', () => {
    // The prefix trap: 'restic-files' starts with 'restic'. If this ever
    // matched, the sweep would point a forget at the merged repository while
    // holding a keep-set built for the split one — and forget everything it
    // did not recognise.
    expect(layoutFromRepoUri(`s3:http://shim:9000/tenant/restic-files/${T}`, T)).toBe('per-component');
    expect(layoutFromRepoUri(`s3:http://shim:9000/tenant/restic-mailboxes/${T}`, T)).toBe('per-component');
  });

  it('reads restic/<id> as the merged repository', () => {
    expect(layoutFromRepoUri(`s3:http://shim:9000/tenant/restic/${T}`, T)).toBe('per-tenant');
    expect(layoutFromRepoUri(`sftp:u@h:/backups/restic/${T}`, T)).toBe('per-tenant');
    expect(layoutFromRepoUri(`/mnt/backups/restic/${T}`, T)).toBe('per-tenant');
  });

  it('reads an absent or empty URI as the historical split', () => {
    expect(layoutFromRepoUri(null, T)).toBe('per-component');
    expect(layoutFromRepoUri('', T)).toBe('per-component');
  });

  it('does not match another tenant id', () => {
    expect(layoutFromRepoUri('s3:http://shim:9000/tenant/restic/tenant-xyz', T)).toBe('per-component');
  });
});
