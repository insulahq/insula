/**
 * DKIM signature cleanup for the email-domain DISABLE flow.
 *
 * Destroying a domain principal alone strands its DkimSignature rows
 * as registry orphans (observed during the 2026-06-07 DKIM E2E:
 * deleted test domains left their RSA + rotation signatures behind),
 * so the disable flow destroys them FIRST via this module.
 *
 * History: this file was suppress-ed25519.ts — the enable-time
 * Ed25519 suppression has been generalized into ./normalize.ts, which
 * replaces Stalwart's auto-created signature pair with the platform's
 * fixed A/B selector scheme (./selectors.ts).
 */

import {
  dkimSignatureGet,
  dkimSignatureSet,
  type JmapAccountId,
  type StalwartDkimSignatureRow,
} from '../stalwart-jmap/client.js';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'email-dkim-cleanup' });

/** All signature ids for a domain, any algorithm — exported for unit tests. */
export function selectAllSignatureIds(
  rows: readonly StalwartDkimSignatureRow[],
  stalwartDomainId: string,
): readonly string[] {
  return rows.filter((r) => r.domainId === stalwartDomainId).map((r) => r.id);
}

export interface CleanupResult {
  readonly destroyed: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Destroy EVERY DkimSignature attached to the given Stalwart domain.
 * Idempotent — returns empty arrays when none exist. Callers treat
 * failures as non-fatal (log + continue): orphaned rows are inert.
 */
export async function removeAllDkimSignaturesForDomain(params: {
  accountId: JmapAccountId;
  stalwartDomainId: string;
  baseUrl?: string;
}): Promise<CleanupResult> {
  const { accountId, stalwartDomainId, baseUrl } = params;

  const rows = await dkimSignatureGet({ accountId, baseUrl });
  const ids = selectAllSignatureIds(rows, stalwartDomainId);
  if (ids.length === 0) {
    return { destroyed: [], failed: [] };
  }

  const res = await dkimSignatureSet({ accountId, destroy: ids, baseUrl });
  const destroyed = res.destroyed ?? [];
  const destroyedSet = new Set(destroyed);
  const failed = ids.filter((id) => !destroyedSet.has(id));
  if (failed.length > 0) {
    log.warn(
      { stalwartDomainId, failed, notDestroyed: res.notDestroyed },
      'DKIM signature cleanup: some signatures were not destroyed',
    );
  } else {
    log.info({ stalwartDomainId, destroyed }, 'DKIM signatures destroyed');
  }
  return { destroyed, failed };
}
