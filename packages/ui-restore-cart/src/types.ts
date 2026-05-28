/**
 * Shared types for the bundle-progress UI surface.
 *
 * These mirror the response shape of:
 *   GET /api/v1/tenants/:tenantId/bundles/:id/status
 *
 * Re-used by the tenant panel's BundleProgressModal and (eventually)
 * the admin panel's progress view, so both consume the same contract
 * and a backend shape change can't drift between panels.
 */

export type ComponentName = 'config' | 'secrets' | 'files' | 'mailboxes';

export type ComponentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type BundleStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed';

export interface BundleComponent {
  readonly id: string;
  readonly component: ComponentName;
  readonly artifactName: string;
  readonly status: ComponentStatus;
  readonly sizeBytes: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastError: string | null;
}

export interface BundleStatusResponse {
  readonly data: {
    readonly bundle: {
      readonly id: string;
      readonly tenantId: string;
      readonly status: BundleStatus;
      readonly sizeBytes: number;
      readonly startedAt: string | null;
      readonly finishedAt: string | null;
      readonly lastError: string | null;
    };
    readonly components: ReadonlyArray<BundleComponent>;
  };
}

/**
 * Bundle states past which the orchestrator no longer mutates the
 * record. Pollers stop refetching once one of these is seen.
 */
export const TERMINAL_BUNDLE_STATES: ReadonlySet<BundleStatus> = new Set([
  'completed',
  'partial',
  'failed',
]);

/**
 * 1024-based byte formatter used by the progress modal. Returns '-'
 * for zero / nullish to keep the UI readable while a component is
 * still initializing.
 */
export function formatBundleBytes(b: number | null | undefined): string {
  // !b covers null, undefined, 0, NaN — keeps the UI clean while a
  // component is still initialising (size_bytes default is 0).
  if (!b) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  return `${(b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
