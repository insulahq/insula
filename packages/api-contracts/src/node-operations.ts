import { z } from 'zod';

/**
 * Operator actions on a node — node-health recovery and Longhorn disk tuning.
 *
 * Both shapes previously existed twice: once in the admin panel as a local
 * interface, once in the backend. `recycle-pod` at least validated, via a
 * hand-written Fastify JSON schema that restated the same fields a third time;
 * the disk PATCH did not validate at all — it cast `request.body ?? {}` — so a
 * misspelled field there was not a 400 but a no-op patch returning 200.
 */

export const recyclePodSchema = z.object({
  node: z.string().min(1),
  namespace: z.string().min(1),
  podName: z.string().min(1),
  reason: z.string().min(3).max(500),
}).strict();
export type RecyclePodInput = z.infer<typeof recyclePodSchema>;
/** Wire shape — what the panel sends. */
export type RecyclePodRequest = z.input<typeof recyclePodSchema>;

/**
 * At least one field must be present: an empty body would build an empty JSON
 * patch and report success without changing anything.
 */
export const patchNodeDiskSchema = z.object({
  storageReserved: z.number().int().min(0).optional(),
  allowScheduling: z.boolean().optional(),
}).strict().refine(
  (v) => v.storageReserved !== undefined || v.allowScheduling !== undefined,
  { message: 'at least one of storageReserved or allowScheduling is required' },
);
export type PatchNodeDiskInput = z.infer<typeof patchNodeDiskSchema>;
export type PatchNodeDiskRequest = z.input<typeof patchNodeDiskSchema>;
