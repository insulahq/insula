import { describe, it, expect, vi } from 'vitest';
import { validateIngressRules, validateLocalPaths, updateBadges } from './service.js';
import type { Database } from '../../db/index.js';

describe('updateBadges', () => {
  // Minimal db double: select() always returns the entry; update().set()
  // captures the mapped values so we can assert the 0/1 encoding.
  function mockDb(entry: Record<string, unknown> | null) {
    const captured: Record<string, unknown> = {};
    const setFn = vi.fn().mockImplementation((v: Record<string, unknown>) => {
      Object.assign(captured, v);
      return { where: () => Promise.resolve(undefined) };
    });
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve(entry ? [entry] : []) }) }),
      update: () => ({ set: setFn }),
    } as unknown as Database;
    return { db, captured, setFn };
  }

  const entry = { id: 'ce-1', name: 'WordPress', featured: 0, popular: 0, disabled: 0 };

  it('maps disabled:true → 1', async () => {
    const { db, captured } = mockDb(entry);
    await updateBadges(db, 'ce-1', { disabled: true });
    expect(captured.disabled).toBe(1);
  });

  it('maps disabled:false → 0', async () => {
    const { db, captured } = mockDb({ ...entry, disabled: 1 });
    await updateBadges(db, 'ce-1', { disabled: false });
    expect(captured.disabled).toBe(0);
  });

  it('does NOT touch disabled when only featured/popular are passed', async () => {
    const { db, captured } = mockDb(entry);
    await updateBadges(db, 'ce-1', { featured: true, popular: true });
    expect(captured).not.toHaveProperty('disabled');
    expect(captured.featured).toBe(1);
    expect(captured.popular).toBe(1);
  });

  it('throws CATALOG_ENTRY_NOT_FOUND when the entry is missing', async () => {
    const { db } = mockDb(null);
    await expect(updateBadges(db, 'nope', { disabled: true })).rejects.toMatchObject({ code: 'CATALOG_ENTRY_NOT_FOUND' });
  });
});

describe('validateIngressRules', () => {
  it('accepts an app with one ingressable component', () => {
    expect(validateIngressRules({
      type: 'application',
      components: [
        { name: 'wordpress', ports: [{ port: 80, ingress: true }] },
        { name: 'mariadb', ports: [{ port: 3306, ingress: false }] },
      ],
    })).toBeNull();
  });

  it('accepts a runtime with one ingressable component', () => {
    expect(validateIngressRules({
      type: 'runtime',
      components: [{ name: 'php', ports: [{ port: 8080, ingress: true }] }],
    })).toBeNull();
  });

  it('rejects a database with an ingress port — DBs must stay cluster-only', () => {
    const err = validateIngressRules({
      type: 'database',
      components: [{ name: 'mariadb', ports: [{ port: 3306, ingress: true }] }],
    });
    expect(err).toMatch(/type 'database' must not declare ingress ports/);
  });

  it('rejects a service tier with an ingress port — internal caches only', () => {
    const err = validateIngressRules({
      type: 'service',
      components: [{ name: 'redis', ports: [{ port: 6379, ingress: true }] }],
    });
    expect(err).toMatch(/type 'service' must not declare ingress ports/);
  });

  it('rejects multi-component apps with TWO ingress components (nextcloud/collabora shape)', () => {
    const err = validateIngressRules({
      type: 'application',
      components: [
        { name: 'nextcloud', ports: [{ port: 80, ingress: true }] },
        { name: 'collabora', ports: [{ port: 9980, ingress: true }] },
      ],
    });
    expect(err).toMatch(/at most one component with ingress: true, got 2/);
  });

  it('rejects a single component with two ingress ports', () => {
    const err = validateIngressRules({
      type: 'application',
      components: [{ name: 'app', ports: [
        { port: 80, ingress: true },
        { port: 443, ingress: true },
      ] }],
    });
    expect(err).toMatch(/component "app" declares 2 ingress ports/);
  });

  it('accepts a database with internal-only ports', () => {
    expect(validateIngressRules({
      type: 'database',
      components: [{ name: 'mariadb', ports: [{ port: 3306, ingress: false }] }],
    })).toBeNull();
  });

  it('accepts an entry with no components (legacy single-image runtime)', () => {
    expect(validateIngressRules({ type: 'runtime' })).toBeNull();
  });
});

// ─── validateLocalPaths ──────────────────────────────────────────────────────

describe('validateLocalPaths', () => {
  it('accepts "." for a single-volume app (PVC-root)', () => {
    expect(validateLocalPaths([{ local_path: '.', container_path: '/var/www/html' }])).toBeNull();
  });

  it('accepts valid single-segment names', () => {
    expect(validateLocalPaths([
      { local_path: 'content', container_path: '/var/www/html/wp-content' },
      { local_path: 'database', container_path: '/var/lib/mysql' },
    ])).toBeNull();
    expect(validateLocalPaths([{ local_path: 'ml-cache', container_path: '/cache' }])).toBeNull();
    expect(validateLocalPaths([{ local_path: 'data_v2', container_path: '/data' }])).toBeNull();
  });

  it('rejects a multi-segment path like "applications/wordpress/content"', () => {
    const err = validateLocalPaths([{ local_path: 'applications/wordpress/content', container_path: '/data' }]);
    expect(err).toMatch(/invalid local_path/);
  });

  it('rejects an absolute path', () => {
    expect(validateLocalPaths([{ local_path: '/data', container_path: '/data' }])).toMatch(/invalid local_path/);
  });

  it('rejects ".." path traversal', () => {
    expect(validateLocalPaths([{ local_path: '..', container_path: '/data' }])).toMatch(/invalid local_path/);
  });

  it('rejects an empty string', () => {
    expect(validateLocalPaths([{ local_path: '', container_path: '/data' }])).toMatch(/invalid local_path/);
  });

  it('rejects undefined / missing local_path', () => {
    const err = validateLocalPaths([{ container_path: '/var/lib/mysql' }]);
    expect(err).toMatch(/missing local_path/);
  });

  it('rejects more than one volume with local_path "."', () => {
    const err = validateLocalPaths([
      { local_path: '.', container_path: '/data' },
      { local_path: '.', container_path: '/other' },
    ]);
    expect(err).toMatch(/at most one PVC-root mount/);
  });

  it('returns null for empty volumes array', () => {
    expect(validateLocalPaths([])).toBeNull();
  });
});
