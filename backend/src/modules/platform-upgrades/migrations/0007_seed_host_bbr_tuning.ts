/**
 * Platform-migration 0007 — add BBR congestion control to the host-config
 * desired-state so EXISTING clusters pick it up on upgrade.
 *
 * `scripts/bootstrap.sh` (configure_tcp_bbr) gives FRESH nodes BBR + fq qdisc.
 * Already-bootstrapped clusters never re-run bootstrap, so the only way they
 * gain BBR is through the host-config convergence path: this migration appends
 * the BBR keys to the `host-config-desired` ConfigMap (sysctls) and the
 * `tcp_bbr` module to `host-modules-desired`. The host-side
 * `platform-ops host-config apply` converger then applies them — gated, as
 * always, on `mode: enforce` (or a manual `--apply`); this migration NEVER
 * flips the mode, so it is a no-op on the node until an operator opts in.
 *
 * ADDITIVE + NON-CLOBBERING: a key/module the operator already set is left
 * exactly as-is (matches the additive-only philosophy of the modules/packages
 * convergers). Idempotent — re-running adds nothing once the keys are present.
 * Order-stable, self-contained, never throws on the absent-client path
 * (no k8s client → no-op, retried next boot).
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../../shared/k8s-patch.js';
import type { PlatformMigration } from '../registry/types.js';

const DESIRED_NAMESPACE = 'platform-system';
const CONFIG_CM = 'host-config-desired';
const MODULES_CM = 'host-modules-desired';

// Pairs with scripts/bootstrap.sh:configure_tcp_bbr. tcp_rmem/tcp_wmem extend
// TCP autotuning up to the 16 MiB ceiling 99-cluster-net-tune already sets on
// net.core.{rmem,wmem}_max; bbr + fq are the congestion-control half.
//
// We always declare `bbr` (every supported OS — Debian 12/13, Ubuntu
// 22.04/24.04, RHEL 9 family — ships BBR). On a hypothetical pre-BBR kernel
// the converger's writeSysctl simply reports `write-failed` for this one key
// (it never bricks the node); the operator resolves it by setting the key to
// `cubic` in the ConfigMap, which this migration will not clobber.
// Exported so the every-boot self-heal reconcile (host-desired-state.ts) can
// compose the SAME canonical BBR content it restores a deleted CM with — one
// source of truth for the BBR keys/module.
export const BBR_SYSCTLS: ReadonlyArray<readonly [key: string, value: string]> = [
  ['net.ipv4.tcp_rmem', '4096 87380 16777216'],
  ['net.ipv4.tcp_wmem', '4096 65536 16777216'],
  ['net.ipv4.tcp_congestion_control', 'bbr'],
  ['net.core.default_qdisc', 'fq'],
];

export const BBR_MODULE = 'tcp_bbr';

export const BBR_SYSCTL_HEADER =
  '# --- BBR congestion control (added by platform-migration 0007) ---';
export const BBR_MODULE_HEADER =
  '# --- tcp_bbr (added by platform-migration 0007; required for tcp_congestion_control=bbr) ---';

/** Keys already declared in a `key = value` sysctl block (comments ignored). */
function declaredSysctlKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

/** Bare module names already declared (comments/blank ignored). */
function declaredModules(text: string): Set<string> {
  const names = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    names.add(line);
  }
  return names;
}

/** Append-only merge: returns the new text + which keys it added (empty = no change). */
function mergeSysctls(existing: string): { text: string; added: string[] } {
  const have = declaredSysctlKeys(existing);
  const additions = BBR_SYSCTLS.filter(([key]) => !have.has(key));
  if (additions.length === 0) return { text: existing, added: [] };
  const base = existing.endsWith('\n') || existing === '' ? existing : `${existing}\n`;
  const block = `${BBR_SYSCTL_HEADER}\n${additions.map(([k, v]) => `${k} = ${v}`).join('\n')}\n`;
  return { text: `${base}${block}`, added: additions.map(([k]) => k) };
}

function mergeModules(existing: string): { text: string; added: boolean } {
  if (declaredModules(existing).has(BBR_MODULE)) return { text: existing, added: false };
  const base = existing.endsWith('\n') || existing === '' ? existing : `${existing}\n`;
  return { text: `${base}${BBR_MODULE_HEADER}\n${BBR_MODULE}\n`, added: true };
}

async function readConfigMap(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<{ data: Record<string, string> } | null> {
  try {
    const cm = (await k8s.core.readNamespacedConfigMap({
      name,
      namespace,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as {
      data?: Record<string, string>;
    };
    return { data: cm.data ?? {} };
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err; // a real API error surfaces as a migration failure (halts + retries)
  }
}

async function patchData(
  k8s: K8sClients,
  namespace: string,
  name: string,
  data: Record<string, string>,
): Promise<void> {
  // JSON merge-patch (RFC 7386): sets only the data keys we changed, leaving
  // metadata + any other data keys (e.g. `mode`) intact. MERGE_PATCH overrides
  // the SDK's default application/json-patch+json content-type, which would
  // otherwise reject this object body.
  await k8s.core.patchNamespacedConfigMap(
    {
      name,
      namespace,
      body: { data },
    } as unknown as Parameters<typeof k8s.core.patchNamespacedConfigMap>[0],
    MERGE_PATCH,
  );
}

export const seedHostBbrTuning: PlatformMigration = {
  id: '0007_seed_host_bbr_tuning',
  version: '2026.6.5',
  description: 'Add BBR sysctls + tcp_bbr module to host-config/modules desired-state (additive)',
  async up(ctx) {
    if (!ctx.k8s) {
      ctx.log.warn('[0007_seed_host_bbr_tuning] no k8s client at startup — skipping (retried next boot)');
      return;
    }

    // ── host-config-desired: append BBR sysctls (skip if absent — 0002 seeds it) ──
    const cfg = await readConfigMap(ctx.k8s, DESIRED_NAMESPACE, CONFIG_CM);
    if (cfg === null) {
      ctx.log.warn(`[0007_seed_host_bbr_tuning] ${CONFIG_CM} absent (0002 seeds it earlier in this pass) — skipping BBR sysctls this run`);
    } else {
      const { text, added } = mergeSysctls(cfg.data['sysctls'] ?? '');
      if (added.length === 0) {
        ctx.log.info('[0007_seed_host_bbr_tuning] BBR sysctls already present — nothing to add');
      } else if (ctx.dryRun) {
        ctx.log.info(`[0007_seed_host_bbr_tuning] would add sysctls to ${CONFIG_CM}: ${added.join(', ')}`);
      } else {
        await patchData(ctx.k8s, DESIRED_NAMESPACE, CONFIG_CM, { sysctls: text });
        ctx.log.info(`[0007_seed_host_bbr_tuning] added sysctls to ${CONFIG_CM}: ${added.join(', ')}`);
      }
    }

    // ── host-modules-desired: append tcp_bbr (skip if absent — 0006 seeds it) ──
    const mods = await readConfigMap(ctx.k8s, DESIRED_NAMESPACE, MODULES_CM);
    if (mods === null) {
      ctx.log.warn(`[0007_seed_host_bbr_tuning] ${MODULES_CM} absent (0006 seeds it earlier in this pass) — skipping tcp_bbr module this run`);
      return;
    }
    const { text, added } = mergeModules(mods.data['modules'] ?? '');
    if (!added) {
      ctx.log.info('[0007_seed_host_bbr_tuning] tcp_bbr module already present — nothing to add');
    } else if (ctx.dryRun) {
      ctx.log.info(`[0007_seed_host_bbr_tuning] would add module to ${MODULES_CM}: ${BBR_MODULE}`);
    } else {
      await patchData(ctx.k8s, DESIRED_NAMESPACE, MODULES_CM, { modules: text });
      ctx.log.info(`[0007_seed_host_bbr_tuning] added module to ${MODULES_CM}: ${BBR_MODULE}`);
    }
  },
};
