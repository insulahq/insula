import { z } from 'zod';

// Global search — the header search box in both panels.
//
// One aggregated endpoint rather than a per-entity fan-out. Two reasons:
// the panel would otherwise spend ~10 list calls per keystroke against a
// 100 req/min per-user rate limit, and — the one that matters — every
// tenant-scoping decision would move into the frontend, where it cannot
// be enforced. Here the caller sends only `q`; panel, role and tenantId
// all come off the verified JWT.
//
// Read-only by construction: every result is a destination. Nothing in
// this contract can mutate anything.

/**
 * What kind of record a hit refers to. `setting` is the client-side
 * static registry (pages + tabs) and never comes back from the API —
 * it is declared here so both sides agree on one union.
 */
export const searchResultTypeSchema = z.enum([
  'setting',
  'tenant',
  'domain',
  'deployment',
  'mailbox',
  'cron_job',
  'user',
  'sftp_user',
  'ssh_key',
  'private_worker',
  'node',
  'catalog_entry',
  'hosting_plan',
  'backup_target',
]);
export type SearchResultType = z.infer<typeof searchResultTypeSchema>;

export const searchItemSchema = z.object({
  /** Stable within a result set; used as the React key and aria-activedescendant target. */
  id: z.string(),
  type: searchResultTypeSchema,
  /** Primary line — the thing the user typed part of. */
  title: z.string(),
  /** Secondary line: owning tenant, status, path. Null when there is nothing useful to add. */
  subtitle: z.string().nullable(),
  /** In-app route to navigate to on select. Always same-origin and relative. */
  href: z.string(),
  /** Optional short status chip (`active`, `suspended`, `Ready`). */
  badge: z.string().nullable(),
});
export type SearchItem = z.infer<typeof searchItemSchema>;

export const searchGroupSchema = z.object({
  type: searchResultTypeSchema,
  /** Heading rendered above the group ("Tenants", "Mailboxes"). */
  label: z.string(),
  items: z.array(searchItemSchema),
  /** True when the provider had more rows than the per-group cap. */
  truncated: z.boolean(),
});
export type SearchGroup = z.infer<typeof searchGroupSchema>;

/**
 * Minimum 2 characters: a 1-char query matches most of the estate and the
 * result is useless noise, so the client does not send it and the server
 * rejects it. Max 64 keeps the `ilike` patterns bounded.
 */
export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 64;

/** Rows per group. Deliberately small — this is a dropdown, not a report. */
export const SEARCH_GROUP_LIMIT = 5;

export const searchQuerySchema = z.object({
  q: z.string().min(SEARCH_MIN_QUERY_LENGTH).max(SEARCH_MAX_QUERY_LENGTH),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResponseSchema = z.object({
  groups: z.array(searchGroupSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
