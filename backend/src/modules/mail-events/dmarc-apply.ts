/**
 * Act on the DMARC recommendation (ROADMAP R5 follow-up).
 *
 * The recommendation (dmarc-policy.ts) said "safe to move to p=quarantine" and
 * nothing let anyone do it: the `_dmarc` record is platform-managed, and the
 * tenant page told domain owners to contact support. This rewrites the `p=` tag
 * of that managed record through the ordinary DNS-record path, which publishes
 * to the domain's DNS servers and restores the old value if they refuse.
 *
 * Still never automatic, and still fail-closed:
 *  - TIGHTENING is accepted only as the exact step the recommendation allows
 *    right now (re-computed here, never trusted from the client), so `none →
 *    reject` in one jump, or a tightening while any source fails, is refused;
 *  - LOOSENING is always accepted — it is the way back when legitimate mail
 *    starts landing in spam, and must never wait for reports.
 */
import type { ApplyDmarcPolicyResponse } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import { updateDnsRecord } from '../dns-records/service.js';
import { isZoneWritable } from '../email-domains/dns-provisioning.js';
import { dmarcDomainSummaries, DMARC_WINDOW_DAYS } from './dmarc-summary.js';
import type { DmarcPolicy } from './dmarc-policy.js';
import { DMARC_POLICY_ORDER as ORDER, isTightening, managedDmarcRecords, policyOf, withPolicy } from './dmarc-record.js';

export async function applyDmarcPolicy(
  db: Database,
  input: { domain: string; policy: DmarcPolicy; tenantId?: string },
): Promise<ApplyDmarcPolicyResponse> {
  const domainName = input.domain.trim().toLowerCase().replace(/\.$/, '');
  const records = (await managedDmarcRecords(db, [domainName])).get(domainName) ?? [];
  // A tenant asking about someone else's domain gets the same answer as for a
  // domain that does not exist.
  const mine = input.tenantId ? records.filter((r) => r.tenantId === input.tenantId) : records;
  if (mine.length === 0) {
    throw new ApiError('DMARC_RECORD_NOT_MANAGED',
      `There is no platform-managed _dmarc record for ${domainName}`, 404);
  }
  if (mine.length > 1) {
    throw new ApiError('DMARC_RECORD_AMBIGUOUS',
      `${domainName} has ${mine.length} _dmarc records; remove the extra one in DNS first`, 409);
  }
  const record = mine[0];
  const current = policyOf(record.recordValue);

  if (current === input.policy) {
    return {
      domain: domainName, policy: input.policy, recordName: record.recordName,
      recordValue: record.recordValue, published: await isZoneWritable(db, record.domainId),
    };
  }

  if (isTightening(current, input.policy)) {
    const summary = (await dmarcDomainSummaries(db, { windowDays: DMARC_WINDOW_DAYS, tenantId: record.tenantId }))
      .find((d) => d.policyDomain.toLowerCase() === domainName);
    const rec = summary?.recommendation;
    // The recommendation steps from what reporters SAW; a tightening already
    // published but not yet reported must not be offered twice.
    const stepFromPublished = ORDER[ORDER.indexOf(current ?? 'none') + 1];
    if (!rec?.ready || rec.recommendedPolicy !== input.policy || stepFromPublished !== input.policy) {
      const message = !rec?.ready
        ? (rec?.reason ?? `There are no DMARC reports for ${domainName} yet, so tightening is not safe.`)
        : rec.recommendedPolicy === current
          ? `p=${current} is already published for ${domainName}; wait until the reports confirm it before tightening further.`
          : `Only p=${rec.recommendedPolicy} is recommended for ${domainName} right now.`;
      throw new ApiError('DMARC_TIGHTENING_NOT_READY', message, 409);
    }
  }

  const recordValue = withPolicy(record.recordValue, input.policy);
  await updateDnsRecord(db, record.tenantId, record.domainId, record.id, { record_value: recordValue });
  return {
    domain: domainName,
    policy: input.policy,
    recordName: record.recordName,
    recordValue,
    published: await isZoneWritable(db, record.domainId),
  };
}
