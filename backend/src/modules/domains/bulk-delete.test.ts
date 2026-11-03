import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A bulk delete is a single delete per domain. It deleted the domains row and
 * reconciled the Ingress, and skipped everything else deleteDomain does: the
 * cert-manager Certificate and Secret, the webmail Ingress, the Stalwart
 * domain and DKIM, and the DNS zone.
 */
const deleteDomain = vi.fn();
vi.mock('./service.js', () => ({
  deleteDomain: (...a: unknown[]) => deleteDomain(...a),
  setDomainVerificationStatus: vi.fn(),
}));
vi.mock('./verification.js', () => ({ verifyDomain: vi.fn(), getPlatformConfig: vi.fn() }));

const { bulkDeleteDomains } = await import('./bulk.js');

/** Answers each domain lookup in turn: the row, or nothing for an unknown id. */
const dbWith = (lookups: Array<{ id: string; tenantId: string } | null>) => {
  const queue = [...lookups];
  return {
    select: () => ({ from: () => ({ where: async () => { const r = queue.shift(); return r ? [r] : []; } }) }),
  } as unknown as Parameters<typeof bulkDeleteDomains>[0];
};

beforeEach(() => { deleteDomain.mockReset(); deleteDomain.mockResolvedValue({ deleted: {} }); });

describe('bulkDeleteDomains', () => {
  it('deletes each domain through deleteDomain, under its own tenant', async () => {
    const k8s = {} as never;
    const db = dbWith([{ id: 'd-1', tenantId: 't-1' }, { id: 'd-2', tenantId: 't-2' }]);
    const r = await bulkDeleteDomains(db, ['d-1', 'd-2'], k8s);
    expect(r).toEqual({ succeeded: ['d-1', 'd-2'], failed: [] });
    expect(deleteDomain).toHaveBeenNthCalledWith(1, db, 't-1', 'd-1', k8s);
    expect(deleteDomain).toHaveBeenNthCalledWith(2, db, 't-2', 'd-2', k8s);
  });

  it('reports an unknown domain and a failed delete per id, and carries on', async () => {
    deleteDomain.mockRejectedValueOnce(new Error('DNS provider down'));
    const db = dbWith([{ id: 'd-1', tenantId: 't-1' }, null, { id: 'd-3', tenantId: 't-1' }]);
    const r = await bulkDeleteDomains(db, ['d-1', 'd-2', 'd-3']);
    expect(r.succeeded).toEqual(['d-3']);
    expect(r.failed).toEqual([
      { id: 'd-1', error: 'DNS provider down' },
      { id: 'd-2', error: "Domain 'd-2' not found" },
    ]);
  });
});
