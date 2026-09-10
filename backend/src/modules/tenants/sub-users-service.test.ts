import { describe, it, expect } from 'vitest';
import bcrypt from 'bcrypt';
import {
  listSubUsers,
  createSubUser,
  deleteSubUser,
  updateSubUser,
  resetSubUserPassword,
  type SubUsersDb,
} from './sub-users-service.js';
import { GENERATED_PASSWORD_LENGTH } from '../../shared/password.js';

/**
 * Phase 1: tests for the extracted sub-users service module.
 *
 * The routes layer will call these functions instead of hitting
 * `app.db` directly, which makes both the routes and the service
 * unit-testable in isolation.
 */

interface SubUserRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly status: string;
  readonly tenantId: string;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly passwordHash: string | null;
}

/**
 * In-memory db stub that matches the narrow SubUsersDb interface.
 * We keep this tiny — just enough to test the service behaviors.
 */
function makeStub(initialRows: SubUserRow[], erased: string[] = []): SubUsersDb {
  let rows = [...initialRows];
  const stub: SubUsersDb = {
    listByTenantId: async (tenantId) =>
      rows
        .filter((r) => r.tenantId === tenantId)
        .map((r) => ({
          id: r.id,
          email: r.email,
          fullName: r.fullName,
          roleName: r.roleName,
          status: r.status,
          createdAt: r.createdAt,
          lastLoginAt: r.lastLoginAt,
        })),
    countByTenantId: async (tenantId) =>
      rows.filter((r) => r.tenantId === tenantId).length,
    countAdminsByTenantId: async (tenantId) =>
      rows.filter(
        (r) => r.tenantId === tenantId && r.roleName === 'tenant_admin',
      ).length,
    countActiveAdminsByTenantId: async (tenantId) =>
      rows.filter(
        (r) =>
          r.tenantId === tenantId
          && r.roleName === 'tenant_admin'
          && r.status === 'active',
      ).length,
    findByIdAndTenantId: async (userId, tenantId) => {
      const row = rows.find((r) => r.id === userId && r.tenantId === tenantId);
      return row
        ? { id: row.id, roleName: row.roleName, status: row.status }
        : null;
    },
    insertSubUser: async (input) => {
      const now = new Date('2026-04-09T12:00:00Z');
      const row: SubUserRow = {
        id: input.id,
        email: input.email,
        fullName: input.fullName,
        roleName: input.roleName,
        status: 'active',
        tenantId: input.tenantId,
        createdAt: now,
        lastLoginAt: null,
        passwordHash: input.passwordHash,
      };
      rows.push(row);
      return {
        id: row.id,
        email: row.email,
        fullName: row.fullName,
        roleName: row.roleName,
        status: row.status,
        createdAt: row.createdAt,
      };
    },
    updateSubUser: async (userId, tenantId, payload) => {
      const idx = rows.findIndex(
        (r) => r.id === userId && r.tenantId === tenantId,
      );
      if (idx < 0) throw new Error(`row not found: ${userId}`);
      const current = rows[idx];
      const next: SubUserRow = {
        ...current,
        fullName: payload.fullName ?? current.fullName,
        roleName: payload.roleName ?? current.roleName,
        status: payload.status ?? current.status,
      };
      rows[idx] = next;
      return {
        id: next.id,
        email: next.email,
        fullName: next.fullName,
        roleName: next.roleName,
        status: next.status,
        createdAt: next.createdAt,
        lastLoginAt: next.lastLoginAt,
      };
    },
    updatePasswordHash: async (userId, tenantId, passwordHash) => {
      const idx = rows.findIndex(
        (r) => r.id === userId && r.tenantId === tenantId,
      );
      if (idx < 0) throw new Error(`row not found: ${userId}`);
      rows[idx] = { ...rows[idx], passwordHash };
    },
    deleteById: async (userId, tenantId) => {
      rows = rows.filter(
        (r) => !(r.id === userId && r.tenantId === tenantId),
      );
    },
    eraseNotifications: async (userId) => { erased.push(userId); },
    // Single-threaded test stub — no actual locking needed.
    runInTransaction: async (fn) => fn(stub),
  };
  return stub;
}

/**
 * Test helper: pokes inside the in-memory stub to read the current
 * password hash for assertions. The real stub is fully closure-
 * scoped, so we expose a readback via the spy pattern below.
 */
function makeStubWithPasswordReadback(initialRows: SubUserRow[]): {
  db: SubUsersDb;
  readHash: (userId: string) => string | null;
} {
  const state: { rows: SubUserRow[] } = { rows: [...initialRows] };
  const stub: SubUsersDb = {
    listByTenantId: async (tenantId) =>
      state.rows
        .filter((r) => r.tenantId === tenantId)
        .map((r) => ({
          id: r.id, email: r.email, fullName: r.fullName, roleName: r.roleName,
          status: r.status, createdAt: r.createdAt, lastLoginAt: r.lastLoginAt,
        })),
    countByTenantId: async (tenantId) =>
      state.rows.filter((r) => r.tenantId === tenantId).length,
    countAdminsByTenantId: async (tenantId) =>
      state.rows.filter((r) => r.tenantId === tenantId && r.roleName === 'tenant_admin').length,
    countActiveAdminsByTenantId: async (tenantId) =>
      state.rows.filter((r) => r.tenantId === tenantId && r.roleName === 'tenant_admin' && r.status === 'active').length,
    findByIdAndTenantId: async (userId, tenantId) => {
      const row = state.rows.find((r) => r.id === userId && r.tenantId === tenantId);
      return row ? { id: row.id, roleName: row.roleName, status: row.status } : null;
    },
    insertSubUser: async (input) => {
      const row: SubUserRow = {
        id: input.id,
        email: input.email,
        fullName: input.fullName,
        roleName: input.roleName,
        status: 'active',
        tenantId: input.tenantId,
        createdAt: new Date('2026-04-09T12:00:00Z'),
        lastLoginAt: null,
        passwordHash: input.passwordHash,
      };
      state.rows.push(row);
      return {
        id: row.id,
        email: row.email,
        fullName: row.fullName,
        roleName: row.roleName,
        status: row.status,
        createdAt: row.createdAt,
      };
    },
    updateSubUser: async () => { throw new Error('not implemented in readback stub'); },
    updatePasswordHash: async (userId, tenantId, passwordHash) => {
      const idx = state.rows.findIndex((r) => r.id === userId && r.tenantId === tenantId);
      if (idx < 0) throw new Error(`row not found: ${userId}`);
      state.rows[idx] = { ...state.rows[idx], passwordHash };
    },
    deleteById: async () => { throw new Error('not implemented in readback stub'); },
    eraseNotifications: async () => { throw new Error('not implemented in readback stub'); },
    runInTransaction: async (fn) => fn(stub),
  };
  return {
    db: stub,
    readHash: (userId) => state.rows.find((r) => r.id === userId)?.passwordHash ?? null,
  };
}

const SEED: SubUserRow[] = [
  {
    id: 'u-admin-1',
    email: 'admin@c1.com',
    fullName: 'C1 Admin',
    roleName: 'tenant_admin',
    status: 'active',
    tenantId: 'c1',
    createdAt: new Date('2026-01-01'),
    lastLoginAt: null,
    passwordHash: 'x',
  },
  {
    id: 'u-user-1',
    email: 'user@c1.com',
    fullName: 'C1 User',
    roleName: 'tenant_user',
    status: 'active',
    tenantId: 'c1',
    createdAt: new Date('2026-01-02'),
    lastLoginAt: null,
    passwordHash: 'x',
  },
  {
    id: 'u-admin-2',
    email: 'admin@c2.com',
    fullName: 'C2 Admin',
    roleName: 'tenant_admin',
    status: 'active',
    tenantId: 'c2',
    createdAt: new Date('2026-01-03'),
    lastLoginAt: null,
    passwordHash: 'x',
  },
];

describe('sub-users-service', () => {
  describe('listSubUsers', () => {
    it('returns only users for the requested tenant', async () => {
      const db = makeStub(SEED);
      const users = await listSubUsers(db, 'c1');
      expect(users).toHaveLength(2);
      expect(users.every((u) => ['u-admin-1', 'u-user-1'].includes(u.id))).toBe(
        true,
      );
    });

    it('returns empty array for a tenant with no users', async () => {
      const db = makeStub(SEED);
      const users = await listSubUsers(db, 'c-unknown');
      expect(users).toEqual([]);
    });

    it('does not leak the passwordHash field', async () => {
      const db = makeStub(SEED);
      const users = await listSubUsers(db, 'c1');
      for (const u of users) {
        expect(u).not.toHaveProperty('passwordHash');
      }
    });
  });

  describe('createSubUser', () => {
    it('creates a sub-user with default role tenant_user', async () => {
      const db = makeStub(SEED);
      const created = await createSubUser(db, 'c1', {
        email: 'new@c1.com',
        full_name: 'New User',
      });
      expect(created.email).toBe('new@c1.com');
      expect(created.roleName).toBe('tenant_user');
      expect(created.status).toBe('active');
      expect(created).not.toHaveProperty('passwordHash');
      // Verify it's actually in the store
      const list = await listSubUsers(db, 'c1');
      expect(list).toHaveLength(3);
    });

    it('creates a sub-user with explicit role_name=tenant_admin (Phase 2)', async () => {
      const db = makeStub(SEED);
      const created = await createSubUser(db, 'c1', {
        email: 'promoted@c1.com',
        full_name: 'Promoted User',
        role_name: 'tenant_admin',
      });
      expect(created.roleName).toBe('tenant_admin');
    });

    it('creates a sub-user with explicit role_name=tenant_user (Phase 2)', async () => {
      const db = makeStub(SEED);
      const created = await createSubUser(db, 'c1', {
        email: 'member@c1.com',
        full_name: 'Team Member',
        role_name: 'tenant_user',
      });
      expect(created.roleName).toBe('tenant_user');
    });

    it('refuses unknown roles at the service boundary (defense in depth)', async () => {
      const db = makeStub(SEED);
      await expect(
        createSubUser(db, 'c1', {
          email: 'bad@c1.com',
          full_name: 'Bad',
          // Cast around the TS union so we can simulate a caller
          // that bypasses the route-level Zod parse.
          role_name: 'super_admin' as unknown as 'tenant_admin',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_FIELD_VALUE',
        status: 400,
      });
    });

    it('rejects when the plan sub-user limit is reached', async () => {
      // Seed with maxSubUsers already full
      const seed: SubUserRow[] = Array.from({ length: 5 }, (_, i) => ({
        id: `u-${i}`,
        email: `u${i}@c3.com`,
        fullName: `User ${i}`,
        roleName: 'tenant_user',
        status: 'active',
        tenantId: 'c3',
        createdAt: new Date(),
        lastLoginAt: null,
        passwordHash: 'x',
      }));
      const db = makeStub(seed);
      await expect(
        createSubUser(
          db,
          'c3',
          { email: 'over@c3.com', full_name: 'Over' },
          { maxSubUsers: 5 },
        ),
      ).rejects.toMatchObject({
        code: 'SUB_USER_LIMIT',
        status: 403,
      });
    });

    it('allows creation up to the plan limit', async () => {
      const seed: SubUserRow[] = [];
      const db = makeStub(seed);
      for (let i = 0; i < 3; i++) {
        await createSubUser(
          db,
          'c4',
          {
            email: `u${i}@c4.com`,
            full_name: `U${i}`,
          },
          { maxSubUsers: 3 },
        );
      }
      await expect(
        createSubUser(
          db,
          'c4',
          {
            email: 'over@c4.com',
            full_name: 'Over',
          },
          { maxSubUsers: 3 },
        ),
      ).rejects.toMatchObject({ code: 'SUB_USER_LIMIT' });
    });

    it('rejects when required fields are missing', async () => {
      const db = makeStub(SEED);
      await expect(
        createSubUser(db, 'c1', {
          email: '',
          full_name: 'User',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_REQUIRED_FIELD' });
      await expect(
        createSubUser(db, 'c1', {
          email: 'ok@c1.com',
          full_name: '',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_REQUIRED_FIELD' });
    });

    it('generates the password itself and returns it exactly once', async () => {
      const db = makeStubWithPasswordReadback([]);
      const created = await createSubUser(db.db, 'c1', {
        email: 'generated@c1.com',
        full_name: 'Generated',
      });

      expect(created.generatedPassword).toHaveLength(GENERATED_PASSWORD_LENGTH);

      // The plaintext is never persisted — the stored hash must be a
      // bcrypt hash that VERIFIES against the returned password. A
      // weaker assertion (hash !== password) would also pass if the
      // row held some unrelated string.
      const stored = db.readHash(created.id);
      expect(stored).toMatch(/^\$2[aby]\$/);
      expect(await bcrypt.compare(created.generatedPassword, stored!)).toBe(true);

      // It must not leak into the listing surface.
      const [listed] = await listSubUsers(db.db, 'c1');
      expect(listed).not.toHaveProperty('generatedPassword');
      expect(listed).not.toHaveProperty('passwordHash');
    });

    it('issues a different password to every sub-user', async () => {
      const db = makeStub([]);
      const passwords = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const created = await createSubUser(db, 'c1', {
          email: `u${i}@c1.com`,
          full_name: `U${i}`,
        });
        passwords.add(created.generatedPassword);
      }
      expect(passwords.size).toBe(10);
    });
  });

  describe('deleteSubUser', () => {
    it('deletes a non-admin user without issue', async () => {
      const db = makeStub(SEED);
      await deleteSubUser(db, 'c1', 'u-user-1');
      const list = await listSubUsers(db, 'c1');
      expect(list.map((u) => u.id)).not.toContain('u-user-1');
    });

    it('returns 404 when the user does not exist in this tenant', async () => {
      const db = makeStub(SEED);
      await expect(
        deleteSubUser(db, 'c1', 'u-does-not-exist'),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND', status: 404 });
    });

    it('returns 404 when the user belongs to a different tenant (cross-tenant isolation)', async () => {
      const db = makeStub(SEED);
      // u-admin-2 exists but belongs to c2, requesting from c1
      await expect(
        deleteSubUser(db, 'c1', 'u-admin-2'),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });

    it('refuses to delete the last tenant_admin', async () => {
      const db = makeStub(SEED);
      await expect(
        deleteSubUser(db, 'c1', 'u-admin-1'),
      ).rejects.toMatchObject({ code: 'LAST_ADMIN', status: 403 });
    });

    it('allows deleting a tenant_admin if others remain', async () => {
      const seed: SubUserRow[] = [
        ...SEED,
        {
          id: 'u-admin-1b',
          email: 'admin2@c1.com',
          fullName: 'C1 Second Admin',
          roleName: 'tenant_admin',
          status: 'active',
          tenantId: 'c1',
          createdAt: new Date(),
          lastLoginAt: null,
          passwordHash: 'x',
        },
      ];
      const db = makeStub(seed);
      await deleteSubUser(db, 'c1', 'u-admin-1');
      const list = await listSubUsers(db, 'c1');
      expect(list.map((u) => u.id)).toContain('u-admin-1b');
      expect(list.map((u) => u.id)).not.toContain('u-admin-1');
    });

    /**
     * GDPR Art. 17. `notifications.user_id` has no FK, so nothing cascades
     * at the database layer — if the service doesn't erase, the rows are
     * orphaned against a user id that no longer resolves.
     */
    it('erases the deleted user notifications', async () => {
      const erased: string[] = [];
      const db = makeStub(SEED, erased);
      await deleteSubUser(db, 'c1', 'u-user-1');
      expect(erased).toEqual(['u-user-1']);
    });

    it('does not erase notifications when the delete is refused', async () => {
      const erased: string[] = [];
      const db = makeStub(SEED, erased);
      await expect(
        deleteSubUser(db, 'c1', 'u-admin-1'),
      ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
      expect(erased).toEqual([]);
    });

    it('does not erase notifications for a user in another tenant', async () => {
      const erased: string[] = [];
      const db = makeStub(SEED, erased);
      await expect(
        deleteSubUser(db, 'c1', 'u-admin-2'),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
      expect(erased).toEqual([]);
    });
  });

  describe('updateSubUser (Phase 3)', () => {
    it('updates a user full_name', async () => {
      const db = makeStub(SEED);
      const updated = await updateSubUser(db, 'c1', 'u-user-1', {
        fullName: 'Renamed User',
      });
      expect(updated.fullName).toBe('Renamed User');
      expect(updated.roleName).toBe('tenant_user');
      expect(updated.status).toBe('active');
    });

    it('promotes a tenant_user to tenant_admin', async () => {
      const db = makeStub(SEED);
      const updated = await updateSubUser(db, 'c1', 'u-user-1', {
        roleName: 'tenant_admin',
      });
      expect(updated.roleName).toBe('tenant_admin');
    });

    it('disables an active user (soft-delete)', async () => {
      const db = makeStub(SEED);
      const updated = await updateSubUser(db, 'c1', 'u-user-1', {
        status: 'disabled',
      });
      expect(updated.status).toBe('disabled');
    });

    it('re-enables a disabled user', async () => {
      const seed: SubUserRow[] = [
        ...SEED,
        {
          id: 'u-disabled',
          email: 'off@c1.com',
          fullName: 'Off',
          roleName: 'tenant_user',
          status: 'disabled',
          tenantId: 'c1',
          createdAt: new Date(),
          lastLoginAt: null,
          passwordHash: 'x',
        },
      ];
      const db = makeStub(seed);
      const updated = await updateSubUser(db, 'c1', 'u-disabled', {
        status: 'active',
      });
      expect(updated.status).toBe('active');
    });

    it('rejects updates for a user not in this tenant', async () => {
      const db = makeStub(SEED);
      await expect(
        updateSubUser(db, 'c1', 'u-admin-2', { fullName: 'Hack' }),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });

    it('rejects unknown role names (defense in depth)', async () => {
      const db = makeStub(SEED);
      await expect(
        updateSubUser(db, 'c1', 'u-user-1', {
          roleName: 'super_admin' as unknown as 'tenant_admin',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE' });
    });

    it('refuses to demote the last active tenant_admin', async () => {
      const db = makeStub(SEED);
      await expect(
        updateSubUser(db, 'c1', 'u-admin-1', { roleName: 'tenant_user' }),
      ).rejects.toMatchObject({ code: 'LAST_ADMIN', status: 403 });
    });

    it('refuses to disable the last active tenant_admin', async () => {
      const db = makeStub(SEED);
      await expect(
        updateSubUser(db, 'c1', 'u-admin-1', { status: 'disabled' }),
      ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    });

    it('allows demoting a tenant_admin if another active admin exists', async () => {
      const seed: SubUserRow[] = [
        ...SEED,
        {
          id: 'u-admin-1b',
          email: 'admin2@c1.com',
          fullName: 'Second Admin',
          roleName: 'tenant_admin',
          status: 'active',
          tenantId: 'c1',
          createdAt: new Date(),
          lastLoginAt: null,
          passwordHash: 'x',
        },
      ];
      const db = makeStub(seed);
      const updated = await updateSubUser(db, 'c1', 'u-admin-1', {
        roleName: 'tenant_user',
      });
      expect(updated.roleName).toBe('tenant_user');
    });

    it('allows disabling a tenant_admin if another active admin exists', async () => {
      const seed: SubUserRow[] = [
        ...SEED,
        {
          id: 'u-admin-1b',
          email: 'admin2@c1.com',
          fullName: 'Second Admin',
          roleName: 'tenant_admin',
          status: 'active',
          tenantId: 'c1',
          createdAt: new Date(),
          lastLoginAt: null,
          passwordHash: 'x',
        },
      ];
      const db = makeStub(seed);
      const updated = await updateSubUser(db, 'c1', 'u-admin-1', {
        status: 'disabled',
      });
      expect(updated.status).toBe('disabled');
    });
  });

  describe('resetSubUserPassword', () => {
    it('regenerates the password and stores only its bcrypt hash', async () => {
      const { db, readHash } = makeStubWithPasswordReadback(SEED);
      const before = readHash('u-user-1');

      const issued = await resetSubUserPassword(db, 'c1', 'u-user-1');

      expect(issued).toHaveLength(GENERATED_PASSWORD_LENGTH);
      const after = readHash('u-user-1');
      expect(after).not.toBe(before);
      expect(after).not.toBe(issued); // hashed, never plaintext
      expect(after).toMatch(/^\$2[aby]\$/);
      // The returned value must be the one that actually logs in —
      // asserting only "the hash changed" would pass even if the
      // service hashed something else and handed back a stray string.
      expect(await bcrypt.compare(issued, after!)).toBe(true);
    });

    it('issues a different password on every reset', async () => {
      const { db } = makeStubWithPasswordReadback(SEED);
      const first = await resetSubUserPassword(db, 'c1', 'u-user-1');
      const second = await resetSubUserPassword(db, 'c1', 'u-user-1');
      expect(first).not.toBe(second);
    });

    it('leaves the old password unusable after a reset', async () => {
      const { db, readHash } = makeStubWithPasswordReadback(SEED);
      const first = await resetSubUserPassword(db, 'c1', 'u-user-1');
      await resetSubUserPassword(db, 'c1', 'u-user-1');
      expect(await bcrypt.compare(first, readHash('u-user-1')!)).toBe(false);
    });

    it('returns 404 for users not in this tenant', async () => {
      const { db } = makeStubWithPasswordReadback(SEED);
      await expect(
        resetSubUserPassword(db, 'c1', 'u-admin-2'),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });

    it('returns 404 for non-existent users', async () => {
      const { db } = makeStubWithPasswordReadback(SEED);
      await expect(
        resetSubUserPassword(db, 'c1', 'u-does-not-exist'),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });
  });
});
