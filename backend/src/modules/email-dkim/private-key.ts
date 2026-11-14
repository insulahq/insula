/**
 * The DKIM key a domain's mail is signed with, for its owner to sign with the
 * SAME key on another mail server: the record the platform published then
 * verifies mail from both.
 *
 * Stalwart holds the key and masks it on read, so the key comes from the
 * platform's encrypted copy (key-store.ts). Which key is the one "in use",
 * and whether the copy is really it, is Stalwart's answer: the copy is only
 * handed out when its public key equals the one Stalwart reports for the
 * signing selector.
 */

import type { DkimKey } from '@insula/api-contracts';
import type { StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';
import { RSA_SIGNATURE_TYPE, ED25519_SIGNATURE_TYPE } from './signatures.js';
import { spkiOf, type KeptKey } from './key-store.js';

export type SigningKeyResult =
  | {
    readonly ok: true;
    readonly selector: string;
    readonly algorithm: DkimKey['algorithm'];
    readonly privateKeyPem: string;
  }
  | {
    readonly ok: false;
    /**
     * no_signing_key  Stalwart holds no active key for the domain
     * not_kept        the key predates the platform keeping copies, or the
     *                 copy was made under another cluster's encryption key
     * mismatch        the copy is not the key Stalwart signs with
     */
    readonly reason: 'no_signing_key' | 'not_kept' | 'mismatch';
    readonly selector?: string;
  };

function algorithmOf(type: string): DkimKey['algorithm'] {
  if (type === RSA_SIGNATURE_TYPE) return 'rsa';
  if (type === ED25519_SIGNATURE_TYPE) return 'ed25519';
  return 'other';
}

/**
 * The signature that signs the domain's mail now: the selector the latest
 * enable or rotation signed with (`activeSelector`), else the domain's only
 * active key. During a rotation both selectors sign; the newest is the one to
 * copy, since the older one is replaced by the next rotation.
 */
export function pickSigningRow(params: {
  readonly rows: readonly StalwartDkimSignatureRow[];
  readonly stalwartDomainId: string;
  readonly activeSelector: string | null;
}): StalwartDkimSignatureRow | null {
  const active = params.rows.filter((r) => r.domainId === params.stalwartDomainId && r.stage === 'active');
  return active.find((r) => r.selector === params.activeSelector)
    ?? (active.length === 1 ? active[0] : null);
}

/** Stalwart's `publicKey` for a row, whitespace removed; null when absent. */
function reportedSpki(row: StalwartDkimSignatureRow): string | null {
  const v = row.publicKey;
  return typeof v === 'string' && v.length > 0 ? v.replace(/\s+/g, '') : null;
}

/**
 * Join Stalwart's signing row with the platform's copy. `readKept` is called
 * once, for the signing selector only.
 */
export async function resolveSigningKey(params: {
  readonly rows: readonly StalwartDkimSignatureRow[];
  readonly stalwartDomainId: string;
  readonly activeSelector: string | null;
  readonly readKept: (selector: string) => Promise<KeptKey>;
}): Promise<SigningKeyResult> {
  const row = pickSigningRow(params);
  if (!row) return { ok: false, reason: 'no_signing_key' };
  const kept = await params.readKept(row.selector);
  if (!kept.ok) return { ok: false, reason: 'not_kept', selector: row.selector };
  const reported = reportedSpki(row);
  if (!reported || spkiOf(kept.privateKeyPem) !== reported) {
    return { ok: false, reason: 'mismatch', selector: row.selector };
  }
  return {
    ok: true,
    selector: row.selector,
    algorithm: algorithmOf(row['@type']),
    privateKeyPem: kept.privateKeyPem.endsWith('\n') ? kept.privateKeyPem : `${kept.privateKeyPem}\n`,
  };
}
