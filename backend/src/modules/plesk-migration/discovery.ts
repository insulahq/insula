/**
 * Plesk discovery orchestrator (R1 PR 1).
 *
 * Runs a read-only inventory of a Plesk source as a one-shot k8s Job
 * in the `plesk-migration` namespace, using the existing
 * tenant-backup-tools image (ssh + python3 + rsync — no new image). The
 * SSH key is delivered via a per-job Secret; the discovery scripts via
 * a per-job ConfigMap (so no image rebuild). The Job ssh's to the
 * Plesk box, runs the read-only remote script, assembles JSON, and
 * prints it between sentinels; we tail the log, parse, and persist.
 *
 * The per-job Secret + ConfigMap are deleted in a finally block; the
 * Job's ttlSecondsAfterFinished (+ a 5-min activeDeadline) is the
 * backstop if the backend dies mid-run.
 */

import { eq, and, inArray, lt, sql } from 'drizzle-orm';
import { pleskSources, pleskDiscoveries } from '../../db/schema.js';
import { sourceAuthSecretData, sourceAuthEnv, sourceAuthKeyVolume } from './ssh-auth.js';
import {
  REMOTE_DISCOVER_SH,
  ASSEMBLE_PY,
  RUNNER_SH,
  INVENTORY_BEGIN,
  INVENTORY_END,
} from './discovery-scripts.js';
import { pleskInventorySchema, type PleskInventory } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export const PLESK_MIGRATION_NAMESPACE = 'plesk-migration';
// Parity with the existing Job-spawning code (backup-restore
// mailboxes-by-address TOOLS_IMAGE_DEFAULT): the mutable :latest tag is
// Flux-pinned in the deployed manifests and cached on nodes; overridable
// via env for tests. A platform-wide digest-pin is a separate effort.
const DISCOVERY_IMAGE =
  process.env.PLESK_DISCOVERY_IMAGE ?? 'ghcr.io/insulahq/insula/tenant-backup-tools:latest';

export interface DiscoveryLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

interface CoreApi {
  createNamespacedSecret: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  createNamespacedConfigMap: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
  deleteNamespacedConfigMap: (a: { name: string; namespace: string }) => Promise<unknown>;
  listNamespacedPod: (a: { namespace: string; labelSelector: string; limit?: number }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
  readNamespacedPodLog: (a: { name: string; namespace: string; container?: string }) => Promise<string>;
}

/**
 * Read the FULL stdout of a Job's pod. (tailJobLog returns only the
 * last line — wrong here: the inventory JSON sits between sentinels and
 * we need the whole block. The discovery pod's stdout is just the
 * assembler's 3 lines, so reading it whole is cheap.)
 */
async function readFullJobLog(core: CoreApi, namespace: string, jobName: string): Promise<string | null> {
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}`, limit: 1 }).catch(() => ({ items: [] }));
  const podName = pods.items?.[0]?.metadata?.name;
  if (!podName) return null;
  return core.readNamespacedPodLog({ name: podName, namespace }).catch(() => null);
}
interface BatchApi {
  createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{ status?: { succeeded?: number; failed?: number } }>;
  deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref(); });
}

/**
 * Kick off a discovery: insert the pending row, then run the Job in
 * the background (fire-and-forget) updating the row as it progresses.
 * Returns the discovery id immediately so the UI can poll.
 */
export async function startDiscovery(
  db: Database,
  k8s: K8sClients | undefined,
  sourceId: string,
  discoveryId: string,
  logger: DiscoveryLogger,
): Promise<void> {
  if (!k8s) {
    await db.update(pleskDiscoveries)
      .set({ status: 'failed', error: 'no kubernetes client available', completedAt: new Date() })
      .where(eq(pleskDiscoveries.id, discoveryId));
    return;
  }
  void runDiscovery(db, k8s, sourceId, discoveryId, logger).catch(async (err) => {
    logger.error({ err, discoveryId }, 'plesk discovery: unhandled failure');
    await db.update(pleskDiscoveries)
      .set({ status: 'failed', error: err instanceof Error ? err.message : String(err), completedAt: new Date() })
      .where(eq(pleskDiscoveries.id, discoveryId))
      .catch(() => {});
  });
}

async function runDiscovery(
  db: Database,
  k8s: K8sClients,
  sourceId: string,
  discoveryId: string,
  logger: DiscoveryLogger,
): Promise<void> {
  const [source] = await db.select().from(pleskSources).where(eq(pleskSources.id, sourceId));
  if (!source) throw new Error(`source ${sourceId} vanished`);

  const core = k8s.core as unknown as CoreApi;
  const batch = k8s.batch as unknown as BatchApi;
  const short = discoveryId.slice(0, 8);
  const jobName = `plesk-disc-${short}`;
  const secretName = `plesk-disc-key-${short}`;
  const cmName = `plesk-disc-scripts-${short}`;

  await db.update(pleskDiscoveries).set({ status: 'running' }).where(eq(pleskDiscoveries.id, discoveryId));

  try {
    // 1. Secret (SSH key) + 2. ConfigMap (scripts), then the Job.
    // backup-coverage: excluded:transient-discovery-job
    // (operator SSH key for a short-lived read-only Job; deleted in the
    //  finally block — no tenant data, nothing to back up.)
    await core.createNamespacedSecret({
      namespace: PLESK_MIGRATION_NAMESPACE,
      body: {
        metadata: { name: secretName, namespace: PLESK_MIGRATION_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'platform-api', 'platform.io/discovery-id': discoveryId } },
        type: 'Opaque',
        // Key auth → id_rsa (normalized so OpenSSH accepts it); password
        // auth → ssh_password (injected to the Job as the SSHPASS env).
        stringData: sourceAuthSecretData(source),
      },
    });
    await core.createNamespacedConfigMap({
      namespace: PLESK_MIGRATION_NAMESPACE,
      body: {
        metadata: { name: cmName, namespace: PLESK_MIGRATION_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'platform-api', 'platform.io/discovery-id': discoveryId } },
        data: { 'remote-discover.sh': REMOTE_DISCOVER_SH, 'assemble.py': ASSEMBLE_PY, 'runner.sh': RUNNER_SH },
      },
    });

    const job = buildDiscoveryJob({ jobName, secretName, cmName, source });
    await batch.createNamespacedJob({ namespace: PLESK_MIGRATION_NAMESPACE, body: job });
    // The finally block is the authoritative cleanup for the Secret +
    // ConfigMap; the Job's ttlSecondsAfterFinished is the backstop.

    // 3. Poll for terminal state (discovery is seconds; cap ~5 min).
    let succeeded = false;
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const st = await batch.readNamespacedJob({ name: jobName, namespace: PLESK_MIGRATION_NAMESPACE })
        .catch((): { status?: { succeeded?: number; failed?: number } } => ({ status: {} }));
      if (st.status?.succeeded && st.status.succeeded > 0) { succeeded = true; break; }
      if (st.status?.failed && st.status.failed > 0) break;
    }

    const log = await readFullJobLog(core, PLESK_MIGRATION_NAMESPACE, jobName);
    const logTail = (log ?? '').slice(-8000);

    if (!succeeded) {
      await db.update(pleskDiscoveries)
        .set({ status: 'failed', error: discoveryFailureReason(logTail), logTail, completedAt: new Date() })
        .where(eq(pleskDiscoveries.id, discoveryId));
      return;
    }

    const inventory = parseInventory(log ?? '');
    if (!inventory) {
      await db.update(pleskDiscoveries)
        .set({ status: 'failed', error: 'could not parse inventory from job output', logTail, completedAt: new Date() })
        .where(eq(pleskDiscoveries.id, discoveryId));
      return;
    }

    // Success: persist the structured inventory only. logTail (raw job
    // output, carries mailbox PII) is kept ONLY on failure for debugging.
    await db.update(pleskDiscoveries)
      .set({ status: 'completed', inventory, logTail: null, completedAt: new Date() })
      .where(eq(pleskDiscoveries.id, discoveryId));
    await db.update(pleskSources)
      .set({
        pleskVersion: inventory.pleskVersion ?? source.pleskVersion,
        passwordStorage: inventory.passwordStorage ?? source.passwordStorage,
        lastDiscoveredAt: new Date(),
        status: 'discovered',
      })
      .where(eq(pleskSources.id, sourceId));
    logger.info({ discoveryId, subscriptions: inventory.subscriptions.length }, 'plesk discovery: completed');
  } finally {
    await batch.deleteNamespacedJob({ name: jobName, namespace: PLESK_MIGRATION_NAMESPACE, propagationPolicy: 'Background' }).catch(() => {});
    await core.deleteNamespacedSecret({ name: secretName, namespace: PLESK_MIGRATION_NAMESPACE }).catch(() => {});
    await core.deleteNamespacedConfigMap({ name: cmName, namespace: PLESK_MIGRATION_NAMESPACE }).catch(() => {});
  }
}

/**
 * A concrete, operator-facing failure reason derived from the Job log — the
 * discovery response only exposes `error` (not the raw logTail), so surface
 * WHY here instead of a generic "did not complete". Especially important for
 * password auth, where a typo must read as an auth failure, not "empty".
 */
export function discoveryFailureReason(logTail: string): string {
  const t = logTail || '';
  if (/Permission denied|Authentication failed|sshpass:/i.test(t)) {
    return 'SSH authentication failed — check the key or password (and that the user may log in)';
  }
  if (/Connection timed out|Connection refused|No route to host|Could not resolve|Name or service not known/i.test(t)) {
    return 'could not reach the host — check the hostname/IP and SSH port';
  }
  if (/plesk version.*empty|plesk db.*unreachable|not a Plesk box/i.test(t)) {
    return 'connected, but this host is not a usable Plesk server (the plesk CLI/DB was unreachable)';
  }
  if (/ssh\/remote command failed/i.test(t)) {
    return 'the remote discovery command failed — wrong credential, unreachable host, or not a Plesk box';
  }
  return 'discovery job did not complete (timeout or ssh failure)';
}

/** Extract + validate the inventory JSON from the Job log. */
export function parseInventory(log: string): PleskInventory | null {
  const begin = log.indexOf(INVENTORY_BEGIN);
  const end = log.indexOf(INVENTORY_END);
  if (begin < 0 || end < 0 || end < begin) return null;
  const json = log.slice(begin + INVENTORY_BEGIN.length, end).trim();
  try {
    const parsed = pleskInventorySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface BuildJobParams {
  jobName: string;
  secretName: string;
  cmName: string;
  source: typeof pleskSources.$inferSelect;
}

export function buildDiscoveryJob({ jobName, secretName, cmName, source }: BuildJobParams): unknown {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: PLESK_MIGRATION_NAMESPACE,
      labels: { 'app.kubernetes.io/name': 'plesk-discovery', 'app.kubernetes.io/managed-by': 'platform-api' },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: 300,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'plesk-discovery' } },
        spec: {
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true, runAsUser: 65534, fsGroup: 65534,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [{
            name: 'discover',
            image: DISCOVERY_IMAGE,
            // Always-pull: the :latest tag must not serve a stale cached layer
            // on a node that ran an earlier migration Job.
            imagePullPolicy: 'Always',
            command: ['sh', '/etc/plesk-scripts/runner.sh'],
            env: [
              { name: 'PLESK_HOST', value: source.hostname },
              { name: 'PLESK_PORT', value: String(source.sshPort) },
              { name: 'PLESK_USER', value: source.sshUser },
              { name: 'HOME', value: '/tmp' },
              ...sourceAuthEnv(source, secretName),
            ],
            volumeMounts: [
              ...sourceAuthKeyVolume(source, secretName).volumeMounts,
              { name: 'plesk-scripts', mountPath: '/etc/plesk-scripts', readOnly: true },
              { name: 'tmp', mountPath: '/tmp' },
            ],
            resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          }],
          volumes: [
            ...sourceAuthKeyVolume(source, secretName).volumes,
            { name: 'plesk-scripts', configMap: { name: cmName } },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}

/**
 * Startup sweep: a backend restart mid-poll orphans the fire-and-forget
 * runner, leaving discoveries stuck in pending/running. Fail any older
 * than the Job's activeDeadline (5 min) + slack so the UI spinner
 * resolves. Idempotent; safe to call on every boot.
 */
export async function failStaleDiscoveries(db: Database): Promise<number> {
  const rows = await db
    .update(pleskDiscoveries)
    .set({ status: 'failed', error: 'backend restarted while the discovery job was in flight', completedAt: new Date() })
    .where(and(
      inArray(pleskDiscoveries.status, ['pending', 'running']),
      lt(pleskDiscoveries.startedAt, sql`NOW() - INTERVAL '10 minutes'`),
    ))
    .returning({ id: pleskDiscoveries.id });
  return rows.length;
}
