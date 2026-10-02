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
   * ★ …ALL of them, fresh ones included. The query used to bound stopped rows
   * by updated_at to protect a stop in progress (updateDeployment writes
   * status='stopped' BEFORE it scales to zero). But SQL cannot see the pods, so
   * the bound also hid a row that was simply WRONG — a snapshot restore's
   * quiesce recorded as a stop — for the full ten minutes while its restored
   * pods served. The protection now lives in stoppedRowMayChange, which can
   * tell the two apart; status-reconciler-storage-op.test.ts pins it.
   */
  it('fetches stopped rows of any age — the stop-in-progress gate is per row, not in SQL', async () => {
    const { db, terms: t } = captureWhere();
    await reconcileDeploymentStatuses(db, k8s);
    expect(t()).toContain('stopped');
    expect(t()).not.toContain('updated_at');
  });

  it('returns an empty result rather than throwing when nothing matches', async () => {
    const { db } = captureWhere();
    await expect(reconcileDeploymentStatuses(db, k8s)).resolves.toEqual({
      checked: 0, updated: 0, errors: [],
    });
  });
});
