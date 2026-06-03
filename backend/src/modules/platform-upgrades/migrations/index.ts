/**
 * The ordered platform-migration registry (W9 / ADR-045).
 *
 * Append new migrations to the END with the next numeric prefix. NEVER
 * renumber, reorder, or remove a shipped migration — its position is its
 * contract (enforced by scripts/ci-migration-idempotency.sh).
 */
import type { PlatformMigration } from '../registry/types.js';
import { recordBaseline } from './0001_record_baseline.js';
import { seedHostConfigDesired } from './0002_seed_host_config_desired.js';
import { seedHostPackagesDesired } from './0003_seed_host_packages_desired.js';
import { seedHostMigrationsDesired } from './0004_seed_host_migrations_desired.js';

export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [
  recordBaseline,
  seedHostConfigDesired,
  seedHostPackagesDesired,
  seedHostMigrationsDesired,
];
