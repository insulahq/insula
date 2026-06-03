/**
 * Real upgrade operations for platform-ops (ADR-045 W13) — host-side Flux re-pin.
 *
 * The PR-18 spike concluded the re-pinner should be host-side platform-ops (not
 * an in-cluster pod), so this wraps the SAME `runUpgrade` orchestrator the
 * backend uses, talking to the DB + k8s API directly. Heavy modules load via
 * dynamic import() so other subcommands stay lean.
 */
import type { UpgradeOps, UpgradeRunResult } from './deps.js';
import { scrubCreds } from './redact.js';

export function realUpgradeOps(env: NodeJS.ProcessEnv): UpgradeOps {
  return {
    async run(opts): Promise<UpgradeRunResult> {
      const url = env.DATABASE_URL;
      if (!url) {
        return { ok: false, errorCode: 'NO_DATABASE_URL', action: 'error', target: null, reason: 'DATABASE_URL is required', proceed: false, applied: false, gitRepository: null, summary: 'DATABASE_URL is required to plan an upgrade' };
      }
      const [{ getDb, closeDb }, { createK8sClients }, { runUpgrade, dbSettings }, { captureUpgradeRescue, realRollbackDeps }, { existsSync }] = await Promise.all([
        import('../../db/index.js'),
        import('../../modules/k8s-provisioner/k8s-client.js'),
        import('../../modules/platform-upgrades/orchestrate.js'),
        import('../../modules/platform-upgrades/rollback.js'),
        import('node:fs'),
      ]);
      const db = getDb(url);
      try {
        const kc = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
        const k8s = existsSync(kc) ? createK8sClients(kc) : createK8sClients();
        // On apply, capture the rescue snapshot + rollback manifest first (W16).
        const rollback = opts.apply
          ? { capture: (input: { fromVersion: string | null; toVersion: string }) => captureUpgradeRescue(realRollbackDeps(db, k8s), input).then((c) => ({ ok: c.ok, reason: c.reason })) }
          : undefined;
        const res = await runUpgrade(dbSettings(db), k8s, { ...opts, rollback });
        // A real failure = apply was requested AND the decision said proceed, but
        // the re-pin didn't land. A blocked/no-op decision is exit 0 (informational).
        const ok = !(opts.apply && res.decision.proceed && !res.applied);
        return {
          ok,
          action: res.decision.action,
          target: res.decision.target,
          reason: res.decision.reason,
          proceed: res.decision.proceed,
          applied: res.applied,
          gitRepository: res.gitRepository,
          summary: res.summary,
        };
      } catch (err) {
        // A pg/Drizzle connection error can embed the DSN (postgresql://user:pass@…)
        // — scrub before it reaches the operator terminal.
        return { ok: false, errorCode: 'UPGRADE_ERROR', action: 'error', target: null, reason: '', proceed: false, applied: false, gitRepository: null, summary: scrubCreds(err instanceof Error ? err.message : String(err)) };
      } finally {
        await closeDb();
      }
    },
  };
}
