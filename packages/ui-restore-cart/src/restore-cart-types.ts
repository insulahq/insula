/**
 * Shared types for the Plesk-style restore-cart UI surface.
 *
 * Authoritative DTOs (RestoreItemInfo, RestoreJobDetail, etc.) live
 * in `@k8s-hosting/api-contracts` and are re-exported here so the
 * UI layer + the backend can never drift. This module ADDS:
 *
 *   - Browse-response shapes (one per picker) that aren't first-class
 *     in api-contracts because they're UI-affordance helpers, not
 *     authoritative API contracts.
 *   - `RestoreCartHooks` — the adapter interface each panel supplies
 *     to inject its own URL prefix + auth context into the shared
 *     layout.
 */

import type {
  AddRestoreItemInput,
  RestoreItemInfo,
  RestoreJobDetail,
  RestoreJobStatus,
  RestoreItemStatus,
  RestoreItemType,
} from '@k8s-hosting/api-contracts';

// Re-exports so panel-side wrappers can `import { RestoreItemInfo }
// from '@k8s-hosting/ui-restore-cart'` without also importing
// api-contracts directly.
export type {
  RestoreItemInfo,
  RestoreJobDetail,
  RestoreJobStatus,
  RestoreItemStatus,
  RestoreItemType,
  AddRestoreItemInput,
};

/** Alias matching the layout's internal naming. */
export type RestoreCartStatus = RestoreJobStatus;

/** Alias used by the picker `addItem` callbacks. */
export type RestoreItemPayload = AddRestoreItemInput;

/** Alias used by the layout's cart-detail consumers. */
export type RestoreCartDetail = RestoreJobDetail;

// ── Browse response shapes ───────────────────────────────────────────

export interface BrowseConfigTablesData {
  readonly bundleId: string;
  readonly tables: ReadonlyArray<{ readonly name: string; readonly rowCount: number }>;
}

export interface BrowseDeploymentsData {
  readonly bundleId: string;
  readonly deployments: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export interface BrowseDomainsData {
  readonly bundleId: string;
  readonly domains: ReadonlyArray<{ readonly id: string; readonly hostname: string }>;
}

export interface BrowseMailboxesData {
  readonly bundleId: string;
  readonly addresses: ReadonlyArray<string>;
}

export interface BrowseFilesEntry {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly mtime: string;
}

export interface BrowseFilesData {
  readonly bundleId: string;
  readonly totalCount: number;
  readonly entries: ReadonlyArray<BrowseFilesEntry>;
  readonly nextCursor: string | null;
  /**
   * 2026-05-28 migration window: bundles created BEFORE the
   * tree.jsonl.gz drop have a real listing; bundles AFTER return
   * totalCount=0 with `migrated: true` + a human-readable `message`.
   * The UI surfaces the message instead of "no files".
   */
  readonly migrated?: boolean;
  readonly message?: string;
}

/**
 * Minimal shape the layout expects from a TanStack Query / Mutation
 * adapter. Each panel passes its own concrete hooks (admin vs tenant
 * URL prefix) that conform to this interface.
 */
export interface RestoreCartQueryResult<T> {
  readonly data?: { readonly data: T };
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: unknown;
}

export interface RestoreCartMutationResult<TVars, TData = unknown> {
  mutate(vars: TVars): void;
  mutateAsync?(vars: TVars): Promise<{ data: TData }>;
  readonly isPending: boolean;
  readonly data?: { readonly data: TData };
  readonly error: unknown;
}

/**
 * The bag of hooks the panel injects into the shared layout. Each
 * panel's hooks call its own URL prefix (admin: `/admin/...`, tenant:
 * `/tenants/:tenantId/...`) but the return shapes match this interface.
 *
 * Hook references MUST be stable across renders. The standard pattern
 * is to define them at module scope in `use-restore-carts.ts` and
 * pass the namespace object straight through — never construct
 * the `hooks` object inline on every render.
 */
export interface RestoreCartHooks {
  useCart(cartId: string | null): RestoreCartQueryResult<RestoreCartDetail>;
  useCreateCart(): RestoreCartMutationResult<
    { tenantId: string; description?: string },
    { id: string; tenantId: string; status: RestoreCartStatus }
  >;
  useAddItem(cartId: string): RestoreCartMutationResult<RestoreItemPayload & { label?: string }, RestoreItemInfo>;
  useRemoveItem(cartId: string): RestoreCartMutationResult<string>;
  useExecuteCart(cartId: string): RestoreCartMutationResult<void, RestoreCartDetail>;
  /** Admin-only; tenant panel omits. */
  useRollbackCart?(cartId: string): RestoreCartMutationResult<
    void,
    { cartId: string; operationId: string; snapshotId: string }
  >;
  // Browse hooks — each picker calls one.
  useBrowseConfigTables(bundleId: string | null): RestoreCartQueryResult<BrowseConfigTablesData>;
  useBrowseDeployments(bundleId: string | null): RestoreCartQueryResult<BrowseDeploymentsData>;
  useBrowseDomains(bundleId: string | null): RestoreCartQueryResult<BrowseDomainsData>;
  useBrowseMailboxes(bundleId: string | null): RestoreCartQueryResult<BrowseMailboxesData>;
  useBrowseFiles(
    bundleId: string | null,
    after: string | null,
    limit?: number,
  ): RestoreCartQueryResult<BrowseFilesData>;
}
