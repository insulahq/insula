/**
 * Which bundle a cross-cluster migration imports for each tenant: the newest
 * one on the source, by its capture time.
 *
 * Typed from the meta contract on purpose. The scan used to read a
 * hand-written interface whose `createdAt` the schema never had (the field is
 * `capturedAt`, and Zod strips unknown keys), so every comparison tied and
 * the first bundle listed won — an arbitrary, often older, copy.
 */

import type { BackupMetaV2 } from '@insula/api-contracts';

export interface ScannedBundle<M extends Pick<BackupMetaV2, 'tenantId' | 'capturedAt'> = Pick<BackupMetaV2, 'tenantId' | 'capturedAt'>> {
  /** The id the store listed — the directory the bundle lives in. */
  readonly bundleId: string;
  readonly meta: M;
}

export interface PickedBundle<M> {
  readonly bundleId: string;
  readonly capturedAt: string;
  readonly meta: M;
  /** How many bundles the source holds for this tenant. */
  readonly count: number;
}

/** Epoch ms of a capture; unparseable sorts before everything. */
function capturedMs(capturedAt: string): number {
  const ms = Date.parse(capturedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** True when `a` should replace `b` as the tenant's newest bundle. */
function isNewer(a: ScannedBundle, b: ScannedBundle): boolean {
  const da = capturedMs(a.meta.capturedAt);
  const db = capturedMs(b.meta.capturedAt);
  if (da !== db) return da > db;
  // Same instant: any fixed order will do, so the pick never depends on
  // the store's listing order.
  return a.bundleId > b.bundleId;
}

export function pickNewestPerTenant<M extends Pick<BackupMetaV2, 'tenantId' | 'capturedAt'>>(
  bundles: ReadonlyArray<ScannedBundle<M>>,
): Map<string, PickedBundle<M>> {
  const out = new Map<string, PickedBundle<M>>();
  for (const b of bundles) {
    const cur = out.get(b.meta.tenantId);
    if (!cur) {
      out.set(b.meta.tenantId, { bundleId: b.bundleId, capturedAt: b.meta.capturedAt, meta: b.meta, count: 1 });
      continue;
    }
    const count = cur.count + 1;
    out.set(
      b.meta.tenantId,
      isNewer(b, { bundleId: cur.bundleId, meta: cur.meta })
        ? { bundleId: b.bundleId, capturedAt: b.meta.capturedAt, meta: b.meta, count }
        : { ...cur, count },
    );
  }
  return out;
}
