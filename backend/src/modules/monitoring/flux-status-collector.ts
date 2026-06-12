/**
 * Flux readiness collector — feeds platform_flux_unready_resources, the
 * gauge behind the flux-reconcile-errors alert rule.
 *
 * Flux controllers expose no scrapeable failure signal: build/apply
 * failures are recorded in status conditions and requeued, NOT returned
 * as reconciler errors, so controller_runtime_reconcile_errors_total
 * stays 0 through real failures (and gotk_reconcile_condition was
 * removed upstream in Flux v2.1). The kube API's Ready conditions are
 * therefore the only truthful source — this collector counts them.
 *
 * Runs on every replica (the scrape is per-pod); each replica computes
 * the same cluster-wide count, and the rule aggregates max by (kind).
 */
import { fluxUnreadyResources } from '../../shared/metrics.js';

export interface FluxKindSpec {
  readonly group: string;
  readonly version: string;
  readonly plural: string;
  readonly kind: string;
}

/** The Flux kinds the platform deploys (RBAC grants get/list on both). */
export const FLUX_RESOURCE_KINDS: ReadonlyArray<FluxKindSpec> = [
  { group: 'kustomize.toolkit.fluxcd.io', version: 'v1', plural: 'kustomizations', kind: 'Kustomization' },
  { group: 'source.toolkit.fluxcd.io', version: 'v1', plural: 'gitrepositories', kind: 'GitRepository' },
];

interface FluxObject {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly suspend?: boolean };
  readonly status?: {
    readonly conditions?: ReadonlyArray<{ readonly type: string; readonly status: string }>;
  };
}

/**
 * Structural slice of @kubernetes/client-node's CustomObjectsApi —
 * narrow on purpose so tests stub it without the client and callers
 * cast once at the wiring site (same pattern as postgres-restore).
 */
export interface FluxCustomLister {
  listClusterCustomObject(args: {
    group: string;
    version: string;
    plural: string;
  }): Promise<{ items?: ReadonlyArray<FluxObject> }>;
}

interface CollectorLog {
  warn: (...args: unknown[]) => void;
}

/**
 * Unready = Ready condition explicitly False on a non-suspended
 * resource. Unknown / missing conditions are progressing or freshly
 * created — counting them would alert on every reconcile-in-flight.
 */
function isUnready(obj: FluxObject): boolean {
  if (obj.spec?.suspend === true) return false;
  const ready = obj.status?.conditions?.find((c) => c.type === 'Ready');
  return ready?.status === 'False';
}

/**
 * One collection pass: list each Flux kind cluster-wide, set the gauge
 * to the unready count (-1 for a kind whose list failed). Never throws.
 */
export async function collectFluxUnreadyOnce(
  custom: FluxCustomLister,
  log: CollectorLog,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const spec of FLUX_RESOURCE_KINDS) {
    let count: number;
    try {
      const res = await custom.listClusterCustomObject({
        group: spec.group,
        version: spec.version,
        plural: spec.plural,
      });
      count = (res.items ?? []).filter(isUnready).length;
    } catch (err: unknown) {
      count = -1;
      log.warn(
        `flux-status-collector: listing ${spec.plural} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    counts[spec.kind] = count;
    fluxUnreadyResources.set({ kind: spec.kind }, count);
  }
  return counts;
}

/**
 * Start the periodic collector. Builds the kube client lazily so unit
 * tests / CI without a kubeconfig degrade to a warned no-op instead of
 * crashing app assembly. Returns a stop function for onClose.
 */
export function startFluxStatusCollector(
  buildCustom: () => FluxCustomLister,
  log: CollectorLog,
  intervalMs = 60_000,
): () => void {
  let custom: FluxCustomLister;
  try {
    custom = buildCustom();
  } catch (err: unknown) {
    log.warn(
      'flux-status-collector disabled (no kube client):',
      err instanceof Error ? err.message : String(err),
    );
    return () => {};
  }
  const runOnce = (): void => {
    collectFluxUnreadyOnce(custom, log).catch((err: unknown) => {
      // collectFluxUnreadyOnce never throws by contract; this guard makes
      // the fire-and-forget explicit instead of relying on it.
      log.warn(
        'flux-status-collector: collection pass failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  };
  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
