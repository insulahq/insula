import { z } from 'zod';

/**
 * Certificate download — scoped tokens + the PEM bundle endpoint.
 *
 * Why a dedicated credential rather than the normal session JWT:
 *
 *   * It has to work under OIDC. When the platform is configured for SSO
 *     there is no password grant to script against, so an external web server
 *     could never fetch its own renewed certificate. A cert token is an opaque
 *     string checked against `cert_download_tokens`, so the download route
 *     never touches the JWT/OIDC path at all.
 *   * It has to be revocable instantly, which a stateless JWT is not.
 *   * It is bound to ONE domain, so a leak exposes that domain's certificate
 *     and nothing else — no panel access, no other domain, no other tenant.
 *
 * A link is a one-off hand-over (24 hours at most). Unattended pickup of a
 * renewed certificate (Let's Encrypt renews every 90 days) calls the download
 * route with an API token, which needs no step-up.
 */

/**
 * How long a download link lives. Links are temporary: a one-off hand-over to
 * another server, 24 hours at most, reaped once expired. Unattended pickup of
 * a renewed certificate uses an API token on the download route instead.
 */
export const certTokenExpirySchema = z.enum(['15m', '1h', '24h']);
export type CertTokenExpiry = z.infer<typeof certTokenExpirySchema>;
/** The longest a link may live, enforced by the server whatever it was minted with. */
export const CERT_TOKEN_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const createCertTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiry: certTokenExpirySchema.default('1h'),
}).strict();
export type CreateCertTokenInput = z.infer<typeof createCertTokenInputSchema>;

/** A token as listed in the panel. Never carries the secret. */
export const certTokenSchema = z.object({
  id: z.string(),
  domainId: z.string(),
  name: z.string(),
  /** ISO date; every link expires. */
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  /**
   * True once expiresAt has passed. The reaper deletes an expired link within
   * minutes; the record that it existed is its audit entry.
   */
  expired: z.boolean(),
});
export type CertToken = z.infer<typeof certTokenSchema>;

/**
 * Creation response. `token` is the ONLY time the plaintext exists outside the
 * caller's machine — the server stores sha256 and cannot recover it. The panel
 * must surface that clearly and offer a copy control.
 */
export const createCertTokenResponseSchema = certTokenSchema.extend({
  token: z.string(),
});
export type CreateCertTokenResponse = z.infer<typeof createCertTokenResponseSchema>;

/**
 * Where a downloadable bundle came from.
 *   `managed`  — issued by cert-manager (Let's Encrypt or the internal CA);
 *                the private key lives in the tenant's TLS Secret.
 *   `uploaded` — supplied by the customer and stored encrypted at rest.
 */
export const certBundleSourceSchema = z.enum(['managed', 'uploaded']);
export type CertBundleSource = z.infer<typeof certBundleSourceSchema>;

/**
 * Whether a domain currently has anything to download, so the panel can show a
 * disabled button with a reason instead of a failing request.
 */
export const certDownloadAvailabilitySchema = z.object({
  available: z.boolean(),
  source: certBundleSourceSchema.nullable(),
  /** Operator-facing reason when `available` is false. */
  reason: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type CertDownloadAvailability = z.infer<typeof certDownloadAvailabilitySchema>;
