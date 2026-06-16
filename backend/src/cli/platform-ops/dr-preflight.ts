/**
 * `platform-ops dr preflight` — DR readiness check (run proactively, while
 * the cluster is UP). Answers "if disaster strikes, will each restore tier
 * actually work?" — so an operator finds the gap now, not mid-recovery.
 *
 *   Tier 0  local etcd snapshots present (zero-network restore)
 *   Tier 1  off-site etcd flowing + cluster_id-namespaced (the descriptor
 *           in the next secrets bundle enables the offline restore)
 *   Tier 1b in-cluster shim reachable (the kubectl→shim restore)
 *   then    postgres ObjectStore + mail restic repo (component restores)
 *
 * Read-only kubectl + host probes. Exit: 0 when no FAIL (WARNs advisory),
 * 1 when a tier with no fallback is unavailable, 2 usage. `--json` for machines.
 */
import type { Deps } from './deps.js';

type Status = 'ok' | 'warn' | 'fail';
interface Check { readonly name: string; readonly status: Status; readonly detail: string }

const KUBECTL = 'kubectl';
const K3S_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
const SCOPED_KUBECONFIG = '/etc/platform/host-config/kubeconfig';
const SNAP_DIR = '/var/lib/rancher/k3s/server/db/snapshots';

function resolveKubeconfigPath(deps: Deps): string | null {
  const explicit = deps.env.KUBECONFIG?.trim();
  if (explicit) return explicit;
  if (deps.readFile(K3S_KUBECONFIG) !== null) return K3S_KUBECONFIG;
  if (deps.readFile(SCOPED_KUBECONFIG) !== null) return SCOPED_KUBECONFIG;
  return null;
}
function kc(kcPath: string | null, args: string[]): string[] {
  return kcPath ? ['--kubeconfig', kcPath, ...args] : args;
}

async function checkLocalSnapshots(deps: Deps): Promise<Check> {
  const r = await deps.exec('sh', ['-c', `ls -1 ${SNAP_DIR} 2>/dev/null | grep -v -E '\\.(sha256|meta)$' | wc -l`], {});
  const n = Number((r.stdout || '').trim()) || 0;
  return n > 0
    ? { name: 'Tier 0: local etcd snapshots', status: 'ok', detail: `${n} snapshot(s) in ${SNAP_DIR} — zero-network restore available` }
    : { name: 'Tier 0: local etcd snapshots', status: 'warn', detail: `none in ${SNAP_DIR} — local-first restore unavailable on this node` };
}

async function checkOffsiteEtcd(deps: Deps, kcPath: string | null): Promise<Check> {
  // The etcd-snap-via-shim CronJob's SHIM_PREFIX is the authoritative
  // signal that a SYSTEM target is bound + snapshots are cluster_id-
  // namespaced (so the offline descriptor in the next bundle will resolve).
  const r = await deps.exec(KUBECTL, kc(kcPath, [
    '-n', 'platform', 'get', 'cronjob', 'etcd-snap-via-shim',
    '-o', 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[?(@.name=="rclone")].env[?(@.name=="SHIM_PREFIX")].value}',
  ]), {});
  const prefix = (r.stdout || '').trim();
  if (r.code !== 0 || !prefix) {
    return { name: 'Tier 1: off-site etcd (system bound)', status: 'warn', detail: 'etcd-snap-via-shim CronJob/SHIM_PREFIX not found — bind a SYSTEM backup target so off-site + offline restore work' };
  }
  if (!prefix.startsWith('etcd/')) {
    return { name: 'Tier 1: off-site etcd (system bound)', status: 'warn', detail: `SHIM_PREFIX '${prefix}' is not cluster_id-namespaced (etcd/<uuid>) — un-upgraded cluster` };
  }
  return { name: 'Tier 1: off-site etcd (system bound)', status: 'ok', detail: `snapshots namespaced under ${prefix}; the next secrets bundle carries dr-system-target.json` };
}

async function checkShim(deps: Deps, kcPath: string | null): Promise<Check> {
  const ip = await deps.exec(KUBECTL, kc(kcPath, ['-n', 'platform', 'get', 'svc', 'backup-rclone-shim', '-o', 'jsonpath={.spec.clusterIP}']), {});
  const cred = await deps.exec(KUBECTL, kc(kcPath, ['-n', 'platform', 'get', 'secret', 'backup-rclone-shim-creds', '-o', 'name']), {});
  const haveIp = ip.code === 0 && !!ip.stdout.trim() && ip.stdout.trim() !== 'None';
  const haveCred = cred.code === 0 && !!cred.stdout.trim();
  return haveIp && haveCred
    ? { name: 'Tier 1b: in-cluster shim', status: 'ok', detail: `ClusterIP ${ip.stdout.trim()} + creds Secret present` }
    : { name: 'Tier 1b: in-cluster shim', status: 'warn', detail: `shim ${haveIp ? 'ClusterIP ok' : 'ClusterIP missing'}, ${haveCred ? 'creds ok' : 'creds Secret missing'} — bind a SYSTEM target` };
}

async function checkPostgresObjectStore(deps: Deps, kcPath: string | null): Promise<Check> {
  const r = await deps.exec(KUBECTL, kc(kcPath, ['-n', 'platform', 'get', 'objectstore.barmancloud.cnpg.io', 'system-postgres-objectstore', '-o', 'name']), {});
  return r.code === 0 && r.stdout.trim()
    ? { name: 'postgres ObjectStore', status: 'ok', detail: 'system-postgres-objectstore present (restore-postgres-from-shim ready)' }
    : { name: 'postgres ObjectStore', status: 'warn', detail: 'system-postgres-objectstore not found — materialises ~min after a SYSTEM bind; postgres restore needs it' };
}

async function checkMailResticRepo(deps: Deps, kcPath: string | null): Promise<Check> {
  const r = await deps.exec(KUBECTL, kc(kcPath, ['-n', 'mail', 'get', 'secret', 'stalwart-snapshot-restic-repo', '-o', 'name']), {});
  return r.code === 0 && r.stdout.trim()
    ? { name: 'mail restic repo', status: 'ok', detail: 'stalwart-snapshot-restic-repo present (restore-mail-from-shim ready)' }
    : { name: 'mail restic repo', status: 'warn', detail: 'stalwart-snapshot-restic-repo not found — bind a MAIL target for mail restore' };
}

const ICON: Record<Status, string> = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };

export async function drPreflight(args: string[], deps: Deps): Promise<number> {
  const json = args.includes('--json');
  const kcPath = resolveKubeconfigPath(deps);

  const local = await checkLocalSnapshots(deps);
  const offsite = await checkOffsiteEtcd(deps, kcPath);
  const checks: Check[] = [
    local,
    offsite,
    await checkShim(deps, kcPath),
    await checkPostgresObjectStore(deps, kcPath),
    await checkMailResticRepo(deps, kcPath),
  ];

  // The one hard gate: at least ONE etcd restore path must exist. If both
  // the local snapshots AND the off-site flow are unavailable, there is no
  // way to recover etcd — that's a FAIL, not a WARN.
  if (local.status !== 'ok' && offsite.status !== 'ok') {
    checks.push({
      name: 'etcd recoverability',
      status: 'fail',
      detail: 'NO etcd restore path: no local snapshots AND no off-site flow. Bind a SYSTEM backup target and/or confirm k3s snapshots are being written.',
    });
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;

  if (json) {
    deps.out(JSON.stringify({ ok: fails === 0, fails, warns, checks }));
    return fails > 0 ? 1 : 0;
  }
  deps.out('platform-ops dr preflight — disaster-recovery readiness');
  for (const c of checks) deps.out(`  ${ICON[c.status]} ${c.name.padEnd(34)} ${c.detail}`);
  deps.out(fails > 0 ? `Overall: ${fails} FAIL, ${warns} WARN` : warns > 0 ? `Overall: ready, ${warns} WARN` : 'Overall: ready');
  return fails > 0 ? 1 : 0;
}
