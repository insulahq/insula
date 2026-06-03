/**
 * Host-migration runner (ADR-045 W10c) — apply per-release one-shot shell
 * scripts on this node, HOST-SIDE (platform-ops is root on the host).
 *
 * Pure decision tree over the HostMigrationDeps seam so ordering, skip-multiple,
 * halt-on-failure, idempotency-via-marker, and the never-run-invalid invariant
 * are unit-testable without touching the host. The real path (index.ts) loads
 * the catalog from the SEA-embedded assets (so scripts travel with every
 * self-upgrade) — or a filesystem dir in dev — and runs each via bash.
 *
 * SAFETY POSTURE:
 *   • Opt-in: only runs when the policy mode==enforce (or --apply); otherwise a
 *     dry-run that reports "would-run" and touches nothing.
 *   • HALTS on the first failure — later pending scripts become "blocked", never
 *     run out of a half-migrated state. Operator-resumable (re-run continues).
 *   • Idempotent by marker: an already-applied script is skipped. Scripts are
 *     platform-authored + themselves idempotent (CI-enforced), not operator input.
 *   • Deterministic order: (version, name) ascending, so skip-multiple walks the
 *     whole backlog in the same order it would have applied incrementally.
 */

import { compareVersions, isValidVersion } from '../../../modules/platform-updates/poller/semver.js';
import type {
  HostMigrationDeps,
  HostMigrationItem,
  HostMigrationResult,
  HostMigrationScript,
} from './types.js';

// Scripts are repo-controlled (not hostile input), but a sanity cap keeps a
// runaway catalog from ever blocking a node indefinitely.
const MAX_SCRIPTS = 500;

/** A host-migration file name: a zero-padded numeric prefix + kebab slug + .sh. */
const NAME_RE = /^[0-9]{3,}-[a-z0-9][a-z0-9-]*\.sh$/;

/** A script is valid only if its version is CalVer and its name matches NAME_RE. */
export function hostMigrationValid(script: { version: string; name: string }): boolean {
  return isValidVersion(script.version) && NAME_RE.test(script.name);
}

/** Stable order: version ascending (CalVer), then name lexicographic. */
export function orderHostMigrations(scripts: readonly HostMigrationScript[]): HostMigrationScript[] {
  return [...scripts].sort((a, b) => {
    const v = compareVersions(a.version, b.version);
    return v !== 0 ? v : a.name.localeCompare(b.name);
  });
}

export function runHostMigrations(
  scripts: readonly HostMigrationScript[] | null,
  enforcing: boolean,
  deps: HostMigrationDeps,
): HostMigrationResult {
  const mode = enforcing ? 'enforce' : 'dry-run';
  if (scripts === null) {
    return { ok: true, mode, source: deps.source, items: [], appliedCount: 0 };
  }
  if (scripts.length > MAX_SCRIPTS) {
    return {
      ok: false,
      mode,
      source: deps.source,
      items: [],
      appliedCount: 0,
      reason: `host-migration catalog has ${scripts.length} scripts (> ${MAX_SCRIPTS} cap) — refusing`,
    };
  }

  const ordered = orderHostMigrations(scripts);
  const items: HostMigrationItem[] = [];
  let appliedCount = 0;
  let halted = false;
  let ok = true;

  for (const s of ordered) {
    if (!hostMigrationValid(s)) {
      items.push({ key: s.key, state: 'invalid' });
      continue; // never run a script whose version/name didn't validate
    }
    if (deps.isApplied(s.key)) {
      items.push({ key: s.key, state: 'already-applied' });
      continue;
    }
    if (!enforcing) {
      items.push({ key: s.key, state: 'would-run' });
      continue;
    }
    if (halted) {
      // A prior script failed — refuse to advance past a half-migrated state.
      items.push({ key: s.key, state: 'blocked' });
      continue;
    }
    try {
      deps.runScript(s);
    } catch (err) {
      ok = false;
      halted = true;
      const message = err instanceof Error ? err.message : String(err);
      items.push({ key: s.key, state: 'run-failed', error: message });
      continue;
    }
    try {
      deps.markApplied(s.key);
    } catch (err) {
      // The script ran but we couldn't persist its marker — halt rather than
      // risk re-running a non-idempotent-in-practice script on the next pass.
      ok = false;
      halted = true;
      const message = err instanceof Error ? err.message : String(err);
      items.push({ key: s.key, state: 'run-failed', error: `applied but marker write failed: ${message}` });
      continue;
    }
    items.push({ key: s.key, state: 'applied' });
    appliedCount++;
  }
  return { ok, mode, source: deps.source, items, appliedCount };
}
