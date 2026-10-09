/**
 * ADR-064 §7 — automatic updates. The toggle used to be stored and read by
 * nothing; this makes it act, through the same run and pre-flight an operator
 * uses, and only when every condition holds:
 *
 *   on · a newer verified STABLE release · not BREAKING · no run in flight ·
 *   inside the operator's maintenance window · pre-flight passes
 *
 * Anything else is a reason, recorded as the status the Updates page shows. A
 * failing gate skips this window and notifies once; nothing is ever forced.
 */
import type { AutoUpdateStatus, MaintenanceWindow } from '@insula/api-contracts';
import { autoUpdateStatusSchema, maintenanceWindowSchema } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { dbSettings } from './orchestrate.js';
import { planUpgrade, type UpgradeDecision } from './upgrade-planner.js';
import { describeWindow, insideWindow } from './maintenance-window.js';
import type { PreflightResult } from './preflight.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { plainText } from '../../shared/plain-text.js';

export const AUTO_UPDATE_STATUS_KEY = 'auto_update_status';
export const MAINTENANCE_WINDOW_KEY = 'auto_update_window';
export const AUTO_UPDATE_TICK_MS = 5 * 60 * 1000;

export interface AutoUpdateDeps {
  readonly now: () => Date;
  readonly decide: () => Promise<UpgradeDecision>;
  readonly window: () => Promise<MaintenanceWindow | null>;
  readonly runInFlight: () => Promise<boolean>;
  readonly preflight: () => Promise<PreflightResult>;
  /** Start the run (mode 'auto'). Returns why not, when it did not start. */
  readonly start: (target: string) => Promise<{ readonly started: boolean; readonly message: string }>;
  /** Notify the admins; `key` deduplicates (same key → one notice). */
  readonly notify: (key: string, detail: string, items: readonly string[]) => Promise<void>;
  readonly saveStatus: (s: AutoUpdateStatus) => Promise<void>;
}

/** One pass. Pure over `deps`; returns the status it recorded. */
export async function autoUpdateTick(deps: AutoUpdateDeps): Promise<AutoUpdateStatus> {
  const checkedAt = deps.now().toISOString();
  const save = async (state: AutoUpdateStatus['state'], detail: string, target: string | null) => {
    const s: AutoUpdateStatus = { state, detail, target, checkedAt };
    await deps.saveStatus(s);
    return s;
  };

  const d = await deps.decide();
  if (d.action === 'blocked-auto-off') return save('off', 'Automatic updates are off.', null);
  if (d.action === 'none' || d.action === 'blocked-no-candidate') return save('current', 'Up to date.', d.target);
  if (!d.proceed) {
    if (d.action === 'blocked-breaking' && d.target) {
      await deps.notify(`auto-update:${d.target}:breaking`, `Automatic updates will not apply ${d.target}: it is a BREAKING release. Read its notes and apply it by hand.`, []);
    }
    return save('held', d.reason, d.target);
  }
  const target = d.target as string;

  if (await deps.runInFlight()) return save('running', 'An upgrade is already running.', target);

  const w = await deps.window();
  if (!w) return save('held', `${target} is available — set a maintenance window for automatic updates to apply it.`, target);
  if (!insideWindow(w, deps.now())) return save('waiting-window', `${target} applies in the next maintenance window: ${describeWindow(w)}.`, target);

  const pf = await deps.preflight();
  if (!pf.ok) {
    const failing = pf.gates.filter((g) => g.status === 'fail');
    await deps.notify(
      `auto-update:${target}:preflight:${failing.map((g) => g.id).sort().join(',')}`,
      `Automatic update to ${target} skipped this maintenance window: pre-flight has ${failing.length} blocking failure(s).`,
      failing.map((g) => plainText(`${g.label}: ${g.detail}`)),
    );
    return save('blocked', `Skipped this window — pre-flight: ${failing.map((g) => g.label).join('; ')}.`, target);
  }

  const r = await deps.start(target);
  if (!r.started) {
    await deps.notify(`auto-update:${target}:start`, `Automatic update to ${target} could not start: ${r.message}`, []);
    return save('blocked', r.message, target);
  }
  await deps.notify(`auto-update:${target}:started`, `Automatic update to ${target} started inside the maintenance window (${describeWindow(w)}).`, []);
  return save('started', `Started the upgrade to ${target}.`, target);
}

/**
 * ADR-064 §9 — a cluster on a release channel (Flux follows the newest tag in a
 * semver range: staging) rolls the services the moment a tag is published, before
 * any run exists. When that happened and nodes lag the release, start a run for
 * it: the nodes take the release promptly, in order, with the same per-node view
 * ("services first" — the one exception to hosts first). Independent of the
 * automatic-updates toggle and the window: the services already changed.
 */
export interface CatchUpDeps {
  readonly followsChannel: () => Promise<boolean>;
  readonly installed: () => Promise<string | null>;
  readonly runInFlight: () => Promise<boolean>;
  /** The latest run's target, if any — one catch-up per version, never a loop. */
  readonly latestRunTarget: () => Promise<string | null>;
  /** Reporting nodes whose CLI is behind `version`; and the ones not Ready (left out). */
  readonly nodesBehind: (version: string) => Promise<{ readonly behind: readonly string[]; readonly notReady: readonly string[] }>;
  readonly start: (version: string, excluded: readonly string[]) => Promise<{ readonly started: boolean; readonly message: string }>;
  /** The same pre-flight every other start runs, judged without the nodes left out. */
  readonly preflight: (excluded: readonly string[]) => Promise<PreflightResult>;
  readonly notify: (key: string, detail: string, items: readonly string[]) => Promise<void>;
}

export async function channelCatchUpTick(deps: CatchUpDeps): Promise<string | null> {
  if (!(await deps.followsChannel())) return null;
  const version = await deps.installed();
  if (!version || (await deps.runInFlight())) return null;
  if ((await deps.latestRunTarget()) === version) return null;
  const { behind, notReady } = await deps.nodesBehind(version);
  const toUpdate = behind.filter((n) => !notReady.includes(n));
  if (toUpdate.length === 0) return null;
  // Every start passes the pre-flight — this one included.
  const pf = await deps.preflight(notReady);
  if (!pf.ok) {
    const failing = pf.gates.filter((g) => g.status === 'fail');
    await deps.notify(
      `channel-catch-up:${version}:preflight:${failing.map((g) => g.id).sort().join(',')}`,
      `The nodes did not start catching up with ${version}: pre-flight has ${failing.length} blocking failure(s). They update on their own hourly check meanwhile.`,
      failing.map((g) => plainText(`${g.label}: ${g.detail}`)),
    );
    return null;
  }
  const r = await deps.start(version, notReady);
  return r.started ? `Nodes catch up with ${version}, which the release channel already rolled out.` : null;
}

export function realCatchUpDeps(db: Database, k8s: K8sClients): CatchUpDeps {
  const settings = dbSettings(db);
  return {
    followsChannel: async () => {
      const { resolveUpgradeGitRepository, readGitRepositoryRef } = await import('./flux-repin.js');
      const name = await resolveUpgradeGitRepository(k8s);
      const ref = name ? await readGitRepositoryRef(k8s, name) : null;
      return !!ref?.semver;
    },
    installed: async () => (await settings.get('installed_platform_version'))?.trim() || null,
    runInFlight: async () => {
      const { getActiveRun } = await import('./run/store.js');
      return (await getActiveRun(db)) !== null || !!(await settings.get('pending_update_version'))?.trim();
    },
    latestRunTarget: async () => {
      const { listRuns } = await import('./run/store.js');
      return (await listRuns(db, 1))[0]?.toVersion ?? null;
    },
    nodesBehind: async (version) => {
      const [{ readHostMigrationStatus }, { listNodeFacts }] = await Promise.all([
        import('./host-migration-status.js'), import('./run/k8s.js'),
      ]);
      const [status, nodes] = await Promise.all([readHostMigrationStatus(k8s, version), listNodeFacts(k8s)]);
      return {
        behind: status.nodes.filter((n) => n.cliBehind === true).map((n) => n.node),
        notReady: nodes.filter((n) => !n.ready).map((n) => n.name),
      };
    },
    preflight: (excluded) => preflightFor(db, k8s, excluded),
    notify: (key, detail, items) => notifyAdmins(db, 'Platform upgrade', key, detail, items),
    start: async (version, excluded) => {
      const { startRunWithTask } = await import('./run/real.js');
      try {
        const run = await startRunWithTask(db, k8s, { fromVersion: null, toVersion: version, mode: 'auto', excludedNodes: [...excluded], initiatedBy: null });
        return run.status === 'running' ? { started: true, message: '' } : { started: false, message: run.message ?? '' };
      } catch (err) {
        return { started: false, message: (err as Error).message };
      }
    },
  };
}

async function preflightFor(db: Database, k8s: K8sClients, excluded: readonly string[]): Promise<PreflightResult> {
  const [{ collectPreflightFacts }, { evaluatePreflight }] = await Promise.all([
    import('./collect-preflight.js'), import('./preflight.js'),
  ]);
  return evaluatePreflight(await collectPreflightFacts(db, k8s, Date.now(), excluded));
}

/** One admin notice; `key` deduplicates, so a 5-minute tick never repeats it. */
async function notifyAdmins(db: Database, subsystem: string, key: string, detail: string, items: readonly string[]): Promise<void> {
  const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
  await notifyAdminOperationalEvent(db, 'platform', {
    subsystem,
    objectLabel: 'platform',
    detail,
    items: [...items],
    severityLabel: 'upgrade',
    recommendedAction: 'See Platform → Updates.',
  }, key).catch(() => { /* a notice must never break the tick */ });
}

export function parseWindow(raw: string | null): MaintenanceWindow | null {
  if (!raw) return null;
  try {
    const r = maintenanceWindowSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function parseStatus(raw: string | null): AutoUpdateStatus | null {
  if (!raw) return null;
  try {
    const r = autoUpdateStatusSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function realAutoUpdateDeps(db: Database, k8s: K8sClients): AutoUpdateDeps {
  const settings = dbSettings(db);
  return {
    now: () => new Date(),
    decide: async () => planUpgrade({
      installed: (await settings.get('installed_platform_version')) ?? '',
      available: await settings.get('available_version'),
      autoUpdate: (await settings.get('auto_update')) === 'true',
      breaking: (await settings.get('available_breaking')) === 'true',
      mode: 'auto',
    }),
    window: async () => parseWindow(await settings.get(MAINTENANCE_WINDOW_KEY)),
    runInFlight: async () => {
      const { getActiveRun } = await import('./run/store.js');
      return (await getActiveRun(db)) !== null || !!(await settings.get('pending_update_version'))?.trim();
    },
    preflight: () => preflightFor(db, k8s, []),
    start: async (target) => {
      const { startAutoRun } = await import('./run/real.js');
      return startAutoRun(db, k8s, target);
    },
    notify: (key, detail, items) => notifyAdmins(db, 'Automatic updates', key, detail, items),
    saveStatus: (s) => settings.set(AUTO_UPDATE_STATUS_KEY, JSON.stringify(s)),
  };
}

export function startAutoUpdateScheduler(db: Database, k8s: K8sClients): { readonly stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    try {
      // The shared scheduler lease: database time, a sticky holder, TTL 1.5×
      // the interval — one replica per tick in HA.
      await withSchedulerLease(db, 'auto-update', AUTO_UPDATE_TICK_MS * 1.5, async () => {
        const caughtUp = await channelCatchUpTick(realCatchUpDeps(db, k8s)).catch((err) => {
          console.error('[auto-update] channel catch-up failed:', (err as Error).message);
          return null;
        });
        if (caughtUp) console.log(`[auto-update] ${caughtUp}`);
        const s = await autoUpdateTick(realAutoUpdateDeps(db, k8s));
        if (s.state === 'started') console.log(`[auto-update] ${s.detail}`);
      });
    } catch (err) {
      console.error('[auto-update] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, AUTO_UPDATE_TICK_MS);
    }
  };
  // First pass a minute after startup: not in the middle of a roll's churn.
  timer = setTimeout(tick, 60 * 1000);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
