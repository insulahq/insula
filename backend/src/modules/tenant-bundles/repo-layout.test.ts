import { describe, it, expect } from 'vitest';
import {
  normaliseRepoLayout,
  resolveBundleRepoLayout,
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

describe('sweep coverage', () => {
  it('covers both layouts, since a tenant has snapshots in both mid-migration', () => {
    expect([...ALL_REPO_LAYOUTS].sort()).toEqual(['per-component', 'per-tenant']);
    expect(ALL_REPO_LAYOUTS).toContain(CURRENT_REPO_LAYOUT);
  });
});
