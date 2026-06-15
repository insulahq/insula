/**
 * `platform-ops cluster doctor` — per-node readiness / drift check.
 *
 * Runs on whatever node you're on and answers "is this node correctly
 * provisioned for the platform's host-side machinery?" — the exact class of
 * drift that otherwise only surfaces by manual SSH poking (a worker missing its
 * cosign trust anchor, missing the host-config kubeconfig, no rclone for DR
 * restore, a stale binary, …). Read-only: it inspects host files + a few cheap
 * kubectl probes and never changes anything.
 *
 * Exit: 0 when nothing FAILed (WARNs are advisory), 1 when any check FAILed,
 * 2 on a usage error. `--json` emits the full check list for machines.
 */
import type { Deps } from './deps.js';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

const KUBECTL = 'kubectl';
const COSIGN_PUB = '/etc/platform/cosign.pub';
const K3S_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
const SCOPED_KUBECONFIG = '/etc/platform/host-config/kubeconfig';
const HOST_MIGRATION_MARKERS = '/var/lib/platform/host-migrations';

/** kubectl args, pinning the resolved kubeconfig when KUBECONFIG isn't set. */
function kubectlArgs(kubeconfig: string | null, args: string[]): string[] {
  return kubeconfig ? ['--kubeconfig', kubeconfig, ...args] : args;
}

/**
 * Resolve the kubeconfig host-config would use (same order as the converger:
 * $KUBECONFIG → k3s admin → scoped worker kubeconfig). Returns the path + a
 * human label, or null when none is present (host-config can't reach the cluster).
 */
function resolveKubeconfig(deps: Deps): { path: string; label: string } | null {
  const explicit = deps.env.KUBECONFIG?.trim();
  if (explicit) return { path: explicit, label: '$KUBECONFIG' };
  if (deps.readFile(K3S_KUBECONFIG) !== null) return { path: K3S_KUBECONFIG, label: 'k3s admin (control-plane)' };
  if (deps.readFile(SCOPED_KUBECONFIG) !== null) return { path: SCOPED_KUBECONFIG, label: 'worker scoped' };
  return null;
}

function checkVersion(deps: Deps, db: { installed?: string; running?: string; available?: string | null } | null): Check {
  const installed = (deps.buildVersion || deps.readFile('/etc/platform/VERSION')?.trim() || 'unknown').trim();
  const available = db?.available ?? null;
  if (available && available !== installed) {
    return { name: 'platform-ops version', status: 'warn', detail: `${installed} installed, ${available} available — self-upgrade pending` };
  }
  return { name: 'platform-ops version', status: 'ok', detail: `${installed}${db?.running ? ` (cluster running ${db.running})` : ''}` };
}

function checkCosign(deps: Deps): Check {
  const pub = deps.readFile(COSIGN_PUB);
  if (pub === null) {
    return { name: 'cosign trust anchor', status: 'fail', detail: `${COSIGN_PUB} MISSING — self-upgrade fails closed (binary can't be verified)` };
  }
  if (!pub.includes('PUBLIC KEY')) {
    return { name: 'cosign trust anchor', status: 'warn', detail: `${COSIGN_PUB} present but not a PEM public key` };
  }
  return { name: 'cosign trust anchor', status: 'ok', detail: `${COSIGN_PUB} present` };
}

function checkKubeconfig(kc: { path: string; label: string } | null): Check {
  if (!kc) {
    return {
      name: 'host-config kubeconfig',
      status: 'fail',
      detail: `none of $KUBECONFIG / ${K3S_KUBECONFIG} / ${SCOPED_KUBECONFIG} — host-config can't read the cluster (host-migrations won't run on this node)`,
    };
  }
  return { name: 'host-config kubeconfig', status: 'ok', detail: `${kc.label} (${kc.path})` };
}

async function checkReachable(deps: Deps, kc: { path: string } | null): Promise<Check> {
  const r = await deps.exec(KUBECTL, kubectlArgs(kc?.path ?? null, ['get', '--raw', '/readyz']), {});
  if (r.code === 0) return { name: 'cluster reachable', status: 'ok', detail: 'apiserver /readyz ok' };
  // /readyz can be RBAC-forbidden for the scoped worker token — fall back to a
  // request the scoped Role allows (get the host-migrations-desired CM).
  const r2 = await deps.exec(
    KUBECTL,
    kubectlArgs(kc?.path ?? null, ['-n', 'platform-system', 'get', 'cm', 'host-migrations-desired', '-o', 'name']),
    {},
  );
  if (r2.code === 0) return { name: 'cluster reachable', status: 'ok', detail: 'apiserver reachable (desired-state CM readable)' };
  return { name: 'cluster reachable', status: 'fail', detail: `apiserver unreachable: ${(r2.stderr || r.stderr).trim().split('\n')[0] || 'unknown'}` };
}

async function checkRclone(deps: Deps): Promise<Check> {
  const r = await deps.exec('sh', ['-c', 'command -v rclone'], {});
  if (r.code === 0 && r.stdout.trim()) {
    return { name: 'rclone (DR restore)', status: 'ok', detail: r.stdout.trim().split('\n')[0] };
  }
  return { name: 'rclone (DR restore)', status: 'warn', detail: 'not installed — DR restore scripts (restore-*-from-shim) need host rclone' };
}

async function checkHostMigrations(deps: Deps): Promise<Check> {
  // Light read-only signal: any applied markers? (full pending/shipped diff lives
  // in `host-config status`.) Absent dir is normal on a node that never enforced.
  const r = await deps.exec('sh', ['-c', `ls ${HOST_MIGRATION_MARKERS}/*/*.done 2>/dev/null | wc -l`], {});
  const n = Number((r.stdout || '').trim()) || 0;
  return {
    name: 'host-migrations applied',
    status: 'ok',
    detail: n > 0 ? `${n} marker(s) under ${HOST_MIGRATION_MARKERS}` : 'none applied yet (run host-config apply, or none shipped)',
  };
}

async function checkNodesReady(deps: Deps, kc: { path: string } | null): Promise<Check> {
  const r = await deps.exec(
    KUBECTL,
    kubectlArgs(kc?.path ?? null, ['get', 'nodes', '--no-headers']),
    {},
  );
  if (r.code !== 0) return { name: 'nodes ready', status: 'warn', detail: 'could not list nodes (insufficient RBAC on this token?)' };
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const ready = lines.filter((l) => / Ready /.test(` ${l} `) || /\sReady\s/.test(l)).length;
  const notReady = lines.length - ready;
  return {
    name: 'nodes ready',
    status: notReady > 0 ? 'warn' : 'ok',
    detail: `${ready}/${lines.length} Ready`,
  };
}

const ICON: Record<Status, string> = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };

export async function clusterDoctor(args: string[], deps: Deps): Promise<number> {
  const json = args.includes('--json');

  let db: { installed?: string; running?: string; available?: string | null } | null = null;
  try {
    db = await deps.versionFromDb();
  } catch {
    db = null;
  }

  const kc = resolveKubeconfig(deps);
  const checks: Check[] = [
    checkVersion(deps, db),
    checkCosign(deps),
    checkKubeconfig(kc),
    await checkReachable(deps, kc),
    await checkRclone(deps),
    await checkHostMigrations(deps),
    await checkNodesReady(deps, kc),
  ];

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;

  if (json) {
    deps.out(JSON.stringify({ ok: fails === 0, fails, warns, checks }));
    return fails > 0 ? 1 : 0;
  }

  const host = (deps.readFile('/etc/hostname') ?? '').trim();
  deps.out(`platform-ops cluster doctor${host ? ` (node: ${host})` : ''}`);
  for (const c of checks) {
    deps.out(`  ${ICON[c.status]} ${c.name.padEnd(24)} ${c.detail}`);
  }
  deps.out(
    fails > 0
      ? `Overall: ${fails} FAIL, ${warns} WARN`
      : warns > 0
        ? `Overall: healthy, ${warns} WARN`
        : 'Overall: healthy',
  );
  return fails > 0 ? 1 : 0;
}
