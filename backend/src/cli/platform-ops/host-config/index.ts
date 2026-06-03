/**
 * Production wiring for `platform-ops host-config` (ADR-045 W10, amended —
 * host-side convergence). platform-ops runs as root on the host, so it reads +
 * writes /proc/sys NATIVELY (it's already in the host mount + net namespaces);
 * no privileged pod, no caps. The desired policy is read from the cluster's
 * host-config-desired ConfigMap via kubeconfig.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  convergeSysctls,
  normalizeSysctl,
  sysctlAllowed,
  sysctlKeyToRelPath,
  MAX_SYSCTL_VALUE_LEN,
} from './sysctls.js';
import { convergePackages, packageNameValid, packageVersionValid } from './packages.js';
import type {
  ConvergeResult,
  HostConfigDeps,
  HostConfigOptions,
  PackageConvergeResult,
  PackageDeps,
  PackageManagerFamily,
  PackageSpec,
  SysctlSpec,
} from './types.js';

export type { ConvergeResult, HostConfigOptions, PackageConvergeResult } from './types.js';

const DESIRED_CM = 'host-config-desired';
const PACKAGES_CM = 'host-packages-desired';
const DESIRED_NS = 'platform-system';
const PROC_SYS = '/proc/sys';

// Per-package subprocess budgets. A query is fast; an install may pull a chain
// off a slow mirror — bounded so one stuck apt/dnf can't wedge the daily timer.
const PKG_QUERY_TIMEOUT_MS = 30_000;
const PKG_INSTALL_TIMEOUT_MS = 300_000;

/** Parse sysctl.conf-style `key = value` lines (matches the Go observe parser). */
export function parseSysctls(raw: string): SysctlSpec[] {
  const out: SysctlSpec[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith(';')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    if (key) out.push({ key, value });
  }
  return out;
}

/** Resolve a sysctl key to its absolute /proc/sys path, with containment. */
function procSysPath(key: string): string | null {
  const rel = sysctlKeyToRelPath(key);
  if (!rel) return null;
  const full = join(PROC_SYS, rel);
  if (full !== PROC_SYS && !full.startsWith(PROC_SYS + '/')) return null;
  return full;
}

function readSysctl(key: string): string | null {
  const full = procSysPath(key);
  if (!full) return null;
  try {
    return normalizeSysctl(readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

// The ONLY host-mutating function. Re-validates the allow-list + deny-list + path
// containment + value length on EVERY write — the second, independent gate behind
// convergeSysctls's allow-list check, so a bug in the loop can never escalate into
// a deny-listed or out-of-bounds host write.
function writeSysctl(key: string, value: string): void {
  if (!sysctlAllowed(key)) throw new Error(`refusing to write non-allow-listed sysctl ${key}`);
  if (value.length > MAX_SYSCTL_VALUE_LEN) throw new Error(`refusing oversize sysctl value (${value.length} bytes) for ${key}`);
  const full = procSysPath(key);
  if (!full) throw new Error(`refusing unsafe sysctl path for ${key}`);
  writeFileSync(full, value + '\n');
}

async function readDesired(env: NodeJS.ProcessEnv): Promise<{ sysctls: SysctlSpec[]; mode: string } | null> {
  try {
    const { createK8sClients } = await import('../../../modules/k8s-provisioner/k8s-client.js');
    const kubeconfig = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
    const k8s = existsSync(kubeconfig) ? createK8sClients(kubeconfig) : createK8sClients();
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: DESIRED_CM,
      namespace: DESIRED_NS,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as { data?: Record<string, string> };
    return {
      sysctls: parseSysctls(cm.data?.['sysctls'] ?? ''),
      mode: (cm.data?.['mode'] ?? '').trim(),
    };
  } catch {
    return null; // ConfigMap absent / cluster unreachable → nothing to converge
  }
}

export function realHostConfigDeps(env: NodeJS.ProcessEnv): HostConfigDeps {
  return {
    readDesired: () => readDesired(env),
    readSysctl,
    writeSysctl,
  };
}

// ── Package convergence (W10b) ───────────────────────────────────────────────

/** Parse `name` / `name=version` lines (comments + blanks skipped). */
export function parsePackages(raw: string): PackageSpec[] {
  const out: PackageSpec[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith(';')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) {
      out.push({ name: t, version: null });
    } else {
      // Normalise a trailing `=` (no value) to "no pin" rather than an empty
      // string, so PackageSpec.version is always either a real pin or null.
      const v = t.slice(eq + 1).trim();
      out.push({ name: t.slice(0, eq).trim(), version: v === '' ? null : v });
    }
  }
  return out;
}

/** Detect the host package manager from the executables actually present. */
function detectFamily(): PackageManagerFamily | null {
  if (existsSync('/usr/bin/apt-get')) return 'apt';
  if (existsSync('/usr/bin/dnf')) return 'dnf';
  return null;
}

function queryInstalled(name: string): { installed: boolean; version: string | null } {
  // Never trust the name into a subprocess without the same guard the converger
  // uses — and pass `--` so it can never be read as a flag.
  if (!packageNameValid(name)) return { installed: false, version: null };
  try {
    if (existsSync('/usr/bin/dpkg-query')) {
      // Absolute path (not bare `dpkg-query`): the binary we run is the exact one
      // existsSync just confirmed, never a PATH-resolved shadow in a writable dir.
      const out = execFileSync('/usr/bin/dpkg-query', ['-W', '-f=${Version}\t${db:Status-Status}', '--', name], {
        encoding: 'utf8',
        timeout: PKG_QUERY_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const [version, status] = out.trim().split('\t');
      if (status === 'installed' && version) return { installed: true, version };
      return { installed: false, version: null };
    }
    if (existsSync('/usr/bin/rpm')) {
      const out = execFileSync('/usr/bin/rpm', ['-q', '--qf', '%{VERSION}-%{RELEASE}', '--', name], {
        encoding: 'utf8',
        timeout: PKG_QUERY_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const version = out.trim();
      if (version && !version.includes('not installed')) return { installed: true, version };
      return { installed: false, version: null };
    }
  } catch {
    // dpkg-query/rpm exit non-zero when the package is absent — that's a clean
    // "not installed", not an error.
    return { installed: false, version: null };
  }
  return { installed: false, version: null };
}

// The ONLY host-mutating package function. Re-validates name + version (the
// second gate behind convergePackages), runs apt/dnf with an argv array (NO
// shell) and a `--` separator (so a spec can never be read as a flag), and is
// ADDITIVE-ONLY — install verbs only; this code path never removes/purges.
function installPackage(family: PackageManagerFamily, name: string, version: string | null): void {
  if (!packageNameValid(name)) throw new Error(`refusing to install invalid package name ${JSON.stringify(name)}`);
  if (version !== null && !packageVersionValid(version)) {
    throw new Error(`refusing invalid pinned version ${JSON.stringify(version)} for ${name}`);
  }
  if (family === 'apt') {
    const spec = version !== null ? `${name}=${version}` : name;
    run('/usr/bin/apt-get', ['install', '-y', '--no-install-recommends', '--', spec], {
      ...process.env,
      DEBIAN_FRONTEND: 'noninteractive',
    });
    return;
  }
  // dnf: pinned form is `name-version` (optional, conservative).
  const spec = version !== null ? `${name}-${version}` : name;
  run('/usr/bin/dnf', ['install', '-y', '--', spec], process.env);
}

// Absolute-path argv only (NO shell). stdout is intentionally discarded — this
// runs unattended from a daily timer, so a clean one-line summary (printed by
// the caller) beats a wall of apt/dnf progress; on failure the last stderr lines
// are surfaced. An interactive operator who needs full output runs apt directly.
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  try {
    execFileSync(cmd, args, { encoding: 'utf8', timeout: PKG_INSTALL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], env });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || 'install failed').toString().trim().split('\n').slice(-3).join('; ');
    throw new Error(detail);
  }
}

async function readDesiredPackages(env: NodeJS.ProcessEnv): Promise<{ packages: PackageSpec[]; mode: string } | null> {
  try {
    const { createK8sClients } = await import('../../../modules/k8s-provisioner/k8s-client.js');
    const kubeconfig = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
    const k8s = existsSync(kubeconfig) ? createK8sClients(kubeconfig) : createK8sClients();
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: PACKAGES_CM,
      namespace: DESIRED_NS,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as { data?: Record<string, string> };
    return {
      packages: parsePackages(cm.data?.['packages'] ?? ''),
      mode: (cm.data?.['mode'] ?? '').trim(),
    };
  } catch {
    return null; // ConfigMap absent / cluster unreachable → nothing to converge
  }
}

export function realPackageDeps(env: NodeJS.ProcessEnv): PackageDeps {
  return {
    readDesiredPackages: () => readDesiredPackages(env),
    detectFamily,
    queryInstalled,
    installPackage,
  };
}

export interface HostConfigOps {
  /** Converge host sysctls to the host-config-desired policy. */
  run: (opts: HostConfigOptions) => Promise<ConvergeResult>;
  /** Converge declared OS packages to "present" (host-packages-desired policy). */
  packages: (opts: HostConfigOptions) => Promise<PackageConvergeResult>;
}

export function realHostConfigOps(env: NodeJS.ProcessEnv): HostConfigOps {
  const deps = realHostConfigDeps(env);
  const pkgDeps = realPackageDeps(env);
  return {
    async run(opts) {
      const desired = await deps.readDesired();
      if (!desired) return convergeSysctls(null, false, deps);
      // Two gates: the desired policy's mode must be "enforce" (opt-in), AND the
      // operator hasn't forced --dry-run. --apply forces enforce (manual run).
      const enforcing = opts.apply || (!opts.dryRun && desired.mode.toLowerCase() === 'enforce');
      return convergeSysctls(desired.sysctls, enforcing, deps);
    },
    async packages(opts) {
      const family = pkgDeps.detectFamily();
      const desired = await pkgDeps.readDesiredPackages();
      if (!desired) return convergePackages(null, family, false, pkgDeps);
      // Same opt-in gating as sysctls, against the packages policy's own mode.
      const enforcing = opts.apply || (!opts.dryRun && desired.mode.toLowerCase() === 'enforce');
      return convergePackages(desired.packages, family, enforcing, pkgDeps);
    },
  };
}
