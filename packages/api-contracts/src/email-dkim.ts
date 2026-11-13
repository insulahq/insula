import { z } from 'zod';

/**
 * DKIM signing keys of one email domain, as the mail server holds them.
 *
 * GET /api/v1/tenants/:tenantId/email-domains/:emailDomainId/dkim/keys
 * POST /api/v1/tenants/:tenantId/email-domains/:emailDomainId/dkim/rotate
 *
 * Both take the EMAIL-DOMAIN id (`email_domains.id`), not the domain id the
 * `/email/domains/:domainId/...` routes take.
 */

export const dkimKeyAlgorithmEnum = z.enum(['rsa', 'ed25519', 'other']);

export const dkimKeySchema = z.object({
  selector: z.string(),
  algorithm: dkimKeyAlgorithmEnum,
  /** The mail server's own stage for the key (`active` when it signs); null when it reports none. */
  stage: z.string().nullable(),
  /** The selector the most recent rotation (or enable) signed with. */
  current: z.boolean(),
  /** `<selector>._domainkey.<domain>` */
  txtRecordName: z.string(),
  /** The TXT value the platform published for this selector; null when it holds none. */
  txtRecordValue: z.string().nullable(),
});

export type DkimKey = z.infer<typeof dkimKeySchema>;

export const dkimKeysResponseSchema = z.object({
  /** False while the domain is not yet set up on the mail server — it has no keys to list. */
  provisioned: z.boolean(),
  keys: z.array(dkimKeySchema),
});

export type DkimKeysResponse = z.infer<typeof dkimKeysResponseSchema>;

export const dkimRotateResultSchema = z.object({
  /** 'dkim-1' | 'dkim-2' — selectors alternate on each rotation. */
  newSelector: z.string(),
  /** Stays published and signing for mail in transit; null on legacy domains. */
  previousSelector: z.string().nullable(),
  newPublicKey: z.string(),
  txtRecordName: z.string(),
  txtRecordValue: z.string(),
  stalwartDkimSignatureId: z.string(),
  destroyedSelectors: z.array(z.string()),
});

export type DkimRotateResult = z.infer<typeof dkimRotateResultSchema>;

/**
 * The private key of the selector that signs the domain's mail, for signing
 * from another mail server with the same key (so the published record keeps
 * verifying both).
 *
 * GET /api/v1/tenants/:tenantId/email-domains/:emailDomainId/dkim/private-key
 *
 * tenant_admin and staff only, behind a fresh step-up (purpose
 * `dkim_private_key`); every answer is audited and sent `no-store`.
 */
export const dkimPrivateKeySchema = z.object({
  /** The `d=` tag a signature made with this key must carry. */
  domain: z.string(),
  /** The `s=` tag; its public key is published at `txtRecordName`. */
  selector: z.string(),
  algorithm: dkimKeyAlgorithmEnum,
  txtRecordName: z.string(),
  /** Whether the platform holds a TXT record for the selector. */
  published: z.boolean(),
  /** PKCS#8 PEM, as the mail server holds it. */
  privateKeyPem: z.string(),
});

export type DkimPrivateKey = z.infer<typeof dkimPrivateKeySchema>;
