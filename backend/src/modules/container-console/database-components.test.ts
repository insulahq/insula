import { describe, expect, it } from 'vitest';
import { DATABASE_TERMINAL_ROLES, databaseComponentNames } from './database-components.js';

type Entry = Parameters<typeof databaseComponentNames>[0];

const entry = (over: Partial<NonNullable<Entry>>): Entry => ({ type: 'application', code: 'wordpress', components: [], ...over }) as Entry;

describe('databaseComponentNames', () => {
  it('names the components that hold a database engine, not the app next to them', () => {
    const names = databaseComponentNames(entry({
      components: [{ name: 'wordpress', image: 'wp' }, { name: 'mariadb', database: 'mariadb' }] as never,
    }));
    expect([...names]).toEqual(['mariadb']);
  });

  it('reads components stored as JSON text', () => {
    const names = databaseComponentNames(entry({ components: JSON.stringify([{ name: 'db', database: 'postgresql' }, { name: 'web' }]) as never }));
    expect([...names]).toEqual(['db']);
  });

  it('a standalone database entry labels its single pod with the entry code', () => {
    const names = databaseComponentNames(entry({ type: 'database', code: 'mariadb-11', components: [{ name: 'main', database: 'mariadb' }] as never }));
    expect(names).toEqual(new Set(['main', 'mariadb-11']));
  });

  it('a standalone database entry with no components is still its code', () => {
    expect(databaseComponentNames(entry({ type: 'database', code: 'mongodb-7', components: null as never }))).toEqual(new Set(['mongodb-7']));
  });

  it.each([null, undefined])('is empty for %s', (e) => {
    expect(databaseComponentNames(e).size).toBe(0);
  });

  it('is empty for an app with no database component, and for unparseable components', () => {
    expect(databaseComponentNames(entry({ components: [{ name: 'web' }] as never })).size).toBe(0);
    expect(databaseComponentNames(entry({ components: '{not json' as never })).size).toBe(0);
  });

  it('ignores an empty database field and an unnamed component', () => {
    const names = databaseComponentNames(entry({ components: [{ name: 'a', database: '' }, { database: 'mariadb' }] as never }));
    expect(names.size).toBe(0);
  });
});

describe('DATABASE_TERMINAL_ROLES', () => {
  it('is platform staff only', () => {
    expect([...DATABASE_TERMINAL_ROLES].sort()).toEqual(['admin', 'super_admin']);
    for (const tenantRole of ['tenant_admin', 'tenant_user', 'client', 'read-only', 'billing', 'support']) {
      expect(DATABASE_TERMINAL_ROLES.has(tenantRole)).toBe(false);
    }
  });
});
