import { z } from 'zod';

// ─── Deployment credentials + the tenant's database administrator ───────────
//
// GET  /tenants/:tenantId/deployments/:id/credentials
// POST /tenants/:tenantId/deployments/:id/admin-account/password
// POST /admin/deployments/:id/repair-database-access
//
// A catalog database's root / superuser login belongs to the platform: the
// SQL Manager, backups, restores and migrations run through it, and a copy a
// tenant could change left the platform locked out. None of those keys
// (`*_ROOT_PASSWORD`, `POSTGRES_PASSWORD`, `MONGO_INITDB_ROOT_*`) appears in
// `credentials` or `generatedKeys` of a standalone instance. The tenant gets its own
// administrator account instead — `adminAccount` — with full rights on every
// one of its databases, the right to create databases named `db_…` in SQL,
// and no right to create users (Database Users in the panel do that).

/** Where to reach the instance from inside the cluster. */
export const deploymentConnectionInfoSchema = z.object({
  /** In-cluster service DNS name. */
  host: z.string(),
  /** From the catalog entry's `provides.port` or its first component port. */
  port: z.number().int().nullable(),
  /** The database created at deploy time (`*_DATABASE` / `POSTGRES_DB`), if any. */
  database: z.string().nullable(),
  /** The application user created at deploy time (`*_USER` / `POSTGRES_USER`), if any. */
  username: z.string().nullable(),
});
export type DeploymentConnectionInfo = z.infer<typeof deploymentConnectionInfoSchema>;

/** The tenant's own administrator account on a database instance ("dbadmin"). */
export const databaseAdminAccountSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type DatabaseAdminAccount = z.infer<typeof databaseAdminAccountSchema>;

export const deploymentCredentialsResponseSchema = z.object({
  /** Generated values the tenant may see (never the platform's admin login). */
  credentials: z.record(z.string(), z.string()),
  connectionInfo: deploymentConnectionInfoSchema,
  /** The catalog's generated keys, minus the platform's own. */
  generatedKeys: z.array(z.string()),
  /**
   * Null while the platform is still setting the account up (a new instance,
   * or the first look after an upgrade) — and always for a deployment that is
   * not a managed database engine. The credentials read itself starts the
   * setup, so a client showing "being set up" should ask again shortly.
   */
  adminAccount: databaseAdminAccountSchema.nullable(),
  /**
   * Why `adminAccount` is what it is:
   *   ready       — set up; `adminAccount` holds it.
   *   pending     — being set up; ask again shortly.
   *   restricted  — set up, but only a tenant administrator sees its password.
   *   unavailable — this deployment has none: not a standalone database
   *                 instance (an app's own database), or one without
   *                 authentication.
   *   lost        — the platform lost its own administrator login to the
   *                 instance; an operator has been notified.
   */
  adminAccountStatus: z.enum(['ready', 'pending', 'restricted', 'unavailable', 'lost']),
});
export type DeploymentCredentialsResponse = z.infer<typeof deploymentCredentialsResponseSchema>;

/**
 * A new password for the administrator account. 409 `ADMIN_ACCOUNT_PENDING`
 * while the account is not set up yet. Every tool still holding the old
 * password stops connecting.
 */
export const rotateDatabaseAdminPasswordResponseSchema = databaseAdminAccountSchema;
export type RotateDatabaseAdminPasswordResponse = z.infer<typeof rotateDatabaseAdminPasswordResponseSchema>;

/**
 * Admin-only: the platform lost its own administrator login to the instance.
 * The instance is redeployed with a reset that restores it — the database
 * restarts once.
 */
export const repairDatabaseAccessResponseSchema = z.object({
  redeployed: z.literal(true),
});
export type RepairDatabaseAccessResponse = z.infer<typeof repairDatabaseAccessResponseSchema>;
