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
  };
}
