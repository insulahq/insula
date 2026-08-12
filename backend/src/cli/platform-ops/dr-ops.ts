/**
 * Real DR operations for platform-ops (ADR-045 / W17).
 *
 * This is the proof of the "CLI imports backend modules directly"
 * architecture: `verifyBundle` and `runRestore` import the SAME
 * `backend/src/modules/dr-restore` primitive the in-cluster
 * `dr-restore-runner` / `scripts/dr-restore-bundle.sh` path uses — zero
 * logic duplication. The host binary works when the cluster/API is
 * degraded because it talks to the DB + k8s API directly, not through
 * platform-api.
 *
 * Every heavy module is loaded via dynamic import() so subcommands that
 * never touch DR (version, cluster, shell) stay lean and start instantly,
 * and so the binary can run with no DATABASE_URL at all (verify is
 * bundle-only). esbuild bundles the dynamic-import targets into the SEA.
 */
import type {
  DrBundleManifest, DrOps, DrRescueFailure, DrRescueOutcome, DrRescueRequest,
  DrRescueSnapshot, DrRestoreOutcome, DrRestoreRequest,
} from './deps.js';
import { scrubCreds } from './redact.js';

function messageOf(err: unknown): string {
  return scrubCreds(err instanceof Error ? err.message : String(err));
}

interface DrErrorClasses {
  readonly LegacyBundleError: new (...a: never[]) => Error;
  readonly BundleVersionError: new (...a: never[]) => Error;
  readonly BundleDecryptError: new (...a: never[]) => Error;
  readonly DrImportError: new (...a: never[]) => Error;
  readonly CnpgRecoveryError: new (...a: never[]) => Error;
  // MailRestoreError carries a separated internal `.detail` (security review
  // LOW#11) — reflect it here so instanceof-narrowing exposes it without a cast.
  readonly MailRestoreError: new (...a: never[]) => Error & { detail?: string };
}

/**
 * Does this look like "the database was not reachable" rather than a DR fault?
 *
 * Postgres pods are NetworkPolicy-restricted and every `from` peer is a pod or
 * namespace selector, so a connection whose SOURCE is a node's host network
 * matches nothing and is dropped. `dr restore` is documented to run from a host
 * (it must work when platform-api is down), which means it only reaches the
 * database from the node running the CNPG primary — everywhere else the pool
 * simply times out. Measured on a 4-node cluster: from the primary's node,
 * ClusterIP:5432 connects in milliseconds; from any other node it hangs until
 * the timeout. That surfaced as a bare "UNEXPECTED — Connection terminated due
 * to connection timeout", which tells an operator mid-incident nothing at all.
 */
export function isDbUnreachable(err: unknown): boolean {
  const m = messageOf(err).toLowerCase();
  return m.includes('connection terminated due to connection timeout')
    || m.includes('timeout exceeded when trying to connect')
    || m.includes('econnrefused')
    || m.includes('etimedout')
    || m.includes('ehostunreach')
    || m.includes('enetunreach');
}

/**
 * Best-effort: name the node the operator must run this on. Uses kubectl, which
 * is unaffected by the restriction above because it goes through the API server.
 * Never throws and never blocks for long — this runs on an error path during an
 * incident, so a missing answer must not replace the error being reported.
 */
async function primaryNodeHint(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const run = (args: string[]): Promise<string> => new Promise((resolve) => {
    try {
      const child = execFile('kubectl', args, { timeout: 8_000 }, (e, out) => resolve(e ? '' : String(out).trim()));
      child.on('error', () => resolve(''));
    } catch { resolve(''); }
  });

  // The primary carries cnpg.io/instanceRole=primary (role=primary on older CNPG).
  let pod = '';
  for (const sel of ['cnpg.io/cluster=system-db,cnpg.io/instanceRole=primary',
                     'cnpg.io/cluster=system-db,role=primary']) {
    pod = await run(['-n', 'platform', 'get', 'pods', '-l', sel, '-o', 'jsonpath={.items[0].metadata.name}']);
    if (pod) break;
  }
  if (!pod) return '';
  const node = await run(['-n', 'platform', 'get', 'pod', pod, '-o', 'jsonpath={.spec.nodeName}']);
  if (!node) return '';
  // Nested range, not a flat jsonpath: a flat one space-joins a dual-stack
  // node's v4 and v6 addresses into a single unusable token.
  const addrs = await run(['get', 'node', node, '-o',
    'jsonpath={range .status.addresses[?(@.type=="InternalIP")]}{.address}{"\n"}{end}']);
  const ips = addrs.split('\n').map((x) => x.trim()).filter(Boolean);
  return ips.length ? `${node} (${ips.join(', ')})` : node;
}

/** Map a thrown DR error to a stable label (same taxonomy as dr-restore-runner). */
function labelOf(err: unknown, c: DrErrorClasses): string {
  if (err instanceof c.LegacyBundleError) return 'LEGACY_BUNDLE';
  if (err instanceof c.BundleVersionError) return 'UNKNOWN_VERSION';
  if (err instanceof c.BundleDecryptError) return 'DECRYPT_ERROR';
  if (err instanceof c.DrImportError) return 'IMPORT_ERROR';
  if (err instanceof c.CnpgRecoveryError) return 'CNPG_RECOVERY_ERROR';
  if (err instanceof c.MailRestoreError) return 'MAIL_RESTORE_ERROR';
  return 'UNEXPECTED';
}

export function realDrOps(): DrOps {
  return {
    async verifyBundle(bundlePath, ageKeyPath, ageBinary): Promise<DrBundleManifest> {
      // Bundle-only: no DB, no cluster. Lets `dr verify` run on a bare
      // jump host with just the bundle + age key. readBundle throws typed
      // errors (BundleDecryptError / LegacyBundleError / BundleVersionError)
      // whose `.name` the command layer maps to a stable label.
      const { readBundle } = await import('../../modules/dr-restore/bundle-reader.js');
      const b = await readBundle({ bundlePath, ageKeyPath, ageBinary });
      const i = b.drInputs;
      return {
        apexDomain: i.apexDomain,
        clusterName: i.clusterName,
        platformVersion: i.platformVersion,
        createdAt: i.createdAt,
        bundleTopology: i.bundleTopology,
        cnpgClusters: i.cnpgClusters,
        secretYamlCount: b.secretYamls.length,
      };
    },

    async runRestore(req: DrRestoreRequest): Promise<DrRestoreOutcome> {
      const [{ loadConfig }, { getDb, closeDb }, k8sMod, drMod] = await Promise.all([
        import('../../config/index.js'),
        import('../../db/index.js'),
        import('../../modules/k8s-provisioner/k8s-client.js'),
        import('../../modules/dr-restore/index.js'),
      ]);
      const { runDrRestore } = drMod;
      const classes: DrErrorClasses = drMod;

      // Setup (config + DB pool) is guarded separately so a missing
      // DATABASE_URL / JWT_SECRET surfaces as the precise SETUP_ERROR label
      // ("fix your environment") rather than UNEXPECTED ("file a bug"). Both
      // calls are inside a try so runRestore honours its never-throws
      // contract (deps.ts); the catch returns, so `db`/`drConfig` are
      // definitely assigned by the time the run block reads them.
      let drConfig: { PLATFORM_BASE_DOMAIN?: string; INGRESS_BASE_DOMAIN?: string; PLATFORM_VERSION?: string };
      let db: ReturnType<typeof getDb>;
      try {
        const config = loadConfig();
        drConfig = {
          PLATFORM_BASE_DOMAIN: config.PLATFORM_BASE_DOMAIN,
          INGRESS_BASE_DOMAIN: config.INGRESS_BASE_DOMAIN,
          PLATFORM_VERSION: config.PLATFORM_VERSION,
        };
        db = getDb(config.DATABASE_URL);
      } catch (err) {
        return { ok: false, errorCode: 'SETUP_ERROR', detail: messageOf(err) };
      }

      // The run block: closeDb in `finally` is reached whenever the pool
      // above was created (DR errors are caught + labelled, never thrown).
      try {
        if (req.mode === 'full') {
          // The discriminated DrRestoreRequest guarantees targetMailNode +
          // confirmClusterNames here; the module re-validates the typed
          // confirmations (value === cluster name verbatim).
          const k8s = k8sMod.createK8sClients(req.kubeconfig);
          const result = await runDrRestore({
            db, mode: 'full',
            bundlePath: req.bundlePath, ageKeyPath: req.ageKeyPath, ageBinary: req.ageBinary,
            strict: req.strict, config: drConfig, k8s,
            confirmClusterNames: req.confirmClusterNames,
            targetMailNode: req.targetMailNode,
          });
          return success(req.mode, result);
        }
        const result = await runDrRestore({
          db, mode: 'partial',
          bundlePath: req.bundlePath, ageKeyPath: req.ageKeyPath, ageBinary: req.ageBinary,
          strict: req.strict, config: drConfig,
        });
        return success(req.mode, result);
      } catch (err) {
        // A connection failure is not a DR fault and must not be reported as
        // one. Say where the command CAN run, by name and address.
        if (isDbUnreachable(err)) {
          const where = await primaryNodeHint();
          const onNode = where
            ? `Run it on ${where} — the node currently running the CNPG primary.`
            : 'Run it on the node currently running the CNPG primary '
              + '(kubectl -n platform get pods -l cnpg.io/cluster=system-db '
              + '-o wide, then use the pod marked primary).';
          return {
            ok: false,
            errorCode: 'DB_UNREACHABLE',
            detail: `${messageOf(err)} — the platform database was not reachable from this host. `
              + `${onNode} Postgres only accepts connections from pods and from its own node, `
              + `so a host-run restore fails anywhere else. `
              + `(kubectl still works from any node; only the direct database connection is restricted.)`,
          };
        }
        const errorCode = labelOf(err, classes);
        // MailRestoreError carries a separated internal `.detail` (security
        // review LOW#11) — surface it on stderr for the operator terminal.
        const extra = err instanceof classes.MailRestoreError && err.detail
          ? ` ${scrubCreds(err.detail)}`
          : '';
        return { ok: false, errorCode, detail: messageOf(err) + extra };
      } finally {
        // closeDb tears down the shared pool; a no-op if getDb never ran.
        await closeDb().catch(() => undefined);
      }
    },

    async rescue(req: DrRescueRequest): Promise<DrRescueOutcome> {
      // Block-level Longhorn snapshots of the system volumes — a safety net
      // before a destructive `dr restore`. Wraps the same `system-snapshots`
      // primitive the /nodes-and-storage UI uses. Enumeration failure
      // (cluster unreachable) → ok:false; per-volume snapshot failures are
      // collected into `failures` so a partial result is visible.
      try {
        const [{ createK8sClients }, snap] = await Promise.all([
          import('../../modules/k8s-provisioner/k8s-client.js'),
          import('../../modules/system-snapshots/service.js'),
        ]);
        const k8s = createK8sClients(req.kubeconfig);
        // Liveness probe FIRST. listSystemPvcSnapshots swallows every per-call
        // error and returns [] on a dead cluster — which for a *rescue* op
        // would dangerously mask "cluster unreachable" as "0 volumes, all
        // good". A cheap cluster-scoped read that throws on a connection
        // failure makes "unreachable" surface as RESCUE_ERROR (outer catch).
        await k8s.core.listNode();
        const summaries = await snap.listSystemPvcSnapshots(k8s);

        const targets = req.volume
          ? summaries.filter((s) => s.longhornVolumeName === req.volume)
          : summaries;
        if (req.volume && targets.length === 0) {
          return { ok: false, errorCode: 'VOLUME_NOT_FOUND', detail: `no system PVC maps to Longhorn volume '${req.volume}'` };
        }

        const snapshots: DrRescueSnapshot[] = [];
        const failures: DrRescueFailure[] = [];
        const seen = new Set<string>();
        for (const s of targets) {
          // Skip PVCs with no bound Longhorn volume + de-dup (a CNPG cluster
          // can surface several PVC rows; one snapshot per volume is enough).
          if (!s.longhornVolumeName || seen.has(s.longhornVolumeName)) continue;
          seen.add(s.longhornVolumeName);
          try {
            const { snapshotName } = await snap.takeSnapshot(k8s, s.longhornVolumeName, req.label);
            snapshots.push({ volumeName: s.longhornVolumeName, namespace: s.namespace, pvcName: s.pvcName, snapshotName });
          } catch (err) {
            failures.push({ volumeName: s.longhornVolumeName, reason: messageOf(err) });
          }
        }
        return { ok: true, snapshots, failures };
      } catch (err) {
        return { ok: false, errorCode: 'RESCUE_ERROR', detail: messageOf(err) };
      }
    },
  };
}

type RunDrRestoreResult = Awaited<ReturnType<Awaited<typeof import('../../modules/dr-restore/index.js')>['runDrRestore']>>;

/** Build a success outcome (manifest + human summary + drift notes). */
function success(mode: 'partial' | 'full', result: RunDrRestoreResult): DrRestoreOutcome {
  const b = result.bundleInfo;
  const ir = result.importResult;
  const summary: string[] = [
    `Imported ${ir.configsInserted} backup configuration(s) `
      + `(${ir.configsSkippedExisting} already present) + ${ir.assignmentsInserted} target assignment(s).`,
  ];
  if (mode === 'partial') {
    summary.push('Rows are read-only — restore tenants individually via the admin UI.');
  } else {
    for (const c of result.cnpgRecoveryResult?.clusters ?? []) {
      summary.push(
        `Recovered CNPG cluster '${c.clusterName}' in ${c.namespace} `
          + `(restore ${c.restoreDurationMs}ms, promote ${c.promoteDurationMs}ms, pitr job ${c.pitrJobName}).`,
      );
    }
    if (result.mailRestoreResult) {
      summary.push(`Mail-stack restored onto node '${result.mailRestoreResult.targetMailNode}' (${result.mailRestoreResult.durationMs}ms).`);
    }
    if (typeof result.drFreezeReappliedRows === 'number') {
      summary.push(`Re-froze ${result.drFreezeReappliedRows} backup configuration row(s) read-only after promote.`);
    }
  }
  return {
    ok: true,
    bundleInfo: {
      apexDomain: b.apexDomain,
      clusterName: b.clusterName,
      platformVersion: b.platformVersion,
      createdAt: b.createdAt,
      // runDrRestore's bundleInfo doesn't surface topology; `dr verify` reads
      // it straight off drInputs. Restore output just doesn't carry it.
      bundleTopology: 'unknown',
      cnpgClusters: b.cnpgClusters,
      secretYamlCount: b.secretYamlCount,
    },
    summary,
    driftNotes: ir.drift.hasDrift ? ir.drift.notes : undefined,
  };
}
