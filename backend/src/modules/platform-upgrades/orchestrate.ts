/**
 * Upgrade orchestration (ADR-045 W13) — ties the version spine (DB settings) +
 * the pure decision (planUpgrade) + the Flux re-pin (repinGitRepositoryTag) into
 * one `runUpgrade` used by BOTH the backend route and host-side `platform-ops
 * upgrade`. DRY-RUN unless `apply` is set; the re-pin is a single atomic patch.
 *
 * Per the PR-18 spike: dev/staging auto-follow a branch (so the AUTO path no-ops
 * there); the tag re-pin is meaningful on a tag-tracking production source.
 */
import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { planUpgrade, type UpgradeDecision } from './upgrade-planner.js';
import { gitTagForVersion, repinGitRepositoryTag, resolveUpgradeGitRepository, type RepinResult } from './flux-repin.js';

const CURRENT_VERSION = (process.env.PLATFORM_VERSION?.replace(/^v/, '') ?? 'unknown').trim();
const ENVIRONMENT = process.env.PLATFORM_ENV ?? 'production';

/** Key-value seam over platform_settings — keeps runUpgrade testable + DB-agnostic. */
export interface SettingsIO {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
}

/** Real platform_settings-backed SettingsIO. */
export function dbSettings(db: Database): SettingsIO {
  return {
    get: async (key) => {
      const rows = await db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
      return rows[0]?.value ?? null;
    },
    set: async (key, value) => {
      await db
        .insert(platformSettings)
        .values({ key, value })
        .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
    },
  };
}

export interface RunUpgradeOpts {
  readonly mode: 'manual' | 'auto';
  readonly requestedVersion?: string;
  /** false = dry-run plan only (default); true = actually re-pin. */
  readonly apply: boolean;
}

export interface RunUpgradeResult {
  readonly decision: UpgradeDecision;
  readonly environment: string;
  readonly gitRepository: string | null;
  readonly applied: boolean;
  readonly repin?: RepinResult;
  /** A human-facing summary line. */
  readonly summary: string;
}

export async function runUpgrade(settings: SettingsIO, k8s: K8sClients, opts: RunUpgradeOpts): Promise<RunUpgradeResult> {
  const rawInstalled = await settings.get('installed_platform_version');
  const installed = rawInstalled ?? CURRENT_VERSION;
  const available = await settings.get('available_version');
  const autoUpdate = (await settings.get('auto_update')) === 'true';
  const breaking = (await settings.get('available_breaking')) === 'true';

  const decision = planUpgrade({
    installed,
    available,
    autoUpdate,
    breaking,
    requestedVersion: opts.requestedVersion,
    mode: opts.mode,
  });

  if (!decision.proceed) {
    return { decision, environment: ENVIRONMENT, gitRepository: null, applied: false, summary: `no-op: ${decision.reason}` };
  }
  if (!opts.apply) {
    const gitRepository = await resolveUpgradeGitRepository(k8s);
    return {
      decision,
      environment: ENVIRONMENT,
      gitRepository,
      applied: false,
      summary: `DRY-RUN: would re-pin ${gitRepository ?? '<no GitRepository found>'} → ${gitTagForVersion(decision.target!) ?? '<bad tag>'} (${decision.reason})`,
    };
  }

  // apply: resolve the source the platform Kustomization tracks, then re-pin it.
  const gitRepository = await resolveUpgradeGitRepository(k8s);
  if (!gitRepository) {
    return { decision, environment: ENVIRONMENT, gitRepository: null, applied: false, summary: 'could not resolve the platform Flux GitRepository (is this a Flux-managed cluster?)' };
  }
  const tag = gitTagForVersion(decision.target!);
  if (!tag) {
    return { decision, environment: ENVIRONMENT, gitRepository, applied: false, summary: `target ${decision.target} has no clean release tag` };
  }
  const repin = await repinGitRepositoryTag(k8s, gitRepository, tag);
  if (repin.ok) {
    // Record the in-flight target so the UI/poller can show "upgrading → X".
    await settings.set('pending_update_version', decision.target!);
  }
  return {
    decision,
    environment: ENVIRONMENT,
    gitRepository,
    applied: repin.ok,
    repin,
    summary: repin.ok
      ? `re-pinned ${gitRepository} → ${tag} — Flux is reconciling ${installed} → ${decision.target}`
      : `re-pin failed: ${repin.reason ?? 'unknown'}`,
  };
}
