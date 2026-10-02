import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const LAST_ACCESS_ANNOTATION = 'insula.host/file-manager-last-access';

// Per-process cache (reduces API server load between writes — we still
// reconcile against the Deployment annotation for cross-pod truth).
const lastAccessMap = new Map<string, number>();

/**
 * Record activity. Updates the in-process cache AND the FM Deployment
 * annotation so other platform-api replicas (each running their own
 * idle-cleanup loop) see the same access time. The annotation write
 * is fire-and-forget — a failure here would just mean another replica
 * might prematurely scale down, so we tolerate transient errors.
 */
export function recordFileManagerAccess(namespace: string, k8s?: K8sClients): void {
  const now = Date.now();
  lastAccessMap.set(namespace, now);
  // Wrap the k8s tenant call in a try block — a missing or partially
  // mocked tenant (`k8s.apps` undefined) would otherwise throw
  // synchronously, escaping the promise's `.catch`. Real callers
  // pass a fully-shaped tenant; tests pass a mock that may not
  // implement every nested property.
  if (!k8s?.apps?.patchNamespacedDeployment) return;
  try {
    void k8s.apps.patchNamespacedDeployment({
      name: 'file-manager',
      namespace,
      body: { metadata: { annotations: { [LAST_ACCESS_ANNOTATION]: String(now) } } },
    } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
      STRATEGIC_MERGE_PATCH).catch((err: unknown) => {
      // Deployment may not exist yet (first /start hasn't created
      // it), or pod may be racing the controller — either way, the
      // in-memory cache covers the current pod.
      const status = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) {
        console.warn(`[file-manager] last-access annotation write failed for ${namespace}:`, (err as Error).message);
      }
    });
  } catch (err) {
    console.warn(`[file-manager] last-access annotation skipped for ${namespace}:`, (err as Error).message);
  }
}

/** The file-manager Deployment fields the idle decision reads. */
export interface IdleCandidate {
  readonly metadata?: {
    readonly annotations?: Record<string, string>;
    readonly creationTimestamp?: string | Date;
  };
  readonly spec?: { readonly replicas?: number };
}

/**
 * Should the idle loop scale this file-manager to 0 now?
 *
 * ★ Never while a storage operation holds it. The hold
 * (`insula.host/storage-quiesced`) means the operation owns this Deployment's
 * replica count: quiesce scaled it down, and unquiesce scales it back to what it
 * was and then WAITS for it to become available before releasing the hold. A
 * file-manager that was up when the operation started (one look at the Files
 * page, or a disk-usage read, is enough) is idle by this loop's definition, so
 * the loop used to scale it straight back to 0 during that wait. Unquiesce then
 * waited out its full five minutes for a pod that was never coming and failed
 * the operation — a snapshot restore that had in fact succeeded was reported as
 * "A storage operation failed", with the tenant's workloads still held.
 * `ensureFileManagerRunning` already refuses to scale UP a held file-manager;
 * this is the other direction.
 *
 * `cachedLastAccessMs` is this replica's in-memory access time (0 if none).
 * Returns how long it has been idle when it is due for scale-down, else null.
 */
export function idleScaleDownDue(deploy: IdleCandidate, cachedLastAccessMs: number, now: number): number | null {
  const replicas = deploy.spec?.replicas ?? 0;
  if (replicas === 0) return null; // Already scaled down
  const annotations = deploy.metadata?.annotations ?? {};
  if (annotations[STORAGE_QUIESCED_ANNOTATION] === 'true') return null;

  // Cross-pod truth: annotation set by recordFileManagerAccess() in any
  // platform-api replica. Falls back to the in-memory cache if the annotation
  // is missing (older Deployment, or a race where /start hasn't yet annotated).
  //
  // CRITICAL: a Deployment that was JUST created by /start has neither
  // annotation nor cache entry on replicas other than the one that handled the
  // request. Treating that as "idle since epoch" would scale it to 0
  // immediately — racing /start. Use the Deployment's own creationTimestamp as
  // the floor so a brand-new FM gets a full IDLE_TIMEOUT_MS grace window even
  // before any /status poll lands.
  const annotated = Number(annotations[LAST_ACCESS_ANNOTATION] ?? '');
  const rawCreated = deploy.metadata?.creationTimestamp;
  const created = rawCreated instanceof Date ? rawCreated.getTime() : Date.parse(rawCreated ?? '');
  const lastAccess = Math.max(
    Number.isFinite(annotated) ? annotated : 0,
    cachedLastAccessMs,
    Number.isFinite(created) ? created : 0,
  );
  const idleMs = now - lastAccess;
  return idleMs > IDLE_TIMEOUT_MS ? idleMs : null;
}

export function startIdleCleanup(kubeconfigPath?: string, intervalMs = 60_000): NodeJS.Timeout | null {
  let k8s: ReturnType<typeof createK8sClients>;
  try {
    k8s = createK8sClients(kubeconfigPath);
  } catch {
    console.warn('[file-manager-cleanup] K8s not available, skipping idle cleanup');
    return null;
  }

  console.log('[file-manager-cleanup] Starting idle cleanup (10min timeout)');

  return setInterval(async () => {
    const now = Date.now();

    try {
      // List all namespaces with file-manager deployments
      const namespaces = await k8s.core.listNamespace({});
      const nsList = ((namespaces as { items?: Array<{ metadata?: { name?: string } }> }).items ?? [])
        .map(ns => ns.metadata?.name)
        .filter((n): n is string => !!n && n.startsWith('tenant-'));

      for (const ns of nsList) {
        try {
          const deploy = await k8s.apps.readNamespacedDeployment({ name: 'file-manager', namespace: ns }) as IdleCandidate;

          const idleMs = idleScaleDownDue(deploy, lastAccessMap.get(ns) ?? 0, now);
          if (idleMs !== null) {
            console.log(`[file-manager-cleanup] Scaling down idle file-manager in ${ns} (idle for ${Math.round(idleMs / 60_000)}m)`);
            // Raw-body scale — the typed patch drops replicas:0 (serializer),
            // which silently no-op'd this idle scale-down. See
            // shared/scale-deployment.ts.
            const { scaleDeploymentReplicas } = await import('../../shared/scale-deployment.js');
            await scaleDeploymentReplicas(ns, 'file-manager', 0);
            lastAccessMap.delete(ns);
          }
        } catch {
          // Deployment doesn't exist or other error — skip
        }
      }
    } catch (err) {
      console.error('[file-manager-cleanup] Error:', err);
    }
  }, intervalMs);
}
