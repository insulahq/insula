import type {
  ApexRecord,
  AttributedRecord,
  HeldRecord,
  RouteHostnameDrift,
  StaleRecord,
} from '@insula/api-contracts';
import { addressKey } from '../../shared/ip-address.js';

/**
 * Pure route-DNS diff for ONE hostname. No DB, no provider calls — the scan
 * and the repair pass everything in, so every case is unit-testable.
 */

/** A record as read back from a DNS provider. */
export interface ProviderRecord {
  readonly type: string;
  readonly name: string;
  readonly content: string;
}

/**
 * What to do with an address that is NOT expected: `stale` (remove it),
 * `held` (ours, but kept on purpose), or null when the platform cannot vouch
 * for it (a foreign record: left alone).
 */
export type Classification =
  | ({ readonly kind: 'stale' } & Omit<StaleRecord, 'type' | 'content'>)
  | ({ readonly kind: 'held' } & Omit<HeldRecord, 'type' | 'content'>);
export type ClassifyUnexpected = (record: ApexRecord) => Classification | null;

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * True when a provider record name addresses `hostname` inside `zone`.
 *
 * Providers disagree on spelling: PowerDNS returns the FQDN with a root dot,
 * others return a zone-relative name or `@` for the apex. Matching only one
 * spelling reports every route as "missing everything", and a repair would
 * then re-add records that already exist.
 */
export function recordNameMatches(recordName: string, hostname: string, zone: string): boolean {
  const n = norm(recordName);
  const h = norm(hostname);
  const z = norm(zone);
  if (n === '' || n === '@') return h === z;
  // Fully qualified: a root dot says so; a name that already ends in the zone
  // is read the same way (providers that drop the dot). Without this the apex
  // `example.test` would also answer for `example.test.example.test`.
  if (recordName.trim().endsWith('.') || n === z || n.endsWith(`.${z}`)) return n === h;
  return `${n}.${z}` === h;
}

/** Kept for the apex-only callers and tests. */
export function isApexRecordName(name: string, domainName: string): boolean {
  return recordNameMatches(name, domainName, domainName);
}

/** Normalise an address for comparison — every IPv6 spelling of one address alike. */
export const addrKey = addressKey;

/**
 * Compare the addresses one route hostname should carry against what the
 * zone holds there.
 *
 * Only A and AAAA at that exact name take part — an MX or TXT beside it is
 * irrelevant to ingress and is neither reported nor touched. Every expected
 * address that is absent is `missing`; every present address that is not
 * expected is `stale` when `classify` can say why it should go (a removed or
 * disabled server, or a record the platform created), `held` when it is ours
 * but stays (a server that is only not Ready, a hand-made record), and
 * `foreign` otherwise.
 */
export function planHostname(input: {
  readonly hostname: string;
  readonly recordName: string;
  readonly zone: string;
  readonly expected: readonly AttributedRecord[];
  readonly zoneRecords: readonly ProviderRecord[];
  readonly classify: ClassifyUnexpected;
}): RouteHostnameDrift {
  const present = input.zoneRecords.filter((r) => {
    const t = r.type.toUpperCase();
    return (t === 'A' || t === 'AAAA') && recordNameMatches(r.name, input.hostname, input.zone);
  });
  const presentKeys = new Set(present.map((r) => addrKey(r.type, r.content)));
  const expectedKeys = new Set(input.expected.map((r) => addrKey(r.type, r.content)));

  const missing = input.expected
    .filter((r) => !presentKeys.has(addrKey(r.type, r.content)))
    .map((r) => ({ type: r.type, content: r.content, servers: [...r.servers] }));
  const ok = input.expected.length - missing.length;

  const stale: StaleRecord[] = [];
  const held: HeldRecord[] = [];
  const foreign: ApexRecord[] = [];
  const seen = new Set<string>();
  for (const r of present) {
    const key = addrKey(r.type, r.content);
    if (expectedKeys.has(key) || seen.has(key)) continue; // a provider may repeat a value
    seen.add(key);
    const record: ApexRecord = { type: r.type.toUpperCase() as 'A' | 'AAAA', content: r.content.trim() };
    const why = input.classify(record);
    if (why?.kind === 'stale') stale.push({ ...record, servers: [...why.servers], reason: why.reason });
    else if (why?.kind === 'held') held.push({ ...record, servers: [...why.servers], reason: why.reason });
    else foreign.push(record);
  }

  return { hostname: input.hostname, recordName: input.recordName, missing, stale, held, foreign, ok };
}
