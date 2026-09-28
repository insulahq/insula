/**
 * The dry run has to say when a saved tier has NOT been applied.
 *
 * ★ This file exists because that half shipped broken and nothing caught it.
 *
 * `buildCpuMigrationPreview` had no test at all, so a reader that returned
 * an empty map — no error, no items — reached a live cluster. Every
 * "applied" figure came back null, `pendingCpuChange` was therefore always
 * false, and the panel silently lost the one thing the field is for. The
 * cluster run found it; a test at this layer would have found it first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

vi.mock('../dashboard/cpu-reservation.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readCpuReservation: vi.fn(async () => ({
    nodes: [{ allocatableMillis: 8000, requestedMillis: 2000, usedMillis: 500 }],
  })),
}));

const TENANT = {
  id: 't1',
  name: 'Example',
  kubernetes_namespace: 'tenant-example',
  plan_code: 'starter',
  cpu_scheduling_mode: 'tiered',
  cpu_limit: '0.25',
  cpu_limit_override: null,
  cpu_tier: null,
  cpu_tier_override: null,
  cpu_burst_cores: null,
  cpu_burst_cores_override: null,
};

/**
 * The four `db.execute` calls the preview makes, in order: tenants, running
 * tasks, deployments, p95. Keyed by order rather than by SQL text because
 * the SQL is a template object, not a string.
 */
function dbWith(tenant: Record<string, unknown>): Database {
  let call = 0;
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: 'repo1' }]) }) }),
    execute: () => {
      call += 1;
      if (call === 1) return Promise.resolve({ rows: [tenant] });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Database;
}

/** A cluster whose namespace enforces `ceiling` cores at `request` millicores. */
function k8sWith(limitRange: { ceiling: string; request: string } | null): K8sClients {
  return {
    core: {
      readNamespacedLimitRange: vi.fn(async () => {
        if (!limitRange) throw Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 });
        /**
         * ★ `_default`, exactly as the Kubernetes client hands it back.
         *
         * `default` is a reserved word, so the generated model renames it
         * on deserialisation — the object we write and the object we read
         * back have different shapes. A fixture spelling it `default`
         * would have passed while the real code read undefined and
         * reported every applied ceiling as null, which is what shipped.
         */
        return {
          spec: {
            limits: [{
              type: 'Container',
              _default: { cpu: limitRange.ceiling },
              defaultRequest: { cpu: limitRange.request },
            }],
          },
        };
      }),
    },
  } as unknown as K8sClients;
}

async function preview(tenant: Record<string, unknown>, lr: { ceiling: string; request: string } | null) {
  const { buildCpuMigrationPreview } = await import('./preview.js');
  const out = await buildCpuMigrationPreview(dbWith(tenant), k8sWith(lr));
  return out.tenants[0];
}

describe('buildCpuMigrationPreview — saved versus applied', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads what the namespace actually enforces', async () => {
    const t = await preview(TENANT, { ceiling: '1', request: '30m' });
    expect(t.appliedCeilingCores).toBe(1);
    expect(t.appliedTier).toBe('high');
  });

  it('reports NO pending change when the cluster matches the database', async () => {
    // No override and no plan tier: the tenant resolves to the default
    // tier `high` and a ceiling derived from cpu_limit as max(1, 0.25x2).
    const t = await preview(TENANT, { ceiling: '1', request: '30m' });
    expect(t.proposedTier).toBe('high');
    expect(t.proposedCeilingCores).toBe(1);
    expect(t.pendingCpuChange).toBe(false);
  });

  it('reports a pending change when the TIER was edited', async () => {
    const t = await preview({ ...TENANT, cpu_tier_override: 'highest' }, { ceiling: '1', request: '30m' });
    expect(t.proposedTier).toBe('highest');
    expect(t.pendingCpuChange).toBe(true);
  });

  it('reports a pending change when the CEILING was edited', async () => {
    const t = await preview({ ...TENANT, cpu_burst_cores_override: '2' }, { ceiling: '1', request: '30m' });
    expect(t.proposedCeilingCores).toBe(2);
    expect(t.pendingCpuChange).toBe(true);
  });

  /**
   * ★ The ceiling comes from the same resolver the runner uses.
   *
   * It used to be `ceilingCores(cpu_limit)` here, ignoring
   * `cpu_burst_cores` entirely — so an operator who configured a ceiling on
   * the plan saw the derived number in the dry run and got the configured
   * one when they applied it.
   */
  it('honours a ceiling configured on the PLAN, not just the derived one', async () => {
    const t = await preview({ ...TENANT, cpu_burst_cores: '3' }, { ceiling: '3', request: '30m' });
    expect(t.proposedCeilingCores).toBe(3);
    expect(t.pendingCpuChange).toBe(false);
  });

  it('says nothing is applied for a namespace with no LimitRange', async () => {
    const t = await preview(TENANT, null);
    expect(t.appliedCeilingCores).toBeNull();
    expect(t.appliedTier).toBeNull();
    // Not "pending": there is nothing to compare against, and claiming a
    // pending change would send an operator to press a button for no reason.
    expect(t.pendingCpuChange).toBe(false);
  });

  it('never reports a pending change for a LEGACY tenant', async () => {
    // A legacy tenant is not "pending", it is un-migrated — a different
    // thing, with a different button.
    const t = await preview({ ...TENANT, cpu_scheduling_mode: 'legacy' }, null);
    expect(t.schedulingMode).toBe('legacy');
    expect(t.pendingCpuChange).toBe(false);
  });
});
