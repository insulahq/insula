import { z } from 'zod';
import { uuidField } from './shared.js';

/**
 * Per-domain TLS detail and the on-demand reissue action.
 *
 * Separate from `domains.ts` (which carries a one-line badge summary)
 * because this is the diagnostic view: every Certificate the domain
 * owns, what cert-manager says about each, and whether the tenant is
 * allowed to ask for a new one right now.
 */

export const certificateStateSchema = z.enum(['issued', 'issuing', 'failed', 'unknown']);

export const certificateDetailSchema = z.object({
  /** cert-manager Certificate CR name. */
  name: z.string(),
  state: certificateStateSchema,
  dnsNames: z.array(z.string()),
  wildcard: z.boolean(),
  secretName: z.string().nullable(),
  issuerName: z.string().nullable(),
  /** Why it is not issued — verbatim from cert-manager. */
  message: z.string().nullable(),
  failedAttempts: z.number(),
  lastFailureAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export const domainTlsStatusSchema = z.object({
  domainId: uuidField,
  domainName: z.string(),
  /** Aggregate state the panels badge on. */
  state: certificateStateSchema,
  wildcardCapable: z.boolean(),
  /** Why a wildcard is not possible for this domain, when it isn't. */
  wildcardBlockedReason: z.string().nullable(),
  fallbackActive: z.boolean(),
  autoTlsEnabled: z.boolean(),
  certificates: z.array(certificateDetailSchema),
  /** null when a reissue may be requested now. */
  reissueAvailableAt: z.string().nullable(),
});

export const certificateReissueResponseSchema = z.object({
  taskId: uuidField,
  domainId: uuidField,
  certificateName: z.string(),
});

export type CertificateState = z.infer<typeof certificateStateSchema>;
export type CertificateDetail = z.infer<typeof certificateDetailSchema>;
export type DomainTlsStatus = z.infer<typeof domainTlsStatusSchema>;
export type CertificateReissueResponse = z.infer<typeof certificateReissueResponseSchema>;
