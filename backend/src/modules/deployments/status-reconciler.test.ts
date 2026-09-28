import { describe, it, expect } from 'vitest';
import { reconcileDeploymentStatuses } from './status-reconciler.js';

/**
 * The reconciler's SELECT is the whole of this bug, so these assert the query
 * it actually builds rather than restating the rule in a second place.
 *
 * `stopped` used to be absent from that query, which made the status a
 * one-way door: a row marked stopped was never examined again, so a
 * deployment whose pods came back stayed "stopped" for good. Seen on a test
 * cluster with replicas=1 and readyReplicas=1 against a stopped row — and
 * everything that asks "what is live?" by filtering `status = 'running'`
 * skipped that workload while it burned real CPU and memory.
 */

/**
 * Drizzle's SQL object is circular (a Column points back at its Table), so it
 * cannot be JSON.stringify'd. Walk only the parts that carry meaning —
 * literal chunks, bound params and column names.
 */
function terms(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (node instanceof Date) { out.push('<date>'); return out; }
  if (Array.isArray(node)) { for (const n of node) terms(n, out); return out; }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.name === 'string') out.push(o.name);
    if (typeof o.value === 'string') out.push(o.value);
    if (o.value instanceof Date) out.push('<date>');
    if (Array.isArray(o.value)) terms(o.value, out);
    if (Array.isArray(o.queryChunks)) terms(o.queryChunks, out);
  }
  return out;
}

function captureWhere() {
  let captured: unknown = null;
  const db = {
    select: () => ({
      from: () => ({
        where: (w: unknown) => { captured = w; return Promise.resolve([]); },
      }),
    }),
  } as never;
  return { db, terms: () => terms(captured) };
}

const k8s = {} as never;

describe('reconcileDeploymentStatuses — which rows it reconsiders', () => {
  it('still reconsiders every active status', async () => {
    const { db, terms: t } = captureWhere();
    await reconcileDeploymentStatuses(db, k8s);
    for (const status of ['running', 'pending', 'deploying', 'failed']) {
      expect(t()).toContain(status);
    }
  });

  /**
   * ★ The fix. Without `stopped` in the query the divergence is permanent and
   * silent — nothing ever looks again.
   */
  it('reconsiders stopped rows too', async () => {
    const { db, terms: t } = captureWhere();
    await reconcileDeploymentStatuses(db, k8s);
    expect(t()).toContain('stopped');
  });

  /**
   * ★ …but only stale ones. updateDeployment writes status='stopped' BEFORE
   * it scales the workload to zero, so in the moment between the two the pods
   * are still Ready — a reconciler reading that would flip the row back to
   * running and undo a stop in progress. The query therefore carries a bound
   * on updated_at; without it this fix would trade a permanent divergence for
   * an intermittent one.
   */
  it('bounds stopped rows by age, so a stop in progress is never undone', async () => {
    const { db, terms: t } = captureWhere();
    await reconcileDeploymentStatuses(db, k8s);
    expect(t()).toContain('updated_at');
    expect(t()).toContain('<date>');
  });

  it('returns an empty result rather than throwing when nothing matches', async () => {
    const { db } = captureWhere();
    await expect(reconcileDeploymentStatuses(db, k8s)).resolves.toEqual({
      checked: 0, updated: 0, errors: [],
    });
  });
});
