/**
 * The platform's encrypted copy of each DKIM key it creates.
 *
 * Stalwart signs with the key and masks it on every read (`secret: "****"`),
 * so the only moment the platform sees a private key is when it generates one:
 * enable-time normalization, rotation, drift repair and DR recreate. Each of
 * those keeps a copy here, one row per (email domain, selector), encrypted with
 * PLATFORM_ENCRYPTION_KEY. Two readers:
 *   - the tenant's "Show private key" (keys-routes.ts), behind a fresh step-up;
 *   - restore.ts, which puts a key Stalwart lost back under its selector so the
 *     published DNS record keeps verifying (instead of a new key and a DNS
 *     change).
 *
 * Keeping the copy must never break signing: a failed write is logged (never
 * with the key) and the domain simply has no copy until its next rotation.
 * The copy is never trusted on its own either: both readers check its public
 * half (`spkiOf`) against Stalwart's key or the published TXT record.
 *
 * The copies travel in tenant bundles (tenant-bundles/components/config.ts),
 * still encrypted: a restore onto a cluster with another PLATFORM_ENCRYPTION_KEY
 * cannot decrypt them and falls back to new keys.
 */

import { createHash, createPublicKey } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { emailDkimPrivateKeys } from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';

export interface KeepKeyLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The row id of a selector's copy: derived, not random, so a bundle restore —
 * which upserts on `id` — replaces the live row of the same selector instead
 * of colliding with it on the (email domain, selector) unique index. Migration
 * 0180 backfills existing rows with the same formula.
 */
export function dkimKeyRowId(emailDomainId: string, selector: string): string {
  const h = createHash('sha256').update(`dkim-key:${emailDomainId}:${selector}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Store (or replace) the copy of one selector's key. Never throws; false when it was not kept. */
export async function keepDkimPrivateKey(
  db: Database,
  input: {
    readonly emailDomainId: string;
    readonly selector: string;
    readonly privateKeyPem: string;
    readonly encryptionKey: string;
  },
  log?: KeepKeyLog,
): Promise<boolean> {
  try {
    const privateKeyEncrypted = encrypt(input.privateKeyPem, input.encryptionKey);
    await db
      .insert(emailDkimPrivateKeys)
      .values({
        id: dkimKeyRowId(input.emailDomainId, input.selector),
        emailDomainId: input.emailDomainId,
        selector: input.selector,
        privateKeyEncrypted,
      })
      .onConflictDoUpdate({
        target: emailDkimPrivateKeys.id,
        set: { privateKeyEncrypted, createdAt: new Date() },
      });
    return true;
  } catch (err) {
    // The error of an insert can carry its parameters; only the class goes out.
    log?.warn(
      { emailDomainId: input.emailDomainId, selector: input.selector, err: err instanceof Error ? err.name : 'unknown' },
      'DKIM: could not keep a copy of the new key; it signs as normal, but cannot be shown until the next rotation',
    );
    return false;
  }
}

export type KeptKey =
  | { readonly ok: true; readonly privateKeyPem: string }
  | { readonly ok: false; readonly reason: 'none' | 'undecryptable' };

function decryptKept(privateKeyEncrypted: string, encryptionKey: string): KeptKey {
  try {
    return { ok: true, privateKeyPem: decrypt(privateKeyEncrypted, encryptionKey) };
  } catch {
    // Encrypted under another cluster's PLATFORM_ENCRYPTION_KEY (a restore).
    return { ok: false, reason: 'undecryptable' };
  }
}

/** The copy of one selector's key, decrypted. */
export async function readKeptDkimPrivateKey(
  db: Database,
  emailDomainId: string,
  selector: string,
  encryptionKey: string,
): Promise<KeptKey> {
  const [row] = await db
    .select({ privateKeyEncrypted: emailDkimPrivateKeys.privateKeyEncrypted })
    .from(emailDkimPrivateKeys)
    .where(and(eq(emailDkimPrivateKeys.emailDomainId, emailDomainId), eq(emailDkimPrivateKeys.selector, selector)))
    .limit(1);
  if (!row) return { ok: false, reason: 'none' };
  return decryptKept(row.privateKeyEncrypted, encryptionKey);
}

/** Every copy a domain has, decrypted, by selector. */
export async function readKeptDkimPrivateKeys(
  db: Database,
  emailDomainId: string,
  encryptionKey: string,
): Promise<ReadonlyMap<string, KeptKey>> {
  const rows = await db
    .select({ selector: emailDkimPrivateKeys.selector, privateKeyEncrypted: emailDkimPrivateKeys.privateKeyEncrypted })
    .from(emailDkimPrivateKeys)
    .where(eq(emailDkimPrivateKeys.emailDomainId, emailDomainId));
  return new Map(rows.map((r) => [r.selector, decryptKept(r.privateKeyEncrypted, encryptionKey)]));
}

/** Drop every copy of a domain's keys — when its signatures are removed. */
export async function forgetDkimPrivateKeys(db: Database, emailDomainId: string): Promise<void> {
  await db.delete(emailDkimPrivateKeys).where(eq(emailDkimPrivateKeys.emailDomainId, emailDomainId));
}

/** Drop the copies of the given selectors — when those signatures are destroyed. */
export async function forgetDkimPrivateKeysFor(
  db: Database,
  emailDomainId: string,
  selectors: readonly string[],
): Promise<void> {
  if (selectors.length === 0) return;
  await db.delete(emailDkimPrivateKeys).where(and(
    eq(emailDkimPrivateKeys.emailDomainId, emailDomainId),
    inArray(emailDkimPrivateKeys.selector, [...selectors]),
  ));
}

/**
 * The public half of a private key in the form Stalwart reports it and the
 * DKIM TXT record carries it (`p=`): base64 SubjectPublicKeyInfo DER, no PEM
 * armour. Null when the PEM does not parse.
 */
export function spkiOf(privateKeyPem: string): string | null {
  try {
    return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
  } catch {
    return null;
  }
}
