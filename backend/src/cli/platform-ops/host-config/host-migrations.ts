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
 *     Precedence: `.done` (ran) > `.skipped` (operator) > `.baseline` (a fresh
 *     bootstrap already reflects it — ADR-056 §5); none of the three ever runs.
 *   • Deterministic order: (version, name) ascending, so skip-multiple walks the
 *     whole backlog in the same order it would have applied incrementally.
 */

import { compareVersions, isValidVersion, parseVersion } from '../../../modules/platform-updates/poller/semver.js';
import { hostMigrationBlocksOnFailure, hostMigrationPhase } from './types.js';
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

/**
 * ADR-064 §3. Have the services reached the release a script belongs to? Script
 * directories are plain CalVer (`2026.10.7`) while the services may run a
 * candidate or a DEV build of it (`2026.10.7-rc.4`, `2026.10.7-ad8fe1a`) — which
 * SemVer sorts BELOW `2026.10.7`. Compare the services' base version, or an
 * after-services script would never run on a release-candidate cluster.
 */
export function servicesReachedRelease(servicesVersion: string | null | undefined, scriptVersion: string): boolean {
  if (!servicesVersion) return false;
  const p = parseVersion(servicesVersion.trim().replace(/^v/, ''));
  if (!p) return false;
  return compareVersions(`${p.major}.${p.minor}.${p.patch}`, scriptVersion) >= 0;
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
  // ADR-056 §1: only a script that DECLARES it blocks halts the chain. Absent
  // header ⇒ blocks, so nothing regresses silently; an author opts out only for
  // a script nothing later depends on.
  let halted = false;
  let ok = true;

  for (const s of ordered) {
    const phase = hostMigrationValid(s) ? hostMigrationPhase(s.body) : null;
    if (phase === null) {
      items.push({ key: s.key, state: 'invalid' });
      continue; // never run a script whose version/name/phase didn't validate
    }
    if (deps.isApplied(s.key)) {
      items.push({ key: s.key, state: 'already-applied', phase });
      continue;
    }
    // ADR-056 §2: an operator-recorded skip. Reported as `skipped`, never
    // `applied` — the node's state stays honest — and it does not block.
    const skip = deps.readSkip?.(s.key) ?? null;
    if (skip) {
      items.push({ key: s.key, state: 'skipped', skipReason: skip.reason, phase });
      continue;
    }
    // ADR-056 §5: a fresh bootstrap of this release already produced the end
    // state, so it is treated as applied and never run — but reported with
    // `baseline: true`, never as if it ran. `.done` (checked above) wins.
    if (deps.readBaseline?.(s.key)) {
      items.push({ key: s.key, state: 'already-applied', baseline: true, phase });
      continue;
    }
    // ADR-064 §3: an after-services script waits for the services to run its
    // release. Not a failure and not blocking — the next converge picks it up.
    if (phase === 'after-services' && !servicesReachedRelease(deps.servicesVersion, s.version)) {
      items.push({ key: s.key, state: 'deferred', phase });
      continue;
    }
    if (!enforcing) {
      items.push({ key: s.key, state: 'would-run', phase });
      continue;
    }
    if (halted) {
      // A prior script failed — refuse to advance past a half-migrated state.
      items.push({ key: s.key, state: 'blocked', phase });
      continue;
    }
    try {
      deps.runScript(s);
    } catch (err) {
      ok = false;
      const blocks = hostMigrationBlocksOnFailure(s.body);
      if (blocks) halted = true;
      const message = err instanceof Error ? err.message : String(err);
      // ADR-056 §3: count it, so a wedge escalates instead of repeating one
      // silent line. DEV failed identically for five weeks before anyone looked.
      const f = deps.noteFailure?.(s.key);
      items.push({
        key: s.key,
        state: 'run-failed',
        error: message,
        phase,
        ...(f ? { attempt: f.attempt, failingSince: f.failingSince } : {}),
      });
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
      const f = deps.noteFailure?.(s.key);
      items.push({
        key: s.key,
        state: 'run-failed',
        error: `applied but marker write failed: ${message}`,
        phase,
        ...(f ? { attempt: f.attempt, failingSince: f.failingSince } : {}),
      });
      continue;
    }
    deps.clearFailure?.(s.key);
    items.push({ key: s.key, state: 'applied', phase });
    appliedCount++;
  }
  return { ok, mode, source: deps.source, items, appliedCount };
}
