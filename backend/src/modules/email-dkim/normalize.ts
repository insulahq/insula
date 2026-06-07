/**
 * DKIM signature normalization — converge a domain onto the fixed
 * A/B selector pair (`dkim-1` / `dkim-2`, see ./selectors.ts).
 *
 * Stalwart 0.16 auto-creates BOTH an RSA and an Ed25519 DkimSignature
 * for every new domain principal (selectors `v1-rsa-<date>` /
 * `v1-ed25519-<date>`), regardless of `Bootstrap.generateDkimKeys`.
 * Two problems with keeping that pair:
 *   1. Gmail and Microsoft 365 do not support RFC 8463
 *      ed25519-sha256 — Gmail reports `dkim=fail` for such signatures
 *      instead of ignoring them (https://support.stalw.art/t/562), so
 *      dual-signing pollutes every tenant's DMARC aggregate reports.
 *   2. The auto selector names are date-stamped, so every domain ends
 *      up with a different selector — incompatible with the fixed A/B
 *      pattern that lets external-DNS tenants set up two TXT records
 *      once and never touch DNS on rotation.
 *
 * Normalization therefore runs right after domain provisioning
 * (email-domain enable + mail-drift repair) and:
 *   - creates a platform-generated RSA-2048 signature under `dkim-1`
 *     (unless an A/B signature already exists — re-enable path), THEN
 *   - destroys every non-A/B signature (the auto pair, bootstrap
 *     `default` rows, legacy timestamped rotation selectors).
 *
 * Create-before-destroy: if the create fails we leave the auto pair
 * untouched, so the domain always has at least one active RSA
 * signature. Callers treat failures as non-fatal (log + continue) —
 * a domain that keeps its auto pair signs and delivers fine; the
 * first rotation converges it onto the A/B pair.
 */

import {
  dkimSignatureGet,
  dkimSignatureSet,
  type JmapAccountId,
  type StalwartDkimSignatureRow,
} from '../stalwart-jmap/client.js';
import { generateDkimKeyPair } from '../email-domains/dkim.js';
import {
  DKIM_SELECTOR_A,
  isAbSelector,
  type DkimAbSelector,
} from './selectors.js';
import { createRsaDkimSignature, RSA_SIGNATURE_TYPE } from './signatures.js';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'email-dkim-normalize' });

export interface NormalizePlan {
  /** Selector to create a fresh RSA key under; null = A/B signature already present. */
  readonly createSelector: DkimAbSelector | null;
  /** Non-A/B signature ids to destroy (after a successful create). */
  readonly destroyIds: readonly string[];
  /** The selector the caller should persist as dkim_active_selector. */
  readonly activeSelector: DkimAbSelector;
}

/**
 * Pure planner — exported for unit tests.
 *
 * @param currentDbSelector the platform's persisted dkim_active_selector
 *   (used only to break the tie when BOTH A/B signatures already exist).
 */
export function planDkimNormalization(
  rows: readonly StalwartDkimSignatureRow[],
  stalwartDomainId: string,
  currentDbSelector: string | null,
): NormalizePlan {
  const domainRows = rows.filter((r) => r.domainId === stalwartDomainId);
  const abRows = domainRows.filter(
    (r) => isAbSelector(r.selector) && r['@type'] === RSA_SIGNATURE_TYPE,
  );
  const destroyIds = domainRows
    .filter((r) => !abRows.some((ab) => ab.id === r.id))
    .map((r) => r.id);

  if (abRows.length === 0) {
    return { createSelector: DKIM_SELECTOR_A, destroyIds, activeSelector: DKIM_SELECTOR_A };
  }

  // A/B signature(s) already present (re-enable / repeated repair) —
  // don't mint a new key, just sweep the non-A/B rows. When both
  // selectors exist, prefer the persisted active selector; fall back
  // to dkim-1 deterministically.
  const selectors = abRows.map((r) => r.selector);
  const activeSelector: DkimAbSelector =
    isAbSelector(currentDbSelector) && selectors.includes(currentDbSelector)
      ? currentDbSelector
      : isAbSelector(selectors[0]) && selectors.length === 1
        ? selectors[0]
        : DKIM_SELECTOR_A;

  return { createSelector: null, destroyIds, activeSelector };
}

export interface NormalizeResult {
  readonly activeSelector: DkimAbSelector;
  /** Server-assigned id of the created signature; null when none was created. */
  readonly createdSignatureId: string | null;
  /**
   * PEM public key of the created signature; null when none was
   * created. Callers use it to publish the selector's TXT record
   * inline (dns-publish.ts) instead of waiting for the next dns-sync
   * cycle.
   */
  readonly createdPublicKey: string | null;
  readonly destroyed: readonly string[];
  /** Ids we asked Stalwart to destroy but it refused — inert leftovers. */
  readonly failed: readonly string[];
}

/**
 * Converge the domain's Stalwart DkimSignature rows onto the A/B pair.
 *
 * Throws when the CREATE step fails (domain keeps its auto pair —
 * caller logs and continues). Destroy failures are soft: leftovers
 * merely dual-sign until the next normalization or rotation sweeps
 * them.
 */
export async function normalizeDomainDkim(params: {
  accountId: JmapAccountId;
  stalwartDomainId: string;
  baseUrl?: string;
  currentDbSelector?: string | null;
}): Promise<NormalizeResult> {
  const { accountId, stalwartDomainId, baseUrl } = params;

  const rows = await dkimSignatureGet({ accountId, baseUrl });
  const plan = planDkimNormalization(rows, stalwartDomainId, params.currentDbSelector ?? null);

  let createdSignatureId: string | null = null;
  let createdPublicKey: string | null = null;
  if (plan.createSelector) {
    const { privateKey, publicKey } = generateDkimKeyPair();
    createdSignatureId = await createRsaDkimSignature({
      accountId,
      stalwartDomainId,
      selector: plan.createSelector,
      privateKeyPem: privateKey,
      baseUrl,
    });
    createdPublicKey = publicKey;
  }

  let destroyed: readonly string[] = [];
  let failed: readonly string[] = [];
  if (plan.destroyIds.length > 0) {
    const res = await dkimSignatureSet({ accountId, destroy: plan.destroyIds, baseUrl });
    destroyed = res.destroyed ?? [];
    const destroyedSet = new Set(destroyed);
    failed = plan.destroyIds.filter((id) => !destroyedSet.has(id));
    if (failed.length > 0) {
      log.warn(
        { stalwartDomainId, failed, notDestroyed: res.notDestroyed },
        'DKIM normalize: some auto-created signatures were not destroyed',
      );
    }
  }

  log.info(
    { stalwartDomainId, activeSelector: plan.activeSelector, createdSignatureId, destroyed },
    'DKIM signatures normalized onto the A/B selector pair',
  );
  return { activeSelector: plan.activeSelector, createdSignatureId, createdPublicKey, destroyed, failed };
}
