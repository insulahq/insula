import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clusterScopedRefsCleanupHook } from './cluster-scoped-refs.js';
import type { HookCtx } from '../registry/index.js';

interface CallLog {
  listed: string[];
  deleted: Array<{ kind: string; ns?: string; name: string }>;
}

function makeCtx(opts: {
  crbs?: Array<{ name: string; subjects?: Array<{ namespace?: string }> }>;
  netpols?: Array<{ ns: string; name: string; matchNs?: string }>;
  deleteThrows?: Map<string, Error>;
}): { ctx: HookCtx; log: CallLog } {
  const log: CallLog = { listed: [], deleted: [] };
  const k8s = {
    custom: {
      listClusterCustomObject: vi.fn().mockImplementation(async (req: { plural: string }) => {
        log.listed.push(req.plural);
        if (req.plural === 'clusterrolebindings') {
          return { items: opts.crbs?.map((c) => ({ metadata: { name: c.name }, subjects: c.subjects ?? [] })) ?? [] };
        }
        if (req.plural === 'networkpolicies') {
          return {
            items: opts.netpols?.map((np) => ({
              metadata: { name: np.name, namespace: np.ns },
              spec: np.matchNs ? {
                ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': np.matchNs } } }] }],
              } : { ingress: [] },
            })) ?? [],
          };
        }
        return { items: [] };
      }),
      deleteClusterCustomObject: vi.fn().mockImplementation(async (req: { plural: string; name: string }) => {
        const key = `${req.plural}/${req.name}`;
        const err = opts.deleteThrows?.get(key);
        if (err) throw err;
        log.deleted.push({ kind: req.plural, name: req.name });
        return {};
      }),
      deleteNamespacedCustomObject: vi.fn().mockImplementation(async (req: { plural: string; namespace: string; name: string }) => {
        const key = `${req.plural}/${req.namespace}/${req.name}`;
        const err = opts.deleteThrows?.get(key);
        if (err) throw err;
        log.deleted.push({ kind: req.plural, ns: req.namespace, name: req.name });
        return {};
      }),
    },
  };
  return {
    ctx: {
      db: {} as never,
      k8s: k8s as never,
      tenantId: 'c1',
      namespace: 'tenant-acme',
      transitionId: 't1',
      transition: 'deleted',
      attempt: 1,
    },
    log,
  };
}

describe('cluster-scoped-refs-cleanup hook', () => {
  beforeEach(() => vi.clearAllMocks());

  it('noop on non-deleted transitions', async () => {
    const { ctx } = makeCtx({});
    const r = await clusterScopedRefsCleanupHook.run({ ...ctx, transition: 'suspended' });
    expect(r.status).toBe('noop');
  });

  it('noop on non-tenant namespaces', async () => {
    const { ctx } = makeCtx({});
    const r = await clusterScopedRefsCleanupHook.run({ ...ctx, namespace: 'kube-system' });
    expect(r.status).toBe('noop');
  });

  it('noop when nothing matches', async () => {
    const { ctx } = makeCtx({
      crbs: [{ name: 'unrelated-crb', subjects: [{ namespace: 'other-ns' }] }],
      netpols: [{ ns: 'app-ns', name: 'np-1', matchNs: 'other-ns' }],
    });
    const r = await clusterScopedRefsCleanupHook.run(ctx);
    expect(r.status).toBe('noop');
  });

  it('deletes CRBs whose subjects reference the namespace', async () => {
    const { ctx, log } = makeCtx({
      crbs: [
        { name: 'sftp-acme', subjects: [{ namespace: 'tenant-acme' }] },
        { name: 'unrelated', subjects: [{ namespace: 'kube-system' }] },
      ],
    });
    const r = await clusterScopedRefsCleanupHook.run(ctx);
    expect(r.status).toBe('ok');
    expect(log.deleted).toContainEqual({ kind: 'clusterrolebindings', name: 'sftp-acme' });
    expect(log.deleted).not.toContainEqual({ kind: 'clusterrolebindings', name: 'unrelated' });
  });

  it('deletes cross-ns NetworkPolicies referencing the namespace', async () => {
    const { ctx, log } = makeCtx({
      netpols: [
        { ns: 'app-shared', name: 'allow-acme', matchNs: 'tenant-acme' },
        { ns: 'tenant-acme', name: 'self-ref', matchNs: 'tenant-acme' }, // own ns — skipped
        { ns: 'other-app', name: 'unrelated', matchNs: 'other-tenant' },
      ],
    });
    const r = await clusterScopedRefsCleanupHook.run(ctx);
    expect(r.status).toBe('ok');
    expect(log.deleted).toContainEqual({ kind: 'networkpolicies', ns: 'app-shared', name: 'allow-acme' });
    expect(log.deleted.find((d) => d.name === 'self-ref')).toBeUndefined();
    expect(log.deleted.find((d) => d.name === 'unrelated')).toBeUndefined();
  });

  it('returns retry envelope when one delete throws', async () => {
    const throws = new Map<string, Error>();
    throws.set('clusterrolebindings/sftp-acme', new Error('FORBIDDEN'));
    const { ctx } = makeCtx({
      crbs: [{ name: 'sftp-acme', subjects: [{ namespace: 'tenant-acme' }] }],
      deleteThrows: throws,
    });
    const r = await clusterScopedRefsCleanupHook.run(ctx);
    expect(r.status).toBe('retry');
    expect(r.envelope?.raw).toContain('FORBIDDEN');
  });

  it('returns retry envelope when LIST clusterrolebindings hits 403 (RBAC)', async () => {
    // Inject a 403 by overriding the mock at construction. We bypass
    // makeCtx's happy-path mock by giving a custom k8s shim.
    const ctx = {
      db: {} as never,
      k8s: {
        custom: {
          listClusterCustomObject: vi.fn().mockImplementation(async () => {
            throw Object.assign(new Error('forbidden'), { statusCode: 403 });
          }),
          deleteClusterCustomObject: vi.fn(),
          deleteNamespacedCustomObject: vi.fn(),
        },
      } as never,
      tenantId: 'c1',
      namespace: 'tenant-acme',
      transitionId: 't1',
      transition: 'deleted' as const,
      attempt: 1,
    };
    const r = await clusterScopedRefsCleanupHook.run(ctx);
    expect(r.status).toBe('retry');
    expect(r.envelope?.title).toContain('Cluster-scoped refs cleanup blocked');
    expect(r.envelope?.remediation?.[0]).toContain('Grant');
  });

  it('treats 404 on delete as success (idempotent)', async () => {
    const throws = new Map<string, Error>();
    throws.set('clusterrolebindings/gone-crb', Object.assign(new Error('not found'), { statusCode: 404 }));
    const { ctx } = makeCtx({
      crbs: [{ name: 'gone-crb', subjects: [{ namespace: 'tenant-acme' }] }],
      deleteThrows: throws,
    });
    const r = await clusterScopedRefsCleanupHook.run(ctx);
    // Found 1, 1 hit 404 → not counted as failure but also not as deleted
    expect(r.status).toBe('noop');
  });
});
