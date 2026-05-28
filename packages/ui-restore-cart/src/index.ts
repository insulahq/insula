/**
 * Shared types + helpers for the restore-cart UI surface.
 *
 * As of 2026-05-28 this is a TYPES-only export — used by both
 * admin and tenant panels to share the bundle-progress shapes
 * without coupling to either panel's auth context. The actual
 * UI components stay in each panel for now (admin: more complex,
 * tenant: simpler MVP). A follow-up can lift presentation-only
 * components here once they're prop-driven (no useAuth coupling).
 */

export type {
  ComponentName,
  ComponentStatus,
  BundleStatus,
  BundleComponent,
  BundleStatusResponse,
} from './types.js';
export { TERMINAL_BUNDLE_STATES, formatBundleBytes } from './types.js';
