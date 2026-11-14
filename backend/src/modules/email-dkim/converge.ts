/**
 * Bring a Stalwart domain's DKIM signatures to the platform's A/B pair —
 * restoring kept keys before minting — and finish the job: persist the active
 * selector, put a restored key's record back on a zone the platform hosts,
 * publish a minted key's record. One function for every path that rebuilds a
 * domain's signatures: email enable, drift repair, DR recover and the staff
 * retry (POST …/dkim/restore), so they cannot drift apart.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { emailDomains } from '../../db/schema.js';
import type { JmapAccountId } from '../stalwart-jmap/client.js';
import { isZoneWritable } from '../email-domains/dns-provisioning.js';
import { normalizeDomainDkim } from './normalize.js';
import { keepDkimPrivateKey, type KeepKeyLog } from './key-store.js';
import { republishRestoredDkim, restorableDkimKeys, type RestoreDeps } from './restore.js';
import { upsertDkimTxtRecord } from './dns-publish.js';

export interface ConvergeDkimResult {
  /** The selector now persisted as active; null when the check was undecidable (nothing changed). */
  readonly activeSelector: string | null;
  /** Selectors put back with their kept key. */
  readonly restored: readonly string[];
  /** A new key was made (nothing could be restored). */
  readonly minted: boolean;
  /** The minted key's record was published on a zone the platform hosts. */
  readonly txtPublished: boolean;
  /** Whether the minted key's copy was kept (null when none was minted). */
  readonly keptCopy: boolean | null;
  /** DNS gave no answer for a published record: nothing was done; retry. */
  readonly undecidable: boolean;
  /** A platform provider group hosts the zone (else its owner publishes DNS). */
  readonly zoneHostedHere: boolean;
}

export async function convergeDomainDkim(
  db: Database,
  params: {
    readonly accountId: JmapAccountId;
    readonly stalwartDomainId: string;
    readonly baseUrl?: string;
    readonly emailDomainId: string;
    readonly domainId: string;
    readonly domainName: string;
    readonly currentDbSelector: string | null;
    readonly expectAutoPair: boolean;
    readonly encryptionKey: string;
    readonly log?: KeepKeyLog;
  },
  deps: RestoreDeps = {},
): Promise<ConvergeDkimResult> {
  const res = await normalizeDomainDkim({
    accountId: params.accountId,
    stalwartDomainId: params.stalwartDomainId,
    baseUrl: params.baseUrl,
    currentDbSelector: params.currentDbSelector,
    expectAutoPair: params.expectAutoPair,
    keepKey: (selector, privateKeyPem) => keepDkimPrivateKey(db, {
      emailDomainId: params.emailDomainId, selector, privateKeyPem, encryptionKey: params.encryptionKey,
    }, params.log),
    restorable: (selectors) => restorableDkimKeys(db, {
      emailDomainId: params.emailDomainId, domainId: params.domainId, domainName: params.domainName,
      selectors, encryptionKey: params.encryptionKey,
    }, deps),
  });
  const zoneHostedHere = await (deps.zoneHostedHere ?? isZoneWritable)(db, params.domainId);
  if (res.undecidable) {
    return {
      activeSelector: null, restored: [], minted: false, txtPublished: false, keptCopy: null,
      undecidable: true, zoneHostedHere,
    };
  }

  await db.update(emailDomains).set({ dkimActiveSelector: res.activeSelector }).where(eq(emailDomains.id, params.emailDomainId));
  await republishRestoredDkim(db, {
    domainId: params.domainId, domainName: params.domainName, restored: res.restored, encryptionKey: params.encryptionKey,
  });
  let txtPublished = false;
  if (res.createdPublicKey) {
    // Published inline so mail sent in the next minutes verifies.
    await upsertDkimTxtRecord(db, {
      domainId: params.domainId, domainName: params.domainName,
      selector: res.activeSelector, publicKey: res.createdPublicKey, encryptionKey: params.encryptionKey,
    });
    txtPublished = zoneHostedHere;
  }
  return {
    activeSelector: res.activeSelector,
    restored: res.restored.map((k) => k.selector),
    minted: res.createdPublicKey !== null,
    txtPublished,
    keptCopy: res.keptCopy,
    undecidable: false,
    zoneHostedHere,
  };
}

/** One operator-facing sentence about what happened to a domain's DKIM keys. */
export function describeDkimConvergence(domainName: string, r: ConvergeDkimResult): string {
  if (r.undecidable) {
    return `The DKIM keys of '${domainName}' were NOT restored yet and no new key was made: public DNS ` +
      `gave no answer when the published records were checked. Mail is not DKIM-signed with the ` +
      `published keys until this is retried (POST /api/v1/tenants/<tenant>/email-domains/<email ` +
      `domain>/dkim/restore, staff only).`;
  }
  if (r.restored.length > 0) {
    return `The DKIM keys of '${domainName}' were put back from the platform's kept copies ` +
      `(${r.restored.join(', ')}), so mail signs with the keys the published records carry. ` +
      (r.zoneHostedHere
        ? 'The platform hosts the zone; no DNS change is needed.'
        : 'The zone is hosted elsewhere: verify the record at your DNS provider.');
  }
  if (r.minted) {
    return `'${domainName}' got a NEW DKIM key — the platform held no copy of the previous keys that ` +
      `DNS still publishes. Mail signed with it fails DKIM, and therefore DMARC, until the ` +
      `${r.activeSelector} record in DNS carries the new key. ` +
      (r.txtPublished
        ? 'The platform has republished it for the zone it hosts.'
        : 'The zone is hosted elsewhere: its owner must update the record at their DNS provider.');
  }
  return `Nothing was changed: '${domainName}' already signs with one of its A/B keys, and no missing ` +
    'selector had a kept key its published record still carries.';
}
