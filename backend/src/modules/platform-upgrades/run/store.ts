/**
 * ADR-064 — persistence of upgrade runs (platform_upgrade_runs, migration 0154).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { UpgradeRun, UpgradeRunNode } from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';
import { platformUpgradeRuns, type PlatformUpgradeRunRow } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';

export type RunPatch = Partial<Pick<PlatformUpgradeRunRow,
  'status' | 'step' | 'nodes' | 'message' | 'stepStartedAt' | 'finishedAt'>>;

const iso = (d: Date | string | null | undefined): string | null =>
  d ? (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) : null;

export function toUpgradeRun(row: PlatformUpgradeRunRow): UpgradeRun {
  return {
    id: row.id,
    fromVersion: row.fromVersion ?? null,
    toVersion: row.toVersion,
    mode: row.mode === 'auto' ? 'auto' : 'manual',
    status: (['succeeded', 'failed', 'cancelled', 'rolled-back'] as const).find((s) => s === row.status) ?? 'running',
    step: (['prepare-nodes', 'update-services', 'finish', 'upgrade-kubernetes', 'done'] as const).find((s) => s === row.step) ?? 'prepare-nodes',
    excludedNodes: Array.isArray(row.excludedNodes) ? row.excludedNodes : [],
    kubernetesVersion: row.kubernetesVersion ?? null,
    nodes: (Array.isArray(row.nodes) ? row.nodes : []) as unknown as UpgradeRunNode[],
    message: row.message ?? null,
    startedAt: iso(row.startedAt) ?? new Date(0).toISOString(),
    stepStartedAt: iso(row.stepStartedAt) ?? new Date(0).toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

export async function getActiveRun(db: Database): Promise<PlatformUpgradeRunRow | null> {
  const rows = await db.select().from(platformUpgradeRuns).where(eq(platformUpgradeRuns.status, 'running')).limit(1);
  return rows[0] ?? null;
}

export async function getRun(db: Database, id: string): Promise<PlatformUpgradeRunRow | null> {
  const rows = await db.select().from(platformUpgradeRuns).where(eq(platformUpgradeRuns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listRuns(db: Database, limit: number): Promise<PlatformUpgradeRunRow[]> {
  return db.select().from(platformUpgradeRuns).orderBy(desc(platformUpgradeRuns.startedAt)).limit(Math.min(Math.max(limit, 1), 100));
}

export interface NewRunInput {
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly mode: 'manual' | 'auto';
  readonly excludedNodes: readonly string[];
  readonly initiatedBy: string | null;
  /** ADR-064 §8: the opt-in Kubernetes step's k3s target. */
  readonly kubernetesVersion?: string | null;
}

/** Create the run. At most one runs at a time (partial unique index) — a second is a 409. */
export async function createRun(db: Database, input: NewRunInput): Promise<PlatformUpgradeRunRow> {
  try {
    const rows = await db.insert(platformUpgradeRuns).values({
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      mode: input.mode,
      excludedNodes: [...input.excludedNodes],
      initiatedBy: input.initiatedBy,
      kubernetesVersion: input.kubernetesVersion ?? null,
    }).returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') {
      throw new ApiError('UPGRADE_ALREADY_RUNNING', 'An upgrade is already running — wait for it to finish (Platform → Updates shows its progress).', 409);
    }
    throw err;
  }
}

export async function updateRun(db: Database, id: string, patch: RunPatch): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db.update(platformUpgradeRuns).set(patch).where(eq(platformUpgradeRuns.id, id));
}

/**
 * Apply `patch` only while the run is still running (and, with `fromStep`, still
 * in that step). The reconciler and an operator's Cancel race; this is the one
 * place either of them changes a run's step or status, so exactly one wins.
 */
export async function transitionRun(db: Database, id: string, fromStep: string | null, patch: RunPatch): Promise<boolean> {
  const conds = [eq(platformUpgradeRuns.id, id), eq(platformUpgradeRuns.status, 'running')];
  if (fromStep !== null) conds.push(eq(platformUpgradeRuns.step, fromStep));
  const rows = await db.update(platformUpgradeRuns).set(patch).where(and(...conds)).returning({ id: platformUpgradeRuns.id });
  return rows.length > 0;
}
