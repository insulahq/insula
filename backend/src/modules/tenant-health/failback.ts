/**
 * Failback review — deriving "what is still displaced" from the audit trail.
 *
 * Every placement move during an outage already writes an audit row:
 * `tenant.auto_repin` when the platform unpins an HA-tier tenant off a dead
 * node, `tenant.repin` when an operator drives the recovery wizard. Both record
 * the node the tenant left. That is enough to answer the failback question
 * without a new table and without a background job holding state — the review
 * is a projection over rows the platform was already writing.
 *
 * Acknowledgement is recorded the same way (`tenant.failback_reviewed`), so an
 * item leaves the review when the operator either moves the tenant again or
 * explicitly decides not to. "Latest placement event wins" is the whole rule.
 *
 * The functions here are pure so the decision table is testable without a
 * cluster: the caller fetches rows and node readiness, these decide.
 */
import type { FailbackRecommendation, FailbackReviewItem } from '@insula/api-contracts';

/** The audit actions that change, or close out, a tenant's placement. */
export const PLACEMENT_AUDIT_ACTIONS = [
  'tenant.auto_repin',
  'tenant.repin',
  'tenant.failback_reviewed',
] as const;

export const FAILBACK_ACK_ACTION = 'tenant.failback_reviewed';

export interface PlacementAuditRow {
  tenantId: string;
  actionType: string;
  createdAt: Date;
  /** `changes` as stored: `strandedOn` for auto, `from`/`to` for manual. */
  changes: Record<string, unknown> | null;
}

export interface FailbackTenantFact {
  tenantId: string;
  tenantName: string;
  /** Current pin — `tenants.node_name`. Null means unpinned. */
  currentNode: string | null;
  storageTier: string;
}

export interface FailbackInput {
  rows: ReadonlyArray<PlacementAuditRow>;
  tenants: ReadonlyArray<FailbackTenantFact>;
  /** Names of nodes that are Ready right now. */
  readyNodes: ReadonlySet<string>;
}

/** The node a placement event moved the tenant OFF, whichever action wrote it. */
export function movedFromNode(row: PlacementAuditRow): string | null {
  const c = row.changes ?? {};
  const v = row.actionType === 'tenant.auto_repin' ? c.strandedOn : c.from;
  return typeof v === 'string' && v !== '' ? v : null;
}

function recommend(tier: string, currentNode: string | null): {
  recommendation: FailbackRecommendation;
  detail: string;
} {
  // An HA-tier tenant that ended up unpinned is in a BETTER place than it
  // started: any node with a replica can serve it, so there is no single host
  // left to lose. Recommending a re-pin here would trade availability for
  // tidiness.
  if (tier === 'ha' && currentNode === null) {
    return {
      recommendation: 'keep_current_placement',
      detail:
        'This tenant is on the HA storage tier and is now unpinned, so the scheduler '
        + 'can place it on any node holding a replica. That is more resilient than the '
        + 'pin it had before the outage — re-pinning would reintroduce a single point of '
        + 'failure. No action needed unless the original pin was deliberate.',
    };
  }
  if (currentNode === null) {
    return {
      recommendation: 'consider_repin',
      detail:
        'This tenant is on the local storage tier and is currently unpinned. Local-tier '
        + 'volumes have a single replica, so the tenant is effectively tied to whichever '
        + 'node holds it. Pin it explicitly so that placement is recorded rather than '
        + 'incidental.',
    };
  }
  return {
    recommendation: 'consider_repin',
    detail:
      `This tenant was moved to '${currentNode}' during the outage and is still there. `
      + 'The node it came from is back. Re-pinning moves its volume data again, so do it '
      + 'only if the original placement mattered — otherwise acknowledge and leave it.',
  };
}

/**
 * Which tenants are still displaced from a node that has since come back.
 *
 * A tenant qualifies when its most recent placement event moved it off a node
 * that is Ready again. Using only the LATEST event is what makes repeated
 * outages behave: a tenant moved off A, then off B, is displaced from B, and
 * acknowledging or re-pinning writes a newer row that ends the review.
 */
export function selectFailbackReviewItems(input: FailbackInput): FailbackReviewItem[] {
  const byTenant = new Map<string, PlacementAuditRow>();
  for (const row of input.rows) {
    const prev = byTenant.get(row.tenantId);
    if (!prev || row.createdAt.getTime() > prev.createdAt.getTime()) {
      byTenant.set(row.tenantId, row);
    }
  }

  const tenantById = new Map(input.tenants.map((t) => [t.tenantId, t]));
  const items: FailbackReviewItem[] = [];

  for (const [tenantId, row] of byTenant) {
    // The operator already closed this one out.
    if (row.actionType === FAILBACK_ACK_ACTION) continue;

    const from = movedFromNode(row);
    if (!from) continue;

    // Still down: that is an OUTAGE, shown by the outage banner. This review is
    // only about nodes that have come back — surfacing both at once would tell
    // the operator to fail back to a host that is still dead.
    if (!input.readyNodes.has(from)) continue;

    const tenant = tenantById.get(tenantId);
    // Tenant deleted since the move; nothing to fail back.
    if (!tenant) continue;

    const { recommendation, detail } = recommend(tenant.storageTier, tenant.currentNode);
    items.push({
      tenantId,
      tenantName: tenant.tenantName,
      movedFromNode: from,
      currentNode: tenant.currentNode,
      storageTier: tenant.storageTier,
      movedBy: row.actionType === 'tenant.auto_repin' ? 'auto' : 'operator',
      movedAt: row.createdAt.toISOString(),
      recommendation,
      detail,
    });
  }

  // Things needing a decision first, then stable by name so the list does not
  // reshuffle under the operator between polls.
  items.sort((a, b) => {
    const rank = (r: FailbackRecommendation) => (r === 'consider_repin' ? 0 : 1);
    const d = rank(a.recommendation) - rank(b.recommendation);
    return d !== 0 ? d : a.tenantName.localeCompare(b.tenantName);
  });
  return items;
}

/** Nodes represented in the review — the ones that came back with work outstanding. */
export function returnedNodesFrom(items: ReadonlyArray<FailbackReviewItem>): string[] {
  return [...new Set(items.map((i) => i.movedFromNode))].sort();
}
