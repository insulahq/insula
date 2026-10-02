/**
 * Remove exactly ONE record value, on any provider.
 *
 * "Delete this record" in the panel means one row — one value. Providers
 * disagree on what their delete call removes:
 *   - RRset-keyed servers (PowerDNS) delete the whole (name, type) set, so
 *     every other value at that name went with it;
 *   - id-keyed APIs (Cloudflare, Hetzner, ClouDNS) want THEIR record id, and
 *     were handed the platform's `name|type|content` composite, which they
 *     reject — the delete never happened.
 * Providers that can remove one value implement `deleteRecordValue`; for the
 * rest, look the value's id up and delete just that record.
 */

import type { DnsProviderAdapter, DnsRecordInput } from './providers/types.js';
import { canonicalContent, qualifyName } from './wire-format.js';

export async function removeRecordValue(
  provider: DnsProviderAdapter,
  zone: string,
  record: DnsRecordInput,
): Promise<void> {
  // A value that cannot be expressed on the wire (a legacy MX row with no
  // priority) was refused when it was written, so it is not upstream.
  try {
    canonicalContent(record);
  } catch {
    return;
  }

  if (provider.deleteRecordValue) {
    await provider.deleteRecordValue(zone, record);
    return;
  }

  const type = record.type.toUpperCase();
  const name = qualifyName(zone, record.name);
  const wanted = canonicalContent(record);
  const hit = (await provider.listRecords(zone)).find((r) => {
    if (r.type.toUpperCase() !== type || qualifyName(zone, r.name) !== name) return false;
    try {
      return canonicalContent({ type, name: r.name, content: r.content, priority: r.priority ?? undefined }) === wanted;
    } catch {
      return false;
    }
  });
  // Absent upstream = already removed; deleting is idempotent.
  if (hit) await provider.deleteRecord(zone, hit.id);
}
