import type { ApexRecord } from '@insula/api-contracts';

/**
 * Pure apex-drift diff. No DB, no provider calls — everything the scan needs
 * to decide is passed in, so the interesting cases are unit-testable.
 */

/** A record as read back from a DNS provider. */
export interface ProviderRecord {
  readonly type: string;
  readonly name: string;
  readonly content: string;
}

export interface ApexDiff {
  /** Expected records the zone is missing — what an additive fix would ADD. */
  readonly missing: ApexRecord[];
  /** Apex A/AAAA the platform did not put there. Never touched by a fix. */
  readonly unmanaged: ApexRecord[];
}

/**
 * True when `name` addresses the zone apex.
 *
 * Providers are inconsistent here: PowerDNS returns the FQDN with a root dot
 * (`example.test.`), others return `@`, and some return the bare zone name.
 * Treating only one of those as the apex silently reports every domain as
 * "missing everything", which would turn the banner into noise and make a
 * fix re-add records that already exist.
 */
export function isApexRecordName(name: string, domainName: string): boolean {
  const n = name.trim().toLowerCase().replace(/\.+$/, '');
  const d = domainName.trim().toLowerCase().replace(/\.+$/, '');
  return n === '' || n === '@' || n === d;
}

/** Normalise an address for comparison. IPv6 is case-insensitive. */
function addrKey(type: string, content: string): string {
  return `${type.toUpperCase()}|${content.trim().toLowerCase()}`;
}

/**
 * Compare the ingress addresses the platform expects at the apex against what
 * the zone actually holds.
 *
 * Only A and AAAA at the apex participate. Other apex types (NS, SOA, MX, TXT,
 * CAA…) are irrelevant to ingress routing and are neither reported nor
 * touched — flagging an apex MX as "unmanaged" would be alarming and wrong.
 */
export function diffApexRecords(
  domainName: string,
  expected: readonly ApexRecord[],
  zoneRecords: readonly ProviderRecord[],
): ApexDiff {
  const apexAddresses = zoneRecords.filter(
    (r) =>
      (r.type.toUpperCase() === 'A' || r.type.toUpperCase() === 'AAAA') &&
      isApexRecordName(r.name, domainName),
  );

  const presentKeys = new Set(apexAddresses.map((r) => addrKey(r.type, r.content)));
  const expectedKeys = new Set(expected.map((r) => addrKey(r.type, r.content)));

  const missing = expected.filter((r) => !presentKeys.has(addrKey(r.type, r.content)));

  // Deduplicate: a provider can return the same content twice across rrsets.
  const seenUnmanaged = new Set<string>();
  const unmanaged: ApexRecord[] = [];
  for (const r of apexAddresses) {
    const key = addrKey(r.type, r.content);
    if (expectedKeys.has(key) || seenUnmanaged.has(key)) continue;
    seenUnmanaged.add(key);
    unmanaged.push({
      type: r.type.toUpperCase() as 'A' | 'AAAA',
      content: r.content.trim(),
    });
  }

  return { missing, unmanaged };
}

/**
 * Build the expected apex record set from the configured ingress addresses.
 * Callers pass already-parsed address lists (loopback filtered out upstream by
 * `parseIngressIps`).
 */
export function buildExpectedApexRecords(
  ipv4: readonly string[],
  ipv6: readonly string[],
): ApexRecord[] {
  return [
    ...ipv4.map((content) => ({ type: 'A' as const, content })),
    ...ipv6.map((content) => ({ type: 'AAAA' as const, content })),
  ];
}
