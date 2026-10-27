/**
 * Whether the shim pods serve the bindings the database holds now.
 *
 * A binding change is written to the database first; the reconciler then
 * renders it and rolls the DaemonSet, and until every pod has rolled the shim
 * still serves the previous target. Code that asks "is this bundle on the
 * bound target?" and then deletes, expires or declares a bundle reclaimed
 * through the shim must not act in that window: it would take the previous
 * target's contents for the new one's (tenant-bundles/unbound-target.ts).
 *
 * Settled: the pod template carries the input hash of the current inputs —
 * the same `computeInputHash` the reconciler stamps there — and the rollout of
 * that template is complete.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { computeInputHash } from './rclone-config.js';
import { readLauncherScript } from './reconciler.js';
import {
  INPUT_HASH_ANNOTATION,
  SHIM_DAEMONSET_NAME,
  SHIM_NAMESPACE,
  loadBackupTargetKey,
  loadShimAssignments,
} from './service.js';

export interface ServedShimClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: Pick<k8s.AppsV1Api, 'readNamespacedDaemonSet'>;
}

interface DaemonSetShape {
  readonly metadata?: { readonly generation?: number };
  readonly spec?: { readonly template?: { readonly metadata?: { readonly annotations?: Record<string, string> } } };
  readonly status?: {
    readonly observedGeneration?: number;
    readonly desiredNumberScheduled?: number;
    readonly updatedNumberScheduled?: number;
    readonly numberAvailable?: number;
  };
}

/** Pure: the DaemonSet runs the template stamped with `inputHash` on every node. */
export function daemonSetServes(ds: DaemonSetShape, inputHash: string): boolean {
  if (ds.spec?.template?.metadata?.annotations?.[INPUT_HASH_ANNOTATION] !== inputHash) return false;
  const s = ds.status ?? {};
  if ((s.observedGeneration ?? 0) < (ds.metadata?.generation ?? 0)) return false;
  const desired = s.desiredNumberScheduled ?? 0;
  return (s.updatedNumberScheduled ?? 0) >= desired && (s.numberAvailable ?? 0) >= desired;
}

/** Throws when an input cannot be read: the caller treats that as "not known". */
export async function shimServesCurrentBindings(
  db: Database,
  clients: ServedShimClients,
  encryptionKey: string,
): Promise<boolean> {
  const [key, loaded, launcher, ds] = await Promise.all([
    loadBackupTargetKey(clients.core, SHIM_NAMESPACE),
    loadShimAssignments(db, encryptionKey),
    readLauncherScript(clients.core),
    clients.apps.readNamespacedDaemonSet({
      name: SHIM_DAEMONSET_NAME, namespace: SHIM_NAMESPACE,
    } as unknown as Parameters<k8s.AppsV1Api['readNamespacedDaemonSet']>[0]) as Promise<DaemonSetShape>,
  ]);
  return daemonSetServes(ds, computeInputHash(key.rawKey, loaded.assignments, launcher));
}
