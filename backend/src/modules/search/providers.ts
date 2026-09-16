import { and, eq, ne, or, ilike, asc, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/index.js';
import { likePattern } from '../../shared/like-pattern.js';
import type { AnyRole } from '../../middleware/auth.js';
import type { SearchItem, SearchResultType } from '@insula/api-contracts';
import {
  tenants,
  domains,
  deployments,
  mailboxes,
  cronJobs,
  users,
  sftpUsers,
  sshKeys,
  privateWorkers,
  clusterNodes,
  catalogEntries,
  hostingPlans,
  backupConfigurations,
} from '../../db/schema.js';

/**
 * Who is asking. Every field is lifted off the VERIFIED JWT in routes.ts —
 * never off the query string, and never off a header. A provider that
 * reads anything else about the caller is a bug.
 */
export interface SearchContext {
  readonly panel: 'admin' | 'tenant';
  readonly role: AnyRole;
  /** Present iff panel === 'tenant'. routes.ts refuses the request without it. */
  readonly tenantId?: string;
}

export interface SearchProvider {
  readonly type: SearchResultType;
  /** Heading rendered above this group in the dropdown. */
  readonly label: string;
  readonly panels: readonly ('admin' | 'tenant')[];
  /**
   * Does a row here BELONG to one tenant?
   *
   *   'tenant'   — rows carry a tenant_id. A tenant-panel caller MUST be
   *                filtered to their own, enforced by tenantScope() and
   *                asserted in providers.test.ts.
   *   'platform' — rows are platform-wide and identical for everyone (the
   *                application catalog, cluster nodes, hosting plans).
   *                There is nothing to scope.
   *
   * Required, with no default, precisely so that adding a provider forces
   * this decision rather than inheriting one. A 'platform' provider that
   * is reachable from the tenant panel is a deliberate, reviewable choice
   * — the test pins the exact set, so widening it cannot pass unnoticed.
   */
  readonly scope: 'tenant' | 'platform';
  /**
   * Roles allowed to see this group. Copied from the role gate on the
   * entity's canonical list endpoint so the palette can never surface a
   * row the caller could not already fetch by other means.
   */
  readonly roles: readonly AnyRole[];
  run(db: Database, ctx: SearchContext, term: string, limit: number): Promise<SearchItem[]>;
}

/**
 * Tenant-panel scoping, in one place.
 *
 * Returns the `tenant_id = ?` predicate for a tenant caller and
 * `undefined` for an admin caller (who is already gated by `roles`).
 * THROWS for a tenant caller with no tenantId rather than returning
 * undefined — an unscoped query is a cross-tenant data leak, and
 * "fail closed" is the only safe reading of a malformed token.
 * routes.ts rejects such tokens first; this is the second lock.
 */
function tenantScope(ctx: SearchContext, column: PgColumn): SQL | undefined {
  if (ctx.panel !== 'tenant') return undefined;
  if (!ctx.tenantId) {
    throw new Error('search: tenant-panel context reached a provider with no tenantId');
  }
  return eq(column, ctx.tenantId);
}

/** `and()` over a list that may contain undefined, collapsing to undefined when empty. */
function allOf(...parts: ReadonlyArray<SQL | undefined>): SQL | undefined {
  const present = parts.filter((p): p is SQL => p !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return and(...present);
}

const STAFF_READ: readonly AnyRole[] = ['super_admin', 'admin', 'support', 'read_only'];
const TENANT_ANY: readonly AnyRole[] = ['tenant_admin', 'tenant_user'];
const ADMIN_ONLY: readonly AnyRole[] = ['super_admin', 'admin'];

// ─── Providers ───────────────────────────────────────────────────────────────

const tenantProvider: SearchProvider = {
  type: 'tenant',
  scope: 'platform',
  label: 'Tenants',
  panels: ['admin'],
  roles: STAFF_READ,
  async run(db, _ctx, term, limit) {
    const rows = await db
      .select({ id: tenants.id, name: tenants.name, status: tenants.status })
      .from(tenants)
      .where(ilike(tenants.name, likePattern(term)))
      .orderBy(asc(tenants.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'tenant' as const,
      title: r.name,
      subtitle: null,
      href: `/tenants/${r.id}`,
      badge: r.status,
    }));
  },
};

const domainProvider: SearchProvider = {
  type: 'domain',
  scope: 'tenant',
  label: 'Domains',
  panels: ['admin', 'tenant'],
  roles: [...STAFF_READ, ...TENANT_ANY],
  async run(db, ctx, term, limit) {
    const rows = await db
      .select({
        id: domains.id,
        domainName: domains.domainName,
        status: domains.status,
        tenantId: domains.tenantId,
        tenantName: tenants.name,
      })
      .from(domains)
      .leftJoin(tenants, eq(domains.tenantId, tenants.id))
      .where(allOf(ilike(domains.domainName, likePattern(term)), tenantScope(ctx, domains.tenantId)))
      .orderBy(asc(domains.domainName))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'domain' as const,
      title: r.domainName,
      subtitle: ctx.panel === 'admin' ? r.tenantName : null,
      href: ctx.panel === 'admin' ? `/tenants/${r.tenantId}/domains/${r.id}` : `/domains/${r.id}`,
      badge: r.status,
    }));
  },
};

const deploymentProvider: SearchProvider = {
  type: 'deployment',
  scope: 'tenant',
  label: 'Applications',
  panels: ['admin', 'tenant'],
  roles: [...STAFF_READ, ...TENANT_ANY],
  async run(db, ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        id: deployments.id,
        name: deployments.name,
        status: deployments.status,
        tenantId: deployments.tenantId,
        tenantName: tenants.name,
        catalogName: catalogEntries.name,
      })
      .from(deployments)
      .leftJoin(tenants, eq(deployments.tenantId, tenants.id))
      .leftJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
      .where(
        allOf(
          // A soft-deleted deployment is not a place the user can navigate to.
          ne(deployments.status, 'deleted'),
          isNull(deployments.deletedAt),
          or(ilike(deployments.name, pattern), ilike(catalogEntries.name, pattern)),
          tenantScope(ctx, deployments.tenantId),
        ),
      )
      .orderBy(asc(deployments.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'deployment' as const,
      title: r.name,
      subtitle: ctx.panel === 'admin'
        ? [r.tenantName, r.catalogName].filter(Boolean).join(' · ') || null
        : r.catalogName,
      href: ctx.panel === 'admin' ? `/tenants/${r.tenantId}?tab=applications` : '/applications?tab=installed',
      badge: r.status,
    }));
  },
};

const mailboxProvider: SearchProvider = {
  type: 'mailbox',
  scope: 'tenant',
  label: 'Mailboxes',
  panels: ['admin', 'tenant'],
  roles: [...STAFF_READ, ...TENANT_ANY],
  async run(db, ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        id: mailboxes.id,
        localPart: mailboxes.localPart,
        fullAddress: mailboxes.fullAddress,
        displayName: mailboxes.displayName,
        status: mailboxes.status,
        tenantId: mailboxes.tenantId,
        tenantName: tenants.name,
      })
      .from(mailboxes)
      .leftJoin(tenants, eq(mailboxes.tenantId, tenants.id))
      .where(
        allOf(
          or(
            ilike(mailboxes.localPart, pattern),
            ilike(mailboxes.fullAddress, pattern),
            ilike(mailboxes.displayName, pattern),
          ),
          tenantScope(ctx, mailboxes.tenantId),
        ),
      )
      .orderBy(asc(mailboxes.fullAddress))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'mailbox' as const,
      title: r.fullAddress,
      subtitle: ctx.panel === 'admin' ? r.tenantName : r.displayName,
      href: ctx.panel === 'admin' ? `/tenants/${r.tenantId}?tab=email` : '/email?tab=mailboxes',
      badge: r.status,
    }));
  },
};

const cronJobProvider: SearchProvider = {
  type: 'cron_job',
  scope: 'tenant',
  label: 'Scheduled Tasks',
  panels: ['admin', 'tenant'],
  roles: [...STAFF_READ, ...TENANT_ANY],
  async run(db, ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        id: cronJobs.id,
        name: cronJobs.name,
        schedule: cronJobs.schedule,
        tenantId: cronJobs.tenantId,
        tenantName: tenants.name,
      })
      .from(cronJobs)
      .leftJoin(tenants, eq(cronJobs.tenantId, tenants.id))
      .where(
        allOf(
          or(ilike(cronJobs.name, pattern), ilike(cronJobs.command, pattern)),
          tenantScope(ctx, cronJobs.tenantId),
        ),
      )
      .orderBy(asc(cronJobs.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'cron_job' as const,
      title: r.name,
      subtitle: ctx.panel === 'admin'
        ? [r.tenantName, r.schedule].filter(Boolean).join(' · ') || null
        : r.schedule,
      href: ctx.panel === 'admin' ? '/tenants/cron-jobs' : '/cron-jobs',
      badge: null,
    }));
  },
};

const userProvider: SearchProvider = {
  type: 'user',
  scope: 'tenant',
  label: 'Users',
  panels: ['admin'],
  // Mirrors admin-users/routes.ts — reading the user directory is a
  // super_admin/admin capability, NOT a read_only or support one.
  roles: ADMIN_ONLY,
  async run(db, _ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        roleName: users.roleName,
        panel: users.panel,
        tenantName: tenants.name,
      })
      .from(users)
      .leftJoin(tenants, eq(users.tenantId, tenants.id))
      .where(or(ilike(users.email, pattern), ilike(users.fullName, pattern)))
      .orderBy(asc(users.email))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'user' as const,
      title: r.fullName ?? r.email,
      subtitle: [r.email !== r.fullName ? r.email : null, r.tenantName]
        .filter(Boolean).join(' · ') || null,
      href: r.panel === 'tenant' ? '/tenants/users' : '/security/identity',
      badge: r.roleName,
    }));
  },
};

const sftpUserProvider: SearchProvider = {
  type: 'sftp_user',
  scope: 'tenant',
  label: 'SFTP Users',
  panels: ['admin', 'tenant'],
  roles: [...ADMIN_ONLY, ...TENANT_ANY],
  async run(db, ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        id: sftpUsers.id,
        username: sftpUsers.username,
        homePath: sftpUsers.homePath,
        tenantId: sftpUsers.tenantId,
        tenantName: tenants.name,
      })
      .from(sftpUsers)
      .leftJoin(tenants, eq(sftpUsers.tenantId, tenants.id))
      .where(
        allOf(
          or(ilike(sftpUsers.username, pattern), ilike(sftpUsers.description, pattern)),
          tenantScope(ctx, sftpUsers.tenantId),
        ),
      )
      .orderBy(asc(sftpUsers.username))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'sftp_user' as const,
      title: r.username,
      subtitle: ctx.panel === 'admin'
        ? [r.tenantName, r.homePath].filter(Boolean).join(' · ') || null
        : r.homePath,
      href: ctx.panel === 'admin' ? `/tenants/${r.tenantId}` : '/sftp',
      badge: null,
    }));
  },
};

const sshKeyProvider: SearchProvider = {
  type: 'ssh_key',
  scope: 'tenant',
  label: 'SSH Keys',
  panels: ['admin', 'tenant'],
  roles: [...ADMIN_ONLY, ...TENANT_ANY],
  async run(db, ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        id: sshKeys.id,
        name: sshKeys.name,
        keyAlgorithm: sshKeys.keyAlgorithm,
        tenantId: sshKeys.tenantId,
        tenantName: tenants.name,
      })
      .from(sshKeys)
      .leftJoin(tenants, eq(sshKeys.tenantId, tenants.id))
      .where(
        allOf(
          or(ilike(sshKeys.name, pattern), ilike(sshKeys.keyFingerprint, pattern)),
          tenantScope(ctx, sshKeys.tenantId),
        ),
      )
      .orderBy(asc(sshKeys.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'ssh_key' as const,
      title: r.name,
      subtitle: ctx.panel === 'admin' ? r.tenantName : null,
      href: ctx.panel === 'admin' ? `/tenants/${r.tenantId}` : '/ssh-keys',
      badge: r.keyAlgorithm,
    }));
  },
};

const privateWorkerProvider: SearchProvider = {
  type: 'private_worker',
  scope: 'tenant',
  label: 'Private Workers',
  panels: ['tenant'],
  roles: TENANT_ANY,
  async run(db, ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        id: privateWorkers.id,
        name: privateWorkers.name,
        status: privateWorkers.status,
      })
      .from(privateWorkers)
      .where(
        allOf(
          or(ilike(privateWorkers.name, pattern), ilike(privateWorkers.slug, pattern)),
          tenantScope(ctx, privateWorkers.tenantId),
        ),
      )
      .orderBy(asc(privateWorkers.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'private_worker' as const,
      title: r.name,
      subtitle: null,
      href: '/private-workers',
      badge: r.status,
    }));
  },
};

const nodeProvider: SearchProvider = {
  type: 'node',
  scope: 'platform',
  label: 'Nodes',
  panels: ['admin'],
  // Mirrors nodes/routes.ts, which gates the whole plugin on super_admin/admin.
  roles: ADMIN_ONLY,
  async run(db, _ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        name: clusterNodes.name,
        displayName: clusterNodes.displayName,
        role: clusterNodes.role,
      })
      .from(clusterNodes)
      .where(or(ilike(clusterNodes.name, pattern), ilike(clusterNodes.displayName, pattern)))
      .orderBy(asc(clusterNodes.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.name,
      type: 'node' as const,
      title: r.displayName ?? r.name,
      subtitle: r.displayName ? r.name : null,
      href: '/cluster/nodes',
      badge: r.role,
    }));
  },
};

const catalogProvider: SearchProvider = {
  type: 'catalog_entry',
  scope: 'platform',
  label: 'Catalog',
  panels: ['admin', 'tenant'],
  roles: [...STAFF_READ, ...TENANT_ANY],
  async run(db, ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({
        id: catalogEntries.id,
        name: catalogEntries.name,
        code: catalogEntries.code,
        type: catalogEntries.type,
      })
      .from(catalogEntries)
      .where(
        allOf(
          // `disabled` is an integer flag (0/1), not a boolean column.
          eq(catalogEntries.disabled, 0),
          or(ilike(catalogEntries.name, pattern), ilike(catalogEntries.code, pattern)),
        ),
      )
      .orderBy(asc(catalogEntries.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'catalog_entry' as const,
      title: r.name,
      subtitle: r.code,
      href: ctx.panel === 'admin' ? '/applications?tab=catalog' : '/applications?tab=catalog',
      badge: r.type,
    }));
  },
};

const planProvider: SearchProvider = {
  type: 'hosting_plan',
  scope: 'platform',
  label: 'Hosting Plans',
  panels: ['admin'],
  roles: ADMIN_ONLY,
  async run(db, _ctx, term, limit) {
    const pattern = likePattern(term);
    const rows = await db
      .select({ id: hostingPlans.id, name: hostingPlans.name, code: hostingPlans.code })
      .from(hostingPlans)
      .where(or(ilike(hostingPlans.name, pattern), ilike(hostingPlans.code, pattern)))
      .orderBy(asc(hostingPlans.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'hosting_plan' as const,
      title: r.name,
      subtitle: r.code,
      href: '/platform/plans',
      badge: null,
    }));
  },
};

const backupTargetProvider: SearchProvider = {
  type: 'backup_target',
  scope: 'platform',
  label: 'Remote Storage Targets',
  panels: ['admin'],
  roles: ADMIN_ONLY,
  async run(db, _ctx, term, limit) {
    const rows = await db
      .select({
        id: backupConfigurations.id,
        name: backupConfigurations.name,
        storageType: backupConfigurations.storageType,
      })
      .from(backupConfigurations)
      .where(ilike(backupConfigurations.name, likePattern(term)))
      .orderBy(asc(backupConfigurations.name))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      type: 'backup_target' as const,
      title: r.name,
      subtitle: null,
      href: '/backups/targets',
      badge: r.storageType,
    }));
  },
};

/**
 * Registration order is dropdown order. Records the user is most likely
 * to be hunting for come first.
 */
export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  tenantProvider,
  domainProvider,
  deploymentProvider,
  mailboxProvider,
  cronJobProvider,
  userProvider,
  sftpUserProvider,
  sshKeyProvider,
  privateWorkerProvider,
  nodeProvider,
  catalogProvider,
  planProvider,
  backupTargetProvider,
];
