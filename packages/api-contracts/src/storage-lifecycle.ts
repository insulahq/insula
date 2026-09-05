import { z } from 'zod';

/**
 * Storage-lifecycle settings — PATCH /admin/settings/storage-lifecycle.
 *
 * Moved here from backend/src/modules/storage-lifecycle/settings.ts. It lived
 * in the backend while the admin panel kept its own hand-written
 * `StorageLifecycleSettingsUpdate`; two copies of one shape, with nothing able
 * to compare them. This file is now the only copy.
 */
export const storageLifecycleSettingsSchema = z.object({
  backend: z.enum(['hostpath', 's3', 'azure']).optional(),
  hostpathRoot: z.string().min(1).max(255).optional(),

  s3Bucket: z.string().min(1).max(255).nullable().optional(),
  s3Region: z.string().min(1).max(64).nullable().optional(),
  s3Endpoint: z.string().url().nullable().optional(),
  s3AccessKeyId: z.string().min(1).max(255).nullable().optional(),
  s3SecretAccessKey: z.string().min(1).max(255).nullable().optional(),

  azureContainer: z.string().min(1).max(255).nullable().optional(),
  azureConnectionString: z.string().min(1).max(2048).nullable().optional(),

  retentionManualDays: z.number().int().min(1).max(3650).optional(),
  retentionPreResizeDays: z.number().int().min(1).max(3650).optional(),
  retentionPreArchiveDays: z.number().int().min(1).max(3650).optional(),
});

export type StorageLifecycleSettingsInput = z.infer<typeof storageLifecycleSettingsSchema>;
/** Wire shape — what the client sends (defaults optional). */
export type StorageLifecycleSettingsRequest = z.input<typeof storageLifecycleSettingsSchema>;
