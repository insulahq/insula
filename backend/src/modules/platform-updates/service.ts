import { eq } from 'drizzle-orm';
import type { PlatformVersionResponse } from '@insula/api-contracts';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { parseResourceValue } from '../../shared/resource-parser.js';

// GitHub Releases API for the upstream repo — no auth required for
// public repos and matches what release.yml publishes on `v*.*.*`
// tags. We previously hit GHCR's tags/list which requires auth for
// public images and always returned 401.
const RELEASES_API = 'https://api.github.com/repos/insulahq/insula/releases/latest';
// Fallback when no releases are published yet (fresh repos). Lists all
// tags; we pick the newest valid semver. Keeps the UI from showing a
// permanent "—" just because release.yml hasn't been cut yet.
const TAGS_API = 'https://api.github.com/repos/insulahq/insula/tags?per_page=20';
const FETCH_OPTS = {
  signal: AbortSignal.timeout(10_000),
  headers: { 'Accept': 'application/vnd.github+json' } as const,
} as const;

type LatestSource = 'releases' | 'tags' | 'none' | 'unreachable';
// PLATFORM_VERSION is injected into the Deployment from the platform-
// version ConfigMap. Before that landed the default was a stale '0.1.0'
// which made the UI always show that regardless of reality; 'unknown'
// is now an explicit sentinel so the UI can distinguish "no version
// wired up" from "really running 0.1.0".
// .trim() because the value is injected from the platform-version ConfigMap
// and Kubernetes ConfigMap values commonly carry a trailing newline.
const CURRENT_VERSION = (process.env.PLATFORM_VERSION?.replace(/^v/, '') ?? 'unknown').trim();
const ENVIRONMENT = process.env.PLATFORM_ENV ?? 'production';

// A "real" platform version is valid SemVer MAJOR.MINOR.PATCH with NO
// leading-zero segments — CalVer `2026.6.1` qualifies (ADR-045 Decision 6),
// `2026.06.1` does not — optionally with a `-<sha>` development suffix. Fully
// anchored so a corrupted env (whitespace, four-part, leading-zero month) is
// rejected before it can pollute the durable installed_platform_version.
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.]+)?$/;

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db.insert(platformSettings).values({ key, value }).onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

/**
 * Record the running pod's version as the durable "installed" version.
 *
 * The version spine (ADR-045) makes `platform_settings.installed_platform_version`
 * the source of truth for "what release is this cluster on" — read by upgrade
 * pre-flight/gating independently of which image is currently up. The running
 * pod (its PLATFORM_VERSION env, injected from the `platform-version` ConfigMap)
 * is authoritative, so every startup persists it. No-op until the version is
 * actually wired (`unknown`), so a misconfigured deploy never writes garbage.
 *
 * @returns the persisted version, or null if the running version isn't wired.
 */
export async function persistInstalledVersion(db: Database): Promise<string | null> {
  if (!VERSION_RE.test(CURRENT_VERSION)) return null;
  await setSetting(db, 'installed_platform_version', CURRENT_VERSION);
  return CURRENT_VERSION;
}

async function resolveLatestVersion(): Promise<{ version: string | null; source: LatestSource }> {
  // Try releases first — preferred because release.yml publishes pinned,
  // promoted versions (not every green main build).
  try {
    const resp = await fetch(RELEASES_API, FETCH_OPTS);
    if (resp.ok) {
      const data = await resp.json() as { tag_name?: string };
      const tag = (data.tag_name ?? '').replace(/^v/, '');
      if (/^\d+\.\d+\.\d+$/.test(tag)) return { version: tag, source: 'releases' };
    } else if (resp.status !== 404) {
      // 404 is expected on repos without a published release — fall
      // through to tags. Any other non-2xx (rate limit, 5xx) is a
      // connectivity issue, bail to 'unreachable'.
      return { version: null, source: 'unreachable' };
    }
  } catch {
    return { version: null, source: 'unreachable' };
  }

  // Fallback: inspect tags. Useful on fresh repos that haven't cut a
  // GitHub release yet but have started tagging (e.g., v0.1.0).
  try {
    const resp = await fetch(TAGS_API, FETCH_OPTS);
    if (resp.ok) {
      const tags = await resp.json() as Array<{ name?: string }>;
      const semvers = tags
        .map(t => (t.name ?? '').replace(/^v/, ''))
        .filter(n => /^\d+\.\d+\.\d+$/.test(n))
        .sort((a, b) => isNewer(b, a) ? 1 : isNewer(a, b) ? -1 : 0);
      if (semvers.length > 0) return { version: semvers[0], source: 'tags' };
    }
  } catch {
    // Ignore — fall through to 'none'.
  }

  return { version: null, source: 'none' };
}

export async function getVersionInfo(db: Database): Promise<PlatformVersionResponse> {
  const autoUpdate = (await getSetting(db, 'auto_update')) === 'true';
  const lastCheckedAt = await getSetting(db, 'last_update_check');
  let latestVersion = await getSetting(db, 'latest_version');
  let latestSource: LatestSource = (await getSetting(db, 'latest_source')) as LatestSource | null ?? 'none';

  // Re-check upstream at most every 5 minutes
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const lastCheck = lastCheckedAt ? new Date(lastCheckedAt).getTime() : 0;

  if (lastCheck < fiveMinutesAgo) {
    const resolved = await resolveLatestVersion();
    // Only overwrite the cache on a definitive result; 'unreachable'
    // preserves the last-known-good value instead of regressing the UI.
    if (resolved.source !== 'unreachable') {
      latestVersion = resolved.version;
      latestSource = resolved.source;
      await setSetting(db, 'latest_source', resolved.source);
      if (resolved.version) await setSetting(db, 'latest_version', resolved.version);
    }
    await setSetting(db, 'last_update_check', new Date().toISOString());
  }

  // The cosign-VERIFIED available version (W11 poller) is authoritative for the
  // spine + upgrade gating. Fall back to the lazy, UNVERIFIED latest_version only
  // when nothing has been verified yet — so dev/staging (often unsigned) still
  // show an available version, while production upgrade-gating (W13) consumes the
  // verified value. availableVerifyStatus surfaces WHY there's no verified value
  // (e.g. 'unsigned', 'verify-failed') so the UI can warn instead of silently
  // showing the unverified fallback.
  const verifiedAvailable = await getSetting(db, 'available_version');
  const availableVerifiedAt = await getSetting(db, 'available_verified_at');
  const availableVerifyStatus = await getSetting(db, 'available_verify_status');
  const includePrereleases = (await getSetting(db, 'auto_update_include_prereleases')) === 'true';
  const available = verifiedAvailable && VERSION_RE.test(verifiedAvailable) ? verifiedAvailable : latestVersion;

  // "unknown" currentVersion means PLATFORM_VERSION isn't wired up —
  // we can't compare semver, so never claim an update is available.
  const canCompare = VERSION_RE.test(CURRENT_VERSION);
  const updateAvailable = canCompare && available !== null && available !== CURRENT_VERSION && isNewer(available, CURRENT_VERSION);

  const imageUpdateStrategy = ENVIRONMENT === 'production' ? 'manual' as const : 'auto' as const;
  const pendingVersion = await getSetting(db, 'pending_update_version');

  // Version spine (ADR-045): three coordinates the admin UI / upgrade flow read.
  //   installed — durable DB record of the release the cluster is on
  //   running   — the live pod's version (ConfigMap → PLATFORM_VERSION env)
  //   available — newest upstream release the poller has seen
  // installed falls back to running until persistInstalledVersion() has run.
  // Re-validate the DB value on read so a hand-edited / restored-from-backup
  // platform_settings row can never escape an unvalidated string through the
  // API (the field feeds future upgrade gating). Mirrors `running`'s 'unknown'
  // sentinel when nothing is wired.
  const rawInstalled = await getSetting(db, 'installed_platform_version');
  const installed = rawInstalled && VERSION_RE.test(rawInstalled) ? rawInstalled : CURRENT_VERSION;

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    latestSource,
    updateAvailable,
    environment: ENVIRONMENT,
    autoUpdate,
    imageUpdateStrategy,
    pendingVersion,
    lastCheckedAt: lastCheckedAt ?? null,
    installed,
    running: CURRENT_VERSION,
    available,
    // W11 verified-poller surfaces:
    availableVerifiedAt: availableVerifiedAt ?? null,
    availableVerifyStatus: availableVerifyStatus ?? null,
    includePrereleases,
  };
}

function isNewer(latest: string, current: string): boolean {
  // Strip any pre-release suffix (0.0.0-<sha>) before comparing so CI-
  // derived currentVersions compare cleanly against pure-semver tags.
  const parse = (v: string) => v.split('-')[0].split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

export async function updateSettings(db: Database, autoUpdate: boolean, includePrereleases?: boolean): Promise<{ autoUpdate: boolean; includePrereleases: boolean }> {
  await setSetting(db, 'auto_update', String(autoUpdate));
  if (includePrereleases !== undefined) {
    await setSetting(db, 'auto_update_include_prereleases', String(includePrereleases));
  }
  const effectivePrereleases = (await getSetting(db, 'auto_update_include_prereleases')) === 'true';
  return { autoUpdate, includePrereleases: effectivePrereleases };
}

// ─── Capacity Check ─────────────────────────────────────────────────────────


interface CapacityCheckResult {
  readonly totalCpu: number;
  readonly totalMemory: number;
  readonly totalStorage: number;
  readonly allocatedCpu: number;
  readonly allocatedMemory: number;
  readonly allocatedStorage: number;
  readonly requestedCpu: number;
  readonly requestedMemory: number;
  readonly requestedStorage: number;
  readonly fits: boolean;
  readonly warnings: readonly string[];
}

export async function getCapacityCheck(
  db: Database,
  appMinCpu: string,
  appMinMemory: string,
  appMinStorage: string,
): Promise<CapacityCheckResult> {
  // Read total node capacity from platform_settings (defaults for CX32)
  const cpuTotal = parseResourceValue(
    (await getSetting(db, 'node_cpu_total')) ?? '4',
    'cpu',
  );
  const memoryTotal = parseResourceValue(
    (await getSetting(db, 'node_memory_total')) ?? '8Gi',
    'memory',
  );
  const storageTotal = parseResourceValue(
    (await getSetting(db, 'node_storage_total')) ?? '80Gi',
    'storage',
  );

  // Sum allocated resources from running application instances
  // For Phase 1, since we don't have real instances yet, allocated is 0
  const allocatedCpu = 0;
  const allocatedMemory = 0;
  const allocatedStorage = 0;

  const requestedCpu = parseResourceValue(appMinCpu, 'cpu');
  const requestedMemory = parseResourceValue(appMinMemory, 'memory');
  const requestedStorage = parseResourceValue(appMinStorage, 'storage');

  const availableCpu = cpuTotal - allocatedCpu;
  const availableMemory = memoryTotal - allocatedMemory;
  const availableStorage = storageTotal - allocatedStorage;

  const warnings: string[] = [];
  let fits = true;

  if (requestedCpu > availableCpu) {
    fits = false;
    warnings.push(
      `This application requires ${requestedCpu.toFixed(2)} CPU but only ${availableCpu.toFixed(2)} CPU is available`,
    );
  } else if ((allocatedCpu + requestedCpu) / cpuTotal >= 0.95) {
    warnings.push(
      `Installing this application would use ${(((allocatedCpu + requestedCpu) / cpuTotal) * 100).toFixed(0)}% of total CPU`,
    );
  }

  if (requestedMemory > availableMemory) {
    fits = false;
    warnings.push(
      `This application requires ${requestedMemory.toFixed(2)}Gi memory but only ${availableMemory.toFixed(2)}Gi is available`,
    );
  } else if ((allocatedMemory + requestedMemory) / memoryTotal >= 0.95) {
    warnings.push(
      `Installing this application would use ${(((allocatedMemory + requestedMemory) / memoryTotal) * 100).toFixed(0)}% of total memory`,
    );
  }

  if (requestedStorage > availableStorage) {
    fits = false;
    warnings.push(
      `This application requires ${requestedStorage.toFixed(2)}Gi storage but only ${availableStorage.toFixed(2)}Gi is available`,
    );
  } else if ((allocatedStorage + requestedStorage) / storageTotal >= 0.95) {
    warnings.push(
      `Installing this application would use ${(((allocatedStorage + requestedStorage) / storageTotal) * 100).toFixed(0)}% of total storage`,
    );
  }

  return {
    totalCpu: cpuTotal,
    totalMemory: memoryTotal,
    totalStorage: storageTotal,
    allocatedCpu,
    allocatedMemory,
    allocatedStorage,
    requestedCpu,
    requestedMemory,
    requestedStorage,
    fits,
    warnings,
  };
}

export async function triggerUpdate(db: Database) {
  if (ENVIRONMENT !== 'production') {
    return { message: 'Auto-update environment — updates are deployed automatically via Flux', targetVersion: CURRENT_VERSION };
  }

  const info = await getVersionInfo(db);
  if (!info.updateAvailable || !info.latestVersion) {
    return { message: 'Already up to date', targetVersion: info.currentVersion };
  }

  // Record the target version. A CronJob (`platform-update-checker`)
  // periodically reads `pending_update_version` from the database and
  // triggers `flux reconcile kustomization platform` when set.
  await setSetting(db, 'pending_update_version', info.latestVersion);
  return { message: 'Update initiated — will be applied on next reconciliation cycle', targetVersion: info.latestVersion };
}
