/**
 * The platform's encrypted copy of each DKIM key it creates.
 *
 * Stalwart signs with the key and masks it on every read (`secret: "****"`),
 * so the only moment the platform sees a private key is when it generates one:
 * enable-time normalization, rotation, drift repair and DR recreate. Each of
 * those keeps a copy here, encrypted with PLATFORM_ENCRYPTION_KEY, for one
 * reader: the tenant's "Show private key" (keys-routes.ts), behind a fresh
 * step-up.
 *
 * Keeping the copy must never break signing: a failed write is logged (never
 * with the key) and the domain simply has no copy until its next rotation.
 * The copy is never trusted on its own either: the reader checks it against
 * the public key Stalwart reports for the selector (`spkiOf`).
 */

import { createPublicKey } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { emailDkimPrivateKeys } from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';

export interface KeepKeyLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Store (or replace) the copy of one selector's key. Never throws. */
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
      .values({ emailDomainId: input.emailDomainId, selector: input.selector, privateKeyEncrypted })
      .onConflictDoUpdate({
        target: [emailDkimPrivateKeys.emailDomainId, emailDkimPrivateKeys.selector],
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
  try {
    return { ok: true, privateKeyPem: decrypt(row.privateKeyEncrypted, encryptionKey) };
  } catch {
    // Encrypted under another cluster's PLATFORM_ENCRYPTION_KEY (a restore).
    return { ok: false, reason: 'undecryptable' };
  }
}

/** Drop every copy of a domain's keys — when its signatures are removed. */
export async function forgetDkimPrivateKeys(db: Database, emailDomainId: string): Promise<void> {
  await db.delete(emailDkimPrivateKeys).where(eq(emailDkimPrivateKeys.emailDomainId, emailDomainId));
}

/**
 * The public half of a private key in the form Stalwart reports it:
 * base64 SubjectPublicKeyInfo DER, no PEM armour. Null when the PEM does not
 * parse.
 */
export function spkiOf(privateKeyPem: string): string | null {
  try {
    return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
  } catch {
    return null;
  }
}
