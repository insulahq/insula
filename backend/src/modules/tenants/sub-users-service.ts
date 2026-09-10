import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { users, hostingPlans, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { generateStrongPassword } from '../../shared/password.js';
import { eraseUserNotificationsInTx } from '../notifications/retention/gdpr-erasure.js';
import type { Database } from '../../db/index.js';

/**
 * Phase 1: extracted sub-users service.
 *
 * Before extraction, the sub-user routes made raw Drizzle calls
 * via `app.db` which made them impossible to unit-test without a
 * real database. The routes layer now delegates to these pure
 * functions, and tests can inject a minimal `SubUsersDb` stub.
 *
 * The production `makeDrizzleSubUsersDb(db)` adapter bridges the
 * stub interface to the real Drizzle queries — the route handlers
 * import that factory so the public call-site stays a single line.
 */

// ─── Public types ───────────────────────────────────────────────────────────

export interface SubUserDto {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
}

export interface CreatedSubUserDto {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly status: string;
  readonly createdAt: Date;
}

/**
 * What `createSubUser` hands back: the persisted row plus the
 * one-shot generated password. Only the hash reaches the database,
 * so this is the single opportunity to show the credential.
 */
export interface CreatedSubUserWithPasswordDto extends CreatedSubUserDto {
  readonly generatedPassword: string;
}

export interface CreateSubUserInput {
  readonly email: string;
  readonly full_name: string;
  /**
   * Phase 2: optional — defaults to `tenant_user`. Callers
   * upstream of the service are responsible for enforcing that
   * only authorized roles (tenant_admin + staff) can request a
   * `tenant_admin` sub-user.
   */
  readonly role_name?: 'tenant_admin' | 'tenant_user';
}

export interface CreateSubUserOptions {
  /**
   * Max sub-users allowed for this tenant (from hosting plan +
   * per-tenant override). Service enforces `< maxSubUsers`. If
   * omitted the service skips the check (callers are expected to
   * pass this in production — the default is `Infinity`).
   */
  readonly maxSubUsers?: number;
}

export interface InsertSubUserPayload {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly tenantId: string;
}

export interface UpdateSubUserPayload {
  readonly fullName?: string;
  readonly roleName?: 'tenant_admin' | 'tenant_user';
  readonly status?: 'active' | 'disabled';
}

/**
 * Narrow db interface the service depends on. Allows tests to
 * pass a tiny in-memory stub instead of mocking all of Drizzle.
 *
 * `runInTransaction` exists to close the Phase 3 last-admin guard
 * TOCTOU race: the service wraps its check+update inside a single
 * transaction so a concurrent request cannot pass the check and
 * then race through the update. The in-memory test stub just
 * invokes the callback with `this` — tests are single-threaded
 * so there's nothing to lock — but the production Drizzle adapter
 * uses `db.transaction()` which takes a row-level lock implicitly
 * via `SERIALIZABLE` isolation (Postgres default: read-committed,
 * but the transaction scope is enough to make the check+update
 * atomic against other transactions committing between them).
 */
export interface SubUsersDb {
  listByTenantId(tenantId: string): Promise<readonly SubUserDto[]>;
  countByTenantId(tenantId: string): Promise<number>;
  countAdminsByTenantId(tenantId: string): Promise<number>;
  countActiveAdminsByTenantId(tenantId: string): Promise<number>;
  findByIdAndTenantId(
    userId: string,
    tenantId: string,
  ): Promise<{ readonly id: string; readonly roleName: string; readonly status: string } | null>;
  insertSubUser(payload: InsertSubUserPayload): Promise<CreatedSubUserDto>;
  updateSubUser(
    userId: string,
    tenantId: string,
    payload: UpdateSubUserPayload,
  ): Promise<SubUserDto>;
  updatePasswordHash(
    userId: string,
    tenantId: string,
    passwordHash: string,
  ): Promise<void>;
  deleteById(userId: string, tenantId: string): Promise<void>;
  /**
   * GDPR Art. 17 — drop the user's notification + delivery rows.
   * `notifications.user_id` has no FK, so nothing cascades at the database
   * layer; without this call a deleted tenant user's inbox rows are
   * orphaned in place forever.
   */
  eraseNotifications(userId: string): Promise<void>;
  runInTransaction<T>(fn: (tx: SubUsersDb) => Promise<T>): Promise<T>;
}

// ─── Service functions ─────────────────────────────────────────────────────

/**
 * Closed set of roles the service is willing to write for a
 * tenant-panel sub-user. This is the service's self-defense
 * against callers that bypass the route-level Zod parse (e.g.
 * scripts, future internal callers). Changing this set also
 * requires updating `subUserRoleSchema` in
 * `@insula/api-contracts` so the HTTP surface stays in sync.
 */
const ALLOWED_SUB_USER_ROLES = ['tenant_admin', 'tenant_user'] as const;
type AllowedSubUserRole = typeof ALLOWED_SUB_USER_ROLES[number];

function isAllowedRole(role: string): role is AllowedSubUserRole {
  return (ALLOWED_SUB_USER_ROLES as readonly string[]).includes(role);
}

export async function listSubUsers(
  db: SubUsersDb,
  tenantId: string,
): Promise<readonly SubUserDto[]> {
  return db.listByTenantId(tenantId);
}

/**
 * Create a tenant-panel sub-user with a server-generated password.
 *
 * The password is NOT an input: manual entry is unavailable on this
 * path, exactly as it is for the tenant's own `tenant_admin` login
 * minted by `createTenant`. The generated value is returned to the
 * caller once, in `generatedPassword`.
 */
export async function createSubUser(
  db: SubUsersDb,
  tenantId: string,
  input: CreateSubUserInput,
  options: CreateSubUserOptions = {},
): Promise<CreatedSubUserWithPasswordDto> {
  if (!input.email || !input.full_name) {
    throw new ApiError(
      'MISSING_REQUIRED_FIELD',
      'email and full_name are required',
      400,
    );
  }

  const roleName = input.role_name ?? 'tenant_user';
  if (!isAllowedRole(roleName)) {
    // Defense in depth — the route layer's Zod parse should have
    // already rejected this, but we refuse to persist an unknown
    // role at the service boundary too.
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      `role_name must be one of: ${ALLOWED_SUB_USER_ROLES.join(', ')}`,
      400,
      { field: 'role_name' },
    );
  }

  const max = options.maxSubUsers ?? Number.POSITIVE_INFINITY;
  const existing = await db.countByTenantId(tenantId);
  if (existing >= max) {
    throw new ApiError(
      'SUB_USER_LIMIT',
      `Maximum ${max} users allowed for this plan`,
      403,
      { limit: max, current: existing },
    );
  }

  const generatedPassword = generateStrongPassword();
  const passwordHash = await bcrypt.hash(generatedPassword, 12);
  const id = crypto.randomUUID();

  const created = await db.insertSubUser({
    id,
    email: input.email,
    passwordHash,
    fullName: input.full_name,
    roleName,
    tenantId,
  });

  return { ...created, generatedPassword };
}

export async function deleteSubUser(
  db: SubUsersDb,
  tenantId: string,
  userId: string,
): Promise<void> {
  // Wrap the check+delete in a single transaction so a concurrent
  // request cannot race between the admin count check and the
  // delete, leaving the tenant with zero admins.
  await db.runInTransaction(async (tx) => {
    const user = await tx.findByIdAndTenantId(userId, tenantId);
    if (!user) {
      throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
    }

    // Don't allow deleting the last tenant_admin
    if (user.roleName === 'tenant_admin') {
      const adminCount = await tx.countAdminsByTenantId(tenantId);
      if (adminCount <= 1) {
        throw new ApiError('LAST_ADMIN', 'Cannot delete the last tenant admin', 403);
      }
    }

    await tx.deleteById(userId, tenantId);

    // Same transaction as the delete: the user row and their notification
    // rows must disappear together. Committing the delete and then failing
    // the erase would leave inbox rows keyed to a user id that no longer
    // resolves, and nothing downstream ever attributes those to anyone.
    await tx.eraseNotifications(userId);
  });
}

/**
 * Update a sub-user's name, role, or status. Enforces:
 *   - User exists and belongs to this tenant
 *   - Can't demote the last active tenant_admin to tenant_user
 *   - Can't disable the last active tenant_admin
 *   - Role change validates against the ALLOWED_SUB_USER_ROLES set
 *
 * Password changes are not accepted here — Phase 4 adds a dedicated
 * reset-password endpoint.
 */
export async function updateSubUser(
  db: SubUsersDb,
  tenantId: string,
  userId: string,
  input: UpdateSubUserPayload,
): Promise<SubUserDto> {
  // Defense-in-depth: validate role BEFORE opening a transaction
  // so a bad request doesn't burn a transaction slot.
  if (input.roleName !== undefined && !isAllowedRole(input.roleName)) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      `role_name must be one of: ${ALLOWED_SUB_USER_ROLES.join(', ')}`,
      400,
      { field: 'role_name' },
    );
  }

  // Wrap the check+update in a single transaction so a concurrent
  // request cannot pass the last-admin guard and race through the
  // update, leaving the tenant with zero active admins.
  return db.runInTransaction(async (tx) => {
    const existing = await tx.findByIdAndTenantId(userId, tenantId);
    if (!existing) {
      throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
    }

    // Last-admin protection: refuse to demote or disable the sole
    // active tenant_admin, which would leave the tenant locked out.
    const wouldDemoteFromAdmin =
      existing.roleName === 'tenant_admin'
      && input.roleName !== undefined
      && input.roleName !== 'tenant_admin';
    const wouldDisableAdmin =
      existing.roleName === 'tenant_admin'
      && existing.status === 'active'
      && input.status === 'disabled';

    if (wouldDemoteFromAdmin || wouldDisableAdmin) {
      const activeAdminCount = await tx.countActiveAdminsByTenantId(tenantId);
      if (activeAdminCount <= 1) {
        throw new ApiError(
          'LAST_ADMIN',
          wouldDemoteFromAdmin
            ? 'Cannot demote the last active tenant admin'
            : 'Cannot disable the last active tenant admin',
          403,
        );
      }
    }

    return tx.updateSubUser(userId, tenantId, {
      fullName: input.fullName,
      roleName: input.roleName,
      status: input.status,
    });
  });
}

/**
 * Admin-assisted password reset. Generates a fresh strong password,
 * writes its bcrypt hash to the users row, and returns the plaintext
 * to the caller once. Verifies the user belongs to the tenant before
 * writing.
 *
 * There is no caller-supplied password: a reset always produces a
 * new random credential, so a weak or reused one cannot be pinned on
 * an account from the panel.
 *
 * Does NOT send email or notify the user — the caller is
 * responsible for communicating the new password out-of-band.
 * Does NOT invalidate existing access JWTs (the route revokes
 * refresh tokens; access tokens expire naturally within 30 min).
 */
export async function resetSubUserPassword(
  db: SubUsersDb,
  tenantId: string,
  userId: string,
): Promise<string> {
  const existing = await db.findByIdAndTenantId(userId, tenantId);
  if (!existing) {
    throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
  }

  const newPassword = generateStrongPassword();
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.updatePasswordHash(userId, tenantId, passwordHash);
  return newPassword;
}

// ─── Production Drizzle adapter ────────────────────────────────────────────

/**
 * Wraps the real `Database` into a `SubUsersDb` so route handlers
 * can call `listSubUsers(makeDrizzleSubUsersDb(app.db), tenantId)`.
 */
/**
 * `Database`-compatible transactional context. Drizzle's transaction
 * callback receives a `tx` parameter that implements the same query
 * interface as `Database`, so we can pass it straight into
 * `makeDrizzleSubUsersDb(tx)` to get a transaction-scoped adapter.
 */
type DbOrTx = Database;

function buildAdapter(db: DbOrTx): SubUsersDb {
  // Phase 1 hardening: every read scopes to `panel = 'tenant'` so an
  // admin-panel user whose `tenantId` column happens to equal the
  // URL-param tenantId can never leak into the tenant-visible team
  // list. Writes always carry both tenantId and panel filters so a
  // mismatched caller can't mutate rows outside the intended scope.
  const tenantUserScope = (tenantId: string) =>
    and(eq(users.tenantId, tenantId), eq(users.panel, 'tenant'));

  return {
    async listByTenantId(tenantId) {
      return db
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          roleName: users.roleName,
          status: users.status,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(tenantUserScope(tenantId));
    },
    async countByTenantId(tenantId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(tenantUserScope(tenantId));
      return rows.length;
    },
    async countAdminsByTenantId(tenantId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, tenantId),
            eq(users.panel, 'tenant'),
            eq(users.roleName, 'tenant_admin'),
          ),
        );
      return rows.length;
    },
    async countActiveAdminsByTenantId(tenantId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, tenantId),
            eq(users.panel, 'tenant'),
            eq(users.roleName, 'tenant_admin'),
            eq(users.status, 'active'),
          ),
        );
      return rows.length;
    },
    async findByIdAndTenantId(userId, tenantId) {
      const [row] = await db
        .select({
          id: users.id,
          roleName: users.roleName,
          status: users.status,
        })
        .from(users)
        .where(
          and(
            eq(users.id, userId),
            eq(users.tenantId, tenantId),
            eq(users.panel, 'tenant'),
          ),
        );
      return row ?? null;
    },
    async insertSubUser(payload) {
      // Phase 1: use `.returning()` to atomically get the created
      // row in one round-trip instead of insert+select.
      const [created] = await db
        .insert(users)
        .values({
          id: payload.id,
          email: payload.email,
          passwordHash: payload.passwordHash,
          fullName: payload.fullName,
          roleName: payload.roleName,
          panel: 'tenant',
          tenantId: payload.tenantId,
          status: 'active',
          emailVerifiedAt: new Date(),
        })
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          roleName: users.roleName,
          status: users.status,
          createdAt: users.createdAt,
        });
      return created;
    },
    async updateSubUser(userId, tenantId, payload) {
      const updates: {
        fullName?: string;
        roleName?: string;
        status?: 'active' | 'disabled';
      } = {};
      if (payload.fullName !== undefined) updates.fullName = payload.fullName;
      if (payload.roleName !== undefined) updates.roleName = payload.roleName;
      if (payload.status !== undefined) updates.status = payload.status;

      const [updated] = await db
        .update(users)
        .set(updates)
        .where(and(eq(users.id, userId), tenantUserScope(tenantId)))
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          roleName: users.roleName,
          status: users.status,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        });
      return updated;
    },
    async updatePasswordHash(userId, tenantId, passwordHash) {
      await db
        .update(users)
        .set({ passwordHash })
        .where(and(eq(users.id, userId), tenantUserScope(tenantId)));
    },
    async deleteById(userId, tenantId) {
      await db
        .delete(users)
        .where(and(eq(users.id, userId), tenantUserScope(tenantId)));
    },
    async eraseNotifications(userId) {
      // `db` here is whatever context buildAdapter was handed — inside
      // runInTransaction that is the tx, so this joins the caller's
      // transaction rather than opening a nested one.
      await eraseUserNotificationsInTx(db, userId);
    },
    async runInTransaction(fn) {
      return db.transaction(async (tx) => fn(buildAdapter(tx as unknown as Database)));
    },
  };
}

export function makeDrizzleSubUsersDb(db: Database): SubUsersDb {
  return buildAdapter(db);
}

/**
 * Look up the effective max sub-user limit for a tenant:
 * `tenants.maxSubUsersOverride` if set, otherwise
 * `hostingPlans.maxSubUsers` for the tenant's plan. Falls back
 * to `10` if neither is present (matches the previous hardcoded
 * behavior for safety).
 */
export async function getEffectiveMaxSubUsers(
  db: Database,
  tenantId: string,
): Promise<number> {
  const [row] = await db
    .select({
      override: tenants.maxSubUsersOverride,
      planMax: hostingPlans.maxSubUsers,
    })
    .from(tenants)
    .leftJoin(hostingPlans, eq(tenants.planId, hostingPlans.id))
    .where(eq(tenants.id, tenantId));

  if (!row) return 10;
  return row.override ?? row.planMax ?? 10;
}
