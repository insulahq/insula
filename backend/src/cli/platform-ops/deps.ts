/**
 * Dependency seam for the platform-ops CLI.
 *
 * Command handlers take a `Deps` so they are pure + unit-testable (no real
 * kubectl, DB, or process spawn in tests). `realDeps()` wires the production
 * implementations. The DB enrichment imports the SAME backend module the
 * in-cluster controllers use (`platform-updates/service`) — proving the
 * "CLI imports backend modules directly" architecture (ADR-045 / W17) and
 * guaranteeing zero version-logic duplication.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { realDrOps } from './dr-ops.js';
import { realSnapshotOps } from './snapshot-ops.js';
import { realSelfUpgradeOps } from './self-upgrade/index.js';
import { realHostConfigOps, type HostConfigOps } from './host-config/index.js';
import { realClusterUpgradeOps } from './cluster-upgrade-ops.js';
import { realNodeOps } from './node-ops.js';
import { realUpgradeOps } from './upgrade-ops.js';
import { realRollbackOps } from './rollback-ops.js';
import { scrubCreds } from './redact.js';
import type { SelfUpgradeOptions, SelfUpgradeResult } from './self-upgrade/types.js';
import type { RenamePlatformDomainResult } from '../../modules/platform-domain/service.js';

export type { SelfUpgradeOptions, SelfUpgradeResult } from './self-upgrade/types.js';
export type { HostConfigOps } from './host-config/index.js';

/**
 * Self-upgrade operations seam (ADR-045 W11.5). The real implementation
 * (`realSelfUpgradeOps`) wires the pure `runSelfUpgrade` orchestrator to k8s /
 * GitHub / filesystem I/O; tests inject a fake. NEVER throws.
 */
export interface SelfUpgradeOps {
  /** Resolve target → cosign-verify → atomically replace the binary. */
  run: (opts: SelfUpgradeOptions) => Promise<SelfUpgradeResult>;
}

export interface VersionInfo {
  installed: string;
  running: string;
  available: string | null;
}

/** One platform-migration's status for `migrations list`. */
export interface MigrationStatusItem {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  /** 'unknown' when the DB is unreachable (registry known, applied-state not). */
  readonly status: 'applied' | 'pending' | 'drift' | 'unknown';
  readonly appliedAt: string | null;
}

/** Result of reading the platform-migration registry status. */
export interface MigrationsStatus {
  /** True when the applied-state was read from the DB; false = offline view. */
  readonly dbReachable: boolean;
  readonly items: ReadonlyArray<MigrationStatusItem>;
}

/** One migration's outcome from `migrations apply`. */
export interface MigrationApplyOutcome {
  readonly id: string;
  readonly status: string;
  readonly durationMs: number;
  readonly error?: string;
}

/** Outcome of `migrations apply` — never thrown; infra failures map to errorCode. */
export interface MigrationApplyResult {
  /** false on an infra failure (no DATABASE_URL, pool error). */
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly detail?: string;
  readonly ran?: boolean;
  readonly dryRun?: boolean;
  readonly applied?: number;
  readonly pending?: number;
  readonly failed?: boolean;
  readonly skippedReason?: string;
  readonly outcomes?: ReadonlyArray<MigrationApplyOutcome>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One CNPG cluster pointer as recorded in a DR bundle's dr-inputs.yaml. */
export interface DrCnpgPointer {
  readonly namespace: string;
  readonly clusterName: string;
  readonly serverName: string;
  readonly objectStoreName: string;
}

/** Read-only summary of a DR bundle (no rows imported, no cluster touched). */
export interface DrBundleManifest {
  readonly apexDomain: string;
  readonly clusterName: string;
  readonly platformVersion: string;
  readonly createdAt: string;
  readonly bundleTopology: string;
  readonly cnpgClusters: ReadonlyArray<DrCnpgPointer>;
  readonly secretYamlCount: number;
}

/** Inputs common to both DR restore modes. */
interface DrRestoreBase {
  readonly bundlePath: string;
  readonly ageKeyPath: string;
  readonly strict: boolean;
  readonly ageBinary?: string;
  readonly kubeconfig?: string;
}

/** Partial restore: import backup_configurations rows read-only; no cluster touched. */
export interface DrRestoreRequestPartial extends DrRestoreBase {
  readonly mode: 'partial';
}

/** Full restore: partial + CNPG recovery + mail data restore (destructive). */
export interface DrRestoreRequestFull extends DrRestoreBase {
  readonly mode: 'full';
  /** Node the mail-stack lands on after restore. */
  readonly targetMailNode: string;
  /** One entry per CNPG cluster; value === name (typed confirmation). */
  readonly confirmClusterNames: ReadonlyMap<string, string>;
}

/**
 * Fully-parsed inputs for a DR restore. A discriminated union on `mode`
 * so the type system — not a runtime non-null assertion — guarantees
 * full-mode only carries the destructive-restore confirmations.
 */
export type DrRestoreRequest = DrRestoreRequestPartial | DrRestoreRequestFull;

/** Outcome of a DR restore — never thrown; failures map to `errorCode`. */
export interface DrRestoreOutcome {
  readonly ok: boolean;
  /** Stable error label on failure (e.g. DECRYPT_ERROR, LEGACY_BUNDLE). */
  readonly errorCode?: string;
  /** Diagnostic detail for the operator terminal (stderr), never a public log. */
  readonly detail?: string;
  /** Bundle manifest, present once the bundle was read successfully. */
  readonly bundleInfo?: DrBundleManifest;
  /** Human-readable summary lines for the terminal (mode-specific). */
  readonly summary?: ReadonlyArray<string>;
  /** Drift notes surfaced from the import (non-fatal unless --strict). */
  readonly driftNotes?: ReadonlyArray<string>;
}

/** Inputs for `dr rescue` — block-level Longhorn safety snapshots. */
export interface DrRescueRequest {
  /** Path to a kubeconfig; falls back to in-cluster / default resolution. */
  readonly kubeconfig?: string;
  /** Optional operator label stamped on every snapshot CR (≤63 chars). */
  readonly label?: string;
  /**
   * Snapshot only this Longhorn volume. When unset, every system PVC's
   * volume (platform / mail / longhorn-system / cnpg-system / monitoring)
   * is snapshotted — a full safety net before a destructive restore.
   */
  readonly volume?: string;
}

/** One Longhorn snapshot created by `dr rescue`. */
export interface DrRescueSnapshot {
  readonly volumeName: string;
  readonly namespace: string;
  readonly pvcName: string;
  readonly snapshotName: string;
}

/** One volume `dr rescue` could not snapshot (per-volume; non-fatal). */
export interface DrRescueFailure {
  readonly volumeName: string;
  readonly reason: string;
}

/**
 * Outcome of `dr rescue` — never thrown. `ok:false` means enumeration
 * itself failed (cluster unreachable); per-volume snapshot failures are
 * reported in `failures` with `ok:true` so partial success is visible.
 */
export interface DrRescueOutcome {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly detail?: string;
  readonly snapshots?: ReadonlyArray<DrRescueSnapshot>;
  readonly failures?: ReadonlyArray<DrRescueFailure>;
}

/**
 * DR operations seam. The real implementation (`realDrOps`) imports the
 * backend `dr-restore` module DIRECTLY (ADR-045 / W17 — no logic
 * duplication); tests inject a fake.
 */
export interface DrOps {
  /**
   * Read-only: age-decrypt + parse a bundle and return its manifest.
   * Throws typed errors (decrypt / legacy / version) that the command
   * layer maps to a stable label + exit code. Touches no DB and no cluster.
   */
  verifyBundle: (bundlePath: string, ageKeyPath: string, ageBinary?: string) => Promise<DrBundleManifest>;
  /**
   * Execute a DR restore via the backend `runDrRestore` primitive.
   * NEVER throws — every failure is mapped into `DrRestoreOutcome.errorCode`.
   */
  runRestore: (req: DrRestoreRequest) => Promise<DrRestoreOutcome>;
  /**
   * Take block-level Longhorn rescue snapshots of the system volumes via
   * the backend `system-snapshots` primitive. NEVER throws — failures map
   * to `DrRescueOutcome.errorCode` / `failures`.
   */
  rescue: (req: DrRescueRequest) => Promise<DrRescueOutcome>;
}

// ── Snapshot (CNPG on-demand backup + object-store catalogue) ────────────────

/** Inputs for `snapshot capture` — an on-demand CNPG base backup. */
export interface SnapshotCaptureRequest {
  readonly namespace: string;
  readonly clusterName: string;
  readonly description?: string;
  readonly kubeconfig?: string;
}

/** Outcome of `snapshot capture` — never thrown; failures map to `errorCode`. */
export interface SnapshotCaptureOutcome {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly detail?: string;
  readonly backup?: {
    readonly backupName: string;
    readonly namespace: string;
    readonly clusterName: string;
    readonly createdAt: string;
  };
}

/** Inputs for `snapshot list` — read the object-store catalogue via the shim. */
export interface SnapshotListRequest {
  readonly namespace: string;
  readonly objectStoreName: string;
  readonly kubeconfig?: string;
}

/** One backup row in the object-store catalogue (subset of CatalogueBackup). */
export interface SnapshotBackupInfo {
  readonly backupId: string;
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly dataSizeBytes: number | null;
  readonly description?: string | null;
  readonly kind?: string | null;
}

/**
 * Outcome of `snapshot list`. The underlying catalogue never throws; an
 * `'unavailable'` source (CR missing, shim down, LIST timeout) maps to
 * `ok:false` so the CLI exits non-zero with the reason on stderr.
 */
export interface SnapshotListOutcome {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly detail?: string;
  readonly objectStoreName?: string;
  readonly namespace?: string;
  readonly backups?: ReadonlyArray<SnapshotBackupInfo>;
}

/**
 * Snapshot/backup operations seam. The real implementation
 * (`realSnapshotOps`) imports the backend `cnpg-backup-now` +
 * `cnpg-backup-catalogue` modules DIRECTLY (ADR-045 / W17); tests inject a fake.
 */
export interface SnapshotOps {
  /** Create a CNPG Backup CR (on-demand base backup). NEVER throws. */
  capture: (req: SnapshotCaptureRequest) => Promise<SnapshotCaptureOutcome>;
  /** List object-store backups via the backup-rclone-shim. NEVER throws. */
  list: (req: SnapshotListRequest) => Promise<SnapshotListOutcome>;
}

// ── Cluster upgrade (W12 / SUC) ──────────────────────────────────────────────
export interface NodeVersion {
  readonly name: string;
  readonly role: 'server' | 'agent';
  readonly kubeletVersion: string | null;
}

export interface ClusterUpgradeOps {
  /** Read every node's role + kubelet/k3s version (for current-min + validation). */
  readNodeVersions: () => Promise<NodeVersion[]>;
  /** Create/merge-patch the SUC Plan CRs in the system-upgrade namespace. */
  applyPlans: (plans: readonly Record<string, unknown>[]) => Promise<{ applied: string[] }>;
}

export interface NodeOps {
  /** Cordon (on=true) / uncordon (on=false) a node via the k8s API. */
  cordon: (name: string, on: boolean) => Promise<void>;
}

// ── Platform upgrade (W13 / host-side Flux re-pin) ───────────────────────────
export interface UpgradeRunResult {
  /** false only on a real failure (apply requested + should-proceed but re-pin didn't land, or a setup error). */
  readonly ok: boolean;
  readonly action: string;
  readonly target: string | null;
  readonly reason: string;
  readonly proceed: boolean;
  readonly applied: boolean;
  readonly gitRepository: string | null;
  readonly summary: string;
  readonly errorCode?: string;
}

export interface UpgradeOps {
  /** Plan (+ optionally apply) a platform upgrade by re-pinning the Flux source. */
  run: (opts: { mode: 'manual' | 'auto'; requestedVersion?: string; apply: boolean }) => Promise<UpgradeRunResult>;
}

export interface RollbackRunResult {
  readonly ok: boolean;
  readonly dataRestored: boolean;
  readonly reason?: string;
  readonly summary: string;
  readonly errorCode?: string;
}

export interface RollbackOps {
  /** Roll back the most recent applied upgrade (re-pin back; restoreData = revert volumes). */
  run: (opts: { apply: boolean; restoreData: boolean }) => Promise<RollbackRunResult>;
}

// ── Admin password reset (R18 — consolidates admin-password-reset.sh) ─────────
/** Outcome of `admin reset-password` — never thrown; failures map to errorCode. */
export interface AdminResetOutcome {
  readonly ok: boolean;
  readonly userId?: string;
  readonly errorCode?: string;
  readonly detail?: string;
}

// ── Domain rename (R18 — wraps the R16 renamePlatformDomain service) ──────────
/** Outcome of `domain rename` — never thrown; failures map to errorCode. */
export interface DomainRenameOutcome {
  readonly ok: boolean;
  readonly result?: RenamePlatformDomainResult;
  readonly errorCode?: string;
  readonly detail?: string;
}

export interface Deps {
  env: NodeJS.ProcessEnv;
  /** Write a line to stdout. */
  out: (s: string) => void;
  /** Write a line to stderr. */
  err: (s: string) => void;
  /**
   * Run a command. With `stdio: 'inherit'` the child takes over the terminal
   * (used by `shell`); otherwise stdout/stderr are captured and returned.
   */
  exec: (cmd: string, args: string[], opts?: { stdio?: 'inherit'; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;
  /**
   * installed/running/available from the platform DB, or null when DATABASE_URL
   * is unset or the DB is unreachable (the CLI must work when the cluster is down).
   */
  versionFromDb: () => Promise<VersionInfo | null>;
  /**
   * Platform-migration registry status. The registry is compiled in (always
   * known); applied-state is read from the DB when reachable, else 'unknown'.
   */
  migrationsStatus: () => Promise<MigrationsStatus>;
  /**
   * Apply pending platform-migrations against the DB + cluster (the same
   * runner the backend uses at startup). NEVER throws — infra failures map to
   * `errorCode`. `dryRun` runs each migration's no-mutation path only.
   */
  applyMigrations: (opts: { dryRun: boolean; kubeconfig?: string }) => Promise<MigrationApplyResult>;
  /** Read a file's contents, or null if it can't be read. */
  readFile: (path: string) => string | null;
  /** The version compiled into this binary at build time (PLATFORM_OPS_VERSION). */
  buildVersion: string;
  /** Disaster-recovery operations (bundle verify + restore + rescue snapshot). */
  dr: DrOps;
  /** Snapshot operations (CNPG on-demand backup + object-store catalogue). */
  snapshot: SnapshotOps;
  /** Self-upgrade: keep this binary current (cosign-verified atomic replace). */
  selfUpgrade: SelfUpgradeOps;
  /** Host-config: converge host sysctls (host-side, root; no privileged pod). */
  hostConfig: HostConfigOps;
  /** Cluster upgrade: read node versions + apply SUC k3s upgrade Plans (W12). */
  clusterUpgrade: ClusterUpgradeOps;
  /** Node operations: cordon/uncordon (W12). */
  node: NodeOps;
  /** Platform upgrade: host-side Flux re-pin (W13). */
  upgrade: UpgradeOps;
  /** Platform rollback: undo the most recent upgrade (W16). */
  rollback: RollbackOps;
  /**
   * Reset a user's password by exec-ing the in-pod entrypoint
   * (`node dist/cli/admin-reset-password.js`) in the platform-api pod — native
   * bcrypt only loads there, not in this SEA binary. Password goes over the
   * exec's stdin (never argv). NEVER throws.
   */
  resetAdminPassword: (opts: { email: string; password: string; kubeconfig?: string }) => Promise<AdminResetOutcome>;
  /**
   * Rename the platform apex by exec-ing the in-pod entrypoint
   * (`node dist/cli/platform-domain-rename.js`) in the platform-api pod — it runs
   * the same `renamePlatformDomain` service the API uses, with the pod's config +
   * in-cluster k8s (the service's native-dep graph can't run in this SEA binary).
   * NEVER throws.
   */
  renameDomain: (opts: { newApex: string; kubeconfig?: string }) => Promise<DomainRenameOutcome>;
  /** Read all of this process's stdin to EOF (for piping a secret in without argv exposure). */
  readStdin: () => Promise<string>;
}

function realExec(
  cmd: string,
  args: string[],
  opts?: { stdio?: 'inherit'; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (opts?.stdio === 'inherit') {
      const child = spawn(cmd, args, { stdio: 'inherit', env: opts.env ?? process.env });
      child.on('error', () => resolve({ code: 127, stdout: '', stderr: `failed to spawn ${cmd}` }));
      child.on('close', (code) => resolve({ code: code ?? 0, stdout: '', stderr: '' }));
      return;
    }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: opts?.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => resolve({ code: 127, stdout, stderr: stderr || `failed to spawn ${cmd}` }));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function realVersionFromDb(env: NodeJS.ProcessEnv): Promise<VersionInfo | null> {
  const url = env.DATABASE_URL;
  if (!url) return null;
  try {
    // Dynamic import keeps the heavy DB graph off the path of subcommands that
    // never touch it, and lets the binary start instantly when the DB is down.
    // STRICTLY READ-ONLY: a plain SELECT on platform_settings — deliberately NOT
    // getVersionInfo(), which writes latest_* settings and makes an outbound
    // GitHub call (it would mutate prod state + race the backend scheduler from
    // a `version` invocation). Still imports backend modules (schema/db) directly.
    const [{ getDb, closeDb }, { platformSettings }, { eq }] = await Promise.all([
      import('../../db/index.js'),
      import('../../db/schema.js'),
      import('drizzle-orm'),
    ]);
    const db = getDb(url);
    try {
      const read = async (key: string): Promise<string | null> => {
        const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
        return row?.value ?? null;
      };
      const installed = await read('installed_platform_version');
      const available = await read('latest_version');
      if (installed === null && available === null) return null;
      // The CLI runs on a host, not in the pod, so it can't observe the live
      // pod's "running" version; the durable installed record is the best signal.
      return { installed: installed ?? 'unknown', running: installed ?? 'unknown', available };
    } finally {
      await closeDb().catch(() => undefined);
    }
  } catch {
    return null; // unreachable / misconfigured DB → caller degrades to local version
  }
}

async function realMigrationsStatus(env: NodeJS.ProcessEnv): Promise<MigrationsStatus> {
  // The registry is compiled into the binary; applied-state needs the DB.
  // Offline-first: the CLI must enumerate this release's migrations even when
  // the DB is down (it just can't say which have applied).
  const { registryStatusOffline, listMigrationStatus } = await import('../../modules/platform-upgrades/index.js');
  const url = env.DATABASE_URL;
  if (!url) return { dbReachable: false, items: registryStatusOffline() };
  try {
    const [{ getDb, closeDb }] = await Promise.all([import('../../db/index.js')]);
    const db = getDb(url);
    try {
      const items = await listMigrationStatus(db);
      return { dbReachable: true, items };
    } finally {
      await closeDb().catch(() => undefined);
    }
  } catch {
    return { dbReachable: false, items: registryStatusOffline() };
  }
}

async function realApplyMigrations(
  env: NodeJS.ProcessEnv,
  opts: { dryRun: boolean; kubeconfig?: string },
): Promise<MigrationApplyResult> {
  const url = env.DATABASE_URL;
  if (!url) {
    return { ok: false, errorCode: 'NO_DATABASE_URL', detail: 'DATABASE_URL is required to apply migrations' };
  }
  try {
    const [{ getDb, getPool, closeDb }, { createK8sClients }, { runStartupMigrations }] = await Promise.all([
      import('../../db/index.js'),
      import('../../modules/k8s-provisioner/k8s-client.js'),
      import('../../modules/platform-upgrades/index.js'),
    ]);
    const db = getDb(url);
    try {
      const k8s = (() => {
        try { return createK8sClients(opts.kubeconfig); } catch { return null; }
      })();
      const result = await runStartupMigrations({
        db,
        pool: getPool(),
        k8s,
        config: { PLATFORM_VERSION: env.PLATFORM_VERSION, KUBECONFIG_PATH: opts.kubeconfig },
        // Live runner logs go to stderr so --json stdout stays a clean envelope.
        log: {
          info: (m) => process.stderr.write(m + '\n'),
          warn: (m) => process.stderr.write(m + '\n'),
        },
        dryRun: opts.dryRun,
        skip: false,
      });
      return {
        ok: true,
        ran: result.ran,
        dryRun: result.dryRun,
        applied: result.applied,
        pending: result.pending,
        failed: result.failed,
        skippedReason: result.skippedReason,
        outcomes: result.outcomes.map((o) => ({ id: o.id, status: o.status, durationMs: o.durationMs, error: o.error })),
      };
    } finally {
      await closeDb().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, errorCode: 'APPLY_ERROR', detail: scrubCreds(err instanceof Error ? err.message : String(err)) };
  }
}

interface PodExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Run `kubectl exec -i deploy/platform-api -c platform-api -- node <nodeArgs>`
 * and capture its output, with a 60s hard cap. The in-pod node entrypoints
 * (admin-reset-password.js, platform-domain-rename.js) run where native deps
 * (bcrypt) + the pod's DATABASE_URL + in-cluster k8s all work — the SEA binary
 * can't. `stdinData`, when set, is piped to the child's stdin (a secret stays
 * off argv/env). NEVER throws.
 */
function execApiPodNode(
  env: NodeJS.ProcessEnv,
  kubeconfig: string | undefined,
  nodeArgs: string[],
  stdinData?: string,
): Promise<PodExecResult> {
  const kc = kubeconfig ?? env.KUBECONFIG;
  // No `-c <container>`: the platform-api pod is single-container, so kubectl
  // targets it automatically (and stays correct if the container is renamed). A
  // future sidecar would make kubectl pick the default/first container and emit
  // a "Defaulted container" note to stderr — harmless, since result parsing
  // reads the last stdout line.
  const args = [
    '--kubeconfig', kc && kc.trim() ? kc : '/etc/rancher/k3s/k3s.yaml',
    '-n', 'platform', 'exec', '-i', 'deploy/platform-api', '--',
    'node', ...nodeArgs,
  ];
  return new Promise<PodExecResult>((resolve) => {
    const child = spawn('kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: PodExecResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Bound the blast radius: a CrashLooping / OOMKilled platform-api pod makes
    // `kubectl exec -i` block on a not-ready container forever. Kill + fail.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr, timedOut: true });
    }, 60_000);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => finish({ code: 127, stdout, stderr: stderr || 'failed to spawn kubectl', timedOut: false }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
    if (stdinData !== undefined) child.stdin?.write(stdinData);
    child.stdin?.end();
  });
}

/** Last non-empty line of stdout — the in-pod entrypoints print one JSON line. */
function lastJsonLine(stdout: string): string {
  return stdout.trim().split('\n').filter(Boolean).pop() ?? '';
}

async function realResetAdminPassword(
  env: NodeJS.ProcessEnv,
  opts: { email: string; password: string; kubeconfig?: string },
): Promise<AdminResetOutcome> {
  // Password over stdin — never argv, never env (stays out of `ps`/exec logs).
  const r = await execApiPodNode(
    env,
    opts.kubeconfig,
    ['dist/cli/admin-reset-password.js', '--email', opts.email],
    opts.password,
  );
  if (r.timedOut) return { ok: false, errorCode: 'TIMEOUT', detail: 'kubectl exec into platform-api timed out after 60s (pod not ready?)' };
  if (r.code !== 0) return { ok: false, errorCode: 'RESET_FAILED', detail: scrubCreds((r.stderr || r.stdout).trim()) || `kubectl exec exited ${r.code}` };
  try {
    const j = JSON.parse(lastJsonLine(r.stdout)) as { ok?: boolean; userId?: string };
    return j.ok ? { ok: true, userId: j.userId } : { ok: false, errorCode: 'RESET_FAILED', detail: lastJsonLine(r.stdout) };
  } catch {
    return { ok: false, errorCode: 'RESET_FAILED', detail: scrubCreds(r.stdout.trim() || r.stderr.trim()) };
  }
}

async function realRenameDomain(
  env: NodeJS.ProcessEnv,
  opts: { newApex: string; kubeconfig?: string },
): Promise<DomainRenameOutcome> {
  const r = await execApiPodNode(env, opts.kubeconfig, ['dist/cli/platform-domain-rename.js', '--to', opts.newApex]);
  if (r.timedOut) return { ok: false, errorCode: 'TIMEOUT', detail: 'kubectl exec into platform-api timed out after 60s (pod not ready?)' };
  // The entrypoint prints a JSON envelope on stdout even when the rename fails
  // (exit 1), so parse first; fall back to the raw exec failure otherwise.
  try {
    const j = JSON.parse(lastJsonLine(r.stdout)) as {
      ok?: boolean;
      result?: RenamePlatformDomainResult;
      errorCode?: string;
      detail?: string;
    };
    if (j.ok && j.result) return { ok: true, result: j.result };
    return { ok: false, errorCode: j.errorCode ?? 'RENAME_ERROR', detail: scrubCreds(j.detail ?? lastJsonLine(r.stdout)) };
  } catch {
    return { ok: false, errorCode: 'RENAME_ERROR', detail: scrubCreds((r.stderr || r.stdout).trim()) || `kubectl exec exited ${r.code}` };
  }
}

export function realDeps(): Deps {
  const env = process.env;
  return {
    env,
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    exec: realExec,
    versionFromDb: () => realVersionFromDb(env),
    migrationsStatus: () => realMigrationsStatus(env),
    applyMigrations: (opts) => realApplyMigrations(env, opts),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    buildVersion: (process.env.PLATFORM_OPS_VERSION ?? '').trim(),
    dr: realDrOps(),
    snapshot: realSnapshotOps(),
    // Thread the LITERAL process.env.PLATFORM_OPS_VERSION (esbuild --define
    // substitutes only that exact expression) so self-upgrade knows its own
    // baked version — reading it via the `env` alias would not be substituted.
    selfUpgrade: realSelfUpgradeOps(env, (process.env.PLATFORM_OPS_VERSION ?? '').trim()),
    hostConfig: realHostConfigOps(env),
    clusterUpgrade: realClusterUpgradeOps(env),
    node: realNodeOps(env),
    upgrade: realUpgradeOps(env),
    rollback: realRollbackOps(env),
    resetAdminPassword: (opts) => realResetAdminPassword(env, opts),
    renameDomain: (opts) => realRenameDomain(env, opts),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}
