/**
 * App preview — view a running deployment in a sandboxed iframe BEFORE
 * (or without) assigning an ingress route.
 *
 * Flow: the panel POSTs …/deployments/:id/preview-session (Bearer) and
 * receives a short-lived, HMAC-signed proxy URL. The iframe loads that
 * URL; the backend proxies it to the workload's ClusterIP Service.
 * Every proxied response carries `Content-Security-Policy: sandbox` so
 * tenant-controlled content can never run with the panel's origin
 * privileges — not even when the URL is opened top-level.
 */
import { z } from 'zod';

export const previewTargetSchema = z.object({
  /** ClusterIP Service object name inside the tenant namespace. */
  serviceName: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  /** Component (catalog) or stack-service (custom) the port belongs to. */
  memberName: z.string().nullable(),
  /** Declared port name when the spec has one (custom deployments). */
  portName: z.string().nullable(),
  /** True for the port an ingress route would bind to — the default pick. */
  primary: z.boolean(),
});
export type PreviewTarget = z.infer<typeof previewTargetSchema>;

export const createPreviewSessionRequestSchema = z.object({
  /** Pick a specific target (from a previous response's `targets`).
   *  Omitted → the primary target. */
  serviceName: z.string().min(1).max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type CreatePreviewSessionRequest = z.infer<typeof createPreviewSessionRequestSchema>;

export const previewSessionSchema = z.object({
  /** Root-relative proxy URL (same origin as the panel) — iframe `src`. */
  url: z.string().min(1),
  expiresAt: z.string(),
  target: previewTargetSchema,
  /** All previewable targets of this deployment, for a picker. */
  targets: z.array(previewTargetSchema),
});
export type PreviewSession = z.infer<typeof previewSessionSchema>;

export const createPreviewSessionResponseSchema = z.object({
  data: previewSessionSchema,
});
export type CreatePreviewSessionResponse = z.infer<typeof createPreviewSessionResponseSchema>;
