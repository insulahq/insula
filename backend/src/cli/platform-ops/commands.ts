/**
 * platform-ops subcommand handlers (ADR-045 / W17, scaffolding tranche).
 *
 * Read-only operator surfaces: version, cluster status/diagnostics, shell, and
 * a migrations-list stub (the platform-migration registry lands in a later
 * release). Each handler takes `Deps` and returns a process exit code.
 */
import type { Deps, VersionInfo } from './deps.js';

const KUBECTL = 'kubectl';

/** Resolve the locally-known version (binary build → /etc/platform/VERSION → unknown). */
function localVersion(deps: Deps): string {
  if (deps.buildVersion) return deps.buildVersion;
  const f = deps.readFile('/etc/platform/VERSION');
  if (f && f.trim()) return f.trim();
  return 'unknown';
}

export async function versionCommand(args: string[], deps: Deps): Promise<number> {
  const local = localVersion(deps);
  let db: VersionInfo | null = null;
  try {
    db = await deps.versionFromDb();
  } catch {
    db = null; // DB optional — the CLI's value is working when the cluster is down
  }
  const info = {
    binary: deps.buildVersion || local,
    installed: db?.installed ?? local,
    running: db?.running ?? local,
    available: db?.available ?? null,
  };
  if (args.includes('--json')) {
    deps.out(JSON.stringify(info));
  } else {
    deps.out(`platform-ops ${info.binary}`);
    deps.out(`  installed: ${info.installed}`);
    deps.out(`  running:   ${info.running}`);
    deps.out(`  available: ${info.available ?? '(unknown)'}`);
  }
  return 0;
}

/** kubectl args with an explicit --kubeconfig only when KUBECONFIG is unset. */
function kubectlArgs(deps: Deps, args: string[]): string[] {
  // k3s writes /etc/rancher/k3s/k3s.yaml; honour an explicit KUBECONFIG if set.
  if (deps.env.KUBECONFIG) return args;
  return ['--kubeconfig', '/etc/rancher/k3s/k3s.yaml', ...args];
}

export async function clusterStatus(_args: string[], deps: Deps): Promise<number> {
  const r = await deps.exec(KUBECTL, kubectlArgs(deps, ['get', 'nodes', '-o', 'wide']), {});
  if (r.code !== 0) {
    deps.err('cluster status: kubectl could not reach the cluster (is it down, or KUBECONFIG unset?)');
    if (r.stderr.trim()) deps.err('  ' + r.stderr.trim().split('\n')[0]);
    return r.code || 1;
  }
  deps.out('Nodes:');
  deps.out(r.stdout.trimEnd());
  return 0;
}

export async function clusterDiagnostics(_args: string[], deps: Deps): Promise<number> {
  // Best-effort support bundle: each probe is independent; a failing probe is
  // reported but never aborts the rest (the cluster may be partly degraded).
  const probes: Array<{ label: string; args: string[] }> = [
    { label: 'Nodes', args: ['get', 'nodes', '-o', 'wide'] },
    { label: 'Not-Running pods', args: ['get', 'pods', '-A', '--field-selector=status.phase!=Running'] },
    { label: 'Recent warning events', args: ['get', 'events', '-A', '--field-selector=type=Warning'] },
    { label: 'Flux Kustomizations', args: ['get', 'kustomizations', '-A'] },
  ];
  for (const p of probes) {
    deps.out(`── ${p.label} ──`);
    const r = await deps.exec(KUBECTL, kubectlArgs(deps, p.args), {});
    if (r.code === 0) {
      deps.out(r.stdout.trimEnd() || '(none)');
    } else {
      deps.err(`  (probe failed: ${r.stderr.trim().split('\n')[0] || 'unknown error'})`);
    }
  }
  return 0;
}

export async function migrationsList(_args: string[], deps: Deps): Promise<number> {
  // The platform-migration registry (W9) is not shipped yet; surface that
  // clearly rather than implying an empty registry.
  deps.out('No platform-migration registry is present in this release.');
  deps.out('(The migrations subcommand activates once the registry ships — ADR-045 W9.)');
  return 0;
}

export async function shellCommand(_args: string[], deps: Deps): Promise<number> {
  const shell = deps.env.SHELL || '/bin/sh';
  // Guard against a hijacked $SHELL (e.g. a poisoned dotfile setting SHELL to an
  // arbitrary binary): require a plain absolute path before we exec it.
  if (!shell.startsWith('/') || !/^\/[A-Za-z0-9._/-]+$/.test(shell)) {
    deps.err(`shell: refusing unsafe $SHELL '${shell}' — must be an absolute path`);
    return 1;
  }
  const kubeconfig = deps.env.KUBECONFIG || '/etc/rancher/k3s/k3s.yaml';
  if (!deps.env.KUBECONFIG) deps.err(`KUBECONFIG defaulting to ${kubeconfig}`);
  const r = await deps.exec(shell, [], { stdio: 'inherit', env: { ...deps.env, KUBECONFIG: kubeconfig } });
  return r.code;
}

export async function selfUpgrade(_args: string[], deps: Deps): Promise<number> {
  // Stub: the daily platform-ops-update.timer (installed by bootstrap) calls
  // `self-upgrade --check`. Until the self-upgrade loop ships (ADR-045 W11.5/W14)
  // this must exit 0 so the timer is a clean no-op rather than a daily failure.
  deps.out('platform-ops self-upgrade is not implemented in this release (no-op).');
  deps.out('(The daily update timer activates once the self-upgrade loop ships — ADR-045 W11.5/W14.)');
  return 0;
}
