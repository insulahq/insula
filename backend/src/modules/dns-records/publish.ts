/**
 * Apply ONE record change to ONE provider — value-scoped.
 *
 * A row in `dns_records` is one value. Providers group values into sets per
 * (name, type), and the old write path treated the set as the unit:
 *   - delete removed the whole set, so deleting one apex A row took every
 *     other apex A value off the air while the panel still listed them;
 *   - update only ADDED the new value, so editing 203.0.113.1 → .2 left .1
 *     answering alongside .2, indefinitely.
 * Here a delete withdraws exactly its value, and an update publishes the new
 * value before withdrawing the old one, so the name never stops resolving —
 * except for a type that holds one value only (CNAME), where that order is
 * invalid and the old value goes first (replaceSingleValue).
 */

import type { DnsProviderAdapter, DnsRecordInput } from '../dns-servers/providers/types.js';
import { removeRecordValue } from '../dns-servers/record-value.js';
import { canonicalContent } from '../dns-servers/wire-format.js';

export type RecordChange =
  | { readonly action: 'create' | 'delete'; readonly record: DnsRecordInput }
  | {
      readonly action: 'update';
      readonly record: DnsRecordInput;
      /** The value being replaced. Omit to leave it published — the caller's
       *  answer when another row still publishes that same value. */
      readonly previous?: DnsRecordInput;
      /** Withdraw the new value again when the old one cannot be removed, so
       *  the server matches the row the caller restores. False when another
       *  row already published the new value before this edit. */
      readonly withdrawOnFailure?: boolean;
    };

export async function applyRecordChange(
  provider: DnsProviderAdapter,
  zone: string,
  change: RecordChange,
): Promise<void> {
  if (change.action === 'delete') {
    await removeRecordValue(provider, zone, change.record);
    return;
  }

  if (change.action === 'update' && change.previous && !sameValue(change.previous, change.record)
    && SINGLE_VALUE_TYPES.has(change.record.type.toUpperCase())) {
    await replaceSingleValue(provider, zone, change.previous, change.record);
    return;
  }

  await provider.createRecord(zone, change.record);
  if (change.action !== 'update' || !change.previous) return;
  if (sameValue(change.previous, change.record)) return; // TTL-only edit

  try {
    await removeRecordValue(provider, zone, change.previous);
  } catch (err) {
    if (change.withdrawOnFailure === false) throw err;
    try {
      await removeRecordValue(provider, zone, change.record);
    } catch (rollbackErr) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      throw new Error(
        `${message} — and the new value could not be withdrawn either (${detail}); `
        + `both values are published until one is removed`,
      );
    }
    throw err;
  }
}

/**
 * Types a name can carry only ONE value of. Providers merge a written value
 * into the existing set (PowerDNS createRecord keeps the set's other values),
 * so publishing the new CNAME before withdrawing the old one asked for a
 * two-value CNAME set — which the server refuses, and the edit failed.
 */
const SINGLE_VALUE_TYPES = new Set(['CNAME', 'DNAME']);

/**
 * Old value out, new value in — the other order is invalid for these types.
 * The name stops resolving for the moment between the two calls. When the new
 * value is refused the old one is put back, so a failed edit leaves the server
 * as it was.
 */
async function replaceSingleValue(
  provider: DnsProviderAdapter,
  zone: string,
  previous: DnsRecordInput,
  next: DnsRecordInput,
): Promise<void> {
  await removeRecordValue(provider, zone, previous);
  try {
    await provider.createRecord(zone, next);
  } catch (err) {
    try {
      await provider.createRecord(zone, previous);
    } catch (restoreErr) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      throw new Error(`${message} — and the previous value could not be restored either (${detail}); the name has no ${next.type} record until one is published`);
    }
    throw err;
  }
}

function sameValue(a: DnsRecordInput, b: DnsRecordInput): boolean {
  try {
    return a.type.toUpperCase() === b.type.toUpperCase() && canonicalContent(a) === canonicalContent(b);
  } catch {
    return false;
  }
}
