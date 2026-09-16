/**
 * The notification envelope — identity, populated centrally.
 *
 * Every notification must answer four questions: which tenant, which object,
 * what happened, and when. Sixteen of the categories answered none of them,
 * and the reason was structural rather than careless: identity was the CALLER's
 * job, so each of ~50 emitters had to remember to pass it and most did not.
 *
 * The dispatcher seeded `tenantName: null` and `platformName: 'Hosting
 * Platform'` as literals and set `userName` to the recipient's email local
 * part. Meanwhile `tenants.contact_name` was populated for every tenant and
 * read by nothing, and `system_settings.platform_name` existed and was ignored
 * in four places — so renaming the platform changed nothing a customer saw.
 *
 * This module fills those in once, from the data, before any template renders.
 * A caller-supplied value always wins: an emitter that knows better (a
 * cross-tenant digest naming its own subject) is not overridden.
 */
import { eq } from 'drizzle-orm';
import { tenants, users, systemSettings } from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';

export interface EnvelopeIdentity {
  readonly platformName: string;
  readonly tenantName: string | null;
  readonly contactName: string | null;
}

/** Cached platform brand. Re-read rarely; an operator rename is not hot-path. */
let brandCache: { value: string; at: number } | null = null;
const BRAND_TTL_MS = 60_000;

export async function platformName(db: Database): Promise<string> {
  const now = Date.now();
  if (brandCache && now - brandCache.at < BRAND_TTL_MS) return brandCache.value;
  try {
    const [row] = await db.select({ name: systemSettings.platformName }).from(systemSettings).limit(1);
    const value = row?.name?.trim() || 'Hosting Platform';
    brandCache = { value, at: now };
    return value;
  } catch {
    // Never let a settings read stop a notification.
    return brandCache?.value ?? 'Hosting Platform';
  }
}

/** Test seam — the cache would otherwise leak a brand between cases. */
export function _resetBrandCacheForTests(): void {
  brandCache = null;
}

/**
 * Tenant display name and the human to address.
 *
 * `contact_name` is the billing/technical contact person, distinct from the
 * organisation name. Addressing someone by name is the difference between
 * "Your subscription was modified" and "Hi Alex — Example Ltd changed plan".
 */
export async function tenantIdentity(
  db: Database,
  tenantId: string | null | undefined,
): Promise<{ tenantName: string | null; contactName: string | null }> {
  if (!tenantId) return { tenantName: null, contactName: null };
  try {
    const [row] = await db
      .select({ name: tenants.name, contactName: tenants.contactName })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return {
      tenantName: row?.name ?? null,
      contactName: row?.contactName ?? null,
    };
  } catch {
    return { tenantName: null, contactName: null };
  }
}

/**
 * The recipient's own name.
 *
 * Was the email local part, which produced "Hi ricardo" where the platform
 * knew the person's full name all along.
 */
export async function userDisplayName(
  db: Database,
  userId: string | null,
  fallbackEmail: string | null,
): Promise<string> {
  if (userId) {
    try {
      const [row] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1);
      const n = row?.fullName?.trim();
      if (n) return n;
    } catch {
      // fall through to the address-derived name
    }
  }
  return fallbackEmail ? (fallbackEmail.split('@')[0] ?? fallbackEmail) : 'there';
}

/**
 * Format an instant for a human.
 *
 * Production has been mailing customers `2026-09-21T00:00:00.000Z`. A raw ISO
 * string in a sentence is a leaked implementation detail, not a date.
 */
export function formatOccurredAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : null;
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Variable names treated as instants and formatted for display. */
const DATE_KEYS = new Set([
  'occurredAt', 'expiresAt', 'newExpiresAt', 'nextBillingAt', 'bootedAtText',
]);

/**
 * Normalise caller-supplied variables: format anything date-shaped, leave
 * everything else untouched.
 */
export function normaliseDateVariables(vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...vars };
  for (const key of DATE_KEYS) {
    if (!(key in out)) continue;
    const formatted = formatOccurredAt(out[key]);
    if (formatted !== null) out[key] = formatted;
  }
  return out;
}
