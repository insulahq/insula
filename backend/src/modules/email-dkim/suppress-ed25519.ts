/**
 * Ed25519 DKIM suppression — keep tenant domains RSA-only.
 *
 * Stalwart 0.16 auto-creates BOTH an RSA and an Ed25519 DkimSignature
 * for every new domain principal (selectors `v1-rsa-<date>` /
 * `v1-ed25519-<date>`), regardless of `Bootstrap.generateDkimKeys`.
 * Gmail and Microsoft 365 do not support RFC 8463 ed25519-sha256 —
 * Gmail reports `dkim=fail` for such signatures instead of ignoring
 * them (https://support.stalw.art/t/562), so dual-signing pollutes
 * every tenant's DMARC aggregate reports with permanent failures.
 *
 * The platform therefore destroys the auto-created Ed25519 signature
 * right after domain provisioning. The RSA signature remains the sole
 * active key; rotation (./rotate.ts) likewise creates RSA-only keys.
 * Ed25519 can return as an ADDITIVE second signature once the major
 * verifiers support RFC 8463.
 */

import {
  dkimSignatureGet,
  dkimSignatureSet,
  type JmapAccountId,
  type StalwartDkimSignatureRow,
} from '../stalwart-jmap/client.js';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'email-dkim-suppress' });

export const ED25519_SIGNATURE_TYPE = 'Dkim1Ed25519Sha256';

/**
 * Pure filter — exported for unit tests.
 * Returns the ids of Ed25519 signatures belonging to `stalwartDomainId`.
 */
export function selectEd25519SignatureIds(
  rows: readonly StalwartDkimSignatureRow[],
  stalwartDomainId: string,
): readonly string[] {
  return rows
    .filter((r) => r['@type'] === ED25519_SIGNATURE_TYPE && r.domainId === stalwartDomainId)
    .map((r) => r.id);
}

export interface SuppressResult {
  readonly destroyed: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Destroy every Ed25519 DkimSignature attached to the given Stalwart
 * domain. Idempotent — returns empty arrays when none exist.
 *
 * Callers should treat failures as non-fatal (log + continue): a
 * domain that keeps its Ed25519 signature merely dual-signs like
 * before — delivery still succeeds via the RSA signature.
 */
export async function removeAutoCreatedEd25519Signatures(params: {
  accountId: JmapAccountId;
  stalwartDomainId: string;
  baseUrl?: string;
}): Promise<SuppressResult> {
  const { accountId, stalwartDomainId, baseUrl } = params;

  const rows = await dkimSignatureGet({ accountId, baseUrl });
  const ids = selectEd25519SignatureIds(rows, stalwartDomainId);
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
      'ed25519 DKIM suppression: some signatures were not destroyed',
    );
  } else {
    log.info({ stalwartDomainId, destroyed }, 'ed25519 DKIM signatures destroyed (RSA-only policy)');
  }
  return { destroyed, failed };
}
