import { nodeTenantHosting, type NodeTenantHosting } from '@insula/api-contracts';

/**
 * Node pickers and a node's tenant hosting mode (backend nodes/tenant-hosting.ts).
 * A pinned-only node is a valid hand-picked target for a Local-tier tenant,
 * never for an HA-tier one, and never for Auto.
 */
type HostingFacts = { readonly canHostTenantWorkloads: boolean; readonly tenantHosting?: NodeTenantHosting };

/** May a tenant on `tier` be placed on this node by hand? Unknown tier: any hosting node. */
export function nodeTakesTier(node: HostingFacts, tier?: string | null): boolean {
  const mode = nodeTenantHosting(node);
  if (mode === 'none') return false;
  return !(mode === 'pinned' && tier === 'ha');
}

/** Appended to a pinned-only node's option text in node pickers. */
export function pinnedOnlySuffix(node: HostingFacts): string {
  return nodeTenantHosting(node) === 'pinned' ? ' — pinned tenants only' : '';
}
