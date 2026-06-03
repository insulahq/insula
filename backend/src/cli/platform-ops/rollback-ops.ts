/**
 * Real rollback operations for platform-ops (ADR-045 W16) — host-side undo of the
 * most recent applied upgrade (re-pin back + optional Longhorn data restore).
 * Wraps the same `runRollback` orchestrator the backend route uses.
 */
import type { RollbackOps, RollbackRunResult } from './deps.js';
import { scrubCreds } from './redact.js';

export function realRollbackOps(env: NodeJS.ProcessEnv): RollbackOps {
  return {
    async run(opts): Promise<RollbackRunResult> {
      const url = env.DATABASE_URL;
      if (!url) {
        return { ok: false, errorCode: 'NO_DATABASE_URL', dataRestored: false, summary: 'DATABASE_URL is required to read the rollback manifest' };
      }
      const [{ getDb, closeDb }, { createK8sClients }, { runRollback, realRollbackDeps }, { existsSync }] = await Promise.all([
        import('../../db/index.js'),
        import('../../modules/k8s-provisioner/k8s-client.js'),
        import('../../modules/platform-upgrades/rollback.js'),
        import('node:fs'),
      ]);
      const db = getDb(url);
      try {
        const kc = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
        const k8s = existsSync(kc) ? createK8sClients(kc) : createK8sClients();
        const r = await runRollback(realRollbackDeps(db, k8s), opts);
        return { ok: r.ok, dataRestored: r.dataRestored, reason: r.reason, summary: r.summary };
      } catch (err) {
        return { ok: false, errorCode: 'ROLLBACK_ERROR', dataRestored: false, summary: scrubCreds(err instanceof Error ? err.message : String(err)) };
      } finally {
        await closeDb();
      }
    },
  };
}
