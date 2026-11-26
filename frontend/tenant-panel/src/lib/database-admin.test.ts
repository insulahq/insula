import { describe, it, expect } from 'vitest';
import { buildConnectionUrl, managedDbEngineOf, allDatabasesOptionLabel } from './database-admin';

const host = 'db.tenant-t1.svc.cluster.local';
const admin = { username: 'dbadmin', password: 'secret-pw' };

describe('buildConnectionUrl', () => {
  it('uses the application user when there is one, and never shows a password', () => {
    const url = buildConnectionUrl({ host, port: 3306, database: 'app', username: 'app' }, 'mariadb', admin);
    expect(url).toBe(`mysql://app:***@${host}:3306/app`);
    expect(url).not.toContain('secret-pw');
  });

  it('falls back to the administrator account, not root', () => {
    expect(buildConnectionUrl({ host, port: 5432, database: null, username: null }, 'postgresql', admin))
      .toBe(`postgresql://dbadmin:***@${host}:5432`);
  });

  it('adds authSource=admin for the MongoDB administrator (it is created in admin)', () => {
    expect(buildConnectionUrl({ host, port: 27017, database: null, username: null }, 'mongodb', admin))
      .toBe(`mongodb://dbadmin:***@${host}:27017/?authSource=admin`);
    expect(buildConnectionUrl({ host, port: 27017, database: 'shop', username: null }, 'mongodb', admin))
      .toBe(`mongodb://dbadmin:***@${host}:27017/shop?authSource=admin`);
  });

  it('names MongoDB as mongodb, not redis (the old port guess did)', () => {
    expect(buildConnectionUrl({ host, port: 27017, database: null, username: null }, null, null))
      .toBe(`mongodb://${host}:27017`);
  });

  it('has no user part while the account is being set up', () => {
    expect(buildConnectionUrl({ host, port: 3306, database: 'app', username: null }, 'mysql', null))
      .toBe(`mysql://${host}:3306/app`);
  });

  it('gives no URL without a port', () => {
    expect(buildConnectionUrl({ host, port: null, database: null, username: null }, 'mariadb', admin)).toBeNull();
  });
});

describe('managedDbEngineOf', () => {
  it('reads the engine from the database component', () => {
    expect(managedDbEngineOf({ components: [{ database: 'postgresql' }] })).toBe('postgresql');
  });

  it('is null for an entry without one — no administrator account to wait for', () => {
    expect(managedDbEngineOf({ components: [{}] })).toBeNull();
    expect(managedDbEngineOf({ components: null })).toBeNull();
    expect(managedDbEngineOf(null)).toBeNull();
  });
});

describe('allDatabasesOptionLabel', () => {
  it('never promises the whole server', () => {
    for (const engine of ['mariadb', 'mysql', 'postgresql', 'mongodb', null] as const) {
      expect(allDatabasesOptionLabel(engine)).not.toMatch(/server/i);
    }
  });
});
