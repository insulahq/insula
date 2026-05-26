import { z } from 'zod';

/**
 * Per-mail-node storage card data — one entry per mail-relevant
 * node (active + primary/secondary/tertiary placement slots +
 * standby-labelled nodes). Drives the "Storage" tab on
 * /email/operations.
 *
 * GET /admin/mail/storage/per-node
 */

export const mailNodeStorageSchema = z.object({
  nodeName: z.string(),
  /** Role tags for this node; one node may carry multiple (e.g. ['active','primary']). */
  roles: z.array(z.enum(['active', 'primary', 'secondary', 'tertiary', 'standby'])),
  isActive: z.boolean(),
  isStandby: z.boolean(),
  /** Node allocatable ephemeral-storage capacity (total disk headroom kubelet reports). */
  totalBytes: z.number().int().nonnegative().nullable(),
  /** Sum of PVC requests bound to PVs pinned on this node. */
  scheduledBytes: z.number().int().nonnegative().nullable(),
  /** Mail data actually consumed on this node (du for active; standby report for standby). */
  mailUsedBytes: z.number().int().nonnegative().nullable(),
  /** ISO timestamp of the mailUsed measurement. Always an ISO datetime —
   *  the frontend's formatAge() helper renders the string 'live' when
   *  the timestamp is < 5 s old. */
  mailUsedReportedAt: z.string().nullable(),
});

export type MailNodeStorage = z.infer<typeof mailNodeStorageSchema>;

export const mailNodeStorageResponseSchema = z.object({
  nodes: z.array(mailNodeStorageSchema),
});

export type MailNodeStorageResponse = z.infer<typeof mailNodeStorageResponseSchema>;
