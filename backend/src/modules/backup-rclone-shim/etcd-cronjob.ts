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

import {
  LABEL_HEALTH_WATCH,
  LABEL_CATEGORY,
  LABEL_SEVERITY,
  ANNOTATION_DISPLAY_NAME,
} from '../backup-health/labels.js';
import { eq, inArray } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import {
  backupConfigurations,
  backupTargetAssignments,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { JSON_PATCH } from '../../shared/k8s-patch.js';
import { getClusterId } from '../system-settings/cluster-id.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Namespace where the CronJob lives. Same as the shim Service. */
export const ETCD_CRONJOB_NAMESPACE = 'platform';
export const ETCD_CRONJOB_NAME = 'etcd-snap-via-shim';

/** Identifier on every reconciler-managed log entry. */
export const ETCD_FIELD_MANAGER = 'platform-api-etcd-cronjob';

/**
 * Flux skip-annotation. The static manifest ships it (seed-then-disown), but
 * Flux skips applying any source object that already carries it — so on an
 * already-existing CronJob the annotation never reaches the live object from
 * Flux. This reconciler re-stamps it onto the live object (same as the postgres
 * ObjectStore reconciler) so Flux reliably disowns the CronJob and never reverts
 * the reconciler-owned SHIM_PREFIX / suspend fields.
 */
export const FLUX_RECONCILE_ANNOTATION = 'kustomize.toolkit.fluxcd.io/reconcile';
/** JSON-Pointer to the annotation; the `/` in the key is escaped as `~1`. */
const FLUX_RECONCILE_ANNOTATION_POINTER =
  '/metadata/annotations/kustomize.toolkit.fluxcd.io~1reconcile';

/**
 * Backup-health discovery labels for the Jobs this CronJob creates.
 *
 * They cannot arrive from the manifest. This CronJob is seed-then-disown: once
 * the reconciler stamps `kustomize.toolkit.fluxcd.io/reconcile: disabled` on the
 * live object, Flux reports `skipped` for it forever, so editing
 * k8s/base/backup/etcd-snap-via-shim-cronjob.yaml only ever reaches a FRESH
 * install. Verified on DEV 2026-09-15: the manifest carried the block, the live
 * object's `spec.jobTemplate.metadata` was `{}`, and kustomize-controller logged
 * `"CronJob/platform/etcd-snap-via-shim":"skipped"`.
 *
 * They go on the JOB TEMPLATE, not the CronJob: the CronJob controller builds
 * each Job's ObjectMeta from `spec.jobTemplate.metadata` only, and the
 * backup-health watcher selects Jobs.
 */
const JOB_TEMPLATE_LABELS: Readonly<Record<string, string>> = {
  [LABEL_HEALTH_WATCH]: 'true',
  [LABEL_CATEGORY]: 'dr',
  [LABEL_SEVERITY]: 'critical',
};
const JOB_TEMPLATE_ANNOTATIONS: Readonly<Record<string, string>> = {
  [ANNOTATION_DISPLAY_NAME]: 'etcd snapshot via shim',
};

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
  metadata?: {
    annotations?: Record<string, string>;
  };
  spec?: {
    suspend?: boolean;
    jobTemplate?: {
      metadata?: {
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
      spec?: {
        template?: {
          spec?: {
            containers?: Array<{ env?: Array<{ name?: string; value?: string }> }>;
          };
        };
      };
    };
  };
}

/**
 * Job-template metadata to write, or null when the live object already carries
 * every desired key.
 *
 * Returning null on convergence preserves the reconciler's idempotence
 * contract: a settled CronJob produces zero ops and therefore zero apiserver
 * calls. Merging over the live values rather than replacing them means a label
 * an operator added to the job template survives.
 */
export function desiredJobTemplateMetadata(live: CronJobView): {
  labels: Record<string, string>;
  annotations: Record<string, string>;
} | null {
  const liveLabels = live.spec?.jobTemplate?.metadata?.labels ?? {};
  const liveAnnotations = live.spec?.jobTemplate?.metadata?.annotations ?? {};
  const converged =
    Object.entries(JOB_TEMPLATE_LABELS).every(([k, v]) => liveLabels[k] === v)
    && Object.entries(JOB_TEMPLATE_ANNOTATIONS).every(([k, v]) => liveAnnotations[k] === v);
  if (converged) return null;
  return {
    labels: { ...liveLabels, ...JOB_TEMPLATE_LABELS },
    annotations: { ...liveAnnotations, ...JOB_TEMPLATE_ANNOTATIONS },
  };
}

/**
 * Locate the SHIM_PREFIX env (the etcd upload prefix) in the live CronJob, so
 * we can patch it by index — found by NAME, robust to env reordering. Returns
 * the JSON-pointer to its `value` + the current value, or null if absent.
 */
function findShimPrefixEnv(live: CronJobView): { path: string; current: string | undefined } | null {
  const containers = live.spec?.jobTemplate?.spec?.template?.spec?.containers ?? [];
  for (let ci = 0; ci < containers.length; ci++) {
    const envs = containers[ci]?.env ?? [];
    for (let ei = 0; ei < envs.length; ei++) {
      if (envs[ei]?.name === 'SHIM_PREFIX') {
        return {
          path: `/spec/jobTemplate/spec/template/spec/containers/${ci}/env/${ei}/value`,
          current: envs[ei]?.value,
        };
      }
    }
  }
  return null;
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
  // ─── 1. Resolve desired suspend state + the cluster_id-namespaced
  //         upload prefix from the DB ─────────────────────────────
  const bound = await isSystemTargetBound(db);
  const desiredSuspend = !bound;
  // Namespace etcd snapshots by the stable cluster_id so two clusters sharing
  // one S3 target never cross-contaminate (a `--latest` restore could otherwise
  // pull ANOTHER cluster's etcd snapshot — catastrophic). Path becomes
  // `<bucket>/etcd/<cluster_id>/<host>-<ts>.db`.
  const desiredPrefix = `etcd/${await getClusterId(db)}`;

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

  // ─── 3. Build the patch — suspend toggle + cluster_id prefix +
  //         Flux skip-annotation re-stamp ─────────────────────────
  // Each op is independent and added only on drift (idempotent: a fully
  // converged CronJob → empty ops → no apiserver call). The re-stamp makes the
  // live object carry `reconcile: disabled` so Flux disowns it and never reverts
  // the SHIM_PREFIX / suspend fields this reconciler owns (seed-then-disown).
  const ops: Array<{ op: 'replace' | 'add'; path: string; value: unknown }> = [];
  if (liveSuspend !== desiredSuspend) {
    ops.push({ op: 'replace', path: '/spec/suspend', value: desiredSuspend });
  }
  const prefixEnv = findShimPrefixEnv(live);
  if (prefixEnv && prefixEnv.current !== desiredPrefix) {
    ops.push({ op: 'replace', path: prefixEnv.path, value: desiredPrefix });
  }
  // `add` upserts the annotation (replaces if present, creates if not). The
  // parent `/metadata/annotations` always exists — the manifest ships a
  // backup-display-name annotation. Only stamped when not already disabled.
  if (live.metadata?.annotations?.[FLUX_RECONCILE_ANNOTATION] !== 'disabled') {
    ops.push({ op: 'add', path: FLUX_RECONCILE_ANNOTATION_POINTER, value: 'disabled' });
  }
  // Backup-health discovery labels on the JOB TEMPLATE. Disowning this CronJob
  // from Flux also disowned it from the manifest that carries them, so the
  // reconciler has to converge them itself or the Jobs stay invisible to the
  // watcher forever.
  const jtMeta = desiredJobTemplateMetadata(live);
  if (jtMeta) {
    // ONE `add` of the whole metadata object, merged over what is live:
    // `add /spec/jobTemplate/metadata/labels` returns 422 on a CronJob whose
    // `metadata` key is absent, and replacing the object wholesale would drop
    // anything else already under it.
    ops.push({ op: 'add', path: '/spec/jobTemplate/metadata', value: jtMeta });
  }

  if (ops.length === 0) {
    return {
      state: bound ? 'STATE_OK' : 'STATE_NO_SYSTEM_TARGET',
      errorMessage: '',
      suspended: desiredSuspend,
      patched: false,
    };
  }

  try {
    await clients.batch.patchNamespacedCronJob(
      {
        name: ETCD_CRONJOB_NAME,
        namespace: ETCD_CRONJOB_NAMESPACE,
        body: ops as unknown as object,
      } as unknown as Parameters<typeof clients.batch.patchNamespacedCronJob>[0],
      JSON_PATCH,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'etcd-cronjob: patch failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      suspended: liveSuspend,
      patched: false,
    };
  }

  log.info(
    { name: ETCD_CRONJOB_NAME, suspend: desiredSuspend, prefix: desiredPrefix, ops: ops.length },
    'etcd-cronjob: reconciled (suspend + cluster_id prefix)',
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
