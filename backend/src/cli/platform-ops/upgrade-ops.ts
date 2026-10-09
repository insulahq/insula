/**
 * Real upgrade operations for platform-ops (ADR-045 W13, ADR-064 §9).
 *
 * An apply runs the SAME pre-flight and starts the SAME run the admin panel
 * does, talking to the DB + k8s API directly; platform-api's reconciler then
 * drives it (nodes first, then the services). `direct` keeps the original
 * host-side Flux re-pin as break-glass — for when platform-api is down and
 * cannot drive a run. Heavy modules load via dynamic import() so other
 * subcommands stay lean.
 */
import type { UpgradeOps, UpgradeRunResult } from './deps.js';
import { scrubCreds } from './redact.js';

const fail = (errorCode: string, summary: string): UpgradeRunResult => ({
  ok: false, errorCode, action: 'error', target: null, reason: '', proceed: false, applied: false, gitRepository: null, summary,
});

async function withPlatform<T>(env: NodeJS.ProcessEnv, fn: (ctx: {
  db: ReturnType<typeof import('../../db/index.js')['getDb']>;
  k8s: ReturnType<typeof import('../../modules/k8s-provisioner/k8s-client.js')['createK8sClients']>;
}) => Promise<T>): Promise<T> {
  const [{ getDb, closeDb }, { createK8sClients }, { existsSync }] = await Promise.all([
    import('../../db/index.js'),
    import('../../modules/k8s-provisioner/k8s-client.js'),
    import('node:fs'),
  ]);
  const db = getDb(env.DATABASE_URL as string);
  try {
    const kc = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
    const k8s = existsSync(kc) ? createK8sClients(kc) : createK8sClients();
    return await fn({ db, k8s });
  } finally {
    await closeDb();
  }
}

export function realUpgradeOps(env: NodeJS.ProcessEnv): UpgradeOps {
  return {
    async run(opts): Promise<UpgradeRunResult> {
      if (!env.DATABASE_URL) return fail('NO_DATABASE_URL', 'DATABASE_URL is required to plan an upgrade');
      try {
        return await withPlatform(env, async ({ db, k8s }) => {
          const [{ runUpgrade, dbSettings }, { captureUpgradeRescue, realRollbackDeps }, { collectPreflightFacts }, { evaluatePreflight }] = await Promise.all([
            import('../../modules/platform-upgrades/orchestrate.js'),
            import('../../modules/platform-upgrades/rollback.js'),
            import('../../modules/platform-upgrades/collect-preflight.js'),
            import('../../modules/platform-upgrades/preflight.js'),
          ]);
          const excluded = [...(opts.excludeNodes ?? [])];
          const pf = evaluatePreflight(await collectPreflightFacts(db, k8s, Date.now(), excluded));
          const blocking = pf.gates.filter((g) => g.status === 'fail').map((g) => `${g.label}: ${g.detail}`);
          const plan = await runUpgrade(dbSettings(db), k8s, { mode: opts.mode, requestedVersion: opts.requestedVersion, apply: false });
          const base = {
            action: plan.decision.action, target: plan.decision.target, reason: plan.decision.reason,
            proceed: plan.decision.proceed, gitRepository: plan.gitRepository, blocking,
          };
          if (!opts.apply || !plan.decision.proceed) {
            return { ...base, ok: true, applied: false, summary: plan.summary };
          }
          // The same gate the API enforces — `--direct` included: break-glass skips
          // platform-api, not the safety checks.
          if (!pf.ok) {
            return { ...base, ok: false, applied: false, errorCode: 'PREFLIGHT_FAILED', summary: `pre-flight has ${pf.failures} blocking failure(s)` };
          }
          if (opts.direct) {
            const rollback = { capture: (input: { fromVersion: string | null; toVersion: string }) => captureUpgradeRescue(realRollbackDeps(db, k8s), input).then((c) => ({ ok: c.ok, reason: c.reason })) };
            const r = await runUpgrade(dbSettings(db), k8s, { mode: opts.mode, requestedVersion: opts.requestedVersion, apply: true, rollback });
            return {
              ...base, ok: !(r.decision.proceed && !r.applied), applied: r.applied,
              summary: `${r.summary}${r.applied ? ' — services only (break-glass): each node catches up on its hourly update check' : ''}`,
            };
          }
          const { startRunWithTask } = await import('../../modules/platform-upgrades/run/real.js');
          const target = plan.decision.target as string;
          const installed = (await dbSettings(db).get('installed_platform_version'))?.trim() || null;
          const run = await startRunWithTask(db, k8s, { fromVersion: installed, toVersion: target, mode: 'manual', excludedNodes: excluded, initiatedBy: null });
          const started = run.status === 'running';
          return {
            ...base, ok: started, applied: started, runId: run.id,
            ...(started ? {} : { errorCode: 'RUN_NOT_STARTED' }),
            summary: started
              ? `upgrade to ${target} started (run ${run.id}): every node takes the release first, then the services roll${excluded.length ? `; without ${excluded.join(', ')}` : ''}`
              : run.message ?? 'the upgrade could not be started',
          };
        });
      } catch (err) {
        const msg = scrubCreds(err instanceof Error ? err.message : String(err));
        return fail(/already running/i.test(msg) ? 'UPGRADE_ALREADY_RUNNING' : 'UPGRADE_ERROR', msg);
      }
    },

    async status() {
      if (!env.DATABASE_URL) return { ok: false, lines: [], errorCode: 'NO_DATABASE_URL' };
      try {
        return await withPlatform(env, async ({ db }) => {
          const { getActiveRun, listRuns, toUpgradeRun } = await import('../../modules/platform-upgrades/run/store.js');
          const row = (await getActiveRun(db)) ?? (await listRuns(db, 1))[0] ?? null;
          if (!row) return { ok: true, lines: [] };
          const r = toUpgradeRun(row);
          // Node-supplied text reaches a root terminal: plain text only.
          const { plainText } = await import('../../shared/plain-text.js');
          const lines = [
            `run ${r.id}: ${r.fromVersion ?? '?'} → ${r.toVersion} · ${r.status} · step ${r.step}${r.mode === 'auto' ? ' · automatic' : ''}`,
            ...(r.message ? [`  ${plainText(r.message)}`] : []),
            ...r.nodes.map((n) => `  ${plainText(n.node, 64).padEnd(24)} ${n.state.padEnd(9)} ${plainText(n.cliVersion ?? '-', 64)}  ${plainText(n.detail)}`),
          ];
          return { ok: r.status !== 'failed', lines };
        });
      } catch (err) {
        return { ok: false, lines: [], errorCode: scrubCreds(err instanceof Error ? err.message : String(err)) };
      }
    },
  };
}
