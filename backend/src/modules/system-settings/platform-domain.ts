/**
 * R16 — platform APEX / brand-domain resolver.
 *
 * The platform apex (`platform_domain`) is distinct from the ingress /
 * CNAME-target domain (`ingress_base_domain`). Apex consumers — `webmail.<apex>`,
 * `mail.<apex>`, the reserved platform subdomains, the stalwart/mgmt hostnames —
 * MUST resolve their apex through `getPlatformApex()` (PR-2 onwards) rather than
 * reading `ingress_base_domain` directly, so a platform-domain rename moves
 * every platform-owned hostname without disturbing tenant CNAME targets.
 *
 * Back-compat: `platform_domain` seeds equal to `ingress_base_domain` (migration
 * 0066), and this resolver falls back to `ingress_base_domain` when the apex was
 * never split — so reads are safe on any install.
 */
import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

async function getKv(db: Database, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key));
  const v = row?.value?.trim();
  return v ? v : null;
}

/** Strip trailing dots from a domain. */
function normalizeApex(value: string): string {
  return value.replace(/\.+$/, '');
}

/**
 * Resolve the platform apex: `platform_domain`, else `ingress_base_domain`
 * (back-compat), else null. Trailing dots stripped.
 */
export async function getPlatformApex(db: Database): Promise<string | null> {
  const platform = await getKv(db, 'platform_domain');
  if (platform) return normalizeApex(platform);
  const ingress = await getKv(db, 'ingress_base_domain');
  return ingress ? normalizeApex(ingress) : null;
}
