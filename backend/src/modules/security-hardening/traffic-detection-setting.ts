/**
 * The operator's saved on/off choice for Malicious Traffic Detection.
 *
 * The live switch is the agent's simulation.yaml (crowdsec-scenarios.ts), but a
 * ConfigMap is not a durable home for a decision: if it is deleted, the backend
 * recreates it at startup, and without a record of the choice it would come
 * back ENABLED — silently re-arming bans the operator had turned off. This row
 * is that record; `ensureAgentSimulationDefault` re-applies it.
 *
 * Unset (never toggled) is reported as `null`, distinct from either value, so
 * an upgrading cluster keeps whatever its agent already runs instead of having
 * a guessed default forced onto it.
 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { platformSettings } from '../../db/schema.js';

// The route plugin and buildApp hold the database under different static
// types; the queries below only need the generic drizzle surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

export const TRAFFIC_DETECTION_ENABLED_KEY = 'security.crowdsec.traffic_detection_enabled';

/** 'true' / 'false' → boolean; anything else (absent, garbled) → null. */
export function parseStoredFlag(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

export async function readTrafficDetectionEnabled(db: Db): Promise<boolean | null> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, TRAFFIC_DETECTION_ENABLED_KEY));
  return parseStoredFlag(row?.value);
}

export async function writeTrafficDetectionEnabled(db: Db, enabled: boolean): Promise<void> {
  const value = String(enabled);
  await db
    .insert(platformSettings)
    .values({ key: TRAFFIC_DETECTION_ENABLED_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
}
