/**
 * Final sync for a PLANNED mail move — the source node is alive (operator
 * migrate, failback), so nothing it received may be lost.
 *
 * The target restores from its standby copy (FAST PATH), which the
 * mail-stack-standby-replicate DaemonSet refreshes every 5 minutes. Without a
 * final sync, mail received since that last refresh was gone after the move —
 * on a VM drill, a message written a minute before a failback was missing from
 * the target. DR failover (source dead) keeps its documented ≤5-minute RPO;
 * this step never runs there.
 *
 * Runs after Stalwart and Bulwark are scaled to 0 on the source (the volume is
 * quiet) and before the PVC swap:
 *   1. a one-shot rsync publisher on the SOURCE node — the same image and
 *      rsyncd config as the Stalwart sidecar — serving the mail volume
 *      read-only (RWO local-path: a second pod on the same node may mount it);
 *   2. the replicate script, run once (LOOP_INTERVAL_SECONDS=0) on the TARGET
 *      node into the same hostPath the DaemonSet uses, pulling from (1). On
 *      success it writes the .standby-complete marker the restore gates on.
 * Both pods are always removed. A NetworkPolicy in the manifests admits only
 * the puller to the publisher.
 *
 * Never throws: returns { ok: false, reason } so the caller rolls back.
 */
import type { AppsV1Api, CoreV1Api } from '@kubernetes/client-node';

export const FINAL_SYNC_PUBLISHER_APP = 'mail-final-sync-publisher';
export const FINAL_SYNC_PULLER_APP = 'mail-final-sync-puller';

const MAIL_NS = 'mail';
const RSYNC_PORT = 873;
const STALWART_DEPLOYMENT = 'stalwart-mail';
const RSYNCD_CONTAINER = 'rsyncd';
const RSYNCD_CONFIG_MAP = 'mail-stack-rsyncd-config';
const REPLICATE_DAEMONSET = 'mail-stack-standby-replicate';
const STANDBY_HOST_PATH = '/var/lib/mail-stack-standby';
const PUBLISHER_READY_SECONDS = 120;
const POLL_MS = 2_000;

export interface FinalSyncDeps {
  readonly core: Pick<CoreV1Api, 'createNamespacedPod' | 'readNamespacedPod' | 'deleteNamespacedPod' | 'readNamespacedPodLog'>;
  readonly apps: Pick<AppsV1Api, 'readNamespacedDeployment' | 'readNamespacedDaemonSet'>;
  readonly log: { info: (msg: string) => void; warn: (msg: string) => void };
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Operator cancel, polled between reads — mail is down for this whole step. */
  readonly cancelCheck?: () => Promise<boolean>;
}

export interface FinalSyncInput {
  readonly runId: string;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly pvcName: string;
  /** Budget for the pull itself; a target with no earlier copy pulls everything. */
  readonly timeoutSeconds?: number;
}

export type FinalSyncResult =
  | { readonly ok: true; readonly durationMs: number }
  | { readonly ok: false; readonly reason: string; readonly cancelled?: true };

const CANCELLED: FinalSyncResult = { ok: false, reason: 'cancelled by the operator', cancelled: true };

/** rsync daemon URL of the publisher pod (IPv6 addresses bracketed). */
export function rsyncUrlFor(podIP: string): string {
  const host = podIP.includes(':') ? `[${podIP}]` : podIP;
  return `rsync://${host}:${RSYNC_PORT}/mail-stack/`;
}

type PodStatus = { status?: { phase?: string; podIP?: string; conditions?: Array<{ type?: string; status?: string }> } };
type Containers = { spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } } };

export async function runFinalStandbySync(deps: FinalSyncDeps, input: FinalSyncInput): Promise<FinalSyncResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const started = now();
  const suffix = input.runId.slice(0, 8);
  const publisherName = `mail-final-sync-pub-${suffix}`;
  const pullerName = `mail-final-sync-pull-${suffix}`;
  const created: string[] = [];
  try {
    // The cluster's own images: the sidecar's rsync, the DaemonSet's tools image.
    const deploy = await deps.apps.readNamespacedDeployment({ name: STALWART_DEPLOYMENT, namespace: MAIL_NS }) as Containers;
    const rsyncImage = deploy.spec?.template?.spec?.containers?.find((c) => c.name === RSYNCD_CONTAINER)?.image;
    const ds = await deps.apps.readNamespacedDaemonSet({ name: REPLICATE_DAEMONSET, namespace: MAIL_NS }) as Containers;
    const toolsImage = ds.spec?.template?.spec?.containers?.[0]?.image;
    if (!rsyncImage || !toolsImage) {
      return { ok: false, reason: `could not resolve the rsync/tools images (rsyncd=${rsyncImage ?? 'none'}, replicate=${toolsImage ?? 'none'})` };
    }

    await deps.core.createNamespacedPod({ namespace: MAIL_NS, body: publisherPod(publisherName, input, rsyncImage) } as never);
    created.push(publisherName);
    const podIP = await waitForPublisher(deps, publisherName, sleep, now);
    if (podIP === CANCELLED_MARK) return CANCELLED;
    if (!podIP) {
      return { ok: false, reason: `the rsync publisher on ${input.sourceNode} did not become Ready within ${PUBLISHER_READY_SECONDS}s` };
    }

    await deps.core.createNamespacedPod({ namespace: MAIL_NS, body: pullerPod(pullerName, input, toolsImage, rsyncUrlFor(podIP)) } as never);
    created.push(pullerName);
    const deadline = now() + (input.timeoutSeconds ?? 1800) * 1000;
    for (;;) {
      if (deps.cancelCheck && await deps.cancelCheck()) return CANCELLED;
      const pod = await deps.core.readNamespacedPod({ name: pullerName, namespace: MAIL_NS }) as PodStatus;
      const phase = pod.status?.phase;
      if (phase === 'Succeeded') {
        const durationMs = now() - started;
        deps.log.info(`[final-sync ${suffix}] ${input.sourceNode} → ${input.targetNode} standby copy current (${Math.round(durationMs / 1000)}s)`);
        return { ok: true, durationMs };
      }
      if (phase === 'Failed') {
        return { ok: false, reason: `the pull on ${input.targetNode} failed: ${await logTail(deps, pullerName)}` };
      }
      if (now() >= deadline) {
        return { ok: false, reason: `the pull on ${input.targetNode} did not finish within ${input.timeoutSeconds ?? 1800}s` };
      }
      await sleep(POLL_MS);
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message ?? String(err) };
  } finally {
    for (const name of created) {
      await deps.core.deleteNamespacedPod({ name, namespace: MAIL_NS, gracePeriodSeconds: 0 } as never)
        .catch((e: unknown) => deps.log.warn(`[final-sync ${suffix}] could not remove pod ${name}: ${(e as Error).message}`));
    }
  }
}

/** Returned by waitForPublisher on cancel — never a pod IP. */
const CANCELLED_MARK = 'cancelled';

async function waitForPublisher(
  deps: FinalSyncDeps,
  name: string,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<string | null> {
  const deadline = now() + PUBLISHER_READY_SECONDS * 1000;
  for (;;) {
    if (deps.cancelCheck && await deps.cancelCheck()) return CANCELLED_MARK;
    const pod = await deps.core.readNamespacedPod({ name, namespace: MAIL_NS }) as PodStatus;
    const ready = (pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
    if (ready && pod.status?.podIP) return pod.status.podIP;
    if (pod.status?.phase === 'Failed' || now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

async function logTail(deps: FinalSyncDeps, name: string): Promise<string> {
  try {
    const text = String(await deps.core.readNamespacedPodLog({ name, namespace: MAIL_NS, tailLines: 5 } as never));
    return text.trim().split('\n').slice(-2).join(' | ').slice(0, 400) || 'no log output';
  } catch {
    return 'log unavailable';
  }
}

function labels(app: string, input: FinalSyncInput): Record<string, string> {
  return {
    app,
    'app.kubernetes.io/part-of': 'hosting-platform',
    'app.kubernetes.io/component': 'mail-final-sync',
    'insula.host/mail-migration-run': input.runId.slice(0, 63),
  };
}

function publisherPod(name: string, input: FinalSyncInput, image: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: MAIL_NS, labels: labels(FINAL_SYNC_PUBLISHER_APP, input) },
    spec: {
      nodeName: input.sourceNode,
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      // Pinned to an exact node by nodeName (which bypasses the scheduler);
      // tolerate everything so a node taint can never strand the copy.
      tolerations: [{ operator: 'Exists' }],
      containers: [{
        name: 'rsyncd',
        image,
        command: ['rsync'],
        args: ['--daemon', '--no-detach', '--config=/etc/rsyncd.conf', `--port=${RSYNC_PORT}`, '--log-file=/dev/stdout'],
        ports: [{ name: 'rsync', containerPort: RSYNC_PORT, protocol: 'TCP' }],
        readinessProbe: { tcpSocket: { port: RSYNC_PORT }, periodSeconds: 2 },
        volumeMounts: [
          { name: 'data', mountPath: '/data', readOnly: true },
          { name: 'rsyncd-config', mountPath: '/etc/rsyncd.conf', subPath: 'rsyncd.conf', readOnly: true },
          { name: 'tmp', mountPath: '/tmp' },
        ],
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 65534,
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
        resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '1', memory: '256Mi' } },
      }],
      volumes: [
        { name: 'data', persistentVolumeClaim: { claimName: input.pvcName, readOnly: true } },
        { name: 'rsyncd-config', configMap: { name: RSYNCD_CONFIG_MAP } },
        { name: 'tmp', emptyDir: { sizeLimit: '10Mi' } },
      ],
    },
  };
}

function pullerPod(name: string, input: FinalSyncInput, image: string, url: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: MAIL_NS, labels: labels(FINAL_SYNC_PULLER_APP, input) },
    spec: {
      nodeName: input.targetNode,
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      tolerations: [{ operator: 'Exists' }],
      containers: [{
        name: 'pull',
        image,
        command: ['/usr/local/bin/standby-replicate.sh'],
        env: [
          { name: 'LOOP_INTERVAL_SECONDS', value: '0' },
          { name: 'PUBLISHER_RSYNC_URL', value: url },
          { name: 'NODE_NAME', value: input.targetNode },
        ],
        volumeMounts: [{ name: 'standby-data', mountPath: '/standby-data' }],
        resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '1', memory: '512Mi' } },
      }],
      volumes: [{ name: 'standby-data', hostPath: { path: STANDBY_HOST_PATH, type: 'DirectoryOrCreate' } }],
    },
  };
}
