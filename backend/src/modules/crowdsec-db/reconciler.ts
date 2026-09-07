/**
 * CrowdSec LAPI Postgres provisioner (R35).
 *
 * Moves the CrowdSec LAPI off SQLite and onto the platform's CNPG cluster, so
 * the LAPI can eventually run more than one replica. SQLite is single-writer;
 * two replicas sharing one file is not a supported configuration, which is why
 * the LAPI is `replicas: 1` + `Recreate` and every rollout has a window with no
 * decision-learning.
 *
 * WHAT THIS DOES, on boot and on a 5-minute tick:
 *
 *   1. Ensure a password exists in `crowdsec/crowdsec-db-credentials`,
 *      generating one on first run and reusing it forever after.
 *   2. Ensure the `crowdsec` role + `crowdsec` database exist in the CNPG
 *      cluster, with that password. Idempotent — converges with no churn.
 *
 * The LAPI pod picks the credentials up from the same Secret: the `seed-config`
 * init container renders them into `db_config` with yq, and only when the
 * Secret is actually mounted. A cluster without it stays on SQLite, so this is
 * additive rather than a flag day.
 *
 * WHY NOT THE CNPG `Database` CR / `managed.roles`
 *
 * Both exist and would work, but they mean editing the `system-db` Cluster
 * spec — the platform's own database — to provision a side concern. The
 * roundcube reconciler already establishes the pattern of creating a role +
 * database with idempotent SQL against the primary, and that keeps this change
 * entirely outside the Cluster manifest.
 *
 * TWO NETWORK POLICIES ARE REQUIRED, and missing either one is silent:
 * `crowdsec` egress to `platform:5432`, and `allow-crowdsec-to-postgres`
 * ingress in `platform` (its `default-deny-ingress` drops the rest). Verified
 * on DEV 2026-09-07 — with only the egress rule, DNS resolved and the TCP
 * connect hung until timeout, which would present as a LAPI that looks
 * configured and reaches nothing.
 */
import * as k8s from '@kubernetes/client-node';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { rollCrowdsecLapiSafely } from '../security-hardening/crowdsec.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

export const CROWDSEC_NAMESPACE = 'crowdsec';
export const CROWDSEC_DB_SECRET = 'crowdsec-db-credentials';
export const CNPG_NAMESPACE = 'platform';
export const CNPG_CLUSTER = 'system-db';
/** Read-write service of the CNPG cluster — always the primary. */
export const CNPG_RW_HOST = 'system-db-rw.platform.svc.cluster.local';
export const CNPG_PORT = '5432';
export const CROWDSEC_DB_NAME = 'crowdsec';
export const CROWDSEC_DB_USER = 'crowdsec';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
/** Two replicas once the durable store is Postgres — removes the rollout gap. */
export const LAPI_REPLICAS_POSTGRES = 2;
/** One while SQLite is the backend: it is single-writer. */
export const LAPI_REPLICAS_SQLITE = 1;
const PSQL_TIMEOUT_MS = 15_000;

export interface CrowdsecDbReconcileResult {
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly applied: boolean;
  readonly createdSecret?: boolean;
  /** True when a live LAPI is registered in the Postgres database. */
  readonly onPostgres?: boolean;
}

type Logger = Pick<Console, 'info' | 'warn' | 'error'> & { debug?: (...a: unknown[]) => void };

/**
 * 32 bytes from the CSPRNG, base64url. Not `Math.random`, and not derived from
 * another secret: a derived password would silently rotate everywhere the
 * source rotated, and Postgres would then reject a LAPI that had not restarted.
 */
function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

interface ReadSecret {
  readonly data: Record<string, string>;
  /**
   * Required on every PUT. Kubernetes rejects a replace without it
   * (`metadata.resourceVersion: Invalid value: "": must be specified for an
   * update`), so dropping it made the repair path below permanently inert —
   * it would fail every tick, forever, while its unit test passed because the
   * mock resolved unconditionally.
   */
  readonly resourceVersion?: string;
}

async function readSecret(
  core: k8s.CoreV1Api,
  namespace: string,
  name: string,
): Promise<ReadSecret | null> {
  try {
    const secret = (await core.readNamespacedSecret({
      namespace,
      name,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0])) as {
      data?: Record<string, string>;
      metadata?: { resourceVersion?: string };
    };
    return { data: secret.data ?? {}, resourceVersion: secret.metadata?.resourceVersion };
  } catch {
    return null;
  }
}

async function findCnpgPrimaryPod(core: k8s.CoreV1Api): Promise<string | null> {
  try {
    const list = (await core.listNamespacedPod({
      namespace: CNPG_NAMESPACE,
      labelSelector: `cnpg.io/cluster=${CNPG_CLUSTER},role=primary`,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0])) as {
      items?: ReadonlyArray<{ metadata?: { name?: string } }>;
    };
    const name = list.items?.[0]?.metadata?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

async function execStdin(
  exec: k8s.Exec,
  namespace: string,
  podName: string,
  containerName: string,
  argv: string[],
  stdin: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutSink = new PassThrough();
    stdoutSink.on('data', (c: Buffer) => stdoutChunks.push(c));
    const stderrSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        stderrChunks.push(chunk);
        cb();
      },
    });
    const stdinSource = new PassThrough();
    const timer = setTimeout(
      () => reject(new Error('crowdsec-db psql exec timed out after 15s')),
      PSQL_TIMEOUT_MS,
    );

    exec
      .exec(namespace, podName, containerName, argv, stdoutSink, stderrSink, stdinSource, false, (status) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          success: status.status !== 'Failure',
        });
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });

    stdinSource.write(stdin);
    stdinSource.end();
  });
}

/**
 * psql `\set` line assigning a variable, safely.
 *
 * Generated passwords are base64url ([A-Za-z0-9_-]), which contains no quote or
 * backslash — but this must not depend on that staying true, because the value
 * is spliced into a psql meta-command. Anything outside the expected alphabet
 * is rejected rather than escaped: a password we cannot represent safely is a
 * bug to surface, not a string to mangle.
 */
export function psqlSetVar(name: string, value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`crowdsec-db: refusing to pass a value with unexpected characters as psql variable ${name}`);
  }
  return `\\set ${name} '${value}'`;
}

/**
 * Idempotent role + database SQL.
 *
 * Injection safety: the password never appears in this string. It arrives as a
 * psql variable set over STDIN (see psqlSetVar) and is referenced as `:'cspw'`,
 * which psql substitutes as a properly quoted SQL literal; `quote_literal()`
 * then quotes it again server-side for the statement `\gexec` emits.
 *
 * `\gexec` rather than a DO block because psql variables do not substitute
 * inside `$$ … $$`.
 */
export function buildCrowdsecDbSql(): string {
  return [
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CROWDSEC_DB_USER}')`,
    `       THEN 'ALTER ROLE ${CROWDSEC_DB_USER} WITH LOGIN PASSWORD ' || quote_literal(:'cspw')`,
    // NOSUPERUSER/NOCREATEDB/NOCREATEROLE are Postgres defaults for an omitted
    // attribute; stating them makes the intent auditable rather than implied.
    `       ELSE 'CREATE ROLE ${CROWDSEC_DB_USER} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ' || quote_literal(:'cspw')`,
    `       END \\gexec`,
    `SELECT 'CREATE DATABASE ${CROWDSEC_DB_NAME} OWNER ${CROWDSEC_DB_USER}'`,
    `  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${CROWDSEC_DB_NAME}') \\gexec`,
    `GRANT ALL PRIVILEGES ON DATABASE ${CROWDSEC_DB_NAME} TO ${CROWDSEC_DB_USER};`,
  ].join('\n');
}

/**
 * Ensure the credentials Secret exists, returning the password.
 *
 * Never regenerates an existing password: the LAPI reads it at pod start, so
 * rotating it here without restarting the pod would leave a running LAPI
 * authenticating with a password Postgres no longer accepts.
 */
export async function ensureDbSecret(
  core: k8s.CoreV1Api,
  log: Logger,
): Promise<{ password: string; created: boolean } | null> {
  const existing = await readSecret(core, CROWDSEC_NAMESPACE, CROWDSEC_DB_SECRET);
  const b64 = existing?.data.password;
  if (b64) {
    return { password: Buffer.from(b64, 'base64').toString('utf8'), created: false };
  }

  const password = generatePassword();
  const body = {
    metadata: {
      name: CROWDSEC_DB_SECRET,
      namespace: CROWDSEC_NAMESPACE,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'waf',
      },
    },
    type: 'Opaque',
    stringData: {
      host: CNPG_RW_HOST,
      port: CNPG_PORT,
      dbname: CROWDSEC_DB_NAME,
      username: CROWDSEC_DB_USER,
      password,
      sslmode: 'require',
    },
  };

  try {
    if (existing === null) {
      // Platform infrastructure, not tenant data: WAF database credentials for
      // a cluster-scoped component. Losing it costs nothing — this reconciler
      // generates a fresh password and ALTERs the Postgres role to match on
      // the next tick, so restoring a stale copy would be worse than restoring
      // none. The decisions it protects are themselves ephemeral (community
      // entries re-pull, agent detections re-detect).
      //
      // backup-coverage: excluded:cluster-infrastructure
      await core.createNamespacedSecret({ namespace: CROWDSEC_NAMESPACE, body } as unknown as
        Parameters<typeof core.createNamespacedSecret>[0]);
      log.info('crowdsec-db: created crowdsec-db-credentials');
      return { password, created: true };
    }
    // Secret exists but has no password key — repair it in place rather than
    // leaving the LAPI with an unusable half-Secret. resourceVersion is
    // mandatory on a replace; without it the API server rejects the call.
    //
    // backup-coverage: excluded:cluster-infrastructure
    await core.replaceNamespacedSecret({
      name: CROWDSEC_DB_SECRET,
      namespace: CROWDSEC_NAMESPACE,
      body: { ...body, metadata: { ...body.metadata, resourceVersion: existing.resourceVersion } },
    } as unknown as Parameters<typeof core.replaceNamespacedSecret>[0]);
    log.warn('crowdsec-db: crowdsec-db-credentials was missing its password key — repaired');
    return { password, created: true };
  } catch (err) {
    // A 409 means another replica created it first (HA runs platform-api at
    // 2-3 replicas). Re-read rather than treating our generated value as the
    // truth, or the two would disagree about the password.
    const status = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (status === 409) {
      const raced = await readSecret(core, CROWDSEC_NAMESPACE, CROWDSEC_DB_SECRET);
      const rb64 = raced?.data.password;
      if (rb64) return { password: Buffer.from(rb64, 'base64').toString('utf8'), created: false };
    }
    log.warn(
      `crowdsec-db: could not ensure the credentials Secret: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Is the LAPI actually using Postgres, right now?
 *
 * Asked of the DATABASE, not of a manifest or a Secret. A LAPI on Postgres
 * registers its machines there on start, so a non-empty `machines` table is
 * proof that a live LAPI is talking to this database. The Secret existing
 * proves only that provisioning ran; the pod may still be on SQLite, which is
 * exactly the state DEV was in for twenty minutes on 2026-09-07.
 *
 * This gates the replica count, so getting it wrong in the optimistic
 * direction would put two pods on one SQLite file — the single-writer
 * condition R35 exists to escape.
 */
async function lapiIsOnPostgres(exec: k8s.Exec, podName: string): Promise<boolean> {
  try {
    const r = await execStdin(
      exec, CNPG_NAMESPACE, podName, 'postgres',
      ['psql', '-X', '-q', '-t', '-A', '-U', 'postgres', '-d', CROWDSEC_DB_NAME],
      'SELECT count(*) FROM machines;',
    );
    if (!r.success) return false;
    return Number.parseInt(r.stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Pod names generated by a ReplicaSet: `crowdsec-<rs-hash>-<pod-suffix>`.
 *
 * Deliberately narrow. It is the allow-list for what the prune below is
 * permitted to delete, so it must not match the agent (`insula-agent`), a
 * bouncer, or anything an operator registered by hand.
 */
const LAPI_POD_MACHINE_RE = /^crowdsec-[a-z0-9]+-[a-z0-9]{5}$/;

/**
 * Delete the LAPI self-registration rows of pods that no longer exist.
 *
 * Each pod registers its own cscli identity under its pod name (CUSTOM_HOSTNAME
 * comes from the downward API — see the Deployment). That is what makes more
 * than one replica safe on a shared database, but it also means every pod
 * replacement leaves a row behind, and pods are replaced on every release.
 * Left alone the table grows without bound and `cscli machines list` becomes
 * unreadable.
 *
 * Scoped three ways, because this issues a DELETE against the WAF's own
 * database on a five-minute timer:
 *   - only rows whose name has the ReplicaSet pod shape,
 *   - only rows not currently backed by a live pod,
 *   - and nothing at all if the pod list came back empty, since "no pods" is
 *     indistinguishable here from a failed List call, and acting on it would
 *     delete the identity of every running replica.
 */
async function pruneOrphanedLapiMachines(
  core: k8s.CoreV1Api,
  exec: k8s.Exec,
  cnpgPod: string,
  log: Logger,
): Promise<number> {
  let live: string[];
  try {
    const list = (await core.listNamespacedPod({
      namespace: CROWDSEC_NAMESPACE,
      labelSelector: 'app.kubernetes.io/name=crowdsec',
    } as unknown as Parameters<typeof core.listNamespacedPod>[0])) as {
      items?: ReadonlyArray<{ metadata?: { name?: string } }>;
    };
    live = (list.items ?? [])
      .map((p) => p.metadata?.name)
      .filter((n): n is string => typeof n === 'string' && LAPI_POD_MACHINE_RE.test(n));
  } catch (err) {
    log.warn({ err }, 'crowdsec-db: could not list LAPI pods; skipping machine prune');
    return 0;
  }
  if (live.length === 0) return 0;

  // Every element already matched LAPI_POD_MACHINE_RE, so it is [a-z0-9-] only
  // and cannot terminate the literal it is embedded in.
  const keep = live.map((n) => `'${n}'`).join(',');
  const r = await execStdin(
    exec, CNPG_NAMESPACE, cnpgPod, 'postgres',
    ['psql', '-X', '-q', '-t', '-A', '-U', 'postgres', '-d', CROWDSEC_DB_NAME],
    `DELETE FROM machines WHERE machine_id ~ '^crowdsec-[a-z0-9]+-[a-z0-9]{5}$' `
      + `AND machine_id NOT IN (${keep});`,
  );
  if (!r.success) {
    log.warn({ stderr: r.stderr.slice(0, 400) }, 'crowdsec-db: machine prune failed');
    return 0;
  }
  const deleted = Number.parseInt((r.stdout.match(/DELETE (\d+)/) ?? [])[1] ?? '0', 10);
  if (deleted > 0) log.info({ deleted, live: live.length }, 'crowdsec-db: pruned stale LAPI machines');
  return deleted;
}

/**
 * Hold the LAPI at the replica count its storage backend can support.
 *
 * `replicas` is deliberately absent from the manifest (Flux SSA would revert an
 * imperative scale within ~30s), so this reconciler owns it — the same division
 * of labour as platform-storage-policy and the backend Deployment.
 *
 * Scales DOWN as well as up: if Postgres stops being the backend, two pods
 * sharing one SQLite file is a corruption risk, not a degraded-but-fine state.
 */
async function ensureLapiReplicas(
  kc: k8s.KubeConfig,
  desired: number,
  log: Logger,
): Promise<void> {
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  try {
    const dep = (await (apps as unknown as {
      readNamespacedDeployment: (a: { name: string; namespace: string }) => Promise<{ spec?: { replicas?: number } }>;
    }).readNamespacedDeployment({ name: 'crowdsec', namespace: CROWDSEC_NAMESPACE }));
    const current = dep.spec?.replicas ?? 1;
    if (current === desired) return;
    await (apps as unknown as {
      patchNamespacedDeployment: (a: unknown, o?: unknown) => Promise<unknown>;
    }).patchNamespacedDeployment(
      { name: 'crowdsec', namespace: CROWDSEC_NAMESPACE, body: { spec: { replicas: desired } } },
      MERGE_PATCH,
    );
    log.info(`crowdsec-db: scaled the LAPI ${current} -> ${desired} replica(s)`);
  } catch (err) {
    log.warn(`crowdsec-db: could not set the LAPI replica count: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Provision the role + database. Safe to run on every tick. */
export async function reconcileCrowdsecDb(
  core: k8s.CoreV1Api,
  kc: k8s.KubeConfig,
  log: Logger,
): Promise<CrowdsecDbReconcileResult> {
  const secret = await ensureDbSecret(core, log);
  if (!secret) return { skipped: true, skipReason: 'secret_unavailable', applied: false };

  const podName = await findCnpgPrimaryPod(core);
  if (!podName) {
    // No primary yet (cluster starting, or no CNPG at all). Not an error —
    // the next tick converges.
    return { skipped: true, skipReason: 'primary_pod_missing', applied: false, createdSecret: secret.created };
  }

  const exec = new k8s.Exec(kc);
  let result: { stdout: string; stderr: string; success: boolean };
  try {
    result = await execStdin(
      exec,
      CNPG_NAMESPACE,
      podName,
      'postgres',
      // -X ignores .psqlrc; ON_ERROR_STOP makes a failed statement a failed
      // exec instead of a silent partial apply.
      ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
      // The password goes over STDIN, never argv.
      //
      // @kubernetes/client-node serialises the command array into the pod-exec
      // subresource's QUERY STRING, so `-v cspw=<secret>` would put the
      // plaintext password in the request URI — which is what an API-server
      // audit log records as RequestURI at every audit level, and what appears
      // in /proc/<pid>/cmdline on the CNPG primary for the life of the psql
      // process. On a 5-minute tick that is forever.
      `${psqlSetVar('cspw', secret.password)}\n${buildCrowdsecDbSql()}`,
    );
  } catch (err) {
    log.warn(`crowdsec-db: psql exec failed: ${err instanceof Error ? err.message : String(err)}`);
    return { skipped: false, applied: false, skipReason: 'psql_failed', createdSecret: secret.created };
  }

  if (!result.success) {
    // stderr can echo the statement, which contains the quoted password —
    // never log it verbatim.
    log.warn('crowdsec-db: psql reported failure while ensuring the role/database');
    return { skipped: false, applied: false, skipReason: 'psql_error', createdSecret: secret.created };
  }

  // Roll the LAPI the FIRST time we provision, and only then.
  //
  // The init container reads the credentials at pod start. On an upgrading
  // cluster the pod is already running when this reconciler creates the
  // Secret, so without a roll it keeps the SQLite config until something else
  // restarts it — observed on DEV 2026-09-07: database and Secret provisioned,
  // pod 3 minutes older than the Secret, `seed-config: db credentials absent
  // — staying on sqlite`. Stored, not running.
  //
  // Reloader cannot cover this: it acts on UPDATES to resources it already
  // tracks and does not fire on creation (established the same day with the
  // CAPI ConfigMap). The annotation is still added for later rotations.
  //
  // Gated on `created` so a steady-state tick never bounces the LAPI.
  if (secret.created) {
    await rollCrowdsecLapiSafely(kc, 'crowdsec-db credentials provisioned');
  }

  // Replica count follows the storage backend, verified against the database
  // rather than assumed from the Secret's existence.
  const onPostgres = await lapiIsOnPostgres(exec, podName);
  await ensureLapiReplicas(kc, onPostgres ? LAPI_REPLICAS_POSTGRES : LAPI_REPLICAS_SQLITE, log);
  // Only meaningful once the pods share a database; on SQLite each pod's
  // machines table is private and there is nothing global to prune.
  if (onPostgres) await pruneOrphanedLapiMachines(core, exec, podName, log);

  return { skipped: false, applied: true, createdSecret: secret.created, onPostgres };
}

/** Boot + 5-minute convergence, mirroring the roundcube reconciler. */
export function startCrowdsecDbReconciler(
  core: k8s.CoreV1Api,
  kc: k8s.KubeConfig,
  log: Logger,
): { stop: () => void } {
  const tick = (): void => {
    void reconcileCrowdsecDb(core, kc, log)
      .then((r) => {
        if (r.applied && r.createdSecret) {
          log.info('crowdsec-db: role + database ensured (credentials created)');
        }
      })
      .catch((err) => {
        log.warn(`crowdsec-db: reconcile threw: ${err instanceof Error ? err.message : String(err)}`);
      });
  };
  tick();
  const timer = setInterval(tick, TICK_INTERVAL_MS);
  // Matches the roundcube reconciler: a convergence timer must never be the
  // reason the process refuses to exit.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
