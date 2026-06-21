/**
 * k3s upgrade Plan generator (ADR-045 W12) — pure, no I/O.
 *
 * Builds the system-upgrade-controller (SUC) Plan CRs that drive a no-SSH,
 * in-cluster k3s node upgrade: a `k3s-server-upgrade` Plan (control-plane,
 * serial, cordon) and a `k3s-agent-upgrade` Plan (workers, serial, cordon +
 * drain, prepared to wait for the server Plan). Modeled on the canonical k3s SUC
 * example.
 *
 * SAFETY: refuses to generate a Plan that skips a Kubernetes minor (locked
 * decision #8 — k3s, like upstream k8s, forbids skip-a-minor), downgrades, or
 * crosses a major. The caller (`platform-ops cluster upgrade`) defaults to a
 * dry-run print; an explicit `--apply` is required to create the CRs, and SUC
 * only then spawns the (privileged) per-node upgrade Jobs.
 */

export interface K3sVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly k3s: number; // the +k3sN suffix
  readonly raw: string;
}

/** Parse a k3s version like `v1.31.5+k3s1` (the leading `v` is optional). */
export function parseK3sVersion(raw: string): K3sVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)\+k3s(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    k3s: Number(m[4]),
    raw: raw.trim(),
  };
}

/** True if `b` is strictly newer than `a` (minor → patch → k3s suffix). */
function isNewer(a: K3sVersion, b: K3sVersion): boolean {
  if (b.minor !== a.minor) return b.minor > a.minor;
  if (b.patch !== a.patch) return b.patch > a.patch;
  return b.k3s > a.k3s;
}

/**
 * True if `version` is at least `atLeast` (major → minor → patch → k3s suffix).
 * Returns false if either string is unparseable. Used to detect when a node has
 * reached a target during a rollout wait.
 */
export function k3sVersionAtLeast(version: string, atLeast: string): boolean {
  const v = parseK3sVersion(version);
  const a = parseK3sVersion(atLeast);
  if (!v || !a) return false;
  if (v.major !== a.major) return v.major > a.major;
  if (v.minor !== a.minor) return v.minor > a.minor;
  if (v.patch !== a.patch) return v.patch > a.patch;
  return v.k3s >= a.k3s;
}

export type PlanGenResult =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly target: string; readonly plans: readonly Record<string, unknown>[] };

/** One minor hop on the way from current → target. `isFinal` carries the exact requested target. */
export interface UpgradeStep {
  readonly major: number;
  readonly minor: number;
  readonly isFinal: boolean;
}

export type UpgradePathResult =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly steps: readonly UpgradeStep[] };

/**
 * Plan the ordered, single-minor steps to get from `current` → `target`.
 *
 * k3s (like upstream k8s) forbids skipping a minor, so a multi-minor target is
 * SPLIT into N serial hops — `[current.minor+1, … , target.minor]` — each of
 * which the caller resolves to a concrete patch and feeds to `buildK3sUpgradePlans`
 * (which re-validates the single-minor invariant per hop, defence in depth). A
 * same-minor patch bump yields a single final step. Refuses cross-major /
 * downgrade / no-op up front (the per-hop generator refuses them again).
 *
 * This is the implemented half of ADR-045 decision 21 ("pre-flight splits a
 * multi-hop k3s upgrade into N serial SUC Plans") — pure, no I/O.
 */
export function planK3sUpgradePath(target: string, current: string): UpgradePathResult {
  const t = parseK3sVersion(target);
  if (!t) return { ok: false, reason: `target version ${JSON.stringify(target)} is not a valid k3s version (want vX.Y.Z+k3sN)` };
  const c = parseK3sVersion(current);
  if (!c) return { ok: false, reason: `current cluster version ${JSON.stringify(current)} is not a valid k3s version (want vX.Y.Z+k3sN)` };

  if (t.major !== c.major) return { ok: false, reason: `refusing cross-major upgrade ${c.raw} → ${t.raw}` };
  if (t.minor < c.minor || (t.minor === c.minor && !isNewer(c, t))) {
    return { ok: false, reason: `refusing downgrade / no-op ${c.raw} → ${t.raw}` };
  }

  const steps: UpgradeStep[] = [];
  for (let m = c.minor + 1; m < t.minor; m++) {
    steps.push({ major: t.major, minor: m, isFinal: false });
  }
  steps.push({ major: t.major, minor: t.minor, isFinal: true });
  return { ok: true, steps };
}

const SUC_NAMESPACE = 'system-upgrade';
const UPGRADE_IMAGE = 'rancher/k3s-upgrade';

/**
 * A container image reference goes verbatim into `spec.upgrade.image` of a Plan
 * that SUC runs as a PRIVILEGED Job on every node — so a `--upgrade-image`
 * override must be a syntactically valid ref (registry/repo[:tag][@digest]) and
 * carry no shell metacharacters / whitespace. (Defense-in-depth: platform-ops is
 * already root-on-node, but this stops a wrapper/automation from smuggling an
 * arbitrary image through an interpolated argument.)
 */
export function imageRefValid(ref: string): boolean {
  if (ref.length === 0 || ref.length > 512) return false;
  return /^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/.test(ref);
}

export interface BuildPlanOpts {
  /** Override the upgrade image (e.g. a mirrored/pinned ref). */
  readonly upgradeImage?: string;
  /** Drain grace for agents (seconds). */
  readonly drainDeleteTimeout?: number;
}

/**
 * Build the server + agent k3s upgrade Plans for `target`, validated against the
 * cluster's current minimum version `current`. Returns `{ ok: false, reason }`
 * for any unsafe transition (skip-a-minor, downgrade, cross-major, no-op, bad
 * version string).
 */
export function buildK3sUpgradePlans(target: string, current: string, opts: BuildPlanOpts = {}): PlanGenResult {
  const t = parseK3sVersion(target);
  if (!t) return { ok: false, reason: `target version ${JSON.stringify(target)} is not a valid k3s version (want vX.Y.Z+k3sN)` };
  const c = parseK3sVersion(current);
  if (!c) return { ok: false, reason: `current cluster version ${JSON.stringify(current)} is not a valid k3s version (want vX.Y.Z+k3sN)` };

  if (t.major !== c.major) return { ok: false, reason: `refusing cross-major upgrade ${c.raw} → ${t.raw}` };
  if (t.minor < c.minor || (t.minor === c.minor && !isNewer(c, t))) {
    return { ok: false, reason: `refusing downgrade / no-op ${c.raw} → ${t.raw}` };
  }
  if (t.minor > c.minor + 1) {
    // Locked decision #8: k3s/k8s forbid skipping a minor — step one minor at a time.
    return { ok: false, reason: `refusing skip-a-minor upgrade ${c.raw} (${c.major}.${c.minor}) → ${t.raw} (${t.major}.${t.minor}); upgrade one minor at a time` };
  }

  if (opts.upgradeImage !== undefined && !imageRefValid(opts.upgradeImage)) {
    return { ok: false, reason: `refusing invalid --upgrade-image ${JSON.stringify(opts.upgradeImage)} (must be a valid image ref, no shell metacharacters)` };
  }
  const image = opts.upgradeImage ?? UPGRADE_IMAGE;
  const version = t.raw.startsWith('v') ? t.raw : `v${t.raw}`;
  const labels = { 'app.kubernetes.io/part-of': 'hosting-platform', 'insula.host/managed-by': 'platform-ops' };

  const server: Record<string, unknown> = {
    apiVersion: 'upgrade.cattle.io/v1',
    kind: 'Plan',
    metadata: { name: 'k3s-server-upgrade', namespace: SUC_NAMESPACE, labels },
    spec: {
      concurrency: 1,
      cordon: true,
      nodeSelector: {
        matchExpressions: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'In', values: ['true'] }],
      },
      serviceAccountName: 'system-upgrade',
      upgrade: { image },
      version,
    },
  };

  const agent: Record<string, unknown> = {
    apiVersion: 'upgrade.cattle.io/v1',
    kind: 'Plan',
    metadata: { name: 'k3s-agent-upgrade', namespace: SUC_NAMESPACE, labels },
    spec: {
      concurrency: 1,
      cordon: true,
      // Agents drain (workloads relocate); servers don't (control-plane stays put).
      drain: { force: true, skipWaitForDeleteTimeout: opts.drainDeleteTimeout ?? 60 },
      nodeSelector: {
        matchExpressions: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'DoesNotExist' }],
      },
      // Wait for ALL servers to finish before any agent starts (k3s requirement).
      prepare: { image, args: ['prepare', 'k3s-server-upgrade'] },
      serviceAccountName: 'system-upgrade',
      upgrade: { image },
      version,
    },
  };

  return { ok: true, target: version, plans: [server, agent] };
}
