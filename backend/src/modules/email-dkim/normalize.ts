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
 *
 * Restore before mint: an A/B selector missing from Stalwart whose kept
 * copy (key-store.ts) is still the key DNS publishes for it is put back
 * with THAT key (restore.ts decides which), so the published record keeps
 * verifying. A new key is minted only when no A/B selector exists and none
 * could be restored — the domain's first enable, or a copy that is gone,
 * undecryptable or no longer published.
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
  DKIM_SELECTOR_B,
  isAbSelector,
  type DkimAbSelector,
} from './selectors.js';
import {
  createRsaDkimSignature,
  redactPemBlocks,
  RSA_SIGNATURE_TYPE,
  ED25519_SIGNATURE_TYPE,
} from './signatures.js';
import type { RestorableDkimKey } from './restore.js';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'email-dkim-normalize' });

// Stalwart generates the auto signature pair ASYNCHRONOUSLY after the
// domain principal create returns — Ed25519 keygen is effectively
// instant but RSA-2048 keygen takes longer, so a listing taken right
// after the create can show only the Ed25519 row (observed live on
// testing: the auto v1-rsa row landed AFTER normalization
// had already swept and created dkim-1). Callers that just created
// the principal pass expectAutoPair=true and we poll until both auto
// rows are visible before planning the sweep.
const AUTO_PAIR_POLL_ATTEMPTS = 6;
const AUTO_PAIR_POLL_DELAY_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * True when the domain's NON-A/B rows include both halves of the
 * Stalwart auto-created pair (one RSA + one Ed25519). Pure — exported
 * for unit tests.
 */
export function hasCompleteAutoPair(
  rows: readonly StalwartDkimSignatureRow[],
  stalwartDomainId: string,
): boolean {
  const nonAb = rows.filter(
    (r) =>
      r.domainId === stalwartDomainId &&
      !(isAbSelector(r.selector) && r['@type'] === RSA_SIGNATURE_TYPE),
  );
  return (
    nonAb.some((r) => r['@type'] === RSA_SIGNATURE_TYPE) &&
    nonAb.some((r) => r['@type'] === ED25519_SIGNATURE_TYPE)
  );
}

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

/**
 * The active selector among those present: the persisted one when it is
 * there, else the only one, else dkim-1. Pure — exported for unit tests.
 */
export function pickActiveSelector(present: readonly string[], currentDbSelector: string | null): DkimAbSelector {
  const ab = present.filter(isAbSelector);
  if (isAbSelector(currentDbSelector) && ab.includes(currentDbSelector)) return currentDbSelector;
  if (ab.length === 1) return ab[0];
  return DKIM_SELECTOR_A;
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
  /** Selectors put back with their kept key; DNS already publishes them. */
  readonly restored: readonly RestorableDkimKey[];
  /** Whether the key this run minted was kept (null when none was minted). */
  readonly keptCopy: boolean | null;
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
  /**
   * True when the caller JUST created the domain principal — Stalwart's
   * auto pair may not be fully materialized yet (see the race note at
   * the top of this file), so we poll for it before planning the sweep.
   */
  expectAutoPair?: boolean;
  /**
   * Called with the key this run creates, if it creates one — the caller keeps
   * the encrypted copy (key-store.ts keepDkimPrivateKey), resolving whether it
   * did. A throw is caught here: keeping a copy never fails signing.
   */
  keepKey?: (selector: string, privateKeyPem: string) => Promise<boolean>;
  /**
   * The kept keys of these missing A/B selectors that may go back into
   * Stalwart (restore.ts restorableDkimKeys). Omitted: nothing is restored.
   */
  restorable?: (selectors: readonly DkimAbSelector[]) => Promise<readonly RestorableDkimKey[]>;
}): Promise<NormalizeResult> {
  const { accountId, stalwartDomainId, baseUrl } = params;

  let rows = await dkimSignatureGet({ accountId, baseUrl });
  if (params.expectAutoPair && !hasCompleteAutoPair(rows, stalwartDomainId)) {
    for (let i = 0; i < AUTO_PAIR_POLL_ATTEMPTS; i++) {
      await sleep(AUTO_PAIR_POLL_DELAY_MS);
      rows = await dkimSignatureGet({ accountId, baseUrl });
      if (hasCompleteAutoPair(rows, stalwartDomainId)) break;
    }
    if (!hasCompleteAutoPair(rows, stalwartDomainId)) {
      log.warn(
        { stalwartDomainId },
        'Stalwart auto signature pair did not fully appear within the poll window — sweeping what exists; the rotation straggler sweep converges any late arrival',
      );
    }
  }
  const plan = planDkimNormalization(rows, stalwartDomainId, params.currentDbSelector ?? null);

  // Restore before mint: put back every missing A/B selector whose kept key
  // DNS still publishes. Each create is soft — a refused one just leaves that
  // selector to the paths below.
  const present = rows
    .filter((r) => r.domainId === stalwartDomainId && isAbSelector(r.selector) && r['@type'] === RSA_SIGNATURE_TYPE)
    .map((r) => r.selector);
  const pair: readonly DkimAbSelector[] = [DKIM_SELECTOR_A, DKIM_SELECTOR_B];
  const missing = pair.filter((s) => !present.includes(s));
  const restored: RestorableDkimKey[] = [];
  if (params.restorable && missing.length > 0) {
    let candidates: readonly RestorableDkimKey[] = [];
    try {
      candidates = await params.restorable(missing);
    } catch (err) {
      log.warn({ stalwartDomainId, err: err instanceof Error ? err.name : 'unknown' },
        'DKIM normalize: kept keys could not be checked for restore');
    }
    for (const key of candidates) {
      if (!missing.includes(key.selector as DkimAbSelector)) continue;
      try {
        await createRsaDkimSignature({
          accountId, stalwartDomainId, selector: key.selector, privateKeyPem: key.privateKeyPem, baseUrl,
        });
        restored.push(key);
      } catch (err) {
        log.warn(
          { stalwartDomainId, selector: key.selector, err: redactPemBlocks(err instanceof Error ? err.message : String(err)).slice(0, 300) },
          'DKIM normalize: Stalwart refused the kept key back; the selector is left to the mint path',
        );
      }
    }
    if (restored.length > 0) {
      log.info({ stalwartDomainId, selectors: restored.map((k) => k.selector) },
        'DKIM normalize: restored the kept keys — the published records keep verifying, no DNS change');
    }
  }

  let createdSignatureId: string | null = null;
  let createdPublicKey: string | null = null;
  let keptCopy: boolean | null = null;
  if (plan.createSelector && restored.length === 0) {
    const { privateKey, publicKey } = generateDkimKeyPair();
    createdSignatureId = await createRsaDkimSignature({
      accountId,
      stalwartDomainId,
      selector: plan.createSelector,
      privateKeyPem: privateKey,
      baseUrl,
    });
    createdPublicKey = publicKey;
    if (params.keepKey) {
      try {
        keptCopy = await params.keepKey(plan.createSelector, privateKey);
      } catch (err) {
        keptCopy = false;
        log.warn({ stalwartDomainId, err: err instanceof Error ? err.name : 'unknown' },
          'DKIM normalize: keeping a copy of the new key failed; it signs as normal');
      }
    }
  }
  const activeSelector = restored.length > 0
    ? pickActiveSelector([...present, ...restored.map((k) => k.selector)], params.currentDbSelector ?? null)
    : plan.activeSelector;

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
    { stalwartDomainId, activeSelector, createdSignatureId, restored: restored.map((k) => k.selector), destroyed },
    'DKIM signatures normalized onto the A/B selector pair',
  );
  return { activeSelector, createdSignatureId, createdPublicKey, destroyed, failed, restored, keptCopy };
}
