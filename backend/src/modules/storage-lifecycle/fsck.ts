import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { PLATFORM_TENANT_OPS_NS, STORAGE_OPS_PRIORITY_CLASS } from './platform-ns.js';

/**
 * Filesystem check / repair helpers — run xfs_repair (XFS) or e2fsck
 * (ext4) against a tenant PVC's underlying block device.
 *
 * Why a privileged hostPath Pod and not a regular volumeMount?
 * xfs_repair and e2fsck both refuse to operate on a mounted
 * filesystem — they need the BLOCK DEVICE, unmounted. Tenant PVCs
 * are provisioned in `volumeMode: Filesystem`, which is immutable, so
 * we can't switch to `volumeMode: Block` to expose the device via
 * `volumeDevices`. The remaining path is to schedule a privileged
 * Pod onto the node where Longhorn has attached the volume and run
 * the tool against `/dev/longhorn/<pvname>` exposed as hostPath.
 *
 * Caller contract:
 *   - The volume MUST be detached before calling. The orchestrator
 *     in service.ts handles quiesce (scale tenant + FM to 0, wait for
 *     Longhorn to detach), then unquiesce after this returns. Even
 *     dry-run mode needs the unmount because xfs_repair -n still
 *     refuses on a mounted FS.
 *   - The Pod is scheduled to the node currently owning the volume's
 *     replica via nodeName — the caller passes that in.
 *
 * This is intentionally narrow: NO automatic dependency on the
 * snapshot/quiesce primitives, NO DB writes. The orchestrator in
 * service.ts owns those.
 */

/**
 * What the run actually established.
 *
 * `inconclusive` exists because `xfs_repair -n` CANNOT replay a dirty log —
 * `-n` is read-only by definition — so against an unflushed journal it always
 * reports the superblock's free-block counter as stale and exits 1. That is not
 * corruption, and the tool says so itself in the output we store:
 *
 *   ALERT: The filesystem has valuable metadata changes in a log which is being
 *   ignored because the -n option was used. Expect spurious inconsistencies
 *   which may be resolved by first mounting the filesystem to replay the log.
 *
 * Production proof that the distinction is real: two dry runs, same code, same
 * flags. The one that printed `zero_log: head block 176 tail block 176` (clean
 * log) exited 0 CLEAN. The one that printed `head block 79392 tail block 79376`
 * (16 blocks unflushed) exited 1 with exactly one "finding" —
 * `sb_fdblocks 1019986, counted 1052976` — while phases 3, 4, 6 and 7 were
 * completely clean. The filesystem was fine: the very next mount replayed the
 * log (`Starting recovery` → `Ending recovery`) and logged nothing since.
 * Reporting that as ERRORS FOUND wedged the tenant in `failed`.
 */
export type FsckVerdict = 'clean' | 'errors' | 'inconclusive';

export interface FsckResult {
  /** Detected filesystem type the run targeted (xfs | ext4 | other). */
  readonly fsType: string;
  /** Whether this was a dry run (-n) or a repair run. */
  readonly dryRun: boolean;
  /**
   * Pod's exit code. The scale is TOOL-SPECIFIC and must not be shared:
   *   • `xfs_repair -n`: 0 = nothing to do, **1 = "would have made changes"**,
   *     2+ = could not complete. Exit 1 is the normal result for a stale
   *     counter or an unreplayed log and is NOT a corruption signal.
   *   • `xfs_repair` (repair mode): 0 = repaired/clean, non-zero = failed.
   *   • `e2fsck`: 0 = clean, 1 = errors CORRECTED, 2 = corrected + reboot,
   *     4 = errors left UNcorrected, 8+ = operational error.
   * Treat `verdict` as the answer; this is the raw evidence behind it.
   */
  readonly exitCode: number;
  /** Combined stdout+stderr from the fsck tool, capped to MAX_OUTPUT_BYTES. */
  readonly output: string;
  /** True iff the run positively established a healthy filesystem. */
  readonly clean: boolean;
  /** Tri-state classification — see FsckVerdict. */
  readonly verdict: FsckVerdict;
  /**
   * The journal had un-replayed records when the tool read the device, so any
   * inconsistency it reported is unreliable. The orchestrator must let the
   * filesystem mount (which replays the log) and re-check rather than declaring
   * damage.
   */
  readonly logDirty: boolean;
  /** One line naming what was established, for progressMessage / alerts. */
  readonly summary: string;
}

// Image must contain xfs_repair (xfsprogs) and e2fsck (e2fsprogs).
// busybox ships only the `fsck` stub. Alpine is small + the cluster
// pulls Alpine for several other tools; `apk add xfsprogs e2fsprogs`
// is fast.
const DEFAULT_JOB_IMAGE = 'alpine:3.20';
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;

interface FsckOpts {
  /**
   * Client's own namespace. The fsck Job DOES NOT run here anymore —
   * it runs in PLATFORM_TENANT_OPS_NS — but we keep the field as a
   * label for filtering by tenant and for log messages.
   */
  readonly namespace: string;
  /** PV name (NOT the PVC name) — Longhorn names its block device
   *  /dev/longhorn/<pv-name>. Caller looks this up via PVC.spec.volumeName. */
  readonly volumeName: string;
  readonly tenantId: string;
  readonly fsType: string;
  readonly dryRun: boolean;
  /** Node name where the Longhorn volume is currently attached (or
   *  was last attached — Longhorn re-creates /dev/longhorn/* on the
   *  next attach). REQUIRED — caller looks this up from
   *  Volume.status.currentNodeID. */
  readonly nodeName: string;
  readonly jobImage?: string;
  readonly timeoutMs?: number;
  /** Live progress callback — fed the latest log line from the
   *  fsck Job pod every poll cycle (~3s). Wired into
   *  storage_operations.progressMessage so the operator sees
   *  xfs_repair pass output instead of a stuck percentage. */
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

/**
 * Build the in-container shell script that installs the fsck tool,
 * runs it against the host block device, and exits with the tool's
 * status. Exported so unit tests can verify the right command is
 * picked per (fsType, dryRun) combo without spinning up a Job.
 */
export function buildFsckScript(fsType: string, dryRun: boolean): string {
  const lower = fsType.toLowerCase();
  let install: string;
  let cmd: string;

  if (lower === 'xfs') {
    install = 'apk add --no-cache xfsprogs >/dev/null';
    // -n  no-modify check, safe to run repeatedly
    // -v  verbose
    // -L (zero log) is INTENTIONALLY NOT INCLUDED — it's destructive
    //    and operators should run it manually if a damaged log
    //    blocks repair.
    cmd = dryRun
      ? 'xfs_repair -n -v "$DEV"'
      : 'xfs_repair -v "$DEV"';
  } else if (lower === 'ext4' || lower === 'ext3' || lower === 'ext2') {
    install = 'apk add --no-cache e2fsprogs >/dev/null';
    // -n  read-only check
    // -y  auto-answer yes (for repair)
    // -f  force check (don't trust the clean bit)
    // -v  verbose
    cmd = dryRun
      ? 'e2fsck -n -fv "$DEV"'
      : 'e2fsck -y -fv "$DEV"';
  } else {
    return [
      'set +e',
      `echo "fsck: unsupported fsType '${lower}' — only xfs/ext4 supported" >&2`,
      'exit 64',
    ].join('\n');
  }

  return [
    'set +e',
    `echo "[fsck] fsType=${lower} dryRun=${dryRun ? 'true' : 'false'} dev=$DEV"`,
    install,
    '[ -b "$DEV" ] || { echo "[fsck] block device $DEV not found on this node — Longhorn volume not attached?"; exit 65; }',
    cmd,
    'RC=$?',
    'echo "[fsck] exit=$RC"',
    'exit $RC',
  ].join('\n');
}

export async function runFsck(k8s: K8sClients, opts: FsckOpts): Promise<FsckResult> {
  const jobImage = opts.jobImage ?? DEFAULT_JOB_IMAGE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const jobName = `fsck-${opts.dryRun ? 'check' : 'repair'}-${opts.volumeName.slice(-12)}-${Date.now().toString(36)}`.slice(0, 63);
  const script = buildFsckScript(opts.fsType, opts.dryRun);

  // Job runs in the platform-tenant-ops namespace (no quota), NOT in
  // the tenant namespace. The tenant's namespace is preserved as a
  // label only, so cancel-by-tenant and progress UIs still work.
  const jobNamespace = PLATFORM_TENANT_OPS_NS;

  // Longhorn block device path on the host. Created by the engine pod
  // when the volume is attached; remains until next detach.
  const devPath = `/dev/longhorn/${opts.volumeName}`;

  const jobBody = {
    metadata: {
      name: jobName,
      namespace: jobNamespace,
      labels: {
        'platform.io/component': 'fsck',
        'platform.io/tenant-id': opts.tenantId,
        'platform.io/tenant-namespace': opts.namespace,
        'platform.io/fsck-mode': opts.dryRun ? 'check' : 'repair',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 1800,
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'fsck',
            'platform.io/tenant-id': opts.tenantId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          // Pin to the node currently holding the Longhorn volume —
          // /dev/longhorn/<vol> only exists on that node.
          nodeName: opts.nodeName,
          // Higher than tenant-default so storage recovery preempts
          // tenant pods on cluster contention. Defined cluster-wide
          // in k8s/base/priority-classes.yaml.
          priorityClassName: STORAGE_OPS_PRIORITY_CLASS,
          containers: [{
            name: 'fsck',
            image: jobImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            env: [{ name: 'DEV', value: devPath }],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '1000m', memory: '1Gi' },
            },
            // We need the kernel block-device interface. Privileged
            // is the simplest way to get the right capabilities +
            // device permissions on a hostPath block dev.
            securityContext: {
              runAsUser: 0,
              privileged: true,
            },
            volumeMounts: [{
              name: 'longhorn-dev',
              mountPath: '/dev/longhorn',
            }],
          }],
          volumes: [{
            name: 'longhorn-dev',
            hostPath: { path: '/dev/longhorn', type: 'Directory' },
          }],
          // Tolerate any taints — fsck Pods need to land where the
          // data is, even on cordoned/quarantined nodes.
          tolerations: [{ operator: 'Exists' }],
        },
      },
    },
  };

  await (k8s.batch as unknown as {
    createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: jobNamespace, body: jobBody });

  // Poll for completion
  const start = Date.now();
  let finalExitCode = -1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await (k8s.batch as unknown as {
      readNamespacedJob: (args: { name: string; namespace: string }) => Promise<{
        status?: { conditions?: Array<{ type: string; status: string }>; succeeded?: number; failed?: number };
      }>;
    }).readNamespacedJob({ name: jobName, namespace: jobNamespace });
    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) {
      finalExitCode = 0;
      break;
    }
    if (failed || (status.failed ?? 0) > 0) {
      finalExitCode = await readPodExitCode(k8s, jobNamespace, jobName);
      break;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`fsck Job ${jobName} timed out after ${timeoutMs}ms`);
    }
    if (opts.onProgress) {
      const { tailJobLog } = await import('./job-log-tail.js');
      const tail = await tailJobLog(k8s, jobNamespace, jobName);
      if (tail) await opts.onProgress(`${opts.fsType}: ${tail}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const output = await readPodLogs(k8s, jobNamespace, jobName);

  // Best-effort delete; ttlSecondsAfterFinished GCs anyway.
  try {
    await (k8s.batch as unknown as {
      deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
    }).deleteNamespacedJob({ name: jobName, namespace: jobNamespace, propagationPolicy: 'Background' });
  } catch { /* fine */ }

  const classified = classifyFsckOutput(opts.fsType, opts.dryRun, finalExitCode, output);

  return {
    fsType: opts.fsType.toLowerCase(),
    dryRun: opts.dryRun,
    exitCode: finalExitCode,
    output: output.slice(0, MAX_OUTPUT_BYTES),
    ...classified,
  };
}

/**
 * Markers that mean the tool found REAL damage — not merely that it would have
 * written something.
 *
 * The previous heuristic was `/error|corrupt|bad superblock|cannot|fail/` over
 * the whole lowercased output, which is a false-positive generator independent
 * of the exit code: `xfs_repair`'s own dirty-log ALERT, a `Failing async write`
 * line, or any sentence containing "cannot" flipped a healthy filesystem to
 * dirty. These patterns are anchored to the specific things xfs_repair and
 * e2fsck print when structure is actually broken.
 */
const XFS_DAMAGE = [
  /bad (?:magic number|superblock)/i,
  /corrupt/i,
  // NOT `/moving .* to lost\+found/` and NOT `/disconnected inode/` bare:
  // `        - moving disconnected inodes to lost+found ...` is a phase-6
  // HEADER that xfs_repair prints unconditionally — it is present verbatim in
  // the captured CLEAN production run. Matching it would mark every XFS volume
  // damaged, which is the exact false-positive class this rewrite removes. The
  // real finding always names the inode NUMBER.
  /disconnected (?:dir )?inode \d+/i,
  /\bbad (?:inode|directory|agf|agi|agfl)\b/i,
  /entry .* points to (?:free|non-existent) inode/i,
  /would (?:have )?(?:clear|junk|reset|fix|rebuild|destroy)/i,
];
const EXT_DAMAGE = [
  /bad (?:magic number|superblock)/i,
  /corrupt/i,
  /\bdeleted inode\b/i,
  /unattached inode/i,
  /inode .* (?:is|has) (?:a )?(?:bad|illegal|invalid)/i,
  /\bfix\? yes\b/i,
];

/**
 * `xfs_repair -n` prints this when the log holds records it is not allowed to
 * replay. Everything it reports afterwards is derived from a stale view.
 */
const XFS_DIRTY_LOG = /valuable metadata changes in a log which is being ignored/i;
/** head != tail in the zero_log line is the same fact, stated numerically. */
const XFS_ZERO_LOG = /zero_log:\s*head block (\d+) tail block (\d+)/i;

/**
 * Turn (tool, mode, exit code, output) into a verdict.
 *
 * Exported so unit tests can pin the semantics against real captured output
 * without spinning up a Job — the whole point of the tri-state is that it is
 * decided here, once, rather than re-derived by each caller from an exit code
 * whose meaning depends on which tool ran.
 */
export function classifyFsckOutput(
  fsType: string,
  dryRun: boolean,
  exitCode: number,
  output: string,
): { clean: boolean; verdict: FsckVerdict; logDirty: boolean; summary: string } {
  const isXfs = fsType.toLowerCase() === 'xfs';
  const mode = dryRun ? 'check' : 'repair';

  let logDirty = XFS_DIRTY_LOG.test(output);
  const zl = XFS_ZERO_LOG.exec(output);
  if (zl && zl[1] !== zl[2]) logDirty = true;

  const damaged = (isXfs ? XFS_DAMAGE : EXT_DAMAGE).some((re) => re.test(output));

  // The tool could not even run (missing device, unsupported fs, install
  // failure). Our own wrapper uses 64/65; xfs_repair uses 2+, e2fsck 8+.
  const operational = exitCode >= 2 && !damaged && !logDirty;

  let verdict: FsckVerdict;
  if (damaged) {
    verdict = 'errors';
  } else if (exitCode === 0) {
    verdict = 'clean';
  } else if (isXfs && dryRun && logDirty) {
    // The defining case: exit 1 caused by an unreplayed journal.
    verdict = 'inconclusive';
  } else if (operational) {
    verdict = 'errors';
  } else if (isXfs && dryRun) {
    // Exit 1, clean log, no damage markers — a stale counter xfs_repair would
    // rewrite. Worth telling the operator, but not damage and not a failure.
    verdict = 'inconclusive';
  } else if (isXfs) {
    // xfs_repair in REPAIR mode: 0 = repaired/clean, anything else = it did not
    // finish. This branch used to fall through to the e2fsck rule below, which
    // maps exit 1-2 to 'clean' — so a repair xfs_repair itself said had not
    // succeeded was reported to the operator as a healthy filesystem, directly
    // contradicting the exit-code contract documented on FsckResult.
    verdict = 'errors';
  } else {
    // e2fsck exit 1/2 in repair mode means it CORRECTED things: the filesystem
    // is now consistent, which is a success with a story attached. Exit 4+ means
    // errors were left UNcorrected.
    verdict = !dryRun && exitCode <= 2 ? 'clean' : 'errors';
  }

  const clean = verdict === 'clean';
  const label = verdict === 'clean' ? 'CLEAN'
    : verdict === 'inconclusive' ? 'INCONCLUSIVE'
      : 'ERRORS FOUND';
  let summary = `${fsType.toLowerCase()} ${mode} exit=${exitCode} ${label}`;
  if (verdict === 'inconclusive' && logDirty) {
    summary += ' — the journal had un-replayed records, so the reported'
      + ' inconsistency is not evidence of damage; the volume was re-mounted'
      + ' (which replays the log). Re-run the check to get a real verdict.';
  } else if (verdict === 'inconclusive') {
    summary += ' — no damage markers, only counters the tool would rewrite.';
  }
  return { clean, verdict, logDirty, summary };
}

async function readPodLogs(k8s: K8sClients, namespace: string, jobName: string): Promise<string> {
  try {
    const podList = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    } as unknown as Parameters<typeof k8s.core.listNamespacedPod>[0]) as { items?: Array<{ metadata?: { name?: string } }> };
    const pod = podList.items?.[0];
    if (!pod?.metadata?.name) return '(no pod found for fsck job)';
    const logs = await (k8s.core as unknown as {
      readNamespacedPodLog: (args: { name: string; namespace: string; container?: string; tailLines?: number }) => Promise<string>;
    }).readNamespacedPodLog({ name: pod.metadata.name, namespace, container: 'fsck' });
    return typeof logs === 'string' ? logs : String(logs);
  } catch (err) {
    return `(failed to read fsck pod logs: ${(err as Error).message})`;
  }
}

async function readPodExitCode(k8s: K8sClients, namespace: string, jobName: string): Promise<number> {
  try {
    const podList = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    } as unknown as Parameters<typeof k8s.core.listNamespacedPod>[0]) as {
      items?: Array<{
        status?: {
          containerStatuses?: Array<{ state?: { terminated?: { exitCode?: number } }; lastState?: { terminated?: { exitCode?: number } } }>;
        };
      }>;
    };
    const pod = podList.items?.[0];
    const cs = pod?.status?.containerStatuses?.[0];
    return cs?.state?.terminated?.exitCode
      ?? cs?.lastState?.terminated?.exitCode
      ?? -1;
  } catch {
    return -1;
  }
}
