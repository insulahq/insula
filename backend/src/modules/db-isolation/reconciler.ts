/**
 * Database connection-isolation converger (ROADMAP R36).
 *
 * Removes the `PUBLIC` CONNECT blanket from every database in the platform's
 * CNPG cluster, so a per-service login role can authenticate into its own
 * database and nothing else. The SQL, the reasoning, and the one genuinely
 * dangerous interaction (the CNPG metrics exporter connects to EVERY database)
 * live in `sql.ts`.
 *
 * ## Why a converger and not a migration
 *
 * A Drizzle migration could revoke on `platform` — the migration runs as
 * `platform`, which owns it — but it could never own `postgres`, `crowdsec` or
 * `roundcube`, which are separate databases created outside the platform
 * schema's lifecycle. And a migration runs once: a database restored from a
 * pre-R36 dump, or a database created later by a new service reconciler, would
 * come back with the blanket re-granted and nothing would notice. ROADMAP R36
 * asks for this "cluster-level rather than per-service", which is what this is.
 *
 * The two creation paths (`crowdsec-db`, `roundcube-db-reconciler`) additionally
 * revoke inline at CREATE time, so a freshly created database is never briefly
 * open while waiting for this tick.
 *
 * ## Blast radius
 *
 * Superusers bypass CONNECT entirely, so `postgres` and `platform` are
 * unaffected however this lands. The roles that could be affected are exactly
 * the non-superuser login roles, and the `atRisk` readout names any that are
 * connected but would be refused on reconnect — the alarm for a cluster whose
 * connection set nobody enumerated.
 *
 * Runs against the CNPG **primary** only; ACL changes replicate to standbys.
 */
import * as k8s from '@kubernetes/client-node';
import { PassThrough, Writable } from 'node:stream';
import {
  buildAtRiskRolesSql,
  buildDbIsolationSql,
  buildDbIsolationStateSql,
  parseAtRiskRoles,
  parseDbIsolationState,
  type AtRiskRole,
  type DbIsolationEntry,
} from './sql.js';

/**
 * The logging surface this module actually uses.
 *
 * Structural rather than pino's `Logger`: Fastify hands callers a
 * `FastifyBaseLogger`, which is missing `msgPrefix` and so does not satisfy
 * pino's full interface. Depending on the full type here would force every
 * call site into an `as unknown as` cast, and a cast at a boundary is how a
 * genuinely wrong argument gets through later.
 */
export interface IsolationLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
}

export const CNPG_NAMESPACE = 'platform';
export const CNPG_CLUSTER_NAME = 'system-db';
const PSQL_TIMEOUT_MS = 15_000;
/**
 * Five minutes, matching the roundcube and crowdsec-db convergers. This is a
 * property that changes only when someone creates a database, so the tick
 * exists to close that window rather than to chase drift.
 */
const TICK_INTERVAL_MS = 5 * 60 * 1000;

export interface DbIsolationResult {
  readonly skipped: boolean;
  readonly skipReason?: 'primary_pod_missing' | 'exec_failed';
  readonly applied: boolean;
  /** Per-database state read back from `pg_database` AFTER applying. */
  readonly state: readonly DbIsolationEntry[];
  /** Roles connected now that would be refused on reconnect. Empty is the good case. */
  readonly atRisk: readonly AtRiskRole[];
  readonly stderr?: string;
}

async function findCnpgPrimaryPod(core: k8s.CoreV1Api): Promise<string | null> {
  try {
    const list = (await core.listNamespacedPod({
      namespace: CNPG_NAMESPACE,
      labelSelector: `cnpg.io/cluster=${CNPG_CLUSTER_NAME},role=primary`,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0])) as {
      items?: ReadonlyArray<{ metadata?: { name?: string } }>;
    };
    const name = list.items?.[0]?.metadata?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Run psql in the CNPG primary, feeding SQL over STDIN.
 *
 * STDIN rather than `-c` because the apply script is a multi-line `DO` block
 * full of quoting that does not survive argv round-tripping intact.
 */
async function execPsql(
  exec: k8s.Exec,
  podName: string,
  sql: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutSink = new Writable({
      write(chunk, _enc, cb) {
        stdoutChunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const stderrSink = new Writable({
      write(chunk, _enc, cb) {
        stderrChunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const stdinSource = new PassThrough();
    const timer = setTimeout(
      () => reject(new Error('db-isolation: psql exec timed out after 15s')),
      PSQL_TIMEOUT_MS,
    );

    exec
      .exec(
        CNPG_NAMESPACE,
        podName,
        'postgres',
        // -X: ignore ~/.psqlrc. -q: no chatter. -A -t: bare values, so the
        // JSON readouts arrive as exactly one parseable line.
        ['psql', '-X', '-q', '-A', '-t', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
        stdoutSink,
        stderrSink,
        stdinSource,
        false,
        (status) => {
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            success: status.status !== 'Failure',
          });
        },
      )
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });

    stdinSource.write(sql);
    stdinSource.end();
  });
}

/**
 * Read the isolation state without changing anything.
 *
 * Used by the admin UI. Kept separate from `reconcileDbIsolation` so rendering
 * the card can never be the thing that mutates the cluster.
 */
export async function readDbIsolationState(
  core: k8s.CoreV1Api,
  kc: k8s.KubeConfig,
): Promise<{ state: DbIsolationEntry[]; atRisk: AtRiskRole[] } | null> {
  const pod = await findCnpgPrimaryPod(core);
  if (!pod) return null;
  const exec = new k8s.Exec(kc);
  try {
    const r = await execPsql(exec, pod, `${buildDbIsolationStateSql()}\n${buildAtRiskRolesSql()}`);
    if (!r.success) return null;
    // Two statements, two JSON lines, in order. Blank lines are psql's, not ours.
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) return null;
    const state = parseDbIsolationState(lines[0]);
    const atRisk = parseAtRiskRoles(lines[1]);
    if (state === null || atRisk === null) return null;
    return { state, atRisk };
  } catch {
    return null;
  }
}

/**
 * Converge the cluster, then read back what is actually true.
 *
 * The readout is a second round-trip against `pg_database` rather than an echo
 * of the intent, because "the converger says it applied" and "PUBLIC no longer
 * holds CONNECT" are different claims and only the second one is the feature.
 */
export async function reconcileDbIsolation(
  core: k8s.CoreV1Api,
  kc: k8s.KubeConfig,
  log: IsolationLogger,
): Promise<DbIsolationResult> {
  const empty = { state: [] as DbIsolationEntry[], atRisk: [] as AtRiskRole[] };
  const pod = await findCnpgPrimaryPod(core);
  if (!pod) {
    // Fresh install before CNPG is Ready, or a failover in progress. Not a
    // failure — the next tick finds it.
    return { skipped: true, skipReason: 'primary_pod_missing', applied: false, ...empty };
  }

  const exec = new k8s.Exec(kc);
  let r: { stdout: string; stderr: string; success: boolean };
  try {
    r = await execPsql(
      exec,
      pod,
      `${buildDbIsolationSql()}\n${buildDbIsolationStateSql()}\n${buildAtRiskRolesSql()}`,
    );
  } catch (err) {
    log.warn(
      `db-isolation: psql exec failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { skipped: true, skipReason: 'exec_failed', applied: false, ...empty };
  }

  if (!r.success) {
    log.warn({ stderr: r.stderr.slice(0, 400) }, 'db-isolation: apply failed');
    return { skipped: true, skipReason: 'exec_failed', applied: false, ...empty, stderr: r.stderr };
  }

  const lines = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  // The DO block emits its own "DO" tag on some psql versions and nothing on
  // others, so the JSON is located by parsing from the end rather than by a
  // fixed offset — an off-by-one here would silently report an empty state.
  const state = lines.length >= 2 ? parseDbIsolationState(lines[lines.length - 2]) : null;
  const atRisk = lines.length >= 1 ? parseAtRiskRoles(lines[lines.length - 1]) : null;

  if (state === null || atRisk === null) {
    log.warn(
      { stdout: r.stdout.slice(0, 400) },
      'db-isolation: applied, but the state read-back could not be parsed',
    );
    return { skipped: false, applied: true, ...empty };
  }

  const stillOpen = state.filter((s) => s.publicConnect).map((s) => s.datname);
  if (stillOpen.length > 0) {
    // The apply reported success and the property is still false. That is a
    // bug in this module, not a transient — say so loudly rather than letting
    // the UI render a half-converged cluster as normal.
    log.error({ databases: stillOpen }, 'db-isolation: PUBLIC still holds CONNECT after apply');
  }
  if (atRisk.length > 0) {
    log.error(
      { atRisk },
      'db-isolation: roles are connected that can no longer reconnect — grant CONNECT explicitly',
    );
  }

  return { skipped: false, applied: true, state, atRisk };
}

/**
 * Boot + 5-minute timer, matching the sibling convergers.
 *
 * `unref()` so a convergence timer is never the reason the process refuses to
 * exit.
 */
export function startDbIsolationReconciler(
  core: k8s.CoreV1Api,
  kc: k8s.KubeConfig,
  log: IsolationLogger,
): { stop: () => void } {
  let lastSignature = '';
  const tick = (): void => {
    void reconcileDbIsolation(core, kc, log)
      .then((res) => {
        if (!res.applied) return;
        // Log on change only. This runs every 5 minutes forever and the steady
        // state is "nothing happened"; an unconditional info line would bury
        // the one tick that matters.
        const signature = res.state
          .map((s) => `${s.datname}:${s.publicConnect ? 'open' : 'closed'}`)
          .join(',');
        if (signature !== lastSignature) {
          log.info(
            { databases: res.state.length, atRisk: res.atRisk.length },
            'db-isolation: PUBLIC CONNECT revoked; owner + metrics exporter granted',
          );
          lastSignature = signature;
        }
      })
      .catch((err) => {
        log.warn(
          `db-isolation: reconcile threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };
  tick();
  const timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
