/**
 * Released-PV janitor — AUTO-deletes the one orphan class that is
 * provably garbage: a `Released` PV whose claim (`platform/system-db-N`)
 * is ALREADY `Bound` to a newer PV. CNPG never re-binds a Released PV,
 * so every instance recreate leaks one under reclaimPolicy=Retain
 * (3 found on staging 2026-06-05, leaked by the WAL-incident recovery;
 * 16 were observed on testing 2026-05-17 when leaked test tenants
 * exhausted the storage budget).
 *
 * Scope is deliberately TIGHT: platform/system-db-N claims only, with a
 * Bound successor for the SAME claim name, Released for >= 2 days.
 * Tenant PVs, mail PVs, and successor-less Released PVs (data not yet
 * superseded — e.g. mid-recreate, or an operator may still restore from
 * them) are NEVER auto-deleted — those stay operator-driven via the
 * orphaned-volumes UI (`deleteOrphan` from the routes).
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { auditLogs } from '../../db/schema.js';
import { deleteOrphan } from './service.js';

const TICK_MS = 24 * 60 * 60 * 1000;      // daily
const INITIAL_DELAY_MS = 15 * 60 * 1000;  // past startup churn
/** Grace window before a superseded Released PV is reaped. */
export const JANITOR_MIN_RELEASED_AGE_DAYS = 2;

const SYSTEM_DB_CLAIM = /^system-db-\d+$/;

/** The narrow PV view the sweep needs (seam for tests). */
export interface JanitorPv {
  readonly name: string;
  readonly phase: string;
  readonly claimNamespace: string | null;
  readonly claimName: string | null;
  readonly longhornVolumeName: string | null;
  /** status.lastTransitionTime as epoch ms, or null when absent. */
  readonly lastTransitionMs: number | null;
}

export interface JanitorDeps {
  readonly listPvs: () => Promise<JanitorPv[]>;
  readonly deleteOrphan: (target: { pvName: string; longhornVolumeName: string | null }) => Promise<unknown>;
  readonly audit: (entry: { pvName: string; claimName: string; supersededBy: string }) => Promise<void>;
}

export interface JanitorSweepResult {
  readonly deleted: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
}

/** One sweep. Pure over the injected seam — unit-testable off k8s/DB. */
export async function sweepReleasedSystemPvs(deps: JanitorDeps, nowMs: number): Promise<JanitorSweepResult> {
  const pvs = await deps.listPvs();

  // Claim → Bound PV name. A Released PV is only garbage once the SAME
  // claim is served by a DIFFERENT, currently-Bound PV.
  const boundByClaim = new Map<string, string>();
  for (const pv of pvs) {
    if (pv.phase === 'Bound' && pv.claimNamespace && pv.claimName) {
      boundByClaim.set(`${pv.claimNamespace}/${pv.claimName}`, pv.name);
    }
  }

  const minAgeMs = JANITOR_MIN_RELEASED_AGE_DAYS * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const pv of pvs) {
    if (pv.phase !== 'Released') continue;
    if (pv.claimNamespace !== 'platform' || !pv.claimName || !SYSTEM_DB_CLAIM.test(pv.claimName)) continue;
    if (pv.lastTransitionMs === null || nowMs - pv.lastTransitionMs < minAgeMs) continue;
    const successor = boundByClaim.get(`${pv.claimNamespace}/${pv.claimName}`);
    if (!successor || successor === pv.name) continue;

    try {
      await deps.deleteOrphan({ pvName: pv.name, longhornVolumeName: pv.longhornVolumeName });
      await deps.audit({ pvName: pv.name, claimName: pv.claimName, supersededBy: successor }).catch((err) => {
        // Audit failure must not abort the sweep — the deletion already
        // happened; log loudly instead.
        console.error(`[pv-janitor] audit insert failed for ${pv.name}:`, (err as Error).message);
      });
      deleted.push(pv.name);
    } catch (err) {
      console.error(`[pv-janitor] failed to reap ${pv.name}:`, (err as Error).message);
      failed.push(pv.name);
    }
  }
  return { deleted, failed };
}

interface PvItem {
  metadata?: { name?: string };
  status?: { phase?: string; lastTransitionTime?: string };
  spec?: {
    claimRef?: { namespace?: string; name?: string };
    csi?: { driver?: string; volumeHandle?: string };
  };
}

export function realJanitorDeps(db: Database, k8s: K8sClients): JanitorDeps {
  return {
    listPvs: async () => {
      const list = await k8s.core.listPersistentVolume({});
      return ((list.items ?? []) as PvItem[]).map((pv) => ({
        name: pv.metadata?.name ?? '',
        phase: pv.status?.phase ?? '',
        claimNamespace: pv.spec?.claimRef?.namespace ?? null,
        claimName: pv.spec?.claimRef?.name ?? null,
        // For Longhorn CSI PVs the volumeHandle IS the Longhorn volume name.
        longhornVolumeName: pv.spec?.csi?.driver === 'driver.longhorn.io'
          ? (pv.spec.csi.volumeHandle ?? pv.metadata?.name ?? null)
          : null,
        lastTransitionMs: pv.status?.lastTransitionTime ? Date.parse(pv.status.lastTransitionTime) : null,
      })).filter((pv) => pv.name !== '');
    },
    deleteOrphan: (target) => deleteOrphan(k8s, target),
    audit: async (entry) => {
      await db.insert(auditLogs).values({
        id: randomUUID(),
        actionType: 'released_pv_reaped',
        resourceType: 'persistent_volume',
        // varchar(36) — a CSI PV name ("pvc-<uuid>", 40 chars) overflows;
        // store the uuid part and keep the full name in `changes`.
        resourceId: entry.pvName.replace(/^pvc-/, '').slice(0, 36),
        // System-driven action, no user session — nil UUID +
        // actorType='system' (same convention as dr_bundle_import).
        actorId: '00000000-0000-0000-0000-000000000000',
        actorType: 'system',
        changes: { claimName: entry.claimName, supersededBy: entry.supersededBy },
      });
    },
  };
}

export function startReleasedPvJanitor(db: Database, k8s: K8sClients): { readonly stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  console.log('[pv-janitor] starting (daily sweep, system-db Released PVs with Bound successors)');

  const tick = async () => {
    if (stopped) return;
    try {
      const r = await sweepReleasedSystemPvs(realJanitorDeps(db, k8s), Date.now());
      if (r.deleted.length > 0) console.log(`[pv-janitor] reaped ${r.deleted.length} Released PV(s): ${r.deleted.join(', ')}`);
      if (r.failed.length > 0) console.error(`[pv-janitor] ${r.failed.length} deletion(s) failed: ${r.failed.join(', ')}`);
    } catch (err) {
      console.error('[pv-janitor] sweep failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
