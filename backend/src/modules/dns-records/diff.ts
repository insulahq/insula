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

import { formatContent, qualifyName } from '../dns-servers/wire-format.js';

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

  /**
   * Canonical wire content — or the raw value when it cannot be built.
   *
   * A legacy MX row with no priority genuinely cannot be published, so
   * falling back to the raw value surfaces it as `local_only`. That is
   * the truth: the record does not exist in DNS.
   */
  const wire = (r: { type: string; name: string; content: string; priority?: number | null; weight?: number | null; port?: number | null }): string => {
    try {
      return formatContent({
        type: r.type,
        name: r.name,
        content: r.content,
        priority: r.priority ?? undefined,
        weight: r.weight ?? undefined,
        port: r.port ?? undefined,
      });
    } catch {
      return r.content;
    }
  };

  const comparable = (type: string) => !SERVER_OWNED_TYPES.has(type.toUpperCase());

  const localMap = new Map<string, LocalRecord>();
  for (const r of localRecords) {
    if (!comparable(r.recordType)) continue;
    const key = [
      r.recordType.toUpperCase(),
      qualifyName(zone, r.recordName),
      wire({ type: r.recordType, name: r.recordName ?? '@', content: r.recordValue ?? '', priority: r.priority, weight: r.weight, port: r.port }),
    ].join('|');
    localMap.set(key, r);
  }

  const remoteMap = new Map<string, RemoteRecord>();
  for (const r of remoteRecords) {
    if (!comparable(r.type)) continue;
    const key = [
      r.type.toUpperCase(),
      qualifyName(zone, r.name),
      wire({ type: r.type, name: r.name, content: r.content }),
    ].join('|');
    remoteMap.set(key, r);
  }

  const diff: DnsRecordDiffEntry[] = [];
  const seen = new Set<string>();

  for (const [key, local] of localMap) {
    seen.add(key);
    const remote = remoteMap.get(key);
    if (remote) {
      diff.push({
        type: local.recordType,
        name: displayName(local.recordName),
        local: { value: local.recordValue ?? '', ttl: local.ttl, id: local.id, priority: local.priority, weight: local.weight, port: local.port },
        remote: { value: remote.content, ttl: remote.ttl },
        status: 'in_sync',
      });
      continue;
    }

    // Same (type, name) with a different value = an edit, not two records.
    const typeNamePrefix = key.split('|').slice(0, 2).join('|');
    const conflicting = Array.from(remoteMap.entries())
      .find(([k]) => k.startsWith(`${typeNamePrefix}|`) && !seen.has(k));
    if (conflicting) {
      seen.add(conflicting[0]);
      diff.push({
        type: local.recordType,
        name: displayName(local.recordName),
        local: { value: local.recordValue ?? '', ttl: local.ttl, id: local.id, priority: local.priority, weight: local.weight, port: local.port },
        remote: { value: conflicting[1].content, ttl: conflicting[1].ttl },
        status: 'conflict',
      });
    } else {
      diff.push({
        type: local.recordType,
        name: displayName(local.recordName),
        local: { value: local.recordValue ?? '', ttl: local.ttl, id: local.id, priority: local.priority, weight: local.weight, port: local.port },
        remote: null,
        status: 'local_only',
      });
    }
  }

  for (const [key, remote] of remoteMap) {
    if (seen.has(key)) continue;
    diff.push({
      type: remote.type,
      name: displayName(remote.name),
      local: null,
      remote: { value: remote.content, ttl: remote.ttl },
      status: 'remote_only',
    });
  }

  // Conflicts first, then remote_only, then local_only, then in_sync.
  const statusOrder = { conflict: 0, remote_only: 1, local_only: 2, in_sync: 3 };
  return diff.sort(
    (a, b) => statusOrder[a.status] - statusOrder[b.status]
      || a.type.localeCompare(b.type)
      || a.name.localeCompare(b.name),
  );
}
