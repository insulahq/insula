import { z } from 'zod';

// R1 PR 1 — Plesk migration source registry + discovery.

const hostnameField = z.string().min(1).max(255).regex(
  /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/,
  'Invalid hostname or IP',
);

// Auth: a source authenticates over SSH with EITHER a private key OR a
// password. Exactly one must be supplied on create. Both are write-only,
// stored AES-encrypted, and never returned.
export const createPleskSourceSchema = z.object({
  name: z.string().min(1).max(255),
  hostname: hostnameField,
  ssh_port: z.number().int().min(1).max(65535).optional(),
  ssh_user: z.string().min(1).max(64).optional(),
  // PEM private key — write-only; never returned. Stored AES-encrypted.
  ssh_private_key: z.string().min(1).max(32768).optional(),
  // SSH password — write-only; never returned. Stored AES-encrypted.
  ssh_password: z.string().min(1).max(1024).optional(),
}).refine(
  (d) => (d.ssh_private_key ? 1 : 0) + (d.ssh_password ? 1 : 0) === 1,
  { message: 'Provide exactly one of ssh_private_key or ssh_password' },
);

export const updatePleskSourceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  hostname: hostnameField.optional(),
  ssh_port: z.number().int().min(1).max(65535).optional(),
  ssh_user: z.string().min(1).max(64).optional(),
  // Supplying either credential switches the source's auth method and
  // replaces the stored secret. Supplying both is rejected.
  ssh_private_key: z.string().min(1).max(32768).optional(),
  ssh_password: z.string().min(1).max(1024).optional(),
}).strict().refine(
  (d) => !(d.ssh_private_key && d.ssh_password),
  { message: 'Provide at most one of ssh_private_key or ssh_password' },
);

// ── Discovery inventory shape (assembled by the discovery Job) ──
export const pleskMailboxSchema = z.object({
  address: z.string(),
  quotaMb: z.number().nullable(),
  // per-account password storage type from psa.accounts.
  passwordType: z.string().nullable(),
});

export const pleskDatabaseSchema = z.object({
  name: z.string(),
  type: z.string(),
  sizeBytes: z.number().nullable(),
});

export const pleskDomainSchema = z.object({
  name: z.string(),
  docRoot: z.string().nullable(),
  phpVersion: z.string().nullable(),
  // Plesk DNS zone type for the domain: 'master' = Plesk is the primary
  // (authoritative) DNS, 'slave' = secondary, null = external DNS. Drives the
  // migrated domain's dns_mode. Default null so pre-this-change snapshots parse.
  dnsZoneType: z.enum(['master', 'slave']).nullable().default(null),
});

export const pleskSubscriptionSchema = z.object({
  name: z.string(),
  sysUser: z.string().nullable(),
  domains: z.array(pleskDomainSchema),
  databases: z.array(pleskDatabaseSchema),
  mailboxes: z.array(pleskMailboxSchema),
  cronCount: z.number(),
  // Raw active crontab lines (comments/blanks stripped) for the subscription's
  // system user. Default [] so snapshots taken before the cron leg still parse.
  cronLines: z.array(z.string()).default([]),
  mailBytes: z.number().nullable(),
});

export const pleskInventorySchema = z.object({
  pleskVersion: z.string().nullable(),
  osVersion: z.string().nullable(),
  // 'sym' | 'crypt' | 'mixed' | null — server-wide password storage.
  passwordStorage: z.string().nullable(),
  subscriptions: z.array(pleskSubscriptionSchema),
});

export const pleskSourceResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  sshPort: z.number(),
  sshUser: z.string(),
  // Which credential the source authenticates with (the secret itself is
  // never returned).
  authMethod: z.enum(['key', 'password']),
  pleskVersion: z.string().nullable(),
  passwordStorage: z.string().nullable(),
  lastDiscoveredAt: z.union([z.string(), z.date()]).nullable(),
  status: z.string(),
  createdAt: z.union([z.string(), z.date()]),
});

export const pleskDiscoveryResponseSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  startedAt: z.union([z.string(), z.date()]),
  completedAt: z.union([z.string(), z.date()]).nullable(),
  inventory: pleskInventorySchema.nullable(),
  error: z.string().nullable(),
});

// ── R1 PR 2 — provision a discovered subscription onto the platform ──
//
// A `plesk_migration` provisions ONE Plesk subscription (the snapshot
// frozen at create-time) into a platform tenant: the tenant itself, its
// domains, and email for the domains that host mailboxes. Content/DB and
// mail-data legs land in later PRs as additional entries in `legs`.

export const createPleskMigrationSchema = z.object({
  source_id: z.string().min(1),
  // Pin to a specific completed discovery's snapshot; omit to use the
  // source's most recent completed discovery.
  discovery_id: z.string().min(1).optional(),
  // The Plesk subscription (its main domain name) to migrate.
  subscription_name: z.string().min(1).max(255),
  // Map onto an EXISTING, already-sized tenant. The operator creates and
  // sizes the tenant first (plan / PVC / CPU / memory / mailbox limits) via
  // the normal tenant flow; the migration then maps the subscription onto it
  // and runs a capacity preflight. Plesk service plans don't map 1:1, so
  // there is no auto-create — the operator owns sizing.
  target_tenant_id: z.string().min(1),
});

const legStatus = z.enum(['pending', 'running', 'completed', 'failed', 'skipped', 'partial']);

export const pleskMigrationLegItemSchema = z.object({
  name: z.string(),
  status: z.enum(['completed', 'failed', 'skipped']),
  message: z.string().nullable().optional(),
});

export const pleskMigrationLegSchema = z.object({
  status: legStatus,
  startedAt: z.union([z.string(), z.date()]).nullable().optional(),
  completedAt: z.union([z.string(), z.date()]).nullable().optional(),
  detail: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  // Per-item outcomes (one per domain / database / mailbox …).
  items: z.array(pleskMigrationLegItemSchema).optional(),
});

// Known legs are optional (a migration in flight has only some populated);
// catchall lets later PRs add content/db/mail legs without a contract bump.
export const pleskMigrationLegsSchema = z
  .object({
    // `preflight` = validate the mapped tenant + capacity-check. (Rows from
    // before the tenant-first redesign used `tenant`; the catchall covers it.)
    preflight: pleskMigrationLegSchema.optional(),
    domains: pleskMigrationLegSchema.optional(),
    email: pleskMigrationLegSchema.optional(),
    databases: pleskMigrationLegSchema.optional(),
    content: pleskMigrationLegSchema.optional(),
    mail: pleskMigrationLegSchema.optional(),
    cron: pleskMigrationLegSchema.optional(),
  })
  .catchall(pleskMigrationLegSchema);

export const pleskMigrationResponseSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  discoveryId: z.string().nullable(),
  subscriptionName: z.string(),
  targetPlanId: z.string().nullable(),
  targetTenantId: z.string().nullable(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'partial']),
  legs: pleskMigrationLegsSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]).nullable(),
});

export type CreatePleskSourceInput = z.infer<typeof createPleskSourceSchema>;
export type UpdatePleskSourceInput = z.infer<typeof updatePleskSourceSchema>;
export type PleskInventory = z.infer<typeof pleskInventorySchema>;
export type PleskSubscription = z.infer<typeof pleskSubscriptionSchema>;
export type PleskMailbox = z.infer<typeof pleskMailboxSchema>;
export type PleskDomain = z.infer<typeof pleskDomainSchema>;
export type PleskDatabase = z.infer<typeof pleskDatabaseSchema>;
export type PleskSourceResponse = z.infer<typeof pleskSourceResponseSchema>;
export type PleskDiscoveryResponse = z.infer<typeof pleskDiscoveryResponseSchema>;
export type CreatePleskMigrationInput = z.infer<typeof createPleskMigrationSchema>;
export type PleskMigrationLeg = z.infer<typeof pleskMigrationLegSchema>;
export type PleskMigrationLegs = z.infer<typeof pleskMigrationLegsSchema>;
export type PleskMigrationResponse = z.infer<typeof pleskMigrationResponseSchema>;
