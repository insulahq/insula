/**
 * Local-vs-provider record diff — the engine behind the panel's
 * "Sync Records" dialog.
 *
 * Pure: no DB, no network. Extracted from `service.ts` so the comparison
 * rules can actually be tested. They could not be before, and the result
 * was that Sync Records could never reach all-green:
 *
 *   - `normalizeValue` claimed in its own comment to strip trailing dots
 *     from CNAME/NS/MX targets and only ever stripped quotes, so a local
 *     `ns1.example.test` never matched a remote `ns1.example.test.`
 *   - MX/SRV were compared as a bare target on one side and full wire
 *     content (`10 mail.example.test.`) on the other, so they always
 *     differed.
 *   - SOA was included, and PowerDNS bumps its serial on every write, so
 *     it reported a conflict no button could clear.
 *
 * The fix is to canonicalise BOTH sides into the exact wire form the
 * provider would write (`wire-format.ts` — the same code path that does
 * the writing), so "in sync" means what it says.
 */

import { canonicalContent, qualifyName } from '../dns-servers/wire-format.js';

export interface DnsRecordDiffEntry {
  readonly type: string;
  readonly name: string;
  /** `priority`/`weight`/`port` travel with the entry so the panel's Push
   *  button can send a complete MX/SRV record. Without them a push of an
   *  MX row sent a bare hostname and the provider refused it. */
  readonly local: {
    value: string;
    ttl: number;
    id: string;
    priority?: number | null;
    weight?: number | null;
    port?: number | null;
  } | null;
  readonly remote: { value: string; ttl: number } | null;
  readonly status: 'in_sync' | 'conflict' | 'local_only' | 'remote_only';
}

/** Shape of a `dns_records` row, narrowed to what the diff reads. */
export interface LocalRecord {
  readonly id: string;
  readonly recordType: string;
  readonly recordName: string | null;
  readonly recordValue: string | null;
  readonly ttl: number;
  readonly priority?: number | null;
  readonly weight?: number | null;
  readonly port?: number | null;
}

/** Shape of a provider record as returned by `DnsProviderAdapter.listRecords`. */
export interface RemoteRecord {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
}

/**
 * SOA is server-owned: PowerDNS rewrites the serial on every zone change,
 * so a local copy is stale the instant it is pulled. Excluding it is the
 * only way the dialog can ever show a clean zone.
 */
const SERVER_OWNED_TYPES = new Set(['SOA']);

/**
 * The identity of one published record: type, absolute name, canonical value.
 *
 * Two rows with the same key are ONE record upstream — a server keeps a single
 * copy of a value per (name, type). The diff pairs local with remote on it,
 * and a delete must not withdraw a value another row still publishes.
 *
 * The value is the canonical wire content, or the raw value when it cannot be
 * built: a legacy MX row with no priority genuinely cannot be published, so
 * the diff surfaces it as `local_only` — the truth, it is not in DNS.
 */
export function recordKey(
  zone: string,
  r: { type: string; name: string | null; content: string; priority?: number | null; weight?: number | null; port?: number | null },
): string {
  let value: string;
  try {
    value = canonicalContent({
      type: r.type,
      name: r.name ?? '@',
      content: r.content,
      priority: r.priority ?? undefined,
      weight: r.weight ?? undefined,
      port: r.port ?? undefined,
    });
  } catch {
    value = r.content;
  }
  return [r.type.toUpperCase(), qualifyName(zone, r.name), value].join('|');
}

/** Local and remote records paired by identity — the diff's one decision. */
export interface RecordPairing<R extends RemoteRecord = RemoteRecord> {
  readonly inSync: ReadonlyArray<readonly [LocalRecord, R]>;
  /** Same (type, name), different value: an edit, not two records. */
  readonly conflicts: ReadonlyArray<readonly [LocalRecord, R]>;
  readonly localOnly: readonly LocalRecord[];
  readonly remoteOnly: readonly R[];
}

/**
 * Pair local rows with provider records. SOA is left out (server-owned).
 *
 * Exact matches are taken FIRST, across the whole zone, and only the leftovers
 * are paired as conflicts. Pairing in one pass let a local value with no exact
 * match claim a remote value that a LATER local row matched exactly: with local
 * A @ {1.1.1.1, 2.2.2.2} and remote {2.2.2.2, 3.3.3.3}, 1.1.1.1 "conflicted"
 * with 2.2.2.2, 2.2.2.2 was also "in sync", and 3.3.3.3 showed as remote-only.
 * Harmless while the dialog could only push and pull; a "remove on server"
 * button on that row would withdraw the wrong value.
 */
export function pairRecords<R extends RemoteRecord>(
  zone: string,
  localRecords: readonly LocalRecord[],
  remoteRecords: readonly R[],
): RecordPairing<R> {
  const comparable = (type: string) => !SERVER_OWNED_TYPES.has(type.toUpperCase());

  const localMap = new Map<string, LocalRecord>();
  for (const r of localRecords) {
    if (!comparable(r.recordType)) continue;
    const key = recordKey(zone, { type: r.recordType, name: r.recordName, content: r.recordValue ?? '', priority: r.priority, weight: r.weight, port: r.port });
    localMap.set(key, r);
  }

  const remoteMap = new Map<string, R>();
  for (const r of remoteRecords) {
    if (!comparable(r.type)) continue;
    const key = recordKey(zone, { type: r.type, name: r.name, content: r.content });
    remoteMap.set(key, r);
  }

  const inSync: Array<readonly [LocalRecord, R]> = [];
  const unmatchedLocal: Array<[string, LocalRecord]> = [];
  for (const [key, local] of localMap) {
    const remote = remoteMap.get(key);
    if (remote) inSync.push([local, remote]);
    else unmatchedLocal.push([key, local]);
  }
  const unmatchedRemote = new Map([...remoteMap].filter(([key]) => !localMap.has(key)));

  const conflicts: Array<readonly [LocalRecord, R]> = [];
  const localOnly: LocalRecord[] = [];
  for (const [key, local] of unmatchedLocal) {
    const typeNamePrefix = key.split('|').slice(0, 2).join('|');
    const partner = [...unmatchedRemote].find(([k]) => k.startsWith(`${typeNamePrefix}|`));
    if (partner) {
      unmatchedRemote.delete(partner[0]);
      conflicts.push([local, partner[1]]);
    } else {
      localOnly.push(local);
    }
  }

  return { inSync, conflicts, localOnly, remoteOnly: [...unmatchedRemote.values()] };
}

export function computeRecordDiff(
  zone: string,
  localRecords: readonly LocalRecord[],
  remoteRecords: readonly RemoteRecord[],
): DnsRecordDiffEntry[] {
  const zoneFqdn = qualifyName(zone, '@');

  /** Relative name for display: `@` at the apex, bare label below it. */
  const displayName = (name: string | null | undefined): string => {
    const abs = qualifyName(zone, name);
    if (abs === zoneFqdn) return '@';
    return abs.endsWith(`.${zoneFqdn}`) ? abs.slice(0, -(zoneFqdn.length + 1)) : abs.replace(/\.$/, '');
  };
  const localSide = (l: LocalRecord) => ({
    value: l.recordValue ?? '', ttl: l.ttl, id: l.id, priority: l.priority, weight: l.weight, port: l.port,
  });

  const pairing = pairRecords(zone, localRecords, remoteRecords);
  const diff: DnsRecordDiffEntry[] = [
    ...pairing.inSync.map(([l, r]): DnsRecordDiffEntry => ({
      type: l.recordType, name: displayName(l.recordName),
      local: localSide(l), remote: { value: r.content, ttl: r.ttl }, status: 'in_sync',
    })),
    ...pairing.conflicts.map(([l, r]): DnsRecordDiffEntry => ({
      type: l.recordType, name: displayName(l.recordName),
      local: localSide(l), remote: { value: r.content, ttl: r.ttl }, status: 'conflict',
    })),
    ...pairing.localOnly.map((l): DnsRecordDiffEntry => ({
      type: l.recordType, name: displayName(l.recordName),
      local: localSide(l), remote: null, status: 'local_only',
    })),
    ...pairing.remoteOnly.map((r): DnsRecordDiffEntry => ({
      type: r.type, name: displayName(r.name),
      local: null, remote: { value: r.content, ttl: r.ttl }, status: 'remote_only',
    })),
  ];

  // Conflicts first, then remote_only, then local_only, then in_sync.
  const statusOrder = { conflict: 0, remote_only: 1, local_only: 2, in_sync: 3 };
  return diff.sort(
    (a, b) => statusOrder[a.status] - statusOrder[b.status]
      || a.type.localeCompare(b.type)
      || a.name.localeCompare(b.name),
  );
}

/**
 * What an import from the provider adds to the local table: the records that
 * exist ONLY there. A conflict is not imported — the local row is the
 * platform's record of what it published, and adding the server's value next
 * to it would turn one CNAME into two. The SOA comes over only when there is
 * no local one at that name; its serial changes on every write, so comparing
 * it by value would import a new SOA row on every call.
 */
export function remoteRecordsToImport<R extends RemoteRecord>(
  zone: string,
  localRecords: readonly LocalRecord[],
  remoteRecords: readonly R[],
): R[] {
  const localSoaNames = new Set(localRecords
    .filter((l) => l.recordType.toUpperCase() === 'SOA')
    .map((l) => qualifyName(zone, l.recordName)));
  const soa = remoteRecords.filter((r) => r.type.toUpperCase() === 'SOA' && !localSoaNames.has(qualifyName(zone, r.name)));
  return [...soa, ...pairRecords(zone, localRecords, remoteRecords).remoteOnly];
}
