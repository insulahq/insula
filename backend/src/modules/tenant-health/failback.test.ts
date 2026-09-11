import { describe, it, expect } from 'vitest';
import {
  selectFailbackReviewItems,
  returnedNodesFrom,
  movedFromNode,
  FAILBACK_ACK_ACTION,
  type PlacementAuditRow,
  type FailbackTenantFact,
} from './failback.js';

const at = (iso: string) => new Date(iso);

const autoRow = (tenantId: string, from: string, iso: string): PlacementAuditRow => ({
  tenantId, actionType: 'tenant.auto_repin', createdAt: at(iso), changes: { strandedOn: from },
});
const manualRow = (tenantId: string, from: string, to: string | null, iso: string): PlacementAuditRow => ({
  tenantId, actionType: 'tenant.repin', createdAt: at(iso), changes: { from, to },
});
const ackRow = (tenantId: string, iso: string): PlacementAuditRow => ({
  tenantId, actionType: FAILBACK_ACK_ACTION, createdAt: at(iso), changes: { reason: 'fine as is' },
});

const tenant = (
  tenantId: string, tenantName: string, storageTier: string, currentNode: string | null,
): FailbackTenantFact => ({ tenantId, tenantName, storageTier, currentNode });

describe('movedFromNode', () => {
  it('reads strandedOn for an automatic unpin and from for a manual one', () => {
    expect(movedFromNode(autoRow('t1', 'n2', '2026-09-11T20:30:00Z'))).toBe('n2');
    // 'from' is the source, NOT 'to' — a manual repin records both.
    expect(movedFromNode(manualRow('t1', 'n2', 'n3', '2026-09-11T20:30:00Z'))).toBe('n2');
  });

  it('returns null rather than guessing when the payload has no source node', () => {
    expect(movedFromNode({
      tenantId: 't1', actionType: 'tenant.repin', createdAt: at('2026-09-11T20:30:00Z'), changes: {},
    })).toBeNull();
    expect(movedFromNode({
      tenantId: 't1', actionType: 'tenant.repin', createdAt: at('2026-09-11T20:30:00Z'), changes: null,
    })).toBeNull();
    // An empty string is a real value in these payloads ('' = cleared pin) and
    // must not be mistaken for a source node.
    expect(movedFromNode({
      tenantId: 't1', actionType: 'tenant.repin', createdAt: at('2026-09-11T20:30:00Z'), changes: { from: '' },
    })).toBeNull();
  });
});

describe('selectFailbackReviewItems', () => {
  it('says nothing while the node is still down — that is the outage banner\'s job', () => {
    const items = selectFailbackReviewItems({
      rows: [autoRow('t1', 'n2', '2026-09-11T20:30:00Z')],
      tenants: [tenant('t1', 'acme', 'ha', null)],
      readyNodes: new Set(['n1', 'n3']),
    });
    expect(items).toEqual([]);
  });

  it('raises the item once that node is Ready again', () => {
    const items = selectFailbackReviewItems({
      rows: [autoRow('t1', 'n2', '2026-09-11T20:30:00Z')],
      tenants: [tenant('t1', 'acme', 'ha', null)],
      readyNodes: new Set(['n1', 'n2', 'n3']),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      tenantId: 't1', movedFromNode: 'n2', movedBy: 'auto', currentNode: null,
    });
  });

  it('recommends KEEPING the placement for an unpinned HA tenant', () => {
    const [item] = selectFailbackReviewItems({
      rows: [autoRow('t1', 'n2', '2026-09-11T20:30:00Z')],
      tenants: [tenant('t1', 'acme', 'ha', null)],
      readyNodes: new Set(['n2']),
    });
    expect(item.recommendation).toBe('keep_current_placement');
    expect(item.detail).toContain('more resilient');
  });

  it('recommends considering a re-pin for a local-tier tenant moved to another node', () => {
    const [item] = selectFailbackReviewItems({
      rows: [manualRow('t1', 'n2', 'n3', '2026-09-11T20:30:00Z')],
      tenants: [tenant('t1', 'acme', 'local', 'n3')],
      readyNodes: new Set(['n2', 'n3']),
    });
    expect(item.recommendation).toBe('consider_repin');
    expect(item.movedBy).toBe('operator');
    expect(item.detail).toContain("'n3'");
  });

  it('flags a local-tier tenant left unpinned — a single replica with no recorded home', () => {
    const [item] = selectFailbackReviewItems({
      rows: [autoRow('t1', 'n2', '2026-09-11T20:30:00Z')],
      tenants: [tenant('t1', 'acme', 'local', null)],
      readyNodes: new Set(['n2']),
    });
    expect(item.recommendation).toBe('consider_repin');
    expect(item.detail).toContain('single replica');
  });

  it('drops the item once the operator acknowledges it', () => {
    const items = selectFailbackReviewItems({
      rows: [
        autoRow('t1', 'n2', '2026-09-11T20:30:00Z'),
        ackRow('t1', '2026-09-11T21:00:00Z'),
      ],
      tenants: [tenant('t1', 'acme', 'ha', null)],
      readyNodes: new Set(['n2']),
    });
    expect(items).toEqual([]);
  });

  it('does NOT drop the item when the acknowledgement predates the move', () => {
    // An older ack must not silence a fresh displacement — latest event wins,
    // not "an ack exists somewhere in history".
    const items = selectFailbackReviewItems({
      rows: [
        ackRow('t1', '2026-09-01T10:00:00Z'),
        autoRow('t1', 'n2', '2026-09-11T20:30:00Z'),
      ],
      tenants: [tenant('t1', 'acme', 'ha', null)],
      readyNodes: new Set(['n2']),
    });
    expect(items).toHaveLength(1);
  });

  it('tracks the LATEST displacement across repeated outages', () => {
    // Moved off n2, then later off n3. n2 is back but n3 is still down, so
    // there is nothing to fail back to yet.
    const rows = [
      autoRow('t1', 'n2', '2026-09-11T20:30:00Z'),
      autoRow('t1', 'n3', '2026-09-11T22:00:00Z'),
    ];
    expect(selectFailbackReviewItems({
      rows, tenants: [tenant('t1', 'acme', 'ha', null)], readyNodes: new Set(['n2']),
    })).toEqual([]);

    // Once n3 returns, the review is about n3 — not the stale n2 event.
    const [item] = selectFailbackReviewItems({
      rows, tenants: [tenant('t1', 'acme', 'ha', null)], readyNodes: new Set(['n2', 'n3']),
    });
    expect(item.movedFromNode).toBe('n3');
  });

  it('skips a tenant that no longer exists', () => {
    expect(selectFailbackReviewItems({
      rows: [autoRow('gone', 'n2', '2026-09-11T20:30:00Z')],
      tenants: [],
      readyNodes: new Set(['n2']),
    })).toEqual([]);
  });

  it('puts decisions before informational items and is stable by name', () => {
    const items = selectFailbackReviewItems({
      rows: [
        autoRow('t1', 'n2', '2026-09-11T20:30:00Z'),
        autoRow('t2', 'n2', '2026-09-11T20:30:00Z'),
        autoRow('t3', 'n2', '2026-09-11T20:30:00Z'),
      ],
      tenants: [
        tenant('t1', 'zeta', 'ha', null),
        tenant('t2', 'alpha', 'local', null),
        tenant('t3', 'beta', 'local', null),
      ],
      readyNodes: new Set(['n2']),
    });
    expect(items.map((i) => i.tenantName)).toEqual(['alpha', 'beta', 'zeta']);
    expect(items.map((i) => i.recommendation)).toEqual([
      'consider_repin', 'consider_repin', 'keep_current_placement',
    ]);
  });
});

describe('returnedNodesFrom', () => {
  it('lists each returned node once, sorted', () => {
    const items = selectFailbackReviewItems({
      rows: [
        autoRow('t1', 'n3', '2026-09-11T20:30:00Z'),
        autoRow('t2', 'n2', '2026-09-11T20:30:00Z'),
        autoRow('t3', 'n3', '2026-09-11T20:30:00Z'),
      ],
      tenants: [
        tenant('t1', 'a', 'ha', null), tenant('t2', 'b', 'ha', null), tenant('t3', 'c', 'ha', null),
      ],
      readyNodes: new Set(['n2', 'n3']),
    });
    expect(returnedNodesFrom(items)).toEqual(['n2', 'n3']);
  });

  it('is empty when nothing is displaced', () => {
    expect(returnedNodesFrom([])).toEqual([]);
  });
});
