import { z } from 'zod';

/**
 * DNS servers — /admin/dns-servers.
 *
 * The provider-GROUP schemas already existed in domains.ts. The admin panel
 * still carried its own copy and the route parsed with neither: three copies of
 * one shape. Group work now uses the domains.ts schemas; only the server shapes
 * are defined here, because those had no contract at all.
 *
 * Authored from the shapes the BACKEND service reads
 * (backend/src/modules/dns-servers/service.ts), not from what the admin panel
 * happened to declare. The two were identical when this was written — which is
 * the point: they were two uncoupled copies with nothing able to compare them,
 * the same arrangement that let the OIDC provider form drift to tenant_id /
 * tenant_secret and ship broken.
 *
 * The routes previously took `request.body as unknown as X` with a truthiness
 * check for the required fields, so a wrong field name produced a generic
 * "missing required field" at best and a silent partial write at worst. They
 * now parse with these schemas.
 */

export const dnsProviderRole = ['primary', 'secondary'] as const;
export const dnsZoneDefaultKind = ['Native', 'Master'] as const;

export const createDnsServerSchema = z.object({
  display_name: z.string().min(1, 'display_name is required').max(255),
  provider_type: z.string().min(1, 'provider_type is required').max(64),
  connection_config: z.record(z.string(), z.unknown()),
  zone_default_kind: z.enum(dnsZoneDefaultKind).optional(),
  is_default: z.boolean().optional(),
  enabled: z.boolean().optional(),
  group_id: z.string().optional(),
  role: z.enum(dnsProviderRole).optional(),
}).strict();
export type CreateDnsServerInput = z.infer<typeof createDnsServerSchema>;
/** Wire shape — what the panel sends. */
export type CreateDnsServerRequest = z.input<typeof createDnsServerSchema>;

export const updateDnsServerSchema = createDnsServerSchema.partial().strict();
export type UpdateDnsServerInput = z.infer<typeof updateDnsServerSchema>;
export type UpdateDnsServerRequest = z.input<typeof updateDnsServerSchema>;
