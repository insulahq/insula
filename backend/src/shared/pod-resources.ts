/**
 * The effective resource request of a Pod — the number Kubernetes charges
 * against a ResourceQuota, which is NOT the sum of `spec.containers`.
 *
 * An init container runs to completion before the app containers start, so the
 * scheduler never has to hold both at once. Kubernetes therefore charges
 * `max(sum(containers), max(initContainers))` per resource — and it charges it
 * for the pod's WHOLE lifetime, long after the init container has exited.
 *
 * The consequence that matters: a pod fronted by an init container larger
 * than its own workload is charged the init container's figure for as long as
 * the pod exists, so any accounting that sums `spec.containers` under-reports
 * it and disagrees with the admission decision it is meant to predict.
 *
 * Sidecars (init containers with `restartPolicy: Always`) DO run alongside the
 * app containers, so Kubernetes adds them to the sum instead, and a regular
 * init container is charged alongside every sidecar declared before it.
 * Modelled here so a future sidecar cannot quietly re-open the same gap.
 *
 * @see https://kubernetes.io/docs/concepts/workloads/pods/init-containers/#resource-sharing-within-containers
 */

import { parseResourceValue } from './resource-parser.js';

export interface ContainerResourcesLike {
  readonly resources?: {
    readonly limits?: { readonly cpu?: string; readonly memory?: string };
    readonly requests?: { readonly cpu?: string; readonly memory?: string };
  };
}

export interface InitContainerResourcesLike extends ContainerResourcesLike {
  /** `Always` marks a sidecar — it outlives init and runs with the app containers. */
  readonly restartPolicy?: string;
}

export interface PodSpecResourcesLike {
  readonly containers?: ReadonlyArray<ContainerResourcesLike>;
  readonly initContainers?: ReadonlyArray<InitContainerResourcesLike>;
}

/**
 * Read one container's request for `unit`, falling back to its limit.
 *
 * Tenant workloads run asymmetric QoS (ADR-037): CPU request only, memory
 * request == limit. So `limits.cpu` is unset on every tenant container and
 * reading limits first reported CPU as 0 forever. The request is also the
 * honest number — it is what the scheduler actually reserves.
 */
function containerRequest(c: ContainerResourcesLike, unit: 'cpu' | 'memory'): number {
  const raw = c.resources?.requests?.[unit] ?? c.resources?.limits?.[unit];
  return raw ? parseResourceValue(raw, unit) : 0;
}

/**
 * Effective pod request for one resource, in the parser's units
 * (cores for `cpu`, Gi for `memory`).
 */
export function effectivePodRequest(spec: PodSpecResourcesLike | undefined, unit: 'cpu' | 'memory'): number {
  if (!spec) return 0;

  const inits = spec.initContainers ?? [];
  const sidecars = inits.filter((c) => c.restartPolicy === 'Always');

  // Sidecars never stop, so they stack on top of the app containers.
  const appSum =
    (spec.containers ?? []).reduce((sum, c) => sum + containerRequest(c, unit), 0) +
    sidecars.reduce((sum, c) => sum + containerRequest(c, unit), 0);

  // A regular init container runs alone — except for the sidecars already
  // started ahead of it, which is why this walks the list in order.
  let sidecarsSoFar = 0;
  let initPeak = 0;
  for (const c of inits) {
    if (c.restartPolicy === 'Always') {
      sidecarsSoFar += containerRequest(c, unit);
      continue;
    }
    initPeak = Math.max(initPeak, containerRequest(c, unit) + sidecarsSoFar);
  }

  return Math.max(appSum, initPeak);
}
