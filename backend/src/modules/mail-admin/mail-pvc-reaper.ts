/**
 * Reap the mail-store directories that failovers leave behind.
 *
 * The mail stack uses `local-path` on purpose (RocksDB needs the node's NVMe,
 * and Longhorn measured 3-7x slower). The consequence is that a failover
 * cannot move the volume: it DELETES the PVC and creates a fresh one on the
 * target node. The old PVC's directory then sits on the source node's disk
 * forever.
 *
 * Measured on staging 2026-09-11 after a day of drills: six orphaned
 * `pvc-*_mail_mail-stack-data` directories across three nodes alongside the
 * single live one. Nothing reaped them — the `mail-standby-janitor` DaemonSet
 * only scans for `mail-stack-standby.deelected-*`, and `orphaned-volumes`
 * classifies PV objects for deleted tenants, so neither looks at a local-path
 * directory whose PV is already gone.
 *
 * On a real mail store this is a capacity bug with teeth: every failover
 * permanently consumes another full copy of the mailbox data on the node it
 * left. Two failovers on a 40 GB store leak 80 GB, and the resulting disk
 * pressure is itself a cause of node outages.
 *
 * SAFETY MODEL
 *
 * The node cannot know which directory is live — that fact lives in the PV's
 * nodeAffinity + local.path. So platform-api resolves the live directory and
 * passes it to the Job explicitly; the Job refuses to run without it. The Job
 * then deletes only directories that are BOTH not-the-live-one AND older than
 * the grace window, so a failover can still be reversed by hand for two days.
 */
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const MAIL_NS = 'mail';
const MAIL_PVC = 'mail-stack-data';
/** Where k3s' local-path provisioner puts PVC directories. */
export const LOCAL_PATH_STORAGE_DIR = '/var/lib/rancher/k3s/storage';
/** Only ever match the mail stack's own directories. */
export const MAIL_PVC_DIR_GLOB = '*_mail_mail-stack-data';
/**
 * Recovery window before an orphan is deleted. Matches the standby janitor's
 * 48h so operators have one consistent "you can still undo this" promise.
 */
export const ORPHAN_GRACE_HOURS = 48;

export interface LivePvcLocation {
  readonly nodeName: string;
  /** Absolute path of the directory currently backing the PVC. */
  readonly path: string;
  /** Basename — what the Job compares against. */
  readonly dirName: string;
}

interface RawPv {
  metadata?: { name?: string };
  spec?: {
    local?: { path?: string };
    claimRef?: { namespace?: string; name?: string };
    nodeAffinity?: {
      required?: { nodeSelectorTerms?: Array<{ matchExpressions?: Array<{ values?: string[] }> }> };
    };
  };
}

/**
 * Where the live mail PVC's data currently lives.
 *
 * Returns null when the PVC is unbound or mid-migration — in which case we do
 * NOT reap, because we cannot prove which directory is in use and deleting
 * the wrong one destroys the mail store.
 */
export async function resolveLiveMailPvcLocation(
  k8s: K8sClients,
): Promise<LivePvcLocation | null> {
  const pvc = (await k8s.core.readNamespacedPersistentVolumeClaim({
    namespace: MAIL_NS, name: MAIL_PVC,
  } as unknown as Parameters<typeof k8s.core.readNamespacedPersistentVolumeClaim>[0])) as {
    spec?: { volumeName?: string };
  };
  const volumeName = pvc.spec?.volumeName;
  if (!volumeName) return null;

  const pv = (await k8s.core.readPersistentVolume({
    name: volumeName,
  } as unknown as Parameters<typeof k8s.core.readPersistentVolume>[0])) as RawPv;

  const path = pv.spec?.local?.path;
  const nodeName = pv.spec?.nodeAffinity?.required?.nodeSelectorTerms?.[0]
    ?.matchExpressions?.[0]?.values?.[0];
  if (!path || !nodeName) return null;

  return { nodeName, path, dirName: path.split('/').pop() ?? '' };
}

/**
 * The shell the reaper Job runs.
 *
 * Exported so a test can assert the guards are present without standing up a
 * cluster — this script deletes data, so its safety clauses matter more than
 * its plumbing.
 *
 *   - refuses outright if LIVE_DIR is empty (can't prove what's in use)
 *   - never touches the live directory
 *   - only deletes past the grace window
 *   - glob is scoped to the mail stack's own naming
 */
export function buildReaperScript(liveDirName: string, graceHours: number): string {
  return [
    'set -eu',
    `LIVE_DIR='${liveDirName}'`,
    // Fail closed: without the live directory name we cannot tell an orphan
    // from the running mail store.
    'if [ -z "$LIVE_DIR" ]; then echo "refusing to reap: live PVC directory unknown"; exit 1; fi',
    `cd /host/storage 2>/dev/null || { echo "no local-path storage dir on this node"; exit 0; }`,
    'reaped=0; kept=0',
    `for d in ${MAIL_PVC_DIR_GLOB}; do`,
    '  [ -d "$d" ] || continue',
    '  if [ "$d" = "$LIVE_DIR" ]; then echo "keep (LIVE): $d"; kept=$((kept+1)); continue; fi',
    // -mmin rather than -mtime so the window is exact rather than rounded to
    // whole days, and -maxdepth 0 so we test the directory itself.
    `  if [ -n "$(find "$d" -maxdepth 0 -mmin +${graceHours * 60} 2>/dev/null)" ]; then`,
    '    sz=$(du -sh "$d" 2>/dev/null | cut -f1)',
    '    rm -rf "$d" && echo "reaped orphan: $d ($sz)" && reaped=$((reaped+1))',
    '  else',
    `    echo "keep (within ${graceHours}h recovery window): $d"; kept=$((kept+1))`,
    '  fi',
    'done',
    'echo "mail-pvc-reaper: reaped=$reaped kept=$kept"',
    // Newlines, NOT '; '. Joining with semicolons yields `for … do;` and
    // `if … then;`, both of which are shell syntax errors — the Job would
    // have failed on every node. Caught by generating the script and running
    // it before shipping rather than reading it.
  ].join('\n');
}

/**
 * Schedule one reaper Job per node.
 *
 * Pinned per node because the directories are node-local. Jobs are named
 * per (node x day) so repeated reconciler ticks are a no-op via 409 Conflict
 * rather than a Job storm.
 */
export async function spawnMailPvcReaperJobs(
  _db: Database,
  k8s: K8sClients,
  opts: { graceHours?: number; now?: Date; log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } } = {},
): Promise<{ scheduled: string[]; skipped: string | null }> {
  const log = opts.log ?? console;
  const graceHours = opts.graceHours ?? ORPHAN_GRACE_HOURS;
  const now = opts.now ?? new Date();

  const live = await resolveLiveMailPvcLocation(k8s);
  if (!live?.dirName) {
    const reason = 'live mail PVC location could not be resolved (unbound or mid-migration) — not reaping';
    log.warn(`[mail-pvc-reaper] ${reason}`);
    return { scheduled: [], skipped: reason };
  }

  const nodeList = (await k8s.core.listNode()) as {
    items?: Array<{ metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } }>;
  };
  const readyNodes = (nodeList.items ?? [])
    .filter((n) => (n.status?.conditions ?? []).find((c) => c.type === 'Ready')?.status === 'True')
    .map((n) => n.metadata?.name)
    .filter((n): n is string => !!n);

  const day = now.toISOString().slice(0, 10);
  const script = buildReaperScript(live.dirName, graceHours);
  const scheduled: string[] = [];

  for (const nodeName of readyNodes) {
    const jobName = `mail-pvc-reaper-${nodeName}-${day}`.toLowerCase().slice(0, 63);
    const body = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: MAIL_NS,
        labels: {
          'app.kubernetes.io/part-of': 'hosting-platform',
          'app.kubernetes.io/component': 'mail-pvc-reaper',
        },
      },
      spec: {
        ttlSecondsAfterFinished: 3600,
        activeDeadlineSeconds: 600,
        backoffLimit: 1,
        template: {
          metadata: { labels: { 'app.kubernetes.io/component': 'mail-pvc-reaper' } },
          spec: {
            nodeName,
            restartPolicy: 'OnFailure',
            // Run even on a cordoned node: the work is local disk only, and a
            // node cordoned for maintenance is exactly where leaked copies of
            // the mail store are most likely to be sitting.
            tolerations: [{ operator: 'Exists' }],
            containers: [{
              name: 'reap',
              image: 'busybox:1.36',
              command: ['sh', '-c'],
              args: [script],
              securityContext: { runAsUser: 0, runAsNonRoot: false },
              volumeMounts: [{ name: 'host-storage', mountPath: '/host/storage' }],
              resources: {
                requests: { cpu: '10m', memory: '16Mi' },
                limits: { cpu: '100m', memory: '64Mi' },
              },
            }],
            volumes: [{
              name: 'host-storage',
              hostPath: { path: LOCAL_PATH_STORAGE_DIR, type: 'DirectoryOrCreate' },
            }],
          },
        },
      },
    };

    try {
      await k8s.batch.createNamespacedJob({
        namespace: MAIL_NS,
        body: body as unknown as Parameters<typeof k8s.batch.createNamespacedJob>[0]['body'],
      });
      scheduled.push(nodeName);
    } catch (err) {
      const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
      // 409 = today's Job already exists (another replica, or an earlier
      // tick). That IS the desired end state, so it is not an error.
      if (status !== 409) {
        log.warn(`[mail-pvc-reaper] could not schedule on ${nodeName}:`, (err as Error).message);
      }
    }
  }

  if (scheduled.length > 0) {
    log.info(`[mail-pvc-reaper] scheduled on ${scheduled.length} node(s); keeping live dir ${live.dirName} on ${live.nodeName}`);
  }
  return { scheduled, skipped: null };
}

/** Daily is right: orphans only appear on a failover, and the grace window is 48h. */
export const REAPER_TICK_MS = 24 * 60 * 60 * 1000;
const REAPER_INITIAL_DELAY_MS = 10 * 60 * 1000;

/**
 * Daily reaper tick. Returns a stop function for `app.addHook('onClose', …)`.
 *
 * Scheduling the Jobs is cheap and idempotent (same name per node per day →
 * 409 on repeat), so several platform-api replicas ticking together is safe
 * without a lease.
 */
export function startMailPvcReaper(db: Database, k8s: K8sClients): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    void spawnMailPvcReaperJobs(db, k8s).catch((err) => {
      console.warn('[mail-pvc-reaper] tick failed:', (err as Error).message);
    });
  };
  const initial = setTimeout(() => {
    run();
    timer = setInterval(run, REAPER_TICK_MS);
  }, REAPER_INITIAL_DELAY_MS);

  return {
    stop: () => {
      clearTimeout(initial);
      if (timer) clearInterval(timer);
    },
  };
}
