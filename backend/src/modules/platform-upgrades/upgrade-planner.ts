/**
 * Upgrade decision logic (ADR-045 W13) — pure, no I/O.
 *
 * Given the version spine (installed / available) + policy (auto_update, BREAKING
 * flag) it decides whether — and to what tag — the cluster's Flux source should be
 * re-pinned. The actual re-pin (PATCH GitRepository.spec.ref.tag) is host-side
 * `platform-ops upgrade` or the backend route; this module only decides.
 *
 * Spike outcome (PR-18 / decision #14) baked in: the re-pin target is a release
 * TAG, dev/staging auto-follow a branch (so the AUTO path is production-only),
 * and a `### BREAKING` release short-circuits the auto path (manual override is
 * allowed but flagged).
 */
import { isNewerVersion, isValidVersion } from '../platform-updates/poller/semver.js';

export type UpgradeAction =
  | 'upgrade' // re-pin to `target`
  | 'none' // already at/above the candidate
  | 'blocked-auto-off' // auto path, but auto_update is off
  | 'blocked-no-candidate' // nothing to upgrade to
  | 'blocked-not-newer' // requested/available is not newer than installed
  | 'blocked-breaking' // auto path, candidate is a BREAKING release
  | 'blocked-installed-unknown' // auto path, installed version unparseable — can't verify
  | 'blocked-bad-version'; // candidate is not a valid version string

export interface UpgradeDecision {
  readonly action: UpgradeAction;
  readonly target: string | null; // the version to re-pin to (no leading 'v')
  readonly reason: string;
  /** True only when action === 'upgrade'. */
  readonly proceed: boolean;
}

export interface UpgradeInput {
  /** Durable installed platform version (CalVer). */
  readonly installed: string;
  /** Cosign-verified available version (CalVer) or null. */
  readonly available: string | null;
  /** Whether auto-update is enabled (production policy; default OFF). */
  readonly autoUpdate: boolean;
  /** Whether the available release is flagged BREAKING (### BREAKING in CHANGELOG). */
  readonly breaking: boolean;
  /** Operator-requested explicit target (manual mode); overrides `available`. */
  readonly requestedVersion?: string;
  /** 'manual' = operator-driven (CLI / UI button); 'auto' = the reconciler. */
  readonly mode: 'manual' | 'auto';
}

function decide(action: UpgradeAction, target: string | null, reason: string): UpgradeDecision {
  return { action, target, reason, proceed: action === 'upgrade' };
}

export function planUpgrade(input: UpgradeInput): UpgradeDecision {
  const installedOk = isValidVersion(input.installed);

  if (input.mode === 'manual') {
    const target = input.requestedVersion ?? input.available ?? null;
    if (!target) return decide('blocked-no-candidate', null, 'no version requested and none available');
    if (!isValidVersion(target)) return decide('blocked-bad-version', null, `requested version ${JSON.stringify(target)} is not a valid version`);
    // A manual upgrade must still move forward (no downgrade / no-op via this path).
    if (installedOk && !isNewerVersion(target, input.installed)) {
      return decide('blocked-not-newer', target, `requested ${target} is not newer than installed ${input.installed}`);
    }
    const note = input.breaking && input.available === target ? ' (BREAKING — operator override)' : '';
    return decide('upgrade', target, `manual upgrade ${input.installed} → ${target}${note}`);
  }

  // mode === 'auto' (the reconciler)
  if (!input.autoUpdate) return decide('blocked-auto-off', null, 'auto-update is disabled');
  if (!input.available) return decide('blocked-no-candidate', null, 'no verified available version');
  if (!isValidVersion(input.available)) return decide('blocked-bad-version', null, `available ${JSON.stringify(input.available)} is not a valid version`);
  // The auto path must NEVER re-pin blindly: if installed is unparseable (fresh
  // boot before persistInstalledVersion, or PLATFORM_VERSION unset) we can't
  // prove the candidate is an upgrade — hold, require a manual decision.
  if (!installedOk) {
    return decide('blocked-installed-unknown', input.available, `installed version ${JSON.stringify(input.installed)} is unknown — auto-upgrade held; apply manually`);
  }
  if (!isNewerVersion(input.available, input.installed)) {
    return decide('none', input.available, `already current (installed ${input.installed} ≥ available ${input.available})`);
  }
  if (input.breaking) {
    return decide('blocked-breaking', input.available, `available ${input.available} is a BREAKING release — auto-update short-circuited; apply manually`);
  }
  return decide('upgrade', input.available, `auto upgrade ${input.installed} → ${input.available}`);
}
