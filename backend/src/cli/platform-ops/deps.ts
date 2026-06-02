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

export interface VersionInfo {
  installed: string;
  running: string;
  available: string | null;
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
  /** Read a file's contents, or null if it can't be read. */
  readFile: (path: string) => string | null;
  /** The version compiled into this binary at build time (PLATFORM_OPS_VERSION). */
  buildVersion: string;
  /** Disaster-recovery operations (bundle verify + restore). */
  dr: DrOps;
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

export function realDeps(): Deps {
  const env = process.env;
  return {
    env,
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    exec: realExec,
    versionFromDb: () => realVersionFromDb(env),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    buildVersion: (process.env.PLATFORM_OPS_VERSION ?? '').trim(),
    dr: realDrOps(),
  };
}
