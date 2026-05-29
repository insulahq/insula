/**
 * Shared restore-cart UI + types for the admin and tenant panels.
 *
 * Surface:
 *   - `RestoreCartLayout` — the Plesk-style two-column page. Both
 *     panels render this; differences (rollback safety net,
 *     header banner) are gated by props.
 *   - `RestoreCartHooks` — the adapter interface each panel supplies.
 *     Wires URL prefixes + auth without coupling the layout to either.
 *   - Bundle-progress types (`BundleStatusResponse` etc.) used by
 *     the per-panel progress modals.
 *
 * Authoritative DTOs (RestoreItemInfo, RestoreJobDetail, etc.) live in
 * @k8s-hosting/api-contracts and are re-exported via
 * `restore-cart-types.js`.
 *
 * History:
 *   2026-05-28 — initial extraction (types only)
 *   2026-05-29 — promoted RestoreCartLayout + pickers from
 *                admin-panel/src/pages/RestoreCart.tsx into the
 *                workspace; both panels are now thin wrappers.
 */

export type {
  ComponentName,
  ComponentStatus,
  BundleStatus,
  BundleComponent,
  BundleStatusResponse,
} from './types.js';
export { TERMINAL_BUNDLE_STATES, formatBundleBytes } from './types.js';

export type {
  // Re-exports from api-contracts (single source of truth)
  RestoreItemType,
  RestoreItemStatus,
  RestoreItemInfo,
  RestoreJobStatus,
  AddRestoreItemInput,
  // ui-restore-cart-local aliases + additions
  RestoreCartStatus,
  RestoreItemPayload,
  RestoreCartDetail,
  RestoreCartHooks,
  RestoreCartQueryResult,
  RestoreCartMutationResult,
  BrowseConfigTablesData,
  BrowseDeploymentsData,
  BrowseDomainsData,
  BrowseMailboxesData,
  BrowseFilesData,
  BrowseFilesEntry,
} from './restore-cart-types.js';

export { RestoreCartLayout } from './RestoreCartLayout.js';
export type { RestoreCartLayoutProps, Tab } from './RestoreCartLayout.js';
