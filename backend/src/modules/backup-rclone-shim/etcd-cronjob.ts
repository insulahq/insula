/**
 * etcd-snap-via-shim CronJob reconciler (R-X7).
 *
 * Toggles `spec.suspend` on the `platform/etcd-snap-via-shim`
 * CronJob based on the SYSTEM-class shim target binding.
 *
 *      backup_target_assignments[system] (bound|unbound)
 *                                 ↓
 *      patch platform/etcd-snap-via-shim
 *           spec.suspend = (unbound ? true : false)
 *
 * The CronJob manifest itself ships static in k8s/base/backup/ —
 * Flux applies it on every reconcile with `suspend: true` as the
 * baseline. This reconciler is the sole owner of the field at
 * runtime; Flux's ssa: merge mode leaves overlay-mutated fields
 * alone as long as the source manifest doesn't re-assert them on
 * every tick.
 *
 * Why a separate reconciler instead of folding into postgres-
 * objectstore.ts: the postgres module is about CNPG/barman-cloud
 * specifics; etcd uses a plain K8s CronJob. Mixing the two would
 * couple unrelated failure modes — if the plugin-barman-cloud CRDs
 * are missing on a fresh cluster, the postgres reconciler can hit
 * STATE_ERROR. We don't want that to also halt the etcd toggle.
 */

import { eq, inArray } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import {
  backupConfigurations,
  backupTargetAssignments,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { JSON_PATCH } from '../../shared/k8s-patch.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Namespace where the CronJob lives. Same as the shim Service. */
export const ETCD_CRONJOB_NAMESPACE = 'platform';
export const ETCD_CRONJOB_NAME = 'etcd-snap-via-shim';

/** Identifier on every reconciler-managed log entry. */
export const ETCD_FIELD_MANAGER = 'platform-api-etcd-cronjob';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EtcdCronJobClients {
  readonly batch: k8s.BatchV1Api;
}

export interface EtcdCronJobResult {
  readonly state: 'STATE_OK' | 'STATE_NO_SYSTEM_TARGET' | 'STATE_NOT_INSTALLED' | 'STATE_ERROR';
  readonly errorMessage: string;
  readonly suspended: boolean;
  /** Whether the apiserver patch was actually issued (false when
   *  the CronJob was already at the desired state). */
  readonly patched: boolean;
}

interface CronJobView {
  spec?: {
    suspend?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * One reconcile pass. Idempotent — re-running with unchanged inputs
 * is a no-op (the live `spec.suspend` is read first; patch is only
 * issued on mismatch).
 *
 * Failure modes:
 *   - CronJob not yet installed (404) → STATE_NOT_INSTALLED, no
 *     error: Flux hasn't synced the base/backup/ manifests yet.
 *     The periodic tick converges once Flux applies.
 *   - any other patch error → STATE_ERROR with the apiserver
 *     message. The next periodic tick retries.
 */
export async function reconcileEtcdCronJob(
  db: Database,
  clients: EtcdCronJobClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<EtcdCronJobResult> {
  // ─── 1. Resolve desired suspend state from the DB ──────────────
  const bound = await isSystemTargetBound(db);
  const desiredSuspend = !bound;

  // ─── 2. Read the live CronJob ──────────────────────────────────
  let live: CronJobView;
  try {
    live = (await clients.batch.readNamespacedCronJob({
      name: ETCD_CRONJOB_NAME,
      namespace: ETCD_CRONJOB_NAMESPACE,
    } as unknown as Parameters<typeof clients.batch.readNamespacedCronJob>[0])) as CronJobView;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) {
      log.warn(
        { name: ETCD_CRONJOB_NAME },
        'etcd-cronjob: CronJob not yet installed (Flux not synced); skipping',
      );
      return {
        state: 'STATE_NOT_INSTALLED',
        errorMessage: '',
        suspended: true,
        patched: false,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'etcd-cronjob: read failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      suspended: desiredSuspend,
      patched: false,
    };
  }

  const liveSuspend = live.spec?.suspend ?? true;

  // ─── 3. Patch only if mismatch ─────────────────────────────────
  if (liveSuspend === desiredSuspend) {
    return {
      state: bound ? 'STATE_OK' : 'STATE_NO_SYSTEM_TARGET',
      errorMessage: '',
      suspended: desiredSuspend,
      patched: false,
    };
  }

  const op = [{ op: 'replace' as const, path: '/spec/suspend', value: desiredSuspend }];
  try {
    await clients.batch.patchNamespacedCronJob(
      {
        name: ETCD_CRONJOB_NAME,
        namespace: ETCD_CRONJOB_NAMESPACE,
        body: op as unknown as object,
      } as unknown as Parameters<typeof clients.batch.patchNamespacedCronJob>[0],
      JSON_PATCH,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'etcd-cronjob: suspend patch failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      suspended: liveSuspend,
      patched: false,
    };
  }

  log.info(
    {
      name: ETCD_CRONJOB_NAME,
      previous: liveSuspend,
      next: desiredSuspend,
    },
    'etcd-cronjob: spec.suspend toggled',
  );

  return {
    state: bound ? 'STATE_OK' : 'STATE_NO_SYSTEM_TARGET',
    errorMessage: '',
    suspended: desiredSuspend,
    patched: true,
  };
}

// ---------------------------------------------------------------------------
// DB query
// ---------------------------------------------------------------------------

async function isSystemTargetBound(db: Database): Promise<boolean> {
  const rows = await db
    .select({
      enabled: backupConfigurations.enabled,
    })
    .from(backupTargetAssignments)
    .innerJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(
      inArray(backupTargetAssignments.backupClass, ['system']),
    )
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  if (rows.length === 0) return false;
  return rows[0].enabled === 1;
}
