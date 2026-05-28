/**
 * Mail standby de-election cleanup (2026-05-28).
 *
 * When the operator changes secondary/tertiary placement, the
 * `mail-stack-standby-replicate` DaemonSet pod stops scheduling on
 * the de-elected node (its label `mail-standby=true` is removed by
 * reconcileMailStandbyLabel in placement.ts). But the on-disk standby
 * data at `/var/lib/mail-stack-standby/` stays, leaking disk space and
 * — if the same node is later re-elected — could be silently read by
 * the FAST PATH copy gated on `.standby-complete`.
 *
 * This module schedules a one-shot Job pinned to the de-elected node
 * that renames the directory to
 * `/var/lib/mail-stack-standby.deelected-<unix-ts>/`. The sibling
 * janitor CronJob (`k8s/base/mail-standby/janitor-cron.yaml`)
 * removes anything matching `.deelected-*` older than 48h, so
 * operators have a recovery window if they swap secondaries by mistake.
 *
 * The rename — not delete — is the central safety invariant. An
 * accidental secondary swap that immediately wiped 10s of GB of standby
 * data would force a full primary→secondary re-sync (minutes to hours
 * depending on mailbox size); the rename keeps the bytes recoverable
 * for two days.
 */

import { ApiError } from '../../shared/errors.js';

/**
 * Job-name prefix; sanitised node name is appended. Exported so the
 * janitor can use the same matching pattern.
 */
export const STANDBY_CLEANUP_JOB_NAME_PREFIX = 'mail-standby-deelect-';

const MAIL_NS = 'mail';
const HOST_LIB_PATH = '/var/lib';
const STANDBY_DIR_NAME = 'mail-stack-standby';

/**
 * Sanitise an arbitrary node name into a DNS-1123 subdomain fragment
 * (lowercase, `[a-z0-9-]` only). K8s Job names must satisfy DNS-1123
 * and we want stability — the same input yields the same output, and
 * two distinct inputs are vanishingly unlikely to collide (the trailing
 * 8-char hash prevents collision between `worker.example.com` and
 * `worker-example-com` neighbours).
 */
function sanitiseNodeNameForJob(nodeName: string): string {
  // Replace any non-[a-z0-9-] with '-'; collapse runs; trim dashes
  const slug = nodeName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Cheap deterministic 8-hex hash (FNV-1a) so distinct nodeNames that
  // collide post-sanitise still get distinct Job names.
  let h = 0x811c9dc5;
  for (let i = 0; i < nodeName.length; i++) {
    h ^= nodeName.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hash = (h >>> 0).toString(16).padStart(8, '0');
  // Total budget: 63 (DNS-1123 label). Prefix 22 + '-' + hash 8 = 31.
  // Leaves 32 for the sanitised slug. Truncate if needed.
  const maxSlug = 63 - STANDBY_CLEANUP_JOB_NAME_PREFIX.length - 1 - hash.length;
  const truncated = slug.slice(0, Math.max(1, maxSlug));
  return `${STANDBY_CLEANUP_JOB_NAME_PREFIX}${truncated}-${hash}`;
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; statusCode?: number; body?: { code?: number } };
  const code = e.code ?? e.statusCode ?? e.body?.code;
  return code === 409;
}

/**
 * Schedule a one-shot Job on `nodeName` that mv's
 * `/var/lib/mail-stack-standby` → `/var/lib/mail-stack-standby.deelected-<ts>`.
 *
 * Idempotent over time: the Job name encodes a hash of `nodeName`, so a
 * second call for the same node within the existing Job's lifetime
 * (Job is name-stable, K8s rejects duplicates with 409) is a no-op.
 * After ttlSecondsAfterFinished elapses the Job is GC'd and a new
 * de-election (e.g., the same node re-elected and re-de-elected) can
 * schedule a fresh Job.
 *
 * If `/var/lib/mail-stack-standby` doesn't exist on the node (never
 * served as standby), the Job exits successfully — the rename uses
 * `|| true` to tolerate the missing source.
 */
export async function spawnStandbyDeelectionCleanupJob(
  batch: Pick<import('@kubernetes/client-node').BatchV1Api, 'createNamespacedJob'>,
  nodeName: string,
): Promise<void> {
  const jobName = sanitiseNodeNameForJob(nodeName);
  // Timestamp captured at Job-creation time, not container-run time, so
  // the rename target is predictable from outside (helps debugging) and
  // doesn't depend on container clock skew.
  const ts = Math.floor(Date.now() / 1000);
  const renameTarget = `${STANDBY_DIR_NAME}.deelected-${ts}`;

  const body = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: MAIL_NS,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'mail-standby-cleanup',
        'platform.phoenix-host.net/de-elected-node': nodeName.slice(0, 63),
      },
    },
    spec: {
      // Self-clean within 1h of completion (success or fail).
      ttlSecondsAfterFinished: 3600,
      // The rename itself is sub-second; 300s covers slow disks +
      // hostPath mount races. Hard deadline so a wedged Job doesn't
      // accumulate.
      activeDeadlineSeconds: 300,
      backoffLimit: 1,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/component': 'mail-standby-cleanup',
            'platform.phoenix-host.net/de-elected-node': nodeName.slice(0, 63),
          },
        },
        spec: {
          // Pin to the de-elected node — that's where the on-disk data
          // lives. Without nodeName the scheduler could place this on
          // any node and the rename would be a no-op.
          nodeName,
          restartPolicy: 'OnFailure',
          // Tolerate everything so the cleanup runs even if the node is
          // tainted (cordoned for maintenance, etc.). The work is
          // entirely local + read-write on /var/lib, no cluster I/O.
          tolerations: [{ operator: 'Exists' }],
          containers: [
            {
              name: 'rename',
              image: 'busybox:1.36',
              command: ['sh', '-c'],
              args: [
                // Absolute paths (under the /host hostPath mount); the
                // `|| { echo … exit 0 }` clause tolerates the source
                // not existing (this node never actually served as
                // standby — e.g., DaemonSet pod was evicted before any
                // data replicated).
                `set -eu; ` +
                  `mv /host/${STANDBY_DIR_NAME} /host/${renameTarget} 2>/dev/null || ` +
                  `{ echo "no /host/${STANDBY_DIR_NAME} to rename (node never served as standby?)"; exit 0; }; ` +
                  `echo "renamed /var/lib/${STANDBY_DIR_NAME} -> /var/lib/${renameTarget}"`,
              ],
              securityContext: {
                runAsUser: 0,
                runAsNonRoot: false,
                // mv via hostPath requires CAP_DAC_OVERRIDE only if
                // the source has different ownership; running as root
                // covers it.
              },
              volumeMounts: [
                { name: 'host-var-lib', mountPath: '/host' },
              ],
              resources: {
                requests: { cpu: '10m', memory: '16Mi' },
                limits: { cpu: '100m', memory: '64Mi' },
              },
            },
          ],
          volumes: [
            {
              name: 'host-var-lib',
              hostPath: { path: HOST_LIB_PATH, type: 'Directory' },
            },
          ],
        },
      },
    },
  };

  try {
    await batch.createNamespacedJob({
      namespace: MAIL_NS,
      body: body as unknown as Parameters<typeof batch.createNamespacedJob>[0]['body'],
    });
  } catch (err) {
    if (isConflict(err)) {
      // A previous reconciler tick (or another platform-api replica)
      // already created the Job. The existing Job is doing exactly
      // what we'd do, so treat as success.
      return;
    }
    throw new ApiError(
      'MAIL_STANDBY_CLEANUP_JOB_FAILED',
      `Failed to create standby de-election cleanup Job on node ${nodeName}: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }
}
