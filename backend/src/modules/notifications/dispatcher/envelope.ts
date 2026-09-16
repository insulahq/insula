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
import { eq, inArray } from 'drizzle-orm';
import { tenants, users, systemSettings, mailboxes, domains } from '../../../db/schema.js';
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

// ── Greeting ──────────────────────────────────────────────────────────────
//
// Operator requirement 2026-09-16: every notification opens by addressing the
// person, EXCEPT when the recipient is only a mailbox owner — they have no
// platform account, so the platform knows no name to use and "Hi bookings"
// (the local part) is worse than no greeting at all.

/**
 * A greeting line, or null when there is no real name to use.
 *
 * Returns null for an address-derived pseudo-name so the template's
 * `{{#if greeting}}` block collapses instead of rendering "Hi no-reply,".
 */
export function greetingFor(name: string | null | undefined): string | null {
  const n = name?.trim();
  if (!n) return null;
  // `userDisplayName` falls back to the email local part and finally to
  // 'there'. Neither is a name, and both read as a mail-merge failure.
  if (n === 'there' || n.includes('@')) return null;
  return `Hi ${n},`;
}

// ── Never print an id ─────────────────────────────────────────────────────
//
// Operator requirement 2026-09-16, after production mailed
// "3fd54013-fc40-4e13-adaf-ed1b5dd39f28 saturated its hour sending limit".
// The emitter had passed `tenantLabel: tenantId` and every layer below
// faithfully rendered it.
//
// Resolution happens HERE rather than in the ~50 emitters, for the same reason
// identity does: a rule that each caller must remember is a rule that half of
// them will not.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every distinct UUID appearing anywhere in a string. */
export function findIds(text: string): string[] {
  return [...new Set(text.match(UUID_RE) ?? [])];
}

export interface ResolvedVariables {
  readonly vars: Record<string, unknown>;
  /** Ids no lookup could name. Reportable — a notification still went out. */
  readonly unresolved: readonly string[];
}

/**
 * Replace every id appearing in any string variable with a human name.
 *
 * Looks the id up as a tenant, then a user, then a mailbox, then a domain —
 * the four things notifications are actually about. Unresolvable ids are
 * replaced with a readable placeholder rather than left raw: the operator's
 * instruction was that an id must never reach a reader, and an id nothing can
 * name is a defect to report, not a string to print.
 */
export async function resolveIdVariables(
  db: Database,
  vars: Record<string, unknown>,
): Promise<ResolvedVariables> {
  const ids = new Set<string>();
  for (const value of Object.values(vars)) {
    if (typeof value === 'string') for (const id of findIds(value)) ids.add(id);
  }
  if (ids.size === 0) return { vars, unresolved: [] };

  const wanted = [...ids];
  const names = new Map<string, string>();

  // inArray, never `= ANY(array)`: Drizzle binds a JS array as ONE scalar and
  // silently matches nothing, which here would look like "no id resolved".
  // Each projection is aliased to the KIND of thing it names, not to a generic
  // `label`. That keeps the four lookups distinguishable to a reader (and to a
  // test double) without anyone having to infer the table from Drizzle
  // internals.
  const lookups: ReadonlyArray<() => Promise<void>> = [
    async () => {
      const rows = await db.select({ id: tenants.id, tenantName: tenants.name })
        .from(tenants).where(inArray(tenants.id, wanted));
      for (const r of rows) if (r.tenantName) names.set(r.id, r.tenantName);
    },
    async () => {
      const rows = await db.select({ id: users.id, userFullName: users.fullName, userEmail: users.email })
        .from(users).where(inArray(users.id, wanted));
      for (const r of rows) names.set(r.id, r.userFullName?.trim() || r.userEmail);
    },
    async () => {
      const rows = await db.select({ id: mailboxes.id, mailboxAddress: mailboxes.fullAddress })
        .from(mailboxes).where(inArray(mailboxes.id, wanted));
      for (const r of rows) if (r.mailboxAddress) names.set(r.id, r.mailboxAddress);
    },
    async () => {
      const rows = await db.select({ id: domains.id, domainName: domains.domainName })
        .from(domains).where(inArray(domains.id, wanted));
      for (const r of rows) if (r.domainName) names.set(r.id, r.domainName);
    },
  ];

  for (const run of lookups) {
    if (names.size === ids.size) break; // everything named already
    try {
      await run();
    } catch {
      // A failed lookup must not stop the notification; the id it would have
      // named falls through to `unresolved` and is reported.
    }
  }

  const unresolved = wanted.filter((id) => !names.has(id));
  const out: Record<string, unknown> = { ...vars };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue;
    if (!UUID_RE.test(value)) continue;
    out[key] = value.replace(UUID_RE, (id) => names.get(id) ?? '(unnamed)');
  }
  return { vars: out, unresolved };
}
