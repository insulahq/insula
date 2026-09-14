/**
 * `POST /admin/dr/tenants/recover-all` — the encryption-key gate (ROADMAP R25 §4).
 *
 * The behaviour under test is a REFUSAL, so the assertion that matters is not
 * the status code but the absence of work: on a mismatch, not one per-tenant
 * recover may be injected. Each of those provisions a namespace, PVC and quota
 * BEFORE it reaches anything needing a cleartext secret, so a gate that returns
 * 409 while still having started the fleet would be worse than no gate at all.
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { drRecoverRoutes } from './routes.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { encrypt } from '../oidc/crypto.js';
import {
  tenants, backupJobs, backupComponents, backupConfigurations,
  deployments, customDeploymentImageCredentials,
} from '../../db/schema.js';

const JWT_SECRET = 'test-jwt-secret-for-dr-recover-encryption-gate';
const KEY_LOCAL = 'a'.repeat(64); // this cluster's key
const KEY_SOURCE = 'b'.repeat(64); // the cluster the platform DB came from

type Row = Record<string, unknown>;

interface DbOpts {
  /** Key the backup target's stored credentials were encrypted with. */
  readonly targetKey?: string;
  /** Key the registry pull credential was encrypted with. */
  readonly patKey?: string;
  /** Omit both to model a fresh cluster with nothing to probe. */
  readonly noCredentials?: boolean;
}

/**
 * Drizzle-shaped mock routed by the TABLE each query selects from.
 *
 * Routing by requested columns (as recover-all-targets.test.ts does) is not
 * enough here: both the tenant lookup and the backup-target lookup are a bare
 * `select()` with no column list, so a column-shaped router hands the tenant
 * lookup a backup_configurations row and the recover dies two steps later with
 * an unrelated error. Table identity is unambiguous.
 */
function makeDb(opts: DbOpts) {
  const rowsFor = (table: unknown, cols: Record<string, unknown> | undefined): Row[] => {
    const keys = Object.keys(cols ?? {});
    if (table === tenants) {
      // The resolver asks for {name, ns}; the single-tenant recover asks for
      // the whole row.
      return keys.length > 0
        ? [{ name: 'Acme', ns: 'tenant-t-1' }]
        : [{ id: 't-1', name: 'Acme', status: 'active', kubernetesNamespace: 'tenant-t-1', provisioningStatus: 'provisioned' }];
    }
    if (table === backupComponents) {
      return [{ component: 'config', status: 'completed' }, { component: 'files', status: 'completed' }];
    }
    if (table === backupJobs) {
      if (keys.length === 1 && keys.includes('targetConfigId')) {
        return opts.noCredentials ? [] : [{ targetConfigId: 'cfg-1' }];
      }
      if (keys.includes('status') && !keys.includes('id')) {
        return [{ status: 'completed', createdAt: new Date('2026-09-01T00:00:00Z') }];
      }
      return [{
        id: 'bundle-9', tenantId: 't-1', status: 'completed',
        createdAt: new Date('2026-09-01T00:00:00Z'), finishedAt: null,
      }];
    }
    if (table === backupConfigurations) {
      if (!opts.targetKey) return [];
      return [{
        id: 'cfg-1',
        name: 'offsite',
        storageType: 's3',
        s3AccessKeyEncrypted: encrypt('AKIA-example', opts.targetKey),
        s3SecretKeyEncrypted: encrypt('s3-secret', opts.targetKey),
        sshKeyEncrypted: null,
        sshPasswordEncrypted: null,
        cifsPasswordEncrypted: null,
      }];
    }
    if (table === deployments) return opts.patKey ? [{ id: 'dep-1', name: 'shop' }] : [];
    if (table === customDeploymentImageCredentials) {
      return opts.patKey
        ? [{ deploymentId: 'dep-1', tokenCipher: encrypt('ghp_example', opts.patKey) }]
        : [];
    }
    return [];
  };

  const builder = (cols?: Record<string, unknown>) => {
    let table: unknown = null;
    const b: Record<string, unknown> = {
      from: (t: unknown) => { table = t; return b; },
    };
    for (const k of ['where', 'orderBy', 'limit', 'innerJoin']) b[k] = () => b;
    b.then = (resolve: (r: Row[]) => void) => resolve(rowsFor(table, cols));
    return b;
  };

  return {
    selectDistinct: () => builder({ tenantId: 1 }),
    select: (cols?: Record<string, unknown>) => builder(cols),
  };
}

async function setupApp(dbOpts: DbOpts) {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  app.decorate('db', makeDb(dbOpts) as unknown);
  app.decorate('config', {
    KUBECONFIG_PATH: undefined,
    PLATFORM_ENCRYPTION_KEY: KEY_LOCAL,
  });

  // The per-tenant recover is a REAL route here (the batch handler injects into
  // it), so it cannot be stubbed. What is stubbed is the expensive work it
  // drives — provisioning and the restore cart. `provisioned` staying empty is
  // the claim under test: the refusal landed before any namespace existed.
  const provisioned: string[] = [];
  await app.register(drRecoverRoutes, { prefix: '/api/v1' });
  await app.register(async (a) => {
    a.post('/admin/tenants/:tenantId/provision', async (req, reply) => {
      provisioned.push((req.params as { tenantId: string }).tenantId);
      reply.status(202).send({ data: { taskId: 'task-1', status: 'pending' } });
    });
    a.get('/admin/tenants/:tenantId/provision/status', async (_req, reply) => {
      reply.status(200).send({ data: { status: 'completed' } });
    });
    a.post('/admin/restores/carts', async (_req, reply) => {
      reply.status(201).send({ data: { id: 'rstr-cart-1', tenantId: 't-1', status: 'draft' } });
    });
    a.post('/admin/restores/carts/:id/items', async (_req, reply) => {
      reply.status(201).send({ data: { id: 'item-x' } });
    });
    a.post('/admin/restores/carts/:id/execute', async (_req, reply) => {
      reply.status(200).send({ data: { id: 'rstr-cart-1', status: 'done', items: [] } });
    });
  }, { prefix: '/api/v1' });
  await app.ready();

  const adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin' });
  const post = (payload: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/v1/admin/dr/tenants/recover-all',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
  return { app, provisioned, post };
}

describe('recover-all encryption-key gate', () => {
  describe('this cluster holds the key its credentials were encrypted with', () => {
    it('reports ok on a preview and lets the run proceed', async () => {
      const { provisioned, post } = await setupApp({ targetKey: KEY_LOCAL, patKey: KEY_LOCAL });

      const preview = await post({ dryRun: true, scope: 'all' });
      expect(preview.statusCode).toBe(200);
      expect(JSON.parse(preview.body).data.encryptionKey.verdict).toBe('ok');

      const run = await post({ scope: 'all' });
      expect(run.statusCode).toBe(202);
      expect(provisioned).toEqual(['t-1']);
    });
  });

  describe('the platform DB was restored from a cluster whose key this one lacks', () => {
    it('previews as a mismatch WITHOUT refusing — the preview exists to show it', async () => {
      const { provisioned, post } = await setupApp({ targetKey: KEY_SOURCE, patKey: KEY_SOURCE });
      const res = await post({ dryRun: true, scope: 'all' });

      expect(res.statusCode).toBe(200);
      const pf = JSON.parse(res.body).data.encryptionKey;
      expect(pf.verdict).toBe('mismatch');
      expect(pf.failed).toBeGreaterThan(0);
      expect(pf.remedy).toContain('secrets-restore');
      expect(provisioned).toHaveLength(0);
    });

    it('refuses the real run with 409 and provisions NOTHING', async () => {
      const { provisioned, post } = await setupApp({ targetKey: KEY_SOURCE, patKey: KEY_SOURCE });
      const res = await post({ scope: 'all' });

      expect(res.statusCode).toBe(409);
      const err = JSON.parse(res.body).error;
      expect(err.code).toBe('DR_ENCRYPTION_KEY_MISMATCH');
      // The whole point: not one tenant was touched.
      expect(provisioned).toHaveLength(0);
    });

    it('carries the remedy, not just the diagnosis', async () => {
      const { post } = await setupApp({ targetKey: KEY_SOURCE });
      const res = await post({ scope: 'all' });
      const err = JSON.parse(res.body).error;
      // The operator needs to know that the fix is to re-bootstrap with the
      // source cluster's key, not to retry.
      expect(JSON.stringify(err)).toContain('secrets-restore');
    });

    it('proceeds when the operator explicitly overrides', async () => {
      const { provisioned, post } = await setupApp({ targetKey: KEY_SOURCE, patKey: KEY_SOURCE });
      const res = await post({ scope: 'all', allowEncryptionKeyMismatch: true });

      expect(res.statusCode).toBe(202);
      expect(provisioned).toEqual(['t-1']);
      // The override runs the recover; it does not rewrite the finding.
      expect(JSON.parse(res.body).data.encryptionKey.verdict).toBe('mismatch');
    });
  });

  describe('nothing to probe', () => {
    it('is unverified, not ok — and does not block', async () => {
      // A cluster with no stored credentials has produced no evidence. Blocking
      // would make a legitimate fresh-cluster migration impossible; reporting
      // `ok` would claim a check that never ran.
      const { provisioned, post } = await setupApp({ noCredentials: true });

      const preview = await post({ dryRun: true, scope: 'all' });
      expect(JSON.parse(preview.body).data.encryptionKey.verdict).toBe('unverified');

      const run = await post({ scope: 'all' });
      expect(run.statusCode).toBe(202);
      expect(provisioned).toEqual(['t-1']);
    });
  });

  it('reports the verdict on a real run too, not only on the preview', async () => {
    // A run started from a stale preview must still carry the finding — the
    // response an operator reads afterwards is the run's, not the preview's.
    const { post } = await setupApp({ targetKey: KEY_LOCAL });
    const res = await post({ scope: 'all' });
    expect(JSON.parse(res.body).data.encryptionKey).toBeDefined();
    expect(JSON.parse(res.body).data.encryptionKey.verdict).toBe('ok');
  });
});
