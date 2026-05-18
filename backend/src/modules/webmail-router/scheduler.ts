/**
 * webmail-router periodic reconciler.
 *
 * Runs `reconcileWebmailIngress` + `reconcileEngineDeployments` on a
 * fixed interval to recover from drift between the DB-stored
 * `default_webmail_engine` setting and the live cluster state.
 *
 * Why this matters: without periodic re-reconcile, the IR + Pod-mutex
 * state can diverge from the DB setting after boot:
 *
 *   - Flux re-applies the static IngressRoute manifest (overriding our
 *     `services[0].name` patch) when the resource is recreated rather
 *     than just patched.
 *   - An operator `kubectl edit ingressroute` reverts the active
 *     service name to `roundcube` (the manifest default).
 *   - platform-storage-policy or another reconciler clears the
 *     `webmail-engine-disabled` annotation off the inactive Deployment.
 *
 * Before this scheduler, drift caused users to hit a 503 "no available
 * server" page (Traefik routing to a Service with 0 endpoints) until
 * the next platform-api restart OR the next engine-flip PATCH.
 *
 * Mirrors `startRoundcubeDbReconciler`'s pattern:
 *   - Fires immediately via setImmediate (fast cold-start convergence)
 *   - Then every `intervalMs` (default 5 min)
 *   - `timer.unref()` so a stuck tick doesn't keep the process alive
 *   - Caller holds the `stop()` handle for graceful shutdown
 *
 * The reconcilers themselves are idempotent — no-op on convergence.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { reconcileWebmailIngress, reconcileEngineDeployments } from './reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface WebmailRouterReconcilerHandle {
  readonly stop: () => void;
}

export interface WebmailRouterClients {
  readonly custom: k8s.CustomObjectsApi;
  readonly apps: k8s.AppsV1Api;
}

export function startWebmailRouterReconciler(
  db: Database,
  clients: WebmailRouterClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): WebmailRouterReconcilerHandle {
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      await reconcileWebmailIngress(db, clients.custom, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'webmail-router-scheduler: reconcileWebmailIngress threw',
      );
    }
    if (cancelled) return;
    try {
      await reconcileEngineDeployments(db, clients.apps, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'webmail-router-scheduler: reconcileEngineDeployments threw',
      );
    }
  };

  // First run immediately so the boot-time reconcile and the periodic
  // tick share the same code path — no two-implementations drift.
  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info(
    { intervalMs },
    'webmail-router-scheduler: started',
  );

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}
