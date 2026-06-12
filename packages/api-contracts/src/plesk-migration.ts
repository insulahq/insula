import { z } from 'zod';

// R1 PR 1 — Plesk migration source registry + discovery.

const hostnameField = z.string().min(1).max(255).regex(
  /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/,
  'Invalid hostname or IP',
);

export const createPleskSourceSchema = z.object({
  name: z.string().min(1).max(255),
  hostname: hostnameField,
  ssh_port: z.number().int().min(1).max(65535).optional(),
  ssh_user: z.string().min(1).max(64).optional(),
  // PEM private key — write-only; never returned. Stored AES-encrypted.
  ssh_private_key: z.string().min(1).max(32768),
});

export const updatePleskSourceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  hostname: hostnameField.optional(),
  ssh_port: z.number().int().min(1).max(65535).optional(),
  ssh_user: z.string().min(1).max(64).optional(),
  ssh_private_key: z.string().min(1).max(32768).optional(),
}).strict();

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
});

export const pleskSubscriptionSchema = z.object({
  name: z.string(),
  sysUser: z.string().nullable(),
  domains: z.array(pleskDomainSchema),
  databases: z.array(pleskDatabaseSchema),
  mailboxes: z.array(pleskMailboxSchema),
  cronCount: z.number(),
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

export type CreatePleskSourceInput = z.infer<typeof createPleskSourceSchema>;
export type UpdatePleskSourceInput = z.infer<typeof updatePleskSourceSchema>;
export type PleskInventory = z.infer<typeof pleskInventorySchema>;
export type PleskSubscription = z.infer<typeof pleskSubscriptionSchema>;
export type PleskSourceResponse = z.infer<typeof pleskSourceResponseSchema>;
export type PleskDiscoveryResponse = z.infer<typeof pleskDiscoveryResponseSchema>;
