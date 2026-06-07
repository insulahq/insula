/**
 * Manual DKIM key rotation for a tenant email domain — A/B selector
 * scheme (`dkim-1` / `dkim-2`, see ./selectors.ts).
 *
 * Stalwart 0.16 ships with `Bootstrap.generateDkimKeys=false` (set
 * in bootstrap-plan-cm.yaml), so DKIM keys do NOT auto-rotate. The
 * tenant-panel offers a button per domain to trigger a manual
 * rotation when needed (annual key rotation hygiene, suspected
 * compromise, etc.).
 *
 * Rotation flow:
 *   1. Read the persisted active selector (email_domains.
 *      dkim_active_selector) and flip to the OTHER one — the target.
 *      Legacy domains (null / timestamped / Stalwart auto selector)
 *      target `dkim-1`.
 *   2. Destroy any Stalwart signature already sitting on the target
 *      selector — that's the key from TWO rotations ago; mail signed
 *      with it cleared receivers' retry queues long ago (a full
 *      A→B→A cycle requires two operator-triggered rotations). While
 *      we're at it, sweep straggler signatures on selectors that are
 *      neither current nor target (Stalwart auto rows whose destroy
 *      soft-failed at enable, legacy timestamped selectors) — but
 *      ONLY when the current selector's signature actually exists,
 *      because then every recent message also carries the current
 *      signature and keeps verifying after the straggler's TXT is
 *      pruned by the dns-sync reconciler.
 *   3. Generate a fresh RSA-2048 key pair — the SAME algorithm
 *      initial provisioning uses (email-domains/dkim.ts). RSA-only:
 *      Gmail and Microsoft 365 do not support RFC 8463
 *      ed25519-sha256 (https://support.stalw.art/t/562).
 *   4. Create the new DkimSignature in Stalwart via JMAP
 *      x:DkimSignature/set. The PREVIOUS selector's signature stays
 *      ACTIVE — Stalwart dual-signs with both keys and both TXT
 *      records stay published, so mail already in receivers' retry
 *      queues keeps verifying. No retirement step is ever needed:
 *      the previous key is replaced in place at the NEXT rotation.
 *   5. Upsert the target selector's TXT record
 *      (`<target>._domainkey.<domain>`) — on selector REUSE the row
 *      already exists with the old public key and must be replaced,
 *      not duplicated (two v=DKIM1 TXT records at one name is a
 *      verifier-dependent permfail per RFC 6376 §3.6.2.2).
 *   6. Persist the target as the new active selector.
 *
 * What this does NOT do:
 *   - Re-signing of historical mail. DKIM signs at send time; a key
 *     rotation only affects new outgoing messages.
 *   - DNS cleanup. Both selectors' TXT records are permanent fixtures
 *     of the zone — that is the point of the A/B scheme.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { emailDomains, domains } from '../../db/schema.js';
import {
  dkimSignatureGet,
  dkimSignatureSet,
  type StalwartDkimSignatureRow,
} from '../stalwart-jmap/client.js';
import { generateDkimKeyPair } from '../email-domains/dkim.js';
import { upsertDkimTxtRecord } from './dns-publish.js';
import { isAbSelector, nextDkimSelector, type DkimAbSelector } from './selectors.js';
import {
  createRsaDkimSignature,
  resolveDkimAccountId,
  DkimSignatureCreateError,
  redactPemBlocks,
} from './signatures.js';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'email-dkim-rotate' });

export interface RotateDkimResult {
  readonly newSelector: DkimAbSelector;
  /**
   * The selector that was active before this rotation. Its signature
   * stays active and its TXT record stays published — mail in transit
   * keeps verifying; nothing to retire. Null for legacy domains with
   * no recorded active selector.
   */
  readonly previousSelector: string | null;
  readonly newPublicKey: string;
  readonly txtRecordName: string;
  readonly txtRecordValue: string;
  readonly stalwartDkimSignatureId: string;
  /** Selectors whose stale signatures were destroyed (target reuse + straggler sweep). */
  readonly destroyedSelectors: readonly string[];
}

export class DkimRotationError extends Error {
  constructor(message: string, readonly code: string, readonly stalwartStatus?: number) {
    super(message);
    this.name = 'DkimRotationError';
  }
}

export interface RotationPlan {
  readonly target: DkimAbSelector;
  readonly previousSelector: string | null;
  /**
   * Signature rows sitting on the TARGET selector — the key from two
   * rotations ago. MUST be destroyed before creating the replacement
   * (two active signatures on one selector would be ambiguous);
   * destroy failure here aborts the rotation.
   */
  readonly staleTargetRows: readonly StalwartDkimSignatureRow[];
  /**
   * Rows on selectors that are neither current nor target. Swept
   * opportunistically (soft-fail) and ONLY when the current
   * selector's signature exists — see module header step 2.
   */
  readonly stragglerRows: readonly StalwartDkimSignatureRow[];
}

/** Pure planner — exported for unit tests. */
export function planDkimRotation(
  rows: readonly StalwartDkimSignatureRow[],
  stalwartDomainId: string,
  persistedActiveSelector: string | null,
): RotationPlan {
  const current = isAbSelector(persistedActiveSelector) ? persistedActiveSelector : null;
  const target = nextDkimSelector(current);
  const domainRows = rows.filter((r) => r.domainId === stalwartDomainId);

  const staleTargetRows = domainRows.filter((r) => r.selector === target);
  const currentExists =
    current !== null && domainRows.some((r) => r.selector === current);
  const stragglerRows = currentExists
    ? domainRows.filter((r) => r.selector !== current && r.selector !== target)
    : [];

  return { target, previousSelector: current, staleTargetRows, stragglerRows };
}

/**
 * Rotate the DKIM key for the email-domain identified by emailDomainId.
 *
 * Returns the new (target) selector + public key. Caller is
 * responsible for any UI surfacing or audit-log entry.
 */
export async function rotateDkimKey(
  db: Database,
  emailDomainId: string,
  encryptionKey: string,
): Promise<RotateDkimResult> {
  // emailDomains has no domain_name column — JOIN to domains.
  const [emailDomain] = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      domainName: domains.domainName,
      stalwartDomainId: emailDomains.stalwartDomainId,
      dkimActiveSelector: emailDomains.dkimActiveSelector,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(eq(emailDomains.id, emailDomainId));

  if (!emailDomain) {
    throw new DkimRotationError(
      `Email domain '${emailDomainId}' not found`,
      'EMAIL_DOMAIN_NOT_FOUND',
    );
  }

  if (!emailDomain.stalwartDomainId) {
    throw new DkimRotationError(
      `Email domain '${emailDomain.domainName}' has not been provisioned to Stalwart yet`,
      'EMAIL_DOMAIN_NOT_PROVISIONED',
    );
  }
  const stalwartDomainId = emailDomain.stalwartDomainId;

  const accountId = await resolveDkimAccountId(process.env.STALWART_MGMT_URL);

  // 1+2. Plan the flip and clear the target selector.
  let rows: readonly StalwartDkimSignatureRow[];
  try {
    rows = await dkimSignatureGet({ accountId, baseUrl: process.env.STALWART_MGMT_URL });
  } catch (err) {
    throw new DkimRotationError(
      `Stalwart DkimSignature listing failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      'STALWART_API_ERROR',
    );
  }
  const plan = planDkimRotation(rows, stalwartDomainId, emailDomain.dkimActiveSelector);

  const destroyRows = [...plan.staleTargetRows, ...plan.stragglerRows];
  if (destroyRows.length > 0) {
    const res = await dkimSignatureSet({
      accountId,
      destroy: destroyRows.map((r) => r.id),
      baseUrl: process.env.STALWART_MGMT_URL,
    });
    const destroyedSet = new Set(res.destroyed ?? []);
    // Target-selector leftovers are fatal — creating the replacement
    // would leave two active signatures on one selector.
    const staleLeft = plan.staleTargetRows.filter((r) => !destroyedSet.has(r.id));
    if (staleLeft.length > 0) {
      throw new DkimRotationError(
        `Stalwart refused to destroy the stale '${plan.target}' signature (ids: ${staleLeft.map((r) => r.id).join(', ')}) — rotation aborted before creating a duplicate selector`,
        'STALWART_API_ERROR',
      );
    }
    const stragglerLeft = plan.stragglerRows.filter((r) => !destroyedSet.has(r.id));
    if (stragglerLeft.length > 0) {
      log.warn(
        { stalwartDomainId, selectors: stragglerLeft.map((r) => r.selector) },
        'DKIM rotation: straggler signatures were not destroyed — they keep dual-signing until the next rotation',
      );
    }
  }

  // 3+4. Mint the new key under the target selector. The previous
  // selector's signature is deliberately left active (dual-signing).
  const { privateKey, publicKey } = generateDkimKeyPair();
  let signatureId: string;
  try {
    signatureId = await createRsaDkimSignature({
      accountId,
      stalwartDomainId,
      selector: plan.target,
      privateKeyPem: privateKey,
      baseUrl: process.env.STALWART_MGMT_URL,
    });
  } catch (err) {
    const safe =
      err instanceof DkimSignatureCreateError
        ? err.message
        : redactPemBlocks(err instanceof Error ? err.message : String(err)).slice(0, 500);
    throw new DkimRotationError(safe, 'STALWART_API_ERROR');
  }

  // 5. Upsert the target selector's TXT record (in-DB + DNS provider).
  // See dns-publish.ts for the replace-not-duplicate semantics and the
  // self-healing failure model (no transaction needed: dns-sync owns
  // *._domainkey.* reconciliation and the previous selector is never
  // touched, so in-flight mail keeps verifying through any partial
  // failure here).
  const { txtRecordName, txtRecordValue } = await upsertDkimTxtRecord(db, {
    domainId: emailDomain.domainId,
    domainName: emailDomain.domainName,
    selector: plan.target,
    publicKey,
    encryptionKey,
  });

  // 6. Persist the flip. Stalwart is already signing with the target
  // key at this point, so the persisted state must follow the create.
  await db
    .update(emailDomains)
    .set({ dkimActiveSelector: plan.target })
    .where(eq(emailDomains.id, emailDomain.id));

  return {
    newSelector: plan.target,
    previousSelector: plan.previousSelector,
    newPublicKey: publicKey,
    txtRecordName,
    txtRecordValue,
    stalwartDkimSignatureId: signatureId,
    destroyedSelectors: [...new Set(destroyRows.map((r) => r.selector))],
  };
}
