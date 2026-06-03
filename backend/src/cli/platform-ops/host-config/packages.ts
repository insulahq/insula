/**
 * Package convergence (ADR-045 W10b) — keep declared OS packages PRESENT on
 * every node, HOST-SIDE (platform-ops is root on the host; no privileged pod).
 *
 * Pure decision tree over the PackageDeps read/install seam so the whole policy
 * — name/version validation, additive-only behaviour, the never-act-on-invalid
 * invariant — is unit-testable without touching apt/dnf. The real install path
 * (index.ts) re-validates and spawns `apt-get`/`dnf` via argv (NO shell, `--`
 * separator) so a desired entry can neither inject a command nor smuggle a flag.
 *
 * SAFETY POSTURE:
 *   • ADDITIVE-ONLY — install missing packages; NEVER remove / purge / autoremove
 *     / auto-downgrade. A pin mismatch on an already-installed package is REPORTED
 *     (`version-mismatch`) and left untouched: silently changing the version of a
 *     package under a running service from a daily timer is unacceptable.
 *   • Acts ONLY on packages named in the desired policy; undeclared packages are
 *     never inspected or touched.
 */

import type {
  PackageConvergeResult,
  PackageDeps,
  PackageItem,
  PackageManagerFamily,
  PackageSpec,
} from './types.js';

/** Conventional dpkg/rpm names are short; cap to keep argv + logs bounded. */
const MAX_PACKAGE_NAME_LEN = 200;
const MAX_PACKAGE_VERSION_LEN = 200;

// A ConfigMap can hold ~1 MiB, i.e. tens of thousands of one-word lines. With a
// 5-min per-install timeout a hostile/huge list could wedge the daily timer for
// a very long time, so refuse a policy larger than any plausible real one rather
// than process it. (Real node package sets are a handful to a few dozen.)
const MAX_PACKAGE_SPECS = 200;

/**
 * A package name must start with an alphanumeric (so it can NEVER be read as a
 * flag by apt/dnf, even before the `--` separator) and contain only the dpkg/rpm
 * name charset. This rejects leading `-`, whitespace, shell metacharacters,
 * slashes, and path traversal outright.
 */
export function packageNameValid(name: string): boolean {
  if (name.length === 0 || name.length > MAX_PACKAGE_NAME_LEN) return false;
  return /^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(name);
}

/**
 * A pinned version (dpkg/rpm): starts alphanumeric, plus the epoch/tilde/plus
 * charset. Same anti-flag, anti-meta guarantees as the name.
 */
export function packageVersionValid(version: string): boolean {
  if (version.length === 0 || version.length > MAX_PACKAGE_VERSION_LEN) return false;
  return /^[A-Za-z0-9][A-Za-z0-9+.~:_-]*$/.test(version);
}

function notAllowed(spec: PackageSpec): PackageItem {
  return { name: spec.name, desiredVersion: spec.version, actualVersion: null, state: 'not-allowed' };
}

/**
 * Converge declared packages to "present" on this host. When `enforcing` is
 * false this is a DRY-RUN: missing packages are reported "would-install",
 * nothing is installed.
 */
export function convergePackages(
  specs: readonly PackageSpec[] | null,
  family: PackageManagerFamily | null,
  enforcing: boolean,
  deps: PackageDeps,
): PackageConvergeResult {
  const mode = enforcing ? 'enforce' : 'dry-run';
  if (specs === null) {
    return { ok: true, mode, desiredSource: 'absent', family, items: [], installedCount: 0 };
  }
  if (specs.length > MAX_PACKAGE_SPECS) {
    // Refuse the whole policy — never partially process a suspiciously large list.
    return {
      ok: false,
      mode,
      desiredSource: 'configmap',
      family,
      items: [],
      installedCount: 0,
      reason: `host-packages-desired declares ${specs.length} packages (> ${MAX_PACKAGE_SPECS} cap) — refusing`,
    };
  }
  if (family === null) {
    // No apt/dnf on this host (e.g. a minimal/immutable OS) — report, never act.
    const items = specs.map<PackageItem>((s) => ({
      name: s.name,
      desiredVersion: s.version,
      actualVersion: null,
      state: 'unsupported',
    }));
    return { ok: true, mode, desiredSource: 'configmap', family: null, items, installedCount: 0 };
  }

  const items: PackageItem[] = [];
  let installedCount = 0;
  let ok = true;

  for (const spec of specs) {
    if (!packageNameValid(spec.name) || (spec.version !== null && !packageVersionValid(spec.version))) {
      items.push(notAllowed(spec));
      continue;
    }
    const cur = deps.queryInstalled(spec.name);
    if (cur.installed) {
      if (spec.version !== null && cur.version !== null && cur.version !== spec.version) {
        // Pin drift on a live package — advisory only, never auto-changed.
        items.push({ name: spec.name, desiredVersion: spec.version, actualVersion: cur.version, state: 'version-mismatch' });
        continue;
      }
      items.push({ name: spec.name, desiredVersion: spec.version, actualVersion: cur.version, state: 'ok' });
      continue;
    }
    if (!enforcing) {
      items.push({ name: spec.name, desiredVersion: spec.version, actualVersion: null, state: 'would-install' });
      continue;
    }
    try {
      deps.installPackage(family, spec.name, spec.version);
    } catch (err) {
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      items.push({ name: spec.name, desiredVersion: spec.version, actualVersion: null, state: 'install-failed', error: message });
      continue;
    }
    const after = deps.queryInstalled(spec.name);
    items.push({ name: spec.name, desiredVersion: spec.version, actualVersion: after.version, state: 'installed' });
    installedCount++;
  }
  return { ok, mode, desiredSource: 'configmap', family, items, installedCount };
}
