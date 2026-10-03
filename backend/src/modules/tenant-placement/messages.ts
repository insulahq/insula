/**
 * Notification text for tenant placement. Pure, so the wording an operator
 * reads at 07:00 is pinned by tests rather than discovered in an inbox.
 */
import type { AdminTenantPlacementPayload } from '../notifications/events.js';
import { formatUtcMinute } from '../../shared/format-utc.js';
import type { StoredFailover, StoredPlacement } from './store.js';

/** At most this many tenants are spelled out; the rest are counted. */
const MAX_LISTED = 10;

function nodes(list: readonly string[]): string {
  return list.length > 0 ? list.join(', ') : 'nowhere yet (restarting)';
}


function summaryOf(names: readonly string[]): string {
  const unique = [...new Set(names)];
  return unique.length === 1 ? unique[0]! : `${unique.length} tenants`;
}

function listed(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_LISTED).join(' ');
  const rest = lines.length - MAX_LISTED;
  return rest > 0 ? `${shown} …and ${rest} more.` : shown;
}

export interface NamedFailover extends StoredFailover {
  readonly tenantName: string;
  readonly primaryNode: string | null;
}

export function failoverMessage(events: readonly NamedFailover[]): AdminTenantPlacementPayload {
  const lines = events.map((e) => {
    const moved = e.primaryNode && e.nodesAfter.length > 0 && e.nodesAfter.some((n) => n !== e.primaryNode)
      ? ` — no longer on its primary node ${e.primaryNode}`
      : '';
    return `${e.tenantName}: volume ${e.pvcName ?? e.volumeName} salvaged at ${formatUtcMinute(e.remountRequestedAt)}; `
      + `was on ${nodes(e.nodesBefore)}, now on ${nodes(e.nodesAfter)}${moved}.`;
  });
  const sameNode = new Set(events.flatMap((e) => e.nodesBefore)).size === 1 && events.length > 1;
  return {
    summary: summaryOf(events.map((e) => e.tenantName)),
    details: listed(lines),
    guidance: (sameNode
      ? 'Every salvaged volume was on the same node — look at that node\'s storage first. '
      : 'A salvage follows a replica that stopped answering, usually a storage stall on its node. ')
      + 'Check the sites are serving, and the tenant\'s Placement card for where it runs now.',
  };
}

export interface NamedPlacement extends StoredPlacement {
  readonly tenantName: string;
}

export function misplacedMessage(placements: readonly NamedPlacement[]): AdminTenantPlacementPayload {
  const lines = placements.map((p) => {
    const why = p.reasons.length > 0 ? p.reasons.join(', ') : `on ${nodes(p.actualNodes)}`;
    const since = p.misplacedSince ? ` since ${formatUtcMinute(p.misplacedSince)}` : '';
    return `${p.tenantName}: primary node ${p.primaryNode ?? '—'}, but ${why}${since}.`;
  });
  return {
    summary: summaryOf(placements.map((p) => p.tenantName)),
    details: listed(lines),
    guidance: 'Away from its primary node a tenant can do its disk I/O across the network, and '
      + 'data locality copies its volume between nodes. Open the tenant\'s Placement card to move it '
      + 'back, or make the node it is on its primary.',
  };
}
