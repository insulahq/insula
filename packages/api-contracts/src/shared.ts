import { z } from 'zod';

// ─── Pagination ──────────────────────────────────────────────────────────────

/** Backend maximum for any list endpoint */
export const MAX_PAGE_LIMIT = 100;

export const paginationParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(20),
  cursor: z.string().optional(),
  sort: z.string().optional(),
  search: z.string().optional(),
});

export type PaginationParams = z.infer<typeof paginationParamsSchema>;

export const paginationMetaSchema = z.object({
  total_count: z.number(),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
  page_size: z.number(),
});

export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

// ─── API Response Envelopes ──────────────────────────────────────────────────

export function paginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    pagination: paginationMetaSchema,
  });
}

export function dataResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
  });
}

// ─── Common Fields ───────────────────────────────────────────────────────────

// Tenant lifecycle status. `archived` means the tenant was off-boarded:
// PVC destroyed, snapshot retained for the configured grace period, but
// the account still exists so it can be restored. See storage-lifecycle/.
//
// The terminal operation is "delete" — a verb, not a persistent state —
// which hard-removes the tenant row from the database. There is no
// `deleted` value in the enum; a deleted tenant simply doesn't exist.
export const tenantStatusEnum = z.enum(['active', 'suspended', 'pending', 'archived']);
export type TenantStatus = z.infer<typeof tenantStatusEnum>;

// Storage lifecycle state machine — orthogonal to tenant.status.
// Lives on `tenants.storage_lifecycle_state`. Callers should treat any
// value other than `idle` as "an orchestrator is currently operating
// on this tenant's PVC; UI should disable destructive actions."
export const storageLifecycleStateEnum = z.enum([
  'idle',
  'snapshotting',
  'quiescing',
  'resizing',
  'replacing',
  'restoring',
  'unquiescing',
  'archiving',
  'failed',
]);
export type StorageLifecycleState = z.infer<typeof storageLifecycleStateEnum>;

export const uuidField = z.string().uuid();

// ─── Shared Patterns ────────────────────────────────────────────────────────

/** GitHub repository URL pattern — shared by workload-repos and application-repos */
export const githubUrlPattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

// ─── Identity email ──────────────────────────────────────────────────────────

/**
 * An email address used as an ACCOUNT IDENTITY, normalised to lowercase.
 *
 * Every account lookup compares this value, and an identity provider is free to
 * vary the casing it asserts between logins. Before this was normalised, an IdP
 * returning `Staff@Example.test` for an account stored as `staff@example.test`
 * matched nothing — and on the OIDC tenant path that does not fail the login, it
 * falls through to auto-provisioning and creates an ENTIRELY NEW TENANT for
 * someone who already had an account.
 *
 * The domain part is case-insensitive per RFC 5321. The local part is
 * technically case-sensitive, but no mainstream provider treats it that way, and
 * operators universally expect addresses to compare case-insensitively.
 *
 * Use this for identity fields only (login, user create, tenant primary email).
 * A plain `z.string().email()` is still right for a free-text contact address
 * that is displayed rather than matched.
 */
export const identityEmailSchema = z
  .string()
  .email()
  .transform((v) => v.trim().toLowerCase());
