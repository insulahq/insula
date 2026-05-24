import { describe, it, expect, vi } from 'vitest';
import { createBackupNow, CnpgBackupNowError } from './service.js';
import type * as k8s from '@kubernetes/client-node';

const clusterWithBarman = {
  metadata: { name: 'system-db', namespace: 'platform' },
  spec: {
    instances: 3,
    plugins: [
      { name: 'barman-cloud.cloudnative-pg.io', enabled: true, parameters: {} },
    ],
  },
};

const clusterWithoutBarman = {
  metadata: { name: 'system-db', namespace: 'platform' },
  spec: {
    instances: 1,
    plugins: [],
  },
};

interface MockOpts {
  readonly clusterCR?: unknown;
  readonly clusterNotFound?: boolean;
  readonly createFails?: { code: number; message: string };
}

function makeCustom(opts: MockOpts = {}): {
  readonly api: k8s.CustomObjectsApi;
  readonly created: Array<{ name?: string; labels?: Record<string, string>; annotations?: Record<string, string>; spec?: unknown }>;
} {
  const created: Array<{ name?: string; labels?: Record<string, string>; annotations?: Record<string, string>; spec?: unknown }> = [];
  const api = {
    getNamespacedCustomObject: vi.fn().mockImplementation(async () => {
      if (opts.clusterNotFound) {
        const e = new Error('not found'); (e as Error & { code?: number }).code = 404; throw e;
      }
      return opts.clusterCR ?? clusterWithBarman;
    }),
    createNamespacedCustomObject: vi.fn().mockImplementation(async (args: {
      body: { metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: unknown };
    }) => {
      if (opts.createFails) {
        const e = new Error(opts.createFails.message);
        (e as Error & { code?: number }).code = opts.createFails.code;
        throw e;
      }
      created.push({
        name: args.body.metadata?.name,
        labels: args.body.metadata?.labels,
        annotations: args.body.metadata?.annotations,
        spec: args.body.spec,
      });
      return {};
    }),
  } as unknown as k8s.CustomObjectsApi;
  return { api, created };
}

describe('createBackupNow', () => {
  it('creates a Backup CR with on-demand label + barman-cloud plugin method', async () => {
    const { api, created } = makeCustom();
    const result = await createBackupNow(api, {
      namespace: 'platform', clusterName: 'system-db',
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.name).toMatch(/^on-demand-\d{13}$/);
    expect(created[0]?.labels?.['platform.phoenix-host.net/on-demand']).toBe('true');
    expect(created[0]?.spec).toEqual({
      cluster: { name: 'system-db' },
      method: 'plugin',
      pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
    });
    expect(result.backupName).toBe(created[0]?.name);
    expect(result.namespace).toBe('platform');
    expect(result.clusterName).toBe('system-db');
    expect(result.createdAt).toMatch(/^\d{4}-/);
  });

  it('rejects an unknown cluster with 404', async () => {
    const { api } = makeCustom({ clusterNotFound: true });
    await expect(
      createBackupNow(api, { namespace: 'platform', clusterName: 'system-db' })
    ).rejects.toMatchObject({
      name: 'CnpgBackupNowError',
      statusCode: 404,
      message: expect.stringContaining('not found'),
    });
  });

  it('rejects clusters without the barman-cloud plugin with 409', async () => {
    const { api } = makeCustom({ clusterCR: clusterWithoutBarman });
    await expect(
      createBackupNow(api, { namespace: 'platform', clusterName: 'system-db' })
    ).rejects.toMatchObject({
      name: 'CnpgBackupNowError',
      statusCode: 409,
      message: expect.stringContaining('no enabled barman-cloud plugin'),
    });
  });

  it('rejects clusters where the barman plugin is present but disabled', async () => {
    const { api } = makeCustom({
      clusterCR: {
        ...clusterWithBarman,
        spec: {
          ...clusterWithBarman.spec,
          plugins: [{ name: 'barman-cloud.cloudnative-pg.io', enabled: false }],
        },
      },
    });
    await expect(
      createBackupNow(api, { namespace: 'platform', clusterName: 'system-db' })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('no enabled barman-cloud plugin'),
    });
  });

  it('rejects invalid namespace + clusterName (DNS-label)', async () => {
    const { api } = makeCustom();
    await expect(
      createBackupNow(api, { namespace: '_BAD_', clusterName: 'system-db' })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createBackupNow(api, { namespace: 'platform', clusterName: 'UPPER' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('surfaces a 403 from k8s as RBAC misconfiguration with 500', async () => {
    const { api } = makeCustom({ createFails: { code: 403, message: 'forbidden' } });
    await expect(
      createBackupNow(api, { namespace: 'platform', clusterName: 'system-db' })
    ).rejects.toMatchObject({
      name: 'CnpgBackupNowError',
      statusCode: 500,
      message: expect.stringContaining('RBAC missing create on backups'),
    });
  });

  it('surfaces a 409 from k8s as conflict', async () => {
    const { api } = makeCustom({ createFails: { code: 409, message: 'exists' } });
    await expect(
      createBackupNow(api, { namespace: 'platform', clusterName: 'system-db' })
    ).rejects.toMatchObject({
      name: 'CnpgBackupNowError',
      statusCode: 409,
    });
  });

  it('uses the input clusterName (not the source-cluster constant) in the spec', async () => {
    const { api, created } = makeCustom();
    await createBackupNow(api, { namespace: 'mail', clusterName: 'mail-db' });
    const spec = created[0]?.spec as { cluster?: { name?: string } };
    expect(spec.cluster?.name).toBe('mail-db');
  });

  // Phase 7b/c (2026-05-24): operator description plumbed through as
  // ANNOTATION (not label — annotations have no charset restrictions
  // so natural-language descriptions like "pre-upgrade: tenant import"
  // are accepted).
  it('attaches the operator description as a Backup CR annotation', async () => {
    const { api, created } = makeCustom();
    await createBackupNow(api, {
      namespace: 'platform', clusterName: 'system-db',
      description: 'pre-upgrade: tenant import',
    });
    expect(created[0]?.annotations?.['platform.phoenix-host.net/description']).toBe('pre-upgrade: tenant import');
    // Must NOT also write the label (it would fail k8s label-value
    // validation for descriptions with spaces or colons).
    expect(created[0]?.labels).not.toHaveProperty('platform.phoenix-host.net/description');
    // The on-demand label still rides along.
    expect(created[0]?.labels?.['platform.phoenix-host.net/on-demand']).toBe('true');
  });

  it('omits the description annotation when no description supplied', async () => {
    const { api, created } = makeCustom();
    await createBackupNow(api, {
      namespace: 'platform', clusterName: 'system-db',
    });
    // No annotations block at all when there's nothing to write.
    expect(created[0]?.annotations).toBeUndefined();
    expect(created[0]?.labels?.['platform.phoenix-host.net/on-demand']).toBe('true');
  });

  it('accepts a barman plugin whose name does not match the exact constant but is a barman variant', async () => {
    const { api, created } = makeCustom({
      clusterCR: {
        ...clusterWithBarman,
        spec: {
          ...clusterWithBarman.spec,
          plugins: [{ name: 'barman-cloud.example.io', enabled: true }],
        },
      },
    });
    await createBackupNow(api, { namespace: 'platform', clusterName: 'system-db' });
    expect(created).toHaveLength(1);
  });
});

describe('CnpgBackupNowError', () => {
  it('carries name + statusCode', () => {
    const e = new CnpgBackupNowError('msg', 422);
    expect(e.name).toBe('CnpgBackupNowError');
    expect(e.statusCode).toBe(422);
    expect(e.message).toBe('msg');
  });
});

// Schema-vs-service alignment: anything the contract accepts must also be
// accepted by the service. Caught by typescript-reviewer 2026-05-24 —
// the contract regex previously had the `i` flag while the service
// regex did not, so 'UPPER' passed validation in the route handler
// then 400'd inside the service. Lock that in here.
describe('contract / service name alignment', () => {
  it('contract rejects uppercase identifiers (matches service guard)', async () => {
    const { cnpgBackupNowRequestSchema } = await import('@k8s-hosting/api-contracts');
    const result = cnpgBackupNowRequestSchema.safeParse({
      namespace: 'platform', clusterName: 'UPPER',
    });
    expect(result.success).toBe(false);
  });
  it('contract rejects > 50 char identifiers (matches service guard)', async () => {
    const { cnpgBackupNowRequestSchema } = await import('@k8s-hosting/api-contracts');
    const result = cnpgBackupNowRequestSchema.safeParse({
      namespace: 'platform', clusterName: 'a'.repeat(51),
    });
    expect(result.success).toBe(false);
  });
});
