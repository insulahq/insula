/**
 * platform-ops subcommand handlers (ADR-045 / W17, scaffolding tranche).
 *
 * Read-only operator surfaces: version, cluster status/diagnostics, shell, and
 * a migrations-list stub (the platform-migration registry lands in a later
 * release). Each handler takes `Deps` and returns a process exit code.
 */
import type { Deps, NodeVersion, VersionInfo } from './deps.js';
import { buildK3sUpgradePlans, parseK3sVersion } from './operations/k3s-plan.js';

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

export async function migrationsList(args: string[], deps: Deps): Promise<number> {
  const json = args.includes('--json');
  const { dbReachable, items } = await deps.migrationsStatus();
  if (json) {
    deps.out(JSON.stringify({ dbReachable, migrations: items }));
    return 0;
  }
  if (items.length === 0) {
    deps.out('No platform-migrations are defined in this release.');
    return 0;
  }
  if (!dbReachable) {
    deps.err('migrations: DB unreachable — showing the compiled-in registry only (applied-state unknown).');
  }
  const pending = items.filter((m) => m.status === 'pending').length;
  const drift = items.filter((m) => m.status === 'drift').length;
  deps.out(`${items.length} platform-migration(s)${dbReachable ? ` — ${pending} pending` + (drift ? `, ${drift} drift` : '') : ''}:`);
  for (const m of items) {
    const when = m.appliedAt ? ` (${m.appliedAt})` : '';
    deps.out(`  ${m.status.padEnd(8)} ${m.id}  v${m.version}${when}  ${m.description}`);
  }
  // Drift is an order-stable-contract violation; exit non-zero so a CI/cron
  // caller notices, but never throw.
  return drift > 0 ? 1 : 0;
}

export async function migrationsApply(args: string[], deps: Deps): Promise<number> {
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  // --kubeconfig <path> (a held advisory lock or a missing kubeconfig are both
  // handled by the runner; we just thread the flag through).
  let kubeconfig: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kubeconfig') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) {
        deps.err('migrations apply: --kubeconfig requires a value');
        return 2;
      }
      kubeconfig = v;
      i++;
    }
  }

  const r = await deps.applyMigrations({ dryRun, kubeconfig });
  if (!r.ok) {
    if (json) deps.out(JSON.stringify({ ok: false, errorCode: r.errorCode ?? 'APPLY_ERROR' }));
    deps.err(`migrations apply: ${r.errorCode ?? 'APPLY_ERROR'}${r.detail ? ` — ${r.detail}` : ''}`);
    return 1;
  }
  if (json) {
    deps.out(JSON.stringify({
      ok: true, ran: r.ran, dryRun: r.dryRun, applied: r.applied, pending: r.pending,
      failed: r.failed, skippedReason: r.skippedReason, outcomes: r.outcomes,
    }));
  } else if (!r.ran) {
    deps.out(`migrations apply: skipped (${r.skippedReason ?? 'unknown'})`);
  } else {
    const tag = r.dryRun ? '[dry-run] ' : '';
    deps.out(`${tag}${r.applied ?? 0} applied, ${r.pending ?? 0} pending${r.failed ? ' — a migration FAILED (sequence halted)' : ''}`);
    for (const o of r.outcomes ?? []) {
      deps.out(`  ${o.status.padEnd(12)} ${o.id}${o.error ? ` — ${o.error}` : ''}`);
    }
  }
  return r.failed ? 1 : 0;
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

interface SelfUpgradeArgs {
  readonly mode: 'check' | 'apply';
  readonly force: boolean;
  readonly version?: string;
}

/** Parse `self-upgrade` flags; returns an error string on a usage problem. */
export function parseSelfUpgradeArgs(args: string[]): SelfUpgradeArgs | { error: string } {
  let mode: 'check' | 'apply' = 'apply';
  let force = false;
  let version: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') mode = 'check';
    else if (a === '--force') force = true;
    else if (a === '--version') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: '--version requires a value (e.g. --version 2026.6.3)' };
      version = v;
      i++;
    } else if (a.startsWith('--version=')) {
      const v = a.slice('--version='.length);
      if (!v) return { error: '--version= requires a value (e.g. --version=2026.6.3)' };
      version = v;
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }
  return { mode, force, version };
}

/**
 * `self-upgrade [--check] [--force] [--version X.Y.Z]` (ADR-045 W11.5).
 *
 * Keeps the binary current: resolve a target (explicit → cluster-up
 * platform-version ConfigMap → cluster-down GitHub Releases), and if it's newer
 * (or --force), download + cosign-verify + atomically replace. `--check` is the
 * daily-timer mode — it APPLIES, but tolerates transient download failures so
 * the unit doesn't flap on a network blip. A verify failure ALWAYS surfaces.
 */
export async function selfUpgrade(args: string[], deps: Deps): Promise<number> {
  const parsed = parseSelfUpgradeArgs(args);
  if ('error' in parsed) {
    deps.err(`self-upgrade: ${parsed.error}`);
    return 2;
  }
  const r = await deps.selfUpgrade.run(parsed);

  switch (r.action) {
    case 'upgraded':
      deps.out(`platform-ops upgraded ${r.current} → ${r.target} (via ${r.source}, ${r.arch})`);
      return 0;
    case 'already-current':
      deps.out(`platform-ops is current (${r.current}; target ${r.target ?? '—'} via ${r.source ?? '—'})`);
      return 0;
    case 'no-target':
      deps.out(`platform-ops ${r.current}: no upgrade target (cluster unreachable + Releases offline)`);
      return 0;
    case 'invalid-version':
      deps.err(`self-upgrade: ${r.reason ?? 'invalid version'}`);
      return 2;
    case 'download-failed':
      deps.err(`self-upgrade: failed to download ${r.target} (${r.arch})`);
      // Transient in the unattended timer — don't flap the unit; surface on a manual run.
      return parsed.mode === 'check' ? 0 : 1;
    case 'verify-failed':
      deps.err(`self-upgrade: REFUSED ${r.target} — ${r.reason ?? 'signature did not verify'} (fail-closed)`);
      return 1;
    case 'replace-failed':
      deps.err(`self-upgrade: verified ${r.target} but atomic replace failed (permissions?)`);
      return 1;
  }
}

/**
 * `host-config apply [--dry-run]` (ADR-045 W10/W10b, amended — host-side converge).
 *
 * Reads the cluster's desired policies and converges this node HOST-SIDE
 * (platform-ops is root on the host — no privileged pod): sysctls
 * (host-config-desired), OS packages (host-packages-desired, additive-only),
 * then host-migration scripts (host-migrations-desired, shipped embedded in the
 * binary). Two gates per surface: the policy's `mode` must be `enforce` (opt-in)
 * AND no `--dry-run`; `--apply` forces enforce for a manual run. Default (no
 * policy / mode!=enforce) is a no-op dry-run, so the daily timer never mutates
 * the host until the operator opts in. Exit 1 only on a real failure.
 */
export async function hostConfigCommand(args: string[], deps: Deps): Promise<number> {
  const sub = args[0];
  if (sub !== undefined && sub !== 'apply' && sub !== 'status' && !sub.startsWith('--')) {
    deps.err(`host-config: unknown subcommand '${sub}' (use: apply | status)`);
    return 2;
  }
  const flags = sub && sub.startsWith('--') ? args : args.slice(1);
  for (const f of flags) {
    if (f !== '--dry-run' && f !== '--apply') {
      deps.err(`host-config: unknown flag: ${f}`);
      return 2;
    }
  }
  const wantApply = flags.includes('--apply');
  const dryRun = flags.includes('--dry-run') || sub === 'status';
  // Guard the silent-enforce footguns: --apply WRITES, so it must never be
  // overridden or ambiguous. Reject --apply with --dry-run / `status`, and
  // require it to be paired with the explicit `apply` subcommand.
  if (wantApply && flags.includes('--dry-run')) {
    deps.err('host-config: --apply and --dry-run are mutually exclusive');
    return 2;
  }
  if (wantApply && sub !== 'apply') {
    deps.err("host-config: --apply requires the 'apply' subcommand (it writes host state)");
    return 2;
  }

  const opts = { dryRun, apply: wantApply };

  // ── sysctls ────────────────────────────────────────────────────────────────
  const r = await deps.hostConfig.run(opts);
  if (r.desiredSource === 'absent') {
    deps.out('host-config: no sysctl policy (host-config-desired absent or cluster unreachable)');
  } else {
    const drift = r.items.filter((i) => i.state === 'would-apply' || i.state === 'applied' || i.state === 'write-failed');
    deps.out(`host-config sysctls ${r.mode}: ${r.appliedCount} applied, ${drift.length} drift, ${r.items.length} keys`);
    for (const i of r.items) {
      if (i.state === 'ok') continue; // only surface the interesting ones
      deps.out(`  ${i.state.padEnd(12)} ${i.key} desired=${i.desired}${i.actual !== null ? ` actual=${i.actual}` : ''}${i.error ? ` — ${i.error}` : ''}`);
    }
  }

  // ── packages (W10b) ─────────────────────────────────────────────────────────
  const p = await deps.hostConfig.packages(opts);
  if (p.desiredSource === 'absent') {
    deps.out('host-config: no package policy (host-packages-desired absent or cluster unreachable)');
  } else if (p.reason) {
    deps.out(`host-config packages: REFUSED — ${p.reason}`);
  } else {
    deps.out(`host-config packages ${p.mode} [${p.family ?? 'no-pkg-mgr'}]: ${p.installedCount} installed, ${p.items.length} declared`);
    for (const i of p.items) {
      if (i.state === 'ok') continue;
      deps.out(`  ${i.state.padEnd(16)} ${i.name}${i.desiredVersion ? `=${i.desiredVersion}` : ''}${i.actualVersion ? ` (have ${i.actualVersion})` : ''}${i.error ? ` — ${i.error}` : ''}`);
    }
  }

  // ── host-migrations (W10c) ──────────────────────────────────────────────────
  const h = await deps.hostConfig.hostMigrations(opts);
  if (h.source === 'absent') {
    deps.out('host-config: no host-migration catalog shipped');
  } else if (h.reason) {
    deps.out(`host-config host-migrations: REFUSED — ${h.reason}`);
  } else {
    const pending = h.items.filter((i) => i.state === 'would-run' || i.state === 'run-failed' || i.state === 'blocked');
    deps.out(`host-config host-migrations ${h.mode} [${h.source}]: ${h.appliedCount} applied, ${pending.length} pending, ${h.items.length} shipped`);
    for (const i of h.items) {
      if (i.state === 'already-applied') continue;
      deps.out(`  ${i.state.padEnd(16)} ${i.key}${i.error ? ` — ${i.error}` : ''}`);
    }
  }

  if (r.desiredSource === 'absent' && p.desiredSource === 'absent' && h.source === 'absent') {
    deps.out('host-config: nothing to do');
  }
  // A write/install/migration failure is a real problem (exit 1). not-allowed /
  // invalid are policy-authoring issues, not runtime failures — exit 0.
  return r.ok && p.ok && h.ok ? 0 : 1;
}

/** Pick the cluster's CURRENT floor version (lowest parseable kubelet version). */
function currentClusterVersion(nodes: readonly NodeVersion[]): string | null {
  let lowest: { v: ReturnType<typeof parseK3sVersion>; raw: string } | null = null;
  for (const n of nodes) {
    if (!n.kubeletVersion) continue;
    const v = parseK3sVersion(n.kubeletVersion);
    if (!v) continue;
    if (
      !lowest ||
      v.minor < lowest.v!.minor ||
      (v.minor === lowest.v!.minor && v.patch < lowest.v!.patch) ||
      (v.minor === lowest.v!.minor && v.patch === lowest.v!.patch && v.k3s < lowest.v!.k3s)
    ) {
      lowest = { v, raw: n.kubeletVersion };
    }
  }
  return lowest?.raw ?? null;
}

/**
 * `cluster upgrade --version vX.Y.Z+k3sN [--apply] [--current V] [--upgrade-image I]`
 * (ADR-045 W12). Generates the SUC server+agent k3s upgrade Plans (refusing
 * skip-a-minor / downgrade / cross-major), and — DRY-RUN BY DEFAULT — prints
 * them. `--apply` is required to actually create the CRs, at which point SUC
 * rolls the nodes (cordon + drain agents, serial). Exit 1 on a refused/failed
 * transition, 2 on usage error.
 */
export async function clusterUpgrade(args: string[], deps: Deps): Promise<number> {
  let version: string | undefined;
  let current: string | undefined;
  let upgradeImage: string | undefined;
  let apply = false;
  // Flag-value reader that refuses to swallow a following flag / a missing value
  // (so `--version --apply` errors rather than silently dropping --apply).
  const valueFor = (i: number, flag: string): string | null => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      deps.err(`cluster upgrade: ${flag} requires a value`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') apply = true;
    else if (a === '--version') {
      const v = valueFor(i, '--version');
      if (v === null) return 2;
      version = v;
      i++;
    } else if (a === '--current') {
      const v = valueFor(i, '--current');
      if (v === null) return 2;
      current = v;
      i++;
    } else if (a === '--upgrade-image') {
      const v = valueFor(i, '--upgrade-image');
      if (v === null) return 2;
      upgradeImage = v;
      i++;
    } else {
      deps.err(`cluster upgrade: unknown arg '${a}'`);
      return 2;
    }
  }
  if (!version) {
    deps.err('cluster upgrade: --version vX.Y.Z+k3sN is required');
    return 2;
  }

  if (!current) {
    let nodes: NodeVersion[];
    try {
      nodes = await deps.clusterUpgrade.readNodeVersions();
    } catch (err) {
      deps.err(`cluster upgrade: could not read node versions: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const floor = currentClusterVersion(nodes);
    if (!floor) {
      deps.err('cluster upgrade: could not determine the cluster current version (no parseable kubelet version); pass --current');
      return 1;
    }
    current = floor;
  }

  const gen = buildK3sUpgradePlans(version, current, upgradeImage ? { upgradeImage } : {});
  if (!gen.ok) {
    deps.err(`cluster upgrade: REFUSED — ${gen.reason}`);
    return 1;
  }

  if (!apply) {
    deps.out(`# DRY-RUN — k3s upgrade ${current} → ${gen.target}. Pass --apply to create these Plans (SUC then rolls the nodes).`);
    deps.out(JSON.stringify(gen.plans, null, 2));
    return 0;
  }

  try {
    const res = await deps.clusterUpgrade.applyPlans(gen.plans);
    deps.out(`cluster upgrade: applied ${res.applied.length} Plan(s) [${res.applied.join(', ')}] → SUC is now rolling ${current} → ${gen.target}`);
    deps.out('Watch: kubectl -n system-upgrade get plans,jobs');
    return 0;
  } catch (err) {
    deps.err(`cluster upgrade: failed to apply Plans: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `node cordon <name>` | `node uncordon <name>` (ADR-045 W12) — operator
 * maintenance via the k8s API (works when platform-api is down).
 */
export async function nodeCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, name] = args;
  if (sub !== 'cordon' && sub !== 'uncordon') {
    deps.err(`node: expected 'cordon' or 'uncordon', got ${sub ? `'${sub}'` : 'none'}`);
    return 2;
  }
  if (!name) {
    deps.err(`node ${sub}: a node name is required`);
    return 2;
  }
  try {
    await deps.node.cordon(name, sub === 'cordon');
    deps.out(`node ${name}: ${sub === 'cordon' ? 'cordoned (unschedulable)' : 'uncordoned (schedulable)'}`);
    return 0;
  } catch (err) {
    deps.err(`node ${sub}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `upgrade [--version X.Y.Z] [--apply]` (ADR-045 W13) — host-side platform
 * upgrade by re-pinning the cluster's Flux GitRepository to a release tag
 * (the PR-18 spike's validated mechanism). DRY-RUN BY DEFAULT: prints the plan +
 * the re-pin it WOULD do; `--apply` performs the re-pin (Flux then rolls the
 * cluster to the new tag). Operator-driven = manual mode (auto_update gating
 * applies only to the backend reconciler). Exit 1 on a real failure.
 */
export async function upgradeCommand(args: string[], deps: Deps): Promise<number> {
  let requestedVersion: string | undefined;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;
    else if (a === '--version') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) {
        deps.err('upgrade: --version requires a value (e.g. --version 2026.7.0)');
        return 2;
      }
      requestedVersion = v;
      i++;
    } else {
      deps.err(`upgrade: unknown arg '${a}'`);
      return 2;
    }
  }

  const r = await deps.upgrade.run({ mode: 'manual', requestedVersion, apply });
  if (r.errorCode) {
    deps.err(`upgrade: ${r.errorCode} — ${r.summary}`);
    return 1;
  }
  if (!apply) {
    deps.out(`# DRY-RUN — ${r.summary}`);
    deps.out(`  decision: ${r.action}${r.target ? ` → ${r.target}` : ''} (${r.reason})`);
    if (r.proceed) deps.out('  pass --apply to perform the re-pin (Flux then rolls the cluster).');
    return 0;
  }
  deps.out(`upgrade: ${r.summary}`);
  if (r.applied) deps.out('Watch: kubectl -n flux-system get gitrepository,kustomization');
  // proceed-but-not-applied is a real failure; a blocked/no-op decision is exit 0.
  return r.ok ? 0 : 1;
}

/**
 * `rollback [--apply] [--restore-data]` (ADR-045 W16) — undo the most recent
 * applied upgrade. DRY-RUN BY DEFAULT (prints what it would do); `--apply`
 * re-pins the Flux source back to the recorded pre-upgrade ref. `--restore-data`
 * ALSO reverts the Longhorn rescue snapshots (DESTRUCTIVE — undoes data changes).
 */
export async function rollbackCommand(args: string[], deps: Deps): Promise<number> {
  let apply = false;
  let restoreData = false;
  for (const a of args) {
    if (a === '--apply') apply = true;
    else if (a === '--restore-data') restoreData = true;
    else if (a === '--dry-run') apply = false;
    else {
      deps.err(`rollback: unknown arg '${a}'`);
      return 2;
    }
  }
  const r = await deps.rollback.run({ apply, restoreData });
  if (r.errorCode) {
    deps.err(`rollback: ${r.errorCode} — ${r.summary}`);
    return 1;
  }
  deps.out(apply ? `rollback: ${r.summary}` : `# DRY-RUN — ${r.summary}\n  pass --apply to perform it${restoreData ? '' : ' (add --restore-data to also revert volumes)'}`);
  return r.ok ? 0 : 1;
}
