import { describe, expect, it } from 'vitest';
import {
  catalogEntryIdsIn,
  isPlatformOnlyConfigKey,
  stripPlatformOnlyConfig,
  stripPlatformOnlyConfigDeep,
  withStoredPlatformOnlyConfig,
  withoutPlatformOnlyConfig,
} from './platform-only-config.js';

describe('isPlatformOnlyConfigKey', () => {
  it.each([
    'MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD_FILE', 'POSTGRES_PASSWORD',
    'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_INITDB_ROOT_USERNAME', 'MARIADB_ROOT_HOST', 'MYSQL_ROOT_HOST',
    'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD', 'MYSQL_ALLOW_EMPTY_PASSWORD', 'MARIADB_RANDOM_ROOT_PASSWORD',
    'MYSQL_RANDOM_ROOT_PASSWORD', 'POSTGRES_HOST_AUTH_METHOD', 'POSTGRES_PASSWORD_FILE',
  ])('%s is the platform\'s', (k) => expect(isPlatformOnlyConfigKey(k)).toBe(true));

  it.each([
    'MARIADB_USER', 'MARIADB_PASSWORD', 'MARIADB_DATABASE', 'POSTGRES_USER', 'POSTGRES_DB',
    'WORDPRESS_DB_PASSWORD', 'SECRET_KEY_BASE', 'ALLOW_EMPTY_PASSWORD',
    // another service's own root credential is its tenant's, not the platform's
    'MINIO_ROOT_PASSWORD', 'MINIO_ROOT_USER', 'GITEA_ROOT_PASSWORD', 'MYSQL_USER', 'MYSQL_DATABASE', 'ROOT_PASSWORD',
    // exact keys only: a longer name that merely contains one is not it
    'MARIADB_ROOT_PASSWORDS', 'XMARIADB_ROOT_PASSWORD', 'mariadb_root_password', 'POSTGRES_PASSWORD_FILES', '_FILE', 'FOO_FILE',
  ])('%s is the tenant\'s', (k) => expect(isPlatformOnlyConfigKey(k)).toBe(false));
});

describe('stripPlatformOnlyConfig / withoutPlatformOnlyConfig', () => {
  it('drops the administrator login and keeps everything else', () => {
    const c = { MARIADB_ROOT_PASSWORD: 'r', MARIADB_USER: 'app', MARIADB_PASSWORD: 'p', MARIADB_ROOT_HOST: 'localhost' };
    expect(stripPlatformOnlyConfig(c)).toEqual({ MARIADB_USER: 'app', MARIADB_PASSWORD: 'p' });
    expect(withoutPlatformOnlyConfig({ ...c, MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: 'yes' })).toEqual({ MARIADB_USER: 'app', MARIADB_PASSWORD: 'p' });
  });
});

describe('withStoredPlatformOnlyConfig — a configuration save', () => {
  const stored = { MARIADB_ROOT_PASSWORD: 'platform', MARIADB_ROOT_HOST: 'localhost', MARIADB_USER: 'app' };

  it('keeps the stored administrator login when the panel never sent it', () => {
    expect(withStoredPlatformOnlyConfig(stored, { MARIADB_USER: 'renamed' }))
      .toEqual({ MARIADB_USER: 'renamed', MARIADB_ROOT_PASSWORD: 'platform', MARIADB_ROOT_HOST: 'localhost' });
  });

  it('ignores an administrator login the save tries to set', () => {
    expect(withStoredPlatformOnlyConfig(stored, { MARIADB_USER: 'app', MARIADB_ROOT_PASSWORD: 'mine', MARIADB_ROOT_HOST: '%' }))
      .toEqual({ MARIADB_USER: 'app', MARIADB_ROOT_PASSWORD: 'platform', MARIADB_ROOT_HOST: 'localhost' });
  });

  it('cannot remove one by omitting it, nor add one that was never stored', () => {
    expect(withStoredPlatformOnlyConfig({ MARIADB_USER: 'app' }, { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' })).toEqual({});
  });
});

describe('stripPlatformOnlyConfigDeep — responses', () => {
  it('strips every configuration in a paginated envelope, and leaves other objects alone', () => {
    const payload = {
      data: [
        { id: 'a', configuration: { POSTGRES_PASSWORD: 'x', POSTGRES_DB: 'app' } },
        { id: 'b', configuration: '{"MYSQL_ROOT_PASSWORD":"y","MYSQL_DATABASE":"d"}' },
        { id: 'c', configuration: { PLAIN: '1' }, nested: { configuration: { MARIADB_ROOT_PASSWORD: 'z' } } },
      ],
      pagination: { total: 3 },
    };
    expect(stripPlatformOnlyConfigDeep(payload)).toEqual({
      data: [
        { id: 'a', configuration: { POSTGRES_DB: 'app' } },
        { id: 'b', configuration: '{"MYSQL_DATABASE":"d"}' },
        { id: 'c', configuration: { PLAIN: '1' }, nested: { configuration: {} } },
      ],
      pagination: { total: 3 },
    });
  });

  it('returns the payload itself when there is nothing to strip', () => {
    const payload = { data: { id: 'a', configuration: { A: '1' } }, when: new Date(0) };
    expect(stripPlatformOnlyConfigDeep(payload)).toBe(payload);
  });
});

describe('stripPlatformOnlyConfigDeep — type-aware', () => {
  const dbEntry = 'cat-db';
  const appEntry = 'cat-app';
  const applies = (o: Readonly<Record<string, unknown>>): boolean => o.catalogEntryId === dbEntry;

  it('strips a database instance\'s keys and leaves an app stack\'s own database login alone', () => {
    const payload = {
      data: [
        { id: 'a', catalogEntryId: dbEntry, configuration: { MARIADB_ROOT_PASSWORD: 'r', MARIADB_USER: 'u' } },
        { id: 'b', catalogEntryId: appEntry, configuration: { MARIADB_ROOT_PASSWORD: 'app-needs-it', WORDPRESS_DB_PASSWORD: 'p' } },
      ],
    };
    expect(stripPlatformOnlyConfigDeep(payload, applies)).toEqual({
      data: [
        { id: 'a', catalogEntryId: dbEntry, configuration: { MARIADB_USER: 'u' } },
        { id: 'b', catalogEntryId: appEntry, configuration: { MARIADB_ROOT_PASSWORD: 'app-needs-it', WORDPRESS_DB_PASSWORD: 'p' } },
      ],
    });
  });

  it('MINIO_ROOT_PASSWORD survives, whatever the owner is', () => {
    const payload = { catalogEntryId: dbEntry, configuration: { MINIO_ROOT_PASSWORD: 'tenants-own', POSTGRES_PASSWORD: 'x' } };
    expect(stripPlatformOnlyConfigDeep(payload, applies)).toEqual({ catalogEntryId: dbEntry, configuration: { MINIO_ROOT_PASSWORD: 'tenants-own' } });
    expect(stripPlatformOnlyConfigDeep(payload)).toEqual({ catalogEntryId: dbEntry, configuration: { MINIO_ROOT_PASSWORD: 'tenants-own' } });
  });

  it('decides per owner, not per payload: the snake_case id works too', () => {
    const owner = (o: Readonly<Record<string, unknown>>): boolean => o.catalog_entry_id === dbEntry;
    const payload = [
      { catalog_entry_id: dbEntry, configuration: '{"POSTGRES_PASSWORD":"x","POSTGRES_DB":"d"}' },
      { catalog_entry_id: appEntry, configuration: '{"POSTGRES_PASSWORD":"x"}' },
    ];
    expect(stripPlatformOnlyConfigDeep(payload, owner)).toEqual([
      { catalog_entry_id: dbEntry, configuration: '{"POSTGRES_DB":"d"}' },
      { catalog_entry_id: appEntry, configuration: '{"POSTGRES_PASSWORD":"x"}' },
    ]);
  });

  it('returns the very same payload when the owner is not a database instance', () => {
    const payload = { catalogEntryId: appEntry, configuration: { POSTGRES_PASSWORD: 'x' } };
    expect(stripPlatformOnlyConfigDeep(payload, applies)).toBe(payload);
  });

  it('JSON text that is not an object, or not JSON, is left alone', () => {
    const arr = { configuration: '["MARIADB_ROOT_PASSWORD"]' };
    const bad = { configuration: '{not json' };
    const nul = { configuration: null };
    expect(stripPlatformOnlyConfigDeep(arr)).toBe(arr);
    expect(stripPlatformOnlyConfigDeep(bad)).toBe(bad);
    expect(stripPlatformOnlyConfigDeep(nul)).toBe(nul);
  });

  it('JSON text with nothing to strip is returned as it was, not re-serialised', () => {
    const payload = { configuration: '{ "A":  "1" }' };
    expect(stripPlatformOnlyConfigDeep(payload)).toBe(payload);
  });

  it('does not touch the input', () => {
    const payload = { data: [{ configuration: { POSTGRES_PASSWORD: 'x', A: '1' } }] };
    const copy = JSON.parse(JSON.stringify(payload));
    stripPlatformOnlyConfigDeep(payload);
    expect(payload).toEqual(copy);
  });

  it.each([null, undefined, 'text', 3, true])('passes %j through', (v) => {
    expect(stripPlatformOnlyConfigDeep(v)).toBe(v);
  });

  it('passes Dates and Buffers through', () => {
    const d = new Date(0);
    const b = Buffer.from('x');
    expect(stripPlatformOnlyConfigDeep(d)).toBe(d);
    expect(stripPlatformOnlyConfigDeep(b)).toBe(b);
  });

  it('strips under a nested owner too', () => {
    const payload = { deployment: { catalogEntryId: dbEntry, configuration: { MONGO_INITDB_ROOT_PASSWORD: 'x', K: 'v' } }, other: [] };
    expect(stripPlatformOnlyConfigDeep(payload, applies)).toEqual({ deployment: { catalogEntryId: dbEntry, configuration: { K: 'v' } }, other: [] });
  });
});

describe('catalogEntryIdsIn', () => {
  it('collects the entry id of every object that carries a configuration', () => {
    const payload = {
      data: [
        { catalogEntryId: 'a', configuration: {} },
        { catalog_entry_id: 'b', configuration: '{}' },
        { catalogEntryId: 'c' },
        { configuration: {} },
        { nested: { catalogEntryId: 'd', configuration: { x: 1 } } },
      ],
      pagination: { total: 4 },
    };
    expect([...catalogEntryIdsIn(payload)].sort()).toEqual(['a', 'b', 'd']);
  });

  it('is empty for payloads with none, and for non-objects', () => {
    for (const p of [null, undefined, 'x', 1, [], {}, [{ a: 1 }], new Date(0), Buffer.from('x')]) expect(catalogEntryIdsIn(p).size).toBe(0);
  });

  it('ignores a non-string id', () => {
    expect(catalogEntryIdsIn({ catalogEntryId: 5, configuration: {} }).size).toBe(0);
  });
});
