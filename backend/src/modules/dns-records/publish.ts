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
 * value before withdrawing the old one, so the name never stops resolving.
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

function sameValue(a: DnsRecordInput, b: DnsRecordInput): boolean {
  try {
    return a.type.toUpperCase() === b.type.toUpperCase() && canonicalContent(a) === canonicalContent(b);
  } catch {
    return false;
  }
}
