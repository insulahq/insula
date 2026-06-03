/**
 * The ordered platform-migration registry (W9 / ADR-045).
 *
 * Append new migrations to the END with the next numeric prefix. NEVER
 * renumber, reorder, or remove a shipped migration — its position is its
 * contract (enforced by scripts/ci-migration-idempotency.sh).
 */
import type { PlatformMigration } from '../registry/types.js';
import { recordBaseline } from './0001_record_baseline.js';

export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [
  recordBaseline,
];
