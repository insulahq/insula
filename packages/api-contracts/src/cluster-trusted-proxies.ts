/**
 * Operator-managed trusted upstream-proxy CIDRs.
 *
 * Where the trust applies:
 *   1. admin-panel + tenant-panel nginx — `set_real_ip_from` lines
 *      injected via mounted ConfigMap (include glob in nginx.conf.template)
 *   2. Traefik DS — `--entryPoints.{web,websecure}.forwardedHeaders
 *      .trustedIPs=` arg, JSON-patched in place by the reconciler
 *
 * Trust semantics: when an inbound request arrives FROM one of these
 * CIDRs, its `X-Forwarded-For` header is honored — nginx and Traefik
 * will walk the chain to find the real client IP. Without the trust
 * entry, the upstream's claimed-source-IP via XFF is ignored and the
 * immediate TCP peer becomes the source IP — which breaks
 * src-IP-aware features (CrowdSec L4 enforcement guard, audit logs,
 * rate-limiting).
 *
 * Three sources, surfaced in the UI but not all editable:
 *   - `system`    — baked into the static nginx template (RFC1918 +
 *                   IPv6 ULA + k3s default pod/svc CIDRs). Shown
 *                   in the UI for visibility; no DB row needed.
 *   - `bootstrap` — k3s cluster CIDRs detected at bootstrap and
 *                   stored in platform_settings. Auto-seeded into
 *                   the DB by the reconciler on every tick. UI
 *                   shows them as "auto-detected", Delete disabled.
 *   - `operator`  — added via the admin UI. Full CRUD by super_admin.
 *                   THIS is the row type for CDN/LB/floating-IP ranges.
 */

import { z } from 'zod';
import {
  ipv4BarePattern,
  ipv4CidrPattern,
  ipv6BarePattern,
  ipv6CidrPattern,
} from './ip.js';

// ─── CIDR validation ──────────────────────────────────────────────────────
//
// Patterns live in ./ip.ts so the DNS resolver settings validate addresses
// identically (extracted 2026-08-20). `/0` prefixes are NOT matched by the
// CIDR patterns — a `0.0.0.0/0` trust entry would let any source IP spoof
// XFF, which is exactly the boundary this feature protects.

const cidrOrIpString = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (s) =>
      ipv4CidrPattern.test(s) ||
      ipv4BarePattern.test(s) ||
      ipv6CidrPattern.test(s) ||
      ipv6BarePattern.test(s),
    {
      message:
        'must be IPv4/v6 address or CIDR (e.g. 1.2.3.4, 10.0.0.0/16, 2001:db8::1, fd00::/8); /0 prefix is not allowed',
    },
  );

// ─── Contract shapes ─────────────────────────────────────────────────────────

export const trustedProxySourceSchema = z.enum(['system', 'bootstrap', 'operator']);
export type TrustedProxySource = z.infer<typeof trustedProxySourceSchema>;

export const trustedProxyRangeSchema = z.object({
  /** UUID — null for synthetic system rows (no DB backing). */
  id: z.string().uuid().nullable(),
  cidr: z.string(),
  description: z.string(),
  source: trustedProxySourceSchema,
  createdAt: z.string().datetime().nullable(),
  /** Email of the user who added the row; null for system / bootstrap. */
  createdByEmail: z.string().nullable(),
});
export type TrustedProxyRange = z.infer<typeof trustedProxyRangeSchema>;

export const createTrustedProxyRangeRequestSchema = z.object({
  cidr: cidrOrIpString,
  description: z.string().min(1).max(200),
});
export type CreateTrustedProxyRangeRequest = z.infer<
  typeof createTrustedProxyRangeRequestSchema
>;

export const listTrustedProxyRangesResponseSchema = z.object({
  ranges: z.array(trustedProxyRangeSchema),
  /** Last successful reconcile time. Null until first run. */
  lastReconciledAt: z.string().datetime().nullable(),
  /** Last reconcile state. */
  lastReconcileError: z.string().nullable(),
  /** Number of admin-panel + tenant-panel pods rolled to the current
   * ConfigMap-hash annotation. Helps the UI show "rollout in progress". */
  panelPodsRolled: z.number().int().nonnegative(),
  panelPodsTotal: z.number().int().nonnegative(),
});
export type ListTrustedProxyRangesResponse = z.infer<
  typeof listTrustedProxyRangesResponseSchema
>;
