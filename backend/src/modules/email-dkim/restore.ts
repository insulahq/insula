/**
 * Put a DKIM key the mail server lost back under its selector, instead of
 * minting a new one.
 *
 * When Stalwart loses a domain's signatures — its data restored from a backup,
 * wiped and recreated by drift repair, or a tenant recovered from a bundle —
 * normalization (normalize.ts) used to create a fresh key under `dkim-1`. The
 * TXT record published for that selector then carries the OLD public key, so
 * every message fails DKIM (and, unaligned SPF aside, DMARC) until DNS
 * changes: an inline republish for a zone the platform hosts, and a manual
 * edit at the registrar, plus propagation, for one it does not.
 *
 * The platform keeps a copy of each key it made (key-store.ts). If that copy
 * is still the key DNS publishes for the selector, putting it back restores
 * signing exactly as it was: no DNS change, no wait.
 *
 * "Still the key DNS publishes" is checked, never assumed, per selector:
 *   - public DNS answers with the record   → the copy must equal a `p=` in it.
 *     An empty `p=` is a REVOKED key (RFC 6376 §3.6.1): never restored.
 *   - public DNS says the name has no TXT  → (NXDOMAIN / NODATA) only for a zone a
 *     platform provider group hosts, the platform's own record of what it
 *     published decides, and that record is put back on the provider. For a
 *     zone hosted elsewhere nothing vouches for the copy.
 *   - public DNS gives no answer           → (SERVFAIL, timeout, refused) the
 *     check is UNDECIDABLE. Nothing is restored and nothing is minted — a
 *     new key would replace one DNS may well still publish — and the caller
 *     reports it, to be retried (POST …/dkim/restore).
 * A copy that is gone, undecryptable (another cluster's key) or does not
 * parse is simply not restorable, and the caller mints as before.
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { dnsRecords } from '../../db/schema.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { txtText } from '../dns-servers/wire-format.js';
import { isZoneWritable, syncRecordToProviders } from '../email-domains/dns-provisioning.js';
import { formatDkimDnsValue } from '../email-domains/dkim.js';
import { readKeptDkimPrivateKeys, spkiOf, type KeptKey } from './key-store.js';

const log = mailLogger().child({ module: 'email-dkim-restore' });

export interface RestorableDkimKey {
  readonly selector: string;
  readonly privateKeyPem: string;
  /** The key's public half, as `p=` carries it. */
  readonly publicKeySpki: string;
  /**
   * Where the matching record was found. `platform`: public DNS has no such
   * record, so the caller puts the platform's record back on the provider.
   */
  readonly matchedBy: 'dns' | 'platform';
}

export interface RestoreCheck {
  readonly restorable: readonly RestorableDkimKey[];
  /** Selectors whose published record could not be checked: restore and mint nothing, retry. */
  readonly undecidable: readonly string[];
}

export interface RestoreDeps {
  /** TXT strings at a name; rejects with ENOTFOUND/ENODATA when there are none. */
  readonly resolveTxt?: (name: string) => Promise<string[][]>;
  /** Whether a platform provider group hosts the zone (dns-provisioning.ts isZoneWritable). */
  readonly zoneHostedHere?: (db: Database, domainId: string) => Promise<boolean>;
}

/** The `p=` of a DKIM TXT value, whitespace removed: '' for a revoked key, null when it has none. */
export function dkimPublicKeyOf(txtValue: string): string | null {
  const m = /(?:^|;)\s*p\s*=\s*([^;]*)/i.exec(txtText(txtValue));
  if (!m) return null;
  return m[1].replace(/[\s"]/g, '');
}

type PublicAnswer =
  | { readonly kind: 'keys'; readonly keys: readonly string[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'no_answer' };

/** NXDOMAIN / NODATA: an answer that the name has no record, unlike a failure to get one. */
function isNoRecord(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

async function publicDnsAnswer(name: string, resolveTxt: (n: string) => Promise<string[][]>): Promise<PublicAnswer> {
  let records: string[];
  try {
    records = (await resolveTxt(name)).map((parts) => parts.join(''));
  } catch (err) {
    return isNoRecord(err) ? { kind: 'none' } : { kind: 'no_answer' };
  }
  const keys = records
    .filter((r) => /^\s*v\s*=\s*DKIM1/i.test(r) || /(?:^|;)\s*p\s*=/i.test(r))
    .map(dkimPublicKeyOf)
    .filter((k): k is string => k !== null);
  return keys.length > 0 ? { kind: 'keys', keys } : { kind: 'none' };
}

async function platformRecordKeys(db: Database, domainId: string, name: string): Promise<string[]> {
  const rows = await db
    .select({ recordValue: dnsRecords.recordValue })
    .from(dnsRecords)
    .where(and(eq(dnsRecords.domainId, domainId), eq(dnsRecords.recordType, 'TXT'), eq(dnsRecords.recordName, name)));
  return rows.map((r) => dkimPublicKeyOf(r.recordValue ?? '')).filter((k): k is string => k !== null);
}

async function defaultResolveTxt(name: string): Promise<string[][]> {
  // The receiver's view (public resolvers, or the operator's configured
  // upstreams), never CoreDNS — see mail-admin/deliverability.ts.
  const { externalResolver } = await import('../mail-admin/deliverability.js');
  return externalResolver().resolveTxt(name);
}

/**
 * Which kept keys of `selectors` may go back into the mail server, and which
 * selectors could not be checked. Never throws: a failure to read the copies
 * or the platform's records is an undecidable check, not a "no".
 */
export async function restorableDkimKeys(
  db: Database,
  params: {
    readonly emailDomainId: string;
    readonly domainId: string;
    readonly domainName: string;
    readonly selectors: readonly string[];
    readonly encryptionKey: string;
  },
  deps: RestoreDeps = {},
): Promise<RestoreCheck> {
  if (params.selectors.length === 0) return { restorable: [], undecidable: [] };
  const resolveTxt = deps.resolveTxt ?? defaultResolveTxt;
  const zoneHostedHere = deps.zoneHostedHere ?? isZoneWritable;
  let kept: ReadonlyMap<string, KeptKey>;
  try {
    kept = await readKeptDkimPrivateKeys(db, params.emailDomainId, params.encryptionKey);
  } catch (err) {
    log.warn({ emailDomainId: params.emailDomainId, err: err instanceof Error ? err.name : 'unknown' },
      'DKIM restore: kept copies unreadable; the check is undecidable, retry');
    return { restorable: [], undecidable: [...params.selectors] };
  }

  const restorable: RestorableDkimKey[] = [];
  const undecidable: string[] = [];
  let hosted: boolean | null = null;
  for (const selector of params.selectors) {
    const copy = kept.get(selector);
    const ctx = { emailDomainId: params.emailDomainId, domain: params.domainName, selector };
    if (!copy) continue; // never kept (a key from before copies were kept)
    if (!copy.ok) {
      log.warn(ctx, 'DKIM restore: the kept copy cannot be decrypted here (another cluster\'s encryption key); a new key is made instead');
      continue;
    }
    const spki = spkiOf(copy.privateKeyPem);
    if (!spki) {
      log.warn(ctx, 'DKIM restore: the kept copy does not parse; a new key is made instead');
      continue;
    }
    const name = `${selector}._domainkey.${params.domainName}`;
    try {
      const answer = await publicDnsAnswer(name, resolveTxt);
      if (answer.kind === 'no_answer') {
        log.warn(ctx, 'DKIM restore: public DNS gave no answer for the record; undecidable — nothing restored or minted, retry');
        undecidable.push(selector);
        continue;
      }
      if (answer.kind === 'keys') {
        if (answer.keys.includes('')) {
          log.warn(ctx, 'DKIM restore: the published record revokes the key (empty p=); never restored');
        } else if (answer.keys.includes(spki)) {
          restorable.push({ selector, privateKeyPem: copy.privateKeyPem, publicKeySpki: spki, matchedBy: 'dns' });
        } else {
          log.warn(ctx, 'DKIM restore: public DNS publishes another key for this selector; a new key is made instead');
        }
        continue;
      }
      // Public DNS: no such record. Only the platform's own zone may vouch.
      hosted ??= await zoneHostedHere(db, params.domainId);
      if (!hosted) {
        log.warn(ctx, 'DKIM restore: the record is not in public DNS and the zone is hosted elsewhere; a new key is made instead');
        continue;
      }
      const stored = await platformRecordKeys(db, params.domainId, name);
      if (stored.includes(spki)) {
        restorable.push({ selector, privateKeyPem: copy.privateKeyPem, publicKeySpki: spki, matchedBy: 'platform' });
      } else {
        log.warn(ctx, stored.includes('')
          ? 'DKIM restore: the platform\'s record revokes the key (empty p=); never restored'
          : 'DKIM restore: no record the platform holds carries the kept key; a new key is made instead');
      }
    } catch (err) {
      log.warn({ ...ctx, err: err instanceof Error ? err.name : 'unknown' },
        'DKIM restore: the published record could not be checked; undecidable, retry');
      undecidable.push(selector);
    }
  }
  return { restorable, undecidable };
}

/**
 * After a restore: a selector matched by the platform's own record (public
 * DNS has none) is put back on the zone's provider with the SAME value. Only a
 * create, which the provider makes idempotent (powerdns.ts createRecord skips a
 * value it already holds): no delete first, so a failure leaves the zone as it
 * was, and the platform's own row — already that value — is not touched.
 * Never throws.
 */
export async function republishRestoredDkim(
  db: Database,
  params: {
    readonly domainId: string;
    readonly domainName: string;
    readonly restored: readonly RestorableDkimKey[];
    readonly encryptionKey: string;
  },
): Promise<void> {
  for (const key of params.restored) {
    if (key.matchedBy !== 'platform') continue;
    const name = `${key.selector}._domainkey.${params.domainName}`;
    try {
      const outcome = await syncRecordToProviders(db, params.domainId, params.domainName, 'create', {
        type: 'TXT', name, content: formatDkimDnsValue(key.publicKeySpki), ttl: 3600, priority: null,
      }, params.encryptionKey);
      if (outcome.status === 'failed') {
        log.warn({ domain: params.domainName, selector: key.selector, message: outcome.message },
          'DKIM restore: putting the restored key\'s record back on the provider failed');
      }
    } catch (err) {
      log.warn({ domain: params.domainName, selector: key.selector, err: err instanceof Error ? err.name : 'unknown' },
        'DKIM restore: putting the restored key\'s record back on the provider failed');
    }
  }
}
