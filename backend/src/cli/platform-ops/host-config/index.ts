/**
 * Production wiring for `platform-ops host-config` (ADR-045 W10, amended —
 * host-side convergence). platform-ops runs as root on the host, so it reads +
 * writes /proc/sys NATIVELY (it's already in the host mount + net namespaces);
 * no privileged pod, no caps. The desired policy is read from the cluster's
 * host-config-desired ConfigMap via kubeconfig.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
import { runHostMigrations, hostMigrationValid } from './host-migrations.js';
import { convergeUlimits, ulimitLineValid } from './ulimits.js';
import { convergeModules, moduleNameValid } from './modules.js';
import type {
  ConvergeResult,
  HostConfigDeps,
  HostConfigOptions,
  HostMigrationDeps,
  HostMigrationResult,
  HostMigrationScript,
  ModuleConvergeResult,
  ModuleDeps,
  ModuleSpec,
  PackageConvergeResult,
  PackageDeps,
  PackageManagerFamily,
  PackageSpec,
  SysctlSpec,
  UlimitConvergeResult,
  UlimitDeps,
} from './types.js';

export type {
  ConvergeResult,
  HostConfigOptions,
  PackageConvergeResult,
  HostMigrationResult,
  UlimitConvergeResult,
  ModuleConvergeResult,
} from './types.js';

const DESIRED_CM = 'host-config-desired';
const PACKAGES_CM = 'host-packages-desired';
const HOST_MIGRATIONS_CM = 'host-migrations-desired';
const ULIMITS_CM = 'host-ulimits-desired';
const MODULES_CM = 'host-modules-desired';
const DESIRED_NS = 'platform-system';
const PROC_SYS = '/proc/sys';

// Managed drop-in / persistence paths. Each is a single platform-owned file —
// the converger overwrites it wholesale, so an operator edit is reverted on the
// next pass (the file header says so).
const ULIMITS_DROP_IN = '/etc/security/limits.d/90-platform.conf';
const MODULES_LOAD_DROP_IN = '/etc/modules-load.d/90-platform.conf';
const MODPROBE_BIN = '/usr/sbin/modprobe';
const MODPROBE_TIMEOUT_MS = 30_000;

// Per-package subprocess budgets. A query is fast; an install may pull a chain
// off a slow mirror — bounded so one stuck apt/dnf can't wedge the daily timer.
const PKG_QUERY_TIMEOUT_MS = 30_000;
const PKG_INSTALL_TIMEOUT_MS = 300_000;

// Host-migration roots + budget. Markers are the per-node applied record; the
// filesystem dir is the dev/escape-hatch catalog source (production is SEA-embedded).
const HOST_MIGRATION_MARKER_ROOT = '/var/lib/platform/host-migrations';
const DEFAULT_HOST_MIGRATIONS_DIR = '/usr/local/share/platform-ops/host-migrations';
const HOST_MIGRATION_TIMEOUT_MS = 600_000;
const HOST_MIGRATION_MAX_OUTPUT = 8 * 1024 * 1024;

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

// ── Host-migration runner (W10c) ─────────────────────────────────────────────

function splitMigrationKey(key: string): { version: string; name: string } {
  const slash = key.indexOf('/');
  if (slash < 0) return { version: '', name: key };
  return { version: key.slice(0, slash), name: key.slice(slash + 1) };
}

/** Build a contained marker path for a key, or null if it fails validation. */
function migrationMarkerPath(key: string): string | null {
  const { version, name } = splitMigrationKey(key);
  if (!hostMigrationValid({ version, name })) return null; // re-guard before any FS path
  const full = join(HOST_MIGRATION_MARKER_ROOT, version, `${name}.done`);
  if (!full.startsWith(HOST_MIGRATION_MARKER_ROOT + '/')) return null;
  return full;
}

function migrationIsApplied(key: string): boolean {
  const p = migrationMarkerPath(key);
  return p !== null && existsSync(p);
}

function migrationMarkApplied(key: string): void {
  const p = migrationMarkerPath(key);
  if (!p) throw new Error(`refusing marker for invalid key ${JSON.stringify(key)}`);
  mkdirSync(join(p, '..'), { recursive: true });
  // Marker presence is the only signal the runner reads; the body is advisory.
  writeFileSync(p, `applied-by platform-ops host-migration runner\n`, { mode: 0o644 });
}

// Run a script via bash from STDIN (no temp file → no path/symlink race), argv-
// only, with a clean minimal env and a hard timeout. Scripts are platform-
// authored + shellcheck-gated; they must not rely on $0/$BASH_SOURCE (stdin).
function migrationRunScript(script: HostMigrationScript): void {
  try {
    execFileSync('/bin/bash', ['-s'], {
      input: script.body,
      encoding: 'utf8',
      timeout: HOST_MIGRATION_TIMEOUT_MS,
      maxBuffer: HOST_MIGRATION_MAX_OUTPUT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root' },
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || 'script failed').toString().trim().split('\n').slice(-4).join('; ');
    throw new Error(detail);
  }
}

/** Parse a catalog dir on disk: <root>/<version>/<NNNN-name.sh>. */
function loadFilesystemCatalog(dir: string): HostMigrationScript[] {
  const out: HostMigrationScript[] = [];
  let versions: string[] = [];
  try {
    versions = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const version of versions) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, version)).filter((f) => f.endsWith('.sh'));
    } catch {
      continue;
    }
    for (const name of files) {
      // Only read files that pass validation — never touch an odd path.
      if (!hostMigrationValid({ version, name })) {
        out.push({ version, name, key: `${version}/${name}`, body: '' });
        continue; // surfaced as "invalid" by the runner; body unused
      }
      try {
        const body = readFileSync(join(dir, version, name), 'utf8');
        out.push({ version, name, key: `${version}/${name}`, body });
      } catch {
        // unreadable → skip; absence is benign
      }
    }
  }
  return out;
}

/**
 * Load the shipped catalog: SEA-embedded assets in production (so scripts travel
 * with every self-upgrade), or a filesystem dir in dev / as an escape hatch.
 */
async function loadHostMigrationCatalog(
  env: NodeJS.ProcessEnv,
): Promise<{ source: 'embedded' | 'filesystem' | 'absent'; scripts: HostMigrationScript[] }> {
  // 1. SEA-embedded (the production path). Distinguish "not a SEA" from "is a SEA
  // but the assets won't load": a real SEA binary ALWAYS carries the manifest, so
  // an asset failure means a CORRUPT binary — refuse outright rather than silently
  // falling through to the lower-trust filesystem (which would let a node that
  // self-upgraded into a bad binary execute env/dir-pointed scripts as root).
  let sea: typeof import('node:sea') | null = null;
  try {
    sea = await import('node:sea');
  } catch {
    sea = null; // not a SEA runtime (dev / tests / plain node)
  }
  if (sea?.isSea()) {
    try {
      const manifestRaw = sea.getAsset('host-migrations/manifest.json', 'utf8') as string;
      const manifest = JSON.parse(manifestRaw) as { scripts?: string[] };
      const scripts: HostMigrationScript[] = [];
      for (const key of manifest.scripts ?? []) {
        const { version, name } = splitMigrationKey(key);
        const body = sea.getAsset(`host-migrations/${key}`, 'utf8') as string;
        scripts.push({ version, name, key, body });
      }
      return { source: 'embedded', scripts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`host-config: embedded host-migration catalog unreadable (corrupt binary?) — refusing: ${msg}\n`);
      return { source: 'absent', scripts: [] };
    }
  }
  // 2. Filesystem — dev / non-SEA only (NEVER reached from a real node binary).
  const dir = env.PLATFORM_OPS_HOST_MIGRATIONS_DIR?.trim() || DEFAULT_HOST_MIGRATIONS_DIR;
  if (!existsSync(dir)) return { source: 'absent', scripts: [] };
  return { source: 'filesystem', scripts: loadFilesystemCatalog(dir) };
}

async function readHostMigrationMode(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { createK8sClients } = await import('../../../modules/k8s-provisioner/k8s-client.js');
    const kubeconfig = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
    const k8s = existsSync(kubeconfig) ? createK8sClients(kubeconfig) : createK8sClients();
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: HOST_MIGRATIONS_CM,
      namespace: DESIRED_NS,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as { data?: Record<string, string> };
    return (cm.data?.['mode'] ?? '').trim();
  } catch {
    return null;
  }
}

export function realHostMigrationDeps(
  env: NodeJS.ProcessEnv,
  catalog: { source: 'embedded' | 'filesystem' | 'absent'; scripts: HostMigrationScript[] },
): HostMigrationDeps {
  return {
    readMode: () => readHostMigrationMode(env),
    isApplied: migrationIsApplied,
    markApplied: migrationMarkApplied,
    runScript: migrationRunScript,
    source: catalog.source,
  };
}

// ── ulimits / limits.d (W10 follow-up) ───────────────────────────────────────

/** Split a CM `limits` block into lines (comments + blanks kept — renderUlimits drops them). */
function parseUlimitLines(raw: string): string[] {
  return raw.split('\n').map((l) => l.replace(/\r$/, ''));
}

function readUlimitDropIn(): string | null {
  try {
    return readFileSync(ULIMITS_DROP_IN, 'utf8');
  } catch {
    return null; // absent → drift vs any desired content
  }
}

// The ONLY ulimit-mutating function. The content is platform-rendered (every
// line already passed ulimitLineValid in renderUlimits); this re-guards each
// non-comment line as a second gate before the file ever lands on disk, so a
// rendering bug can't write an unvalidated line into limits.d.
function writeUlimitDropIn(content: string): void {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (!ulimitLineValid(t)) throw new Error(`refusing to write invalid limits.conf line ${JSON.stringify(t)}`);
  }
  mkdirSync(join(ULIMITS_DROP_IN, '..'), { recursive: true });
  writeFileSync(ULIMITS_DROP_IN, content, { mode: 0o644 });
}

async function readDesiredUlimits(env: NodeJS.ProcessEnv): Promise<{ lines: string[]; mode: string } | null> {
  try {
    const { createK8sClients } = await import('../../../modules/k8s-provisioner/k8s-client.js');
    const kubeconfig = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
    const k8s = existsSync(kubeconfig) ? createK8sClients(kubeconfig) : createK8sClients();
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: ULIMITS_CM,
      namespace: DESIRED_NS,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as { data?: Record<string, string> };
    return {
      lines: parseUlimitLines(cm.data?.['limits'] ?? ''),
      mode: (cm.data?.['mode'] ?? '').trim(),
    };
  } catch {
    return null;
  }
}

export function realUlimitDeps(env: NodeJS.ProcessEnv): UlimitDeps {
  return {
    readDesired: () => readDesiredUlimits(env),
    readCurrent: readUlimitDropIn,
    writeDropIn: writeUlimitDropIn,
  };
}

// ── kernel modules (W10 follow-up) ───────────────────────────────────────────

/** Parse a CM `modules` block into specs (one name per line; comments + blanks skipped). */
export function parseModules(raw: string): ModuleSpec[] {
  const out: ModuleSpec[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith(';')) continue;
    out.push({ name: t });
  }
  return out;
}

// A module is "loaded" iff it appears in /proc/modules (first column). Reading
// the file (not `lsmod`) keeps this dependency-free + race-free. Names there use
// underscores; modprobe accepts either, so we compare on the normalised form.
function moduleIsLoaded(name: string): boolean {
  if (!moduleNameValid(name)) return false;
  let raw: string;
  try {
    raw = readFileSync('/proc/modules', 'utf8');
  } catch {
    return false;
  }
  const want = name.replace(/-/g, '_');
  for (const line of raw.split('\n')) {
    const first = line.split(' ', 1)[0];
    if (first && first.replace(/-/g, '_') === want) return true;
  }
  return false;
}

// The ONLY module-mutating function. Re-validates the name (second gate behind
// convergeModules), loads via modprobe (absolute path, argv-only, `--` separator
// so a name can never be read as a flag), then persists to modules-load.d so the
// module survives a reboot. ADDITIVE: append-if-absent, never rewrite/remove.
function loadModule(name: string): void {
  if (!moduleNameValid(name)) throw new Error(`refusing to load invalid module name ${JSON.stringify(name)}`);
  try {
    execFileSync(MODPROBE_BIN, ['--', name], {
      encoding: 'utf8',
      timeout: MODPROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || 'modprobe failed').toString().trim().split('\n').slice(-2).join('; ');
    throw new Error(detail);
  }
  persistModule(name);
}

/** Append a module to /etc/modules-load.d/90-platform.conf if not already present. */
function persistModule(name: string): void {
  // Independent gate: persistModule is private (only loadModule calls it today),
  // but guard defensively so any future caller cannot bypass the name validation.
  if (!moduleNameValid(name)) throw new Error(`refusing to persist invalid module name ${JSON.stringify(name)}`);
  let existing = '';
  try {
    existing = readFileSync(MODULES_LOAD_DROP_IN, 'utf8');
  } catch {
    existing = '';
  }
  // Dedup on the kernel-normalised form (hyphen ≡ underscore) so a name already
  // persisted in either spelling is never appended a second time.
  const want = name.replace(/-/g, '_');
  const lines = existing.split('\n').map((l) => l.trim());
  if (lines.some((l) => l.replace(/-/g, '_') === want)) return; // already persisted
  const header = existing.startsWith('#')
    ? ''
    : '# Managed by platform-ops host-config (ADR-045 W10) — modules to load at boot.\n';
  const body = existing.endsWith('\n') || existing === '' ? existing : existing + '\n';
  mkdirSync(join(MODULES_LOAD_DROP_IN, '..'), { recursive: true });
  writeFileSync(MODULES_LOAD_DROP_IN, `${header}${body}${name}\n`, { mode: 0o644 });
}

async function readDesiredModules(env: NodeJS.ProcessEnv): Promise<{ modules: ModuleSpec[]; mode: string } | null> {
  try {
    const { createK8sClients } = await import('../../../modules/k8s-provisioner/k8s-client.js');
    const kubeconfig = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
    const k8s = existsSync(kubeconfig) ? createK8sClients(kubeconfig) : createK8sClients();
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: MODULES_CM,
      namespace: DESIRED_NS,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as { data?: Record<string, string> };
    return {
      modules: parseModules(cm.data?.['modules'] ?? ''),
      mode: (cm.data?.['mode'] ?? '').trim(),
    };
  } catch {
    return null;
  }
}

export function realModuleDeps(env: NodeJS.ProcessEnv): ModuleDeps {
  return {
    readDesired: () => readDesiredModules(env),
    isLoaded: moduleIsLoaded,
    loadModule,
  };
}

export interface HostConfigOps {
  /** Converge host sysctls to the host-config-desired policy. */
  run: (opts: HostConfigOptions) => Promise<ConvergeResult>;
  /** Converge declared OS packages to "present" (host-packages-desired policy). */
  packages: (opts: HostConfigOptions) => Promise<PackageConvergeResult>;
  /** Apply pending host-migration scripts (host-migrations-desired policy). */
  hostMigrations: (opts: HostConfigOptions) => Promise<HostMigrationResult>;
  /** Converge the managed limits.d drop-in (host-ulimits-desired policy). */
  ulimits: (opts: HostConfigOptions) => Promise<UlimitConvergeResult>;
  /** Ensure declared kernel modules are loaded (host-modules-desired policy). */
  modules: (opts: HostConfigOptions) => Promise<ModuleConvergeResult>;
}

export function realHostConfigOps(env: NodeJS.ProcessEnv): HostConfigOps {
  const deps = realHostConfigDeps(env);
  const pkgDeps = realPackageDeps(env);
  const ulimitDeps = realUlimitDeps(env);
  const moduleDeps = realModuleDeps(env);
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
    async hostMigrations(opts) {
      const catalog = await loadHostMigrationCatalog(env);
      const hmDeps = realHostMigrationDeps(env, catalog);
      if (catalog.source === 'absent') return runHostMigrations(null, false, hmDeps);
      // Same opt-in gating, against the host-migrations policy's own mode.
      const mode = await hmDeps.readMode();
      const enforcing = opts.apply || (!opts.dryRun && (mode ?? '').toLowerCase() === 'enforce');
      return runHostMigrations(catalog.scripts, enforcing, hmDeps);
    },
    async ulimits(opts) {
      const desired = await ulimitDeps.readDesired();
      if (!desired) return convergeUlimits(null, false, ulimitDeps);
      // Same opt-in gating as sysctls, against the ulimits policy's own mode.
      const enforcing = opts.apply || (!opts.dryRun && desired.mode.toLowerCase() === 'enforce');
      return convergeUlimits(desired.lines, enforcing, ulimitDeps);
    },
    async modules(opts) {
      const desired = await moduleDeps.readDesired();
      if (!desired) return convergeModules(null, false, moduleDeps);
      // Same opt-in gating, against the modules policy's own mode.
      const enforcing = opts.apply || (!opts.dryRun && desired.mode.toLowerCase() === 'enforce');
      return convergeModules(desired.modules, enforcing, moduleDeps);
    },
  };
}
