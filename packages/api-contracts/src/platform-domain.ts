import { z } from 'zod';

/**
 * R16 — turnkey platform-apex rename.
 *
 * POST /admin/platform-domain/rename moves every reconciler-driven platform
 * hostname (admin|tenant|webmail|mail.<apex>) + its TLS cert to `newApex`,
 * leaving the tenant CNAME-target domain (ingress_base_domain) untouched.
 */
export const renamePlatformDomainSchema = z.object({
  newApex: z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      'newApex must be a fully-qualified domain (e.g. brand.example.com)',
    ),
});

export type RenamePlatformDomainInput = z.infer<typeof renamePlatformDomainSchema>;
