/**
 * Self-heal for the host-config desired-state ConfigMaps (ADR-045 W10).
 *
 * The seed migrations (0002–0007) create these ConfigMaps once; the registry
 * runner then records them applied and NEVER re-runs them (runner.ts skips
 * already-applied ids). So a desired-CM DELETED later — by an operator, a
 * `kubectl delete`, a botched reset — was never recreated: the
 * host-config-reconciler lost its drift baseline and any platform-managed
 * sysctls/modules (e.g. BBR) silently stopped being declared.
 *
 * `ensureHostDesiredConfigMaps` runs on EVERY backend boot (and every
 * `platform-ops migrations apply`) and CREATE-IF-ABSENT each desired CM with
 * its canonical content. It is deliberately create-only:
 *   - an EXISTING CM is never touched → operator edits stay intact (same
 *     promise the seed migrations make);
 *   - only a CM that is gone WHOLESALE is restored.
 * No-op without a k8s client; each CM is isolated in its own try/catch so one
 * failure can't block the others or fail boot; dry-run reports without writing.
 *
 * Canonical content is the LIVE source of truth (it includes BBR), distinct
 * from the frozen historical snapshots inside the seed migrations — which must
 * never change (their checksum is their contract). On a fresh cluster the
 * migrations seed first and this reconcile no-ops; the canonical content only
 * materialises when restoring a deleted CM. It carries the same sysctl/module
 * VALUES 0002 + 0007 produce on a healthy cluster (the BBR keys/module are
 * imported from 0007, the single source for those); the operator-facing
 * comment text may differ, which is fine for a recovery artifact. If a default
 * VALUE ever changes, update it here AND ship a migration to patch existing
 * clusters — never edit the frozen seed migration.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { MigrationLogger } from './registry/types.js';
import {
  BBR_SYSCTLS,
  BBR_MODULE,
  BBR_SYSCTL_HEADER,
  BBR_MODULE_HEADER,
} from './migrations/0007_seed_host_bbr_tuning.js';

export const DESIRED_NAMESPACE = 'platform-system';

const LABELS = {
  app: 'host-config-reconciler',
  'app.kubernetes.io/part-of': 'hosting-platform',
} as const;

// host-config-desired sysctls = the 0002 baseline + the 0007 BBR block. BBR
// lines come from 0007's exported constant (single source of truth).
const CANONICAL_SYSCTLS = [
  '# host-config-desired — sysctls the platform expects on every node.',
  '# OBSERVE by default: the host-config-reconciler reports drift; it does NOT',
  '# write these. Restored create-if-absent by ensureHostDesiredConfigMaps —',
  '# a wholesale-deleted CM is recreated, but your edits are never overwritten.',
  'fs.inotify.max_user_watches = 524288',
  'fs.inotify.max_user_instances = 8192',
  'vm.max_map_count = 262144',
  'net.core.somaxconn = 1024',
  BBR_SYSCTL_HEADER,
  ...BBR_SYSCTLS.map(([k, v]) => `${k} = ${v}`),
  '',
].join('\n');

const CANONICAL_MODULES = [
  '# host-modules-desired — kernel modules the platform keeps LOADED on every node.',
  '# ADDITIVE-ONLY (the converger never unloads). mode: observe → drift-only until',
  '# an operator sets mode: enforce.',
  BBR_MODULE_HEADER,
  BBR_MODULE,
  '',
].join('\n');

const CANONICAL_PACKAGES =
  '# host-packages-desired — OS packages the platform keeps PRESENT (additive-only).\n'
  + '# Empty + mode: observe by default — a strict no-op until an operator opts in.\n';

const CANONICAL_LIMITS =
  '# host-ulimits-desired — PAM limits.conf lines rendered into the managed drop-in.\n'
  + '# Empty + mode: observe by default — a strict no-op until an operator opts in.\n';

/** One desired-state ConfigMap the platform self-heals. */
export interface DesiredConfigMapSpec {
  readonly name: string;
  readonly data: Record<string, string>;
}

// Order mirrors the seed migrations 0002–0006. `mode: observe` on every policy
// that gates host writes, so a restored CM can NEVER auto-enforce (a restored
// CM could otherwise become a backdoor to host kernel writes). host-config-desired
// intentionally carries no `mode` key — the sysctl converger is observe-only at
// the reconciler level and does not read `mode` for that CM (matches 0002).
export const HOST_DESIRED_CONFIGMAPS: readonly DesiredConfigMapSpec[] = [
  { name: 'host-config-desired', data: { sysctls: CANONICAL_SYSCTLS } },
  { name: 'host-packages-desired', data: { packages: CANONICAL_PACKAGES, mode: 'observe' } },
  {
    name: 'host-migrations-desired',
    data: { mode: 'observe', _note: 'Set mode: enforce to apply shipped host-migration scripts on this node.' },
  },
  { name: 'host-ulimits-desired', data: { limits: CANONICAL_LIMITS, mode: 'observe' } },
  { name: 'host-modules-desired', data: { modules: CANONICAL_MODULES, mode: 'observe' } },
];

async function configMapExists(k8s: K8sClients, name: string): Promise<boolean> {
  try {
    await k8s.core.readNamespacedConfigMap({
      name,
      namespace: DESIRED_NAMESPACE,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0]);
    return true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) return false;
    throw err;
  }
}

export interface EnsureResult {
  /** Names of CMs that were absent and got recreated (or would, in dry-run). */
  readonly created: string[];
}

/**
 * Create-if-absent each host desired-state ConfigMap. Idempotent, create-only
 * (never overwrites an existing CM), per-CM error isolation, no-op without a
 * k8s client. Safe to call on every boot.
 */
export async function ensureHostDesiredConfigMaps(
  k8s: K8sClients | null,
  log: MigrationLogger,
  opts: { readonly dryRun?: boolean } = {},
): Promise<EnsureResult> {
  const created: string[] = [];
  if (!k8s) {
    log.info('[host-desired-state] no k8s client — skipping self-heal (retried next boot)');
    return { created };
  }
  // Runs OUTSIDE the migration advisory lock (the lock is released when
  // runPlatformMigrations returns). That is safe: on HA two backends may both
  // read 404 and both create — the loser's create gets a 409 Conflict, which
  // configMapExists does not treat as 404, so it surfaces in the per-CM catch
  // as a harmless warn. No clobber, no crash, no duplicate.
  for (const cm of HOST_DESIRED_CONFIGMAPS) {
    try {
      if (await configMapExists(k8s, cm.name)) continue;
      if (opts.dryRun) {
        log.info(`[host-desired-state] would recreate absent ConfigMap ${cm.name}`);
        created.push(cm.name);
        continue;
      }
      await k8s.core.createNamespacedConfigMap({
        namespace: DESIRED_NAMESPACE,
        body: {
          metadata: { name: cm.name, namespace: DESIRED_NAMESPACE, labels: { ...LABELS } },
          data: cm.data,
        },
      } as unknown as Parameters<typeof k8s.core.createNamespacedConfigMap>[0]);
      created.push(cm.name);
      log.info(`[host-desired-state] recreated absent ConfigMap ${cm.name}`);
    } catch (err) {
      // Isolated: a transient API error on one CM must not block the others or
      // fail boot. It is retried on the next boot's reconcile.
      log.warn(`[host-desired-state] could not ensure ${cm.name} (continuing)`, err);
    }
  }
  return { created };
}
