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
 * "Still the key DNS publishes" is checked, never assumed. The copy's public
 * half must equal a `p=` the selector's TXT record carries:
 *   - in public DNS when it answers (what receivers see), else
 *   - in the platform's own record of what it published (dns_records), for a
 *     lookup that found nothing or failed — e.g. a zone hosted here that is
 *     being rebuilt, or a lab cluster with no public DNS.
 * A copy that matches neither is never restored: the caller mints a new key
 * as before. A copy encrypted under another cluster's key cannot be decrypted
 * and is skipped the same way.
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { dnsRecords } from '../../db/schema.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { txtText } from '../dns-servers/wire-format.js';
import { readKeptDkimPrivateKeys, spkiOf, type KeptKey } from './key-store.js';
import { upsertDkimTxtRecord } from './dns-publish.js';

const log = mailLogger().child({ module: 'email-dkim-restore' });

export interface RestorableDkimKey {
  readonly selector: string;
  readonly privateKeyPem: string;
  /** The key's public half, as `p=` carries it. */
  readonly publicKeySpki: string;
  /**
   * Where the matching record was found. `platform`: public DNS did not show
   * it, so the caller republishes the same value for a zone it hosts.
   */
  readonly matchedBy: 'dns' | 'platform';
}

export interface RestoreDeps {
  /** TXT strings at a name; rejects with ENOTFOUND/ENODATA when there are none. */
  readonly resolveTxt?: (name: string) => Promise<string[][]>;
}

/** The `p=` of a DKIM TXT value, whitespace removed; null when it has none. */
export function dkimPublicKeyOf(txtValue: string): string | null {
  const m = /(?:^|;)\s*p\s*=\s*([^;]*)/i.exec(txtText(txtValue));
  const p = m?.[1]?.replace(/[\s"]/g, '');
  return p ? p : null;
}

async function publicDnsKeys(name: string, resolveTxt: (n: string) => Promise<string[][]>): Promise<string[] | null> {
  try {
    const records = (await resolveTxt(name)).map((parts) => parts.join(''));
    const keys = records
      .filter((r) => /^\s*v\s*=\s*DKIM1/i.test(r) || /(?:^|;)\s*p\s*=/i.test(r))
      .map(dkimPublicKeyOf)
      .filter((k): k is string => k !== null);
    return keys.length > 0 ? keys : null;
  } catch {
    // NXDOMAIN, no TXT, or no answer: public DNS cannot vouch for the copy.
    return null;
  }
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
 * The kept keys of `selectors` that may go back into the mail server.
 * Never throws: anything it cannot vouch for is left out (and logged).
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
): Promise<RestorableDkimKey[]> {
  if (params.selectors.length === 0) return [];
  const resolveTxt = deps.resolveTxt ?? defaultResolveTxt;
  let kept: ReadonlyMap<string, KeptKey>;
  try {
    kept = await readKeptDkimPrivateKeys(db, params.emailDomainId, params.encryptionKey);
  } catch (err) {
    log.warn({ emailDomainId: params.emailDomainId, err: err instanceof Error ? err.name : 'unknown' },
      'DKIM restore: kept copies unreadable; new keys are made instead');
    return [];
  }

  const out: RestorableDkimKey[] = [];
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
    let matchedBy: RestorableDkimKey['matchedBy'] | null = null;
    try {
      const live = await publicDnsKeys(name, resolveTxt);
      if (live) {
        matchedBy = live.includes(spki) ? 'dns' : null;
        if (!matchedBy) log.warn(ctx, 'DKIM restore: public DNS publishes another key for this selector; a new key is made instead');
      } else if ((await platformRecordKeys(db, params.domainId, name)).includes(spki)) {
        matchedBy = 'platform';
      } else {
        log.warn(ctx, 'DKIM restore: no published record carries the kept key; a new key is made instead');
      }
    } catch (err) {
      log.warn({ ...ctx, err: err instanceof Error ? err.name : 'unknown' },
        'DKIM restore: the published record could not be checked; a new key is made instead');
    }
    if (matchedBy) out.push({ selector, privateKeyPem: copy.privateKeyPem, publicKeySpki: spki, matchedBy });
  }
  return out;
}

/**
 * After a restore: a selector matched only by the platform's own record
 * (public DNS showed nothing) is republished with the SAME value, so a zone
 * the platform hosts carries it again. Records public DNS already showed are
 * left alone. Never throws — signing is restored either way.
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
    try {
      await upsertDkimTxtRecord(db, {
        domainId: params.domainId,
        domainName: params.domainName,
        selector: key.selector,
        publicKey: key.publicKeySpki,
        encryptionKey: params.encryptionKey,
      });
    } catch (err) {
      log.warn({ domain: params.domainName, selector: key.selector, err: err instanceof Error ? err.name : 'unknown' },
        'DKIM restore: republishing the restored key\'s record failed; the record the platform holds is unchanged');
    }
  }
}
