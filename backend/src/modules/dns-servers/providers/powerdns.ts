import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, PowerDnsConfig } from './types.js';
import { describeFetchFailure, summarizeUpstreamBody } from '../../../shared/fetch-error.js';
import { fqdn, qualifyName, formatContent } from '../wire-format.js';

/**
 * PowerDNS Authoritative Server provider (API v4 / v5).
 * Uses the PowerDNS REST API for zone and record management.
 */
export class PowerDnsProvider implements DnsProviderAdapter {
  readonly providerType = 'powerdns';
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: PowerDnsConfig) {
    const apiBase = config.api_url.replace(/\/$/, '');
    this.baseUrl = `${apiBase}/api/v1/servers/${config.server_id}`;
    this.headers = {
      'X-API-Key': config.api_key,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: { ...this.headers, ...options.headers },
      });
    } catch (err) {
      // undici reports every transport failure as `fetch failed`; name it.
      throw new Error(describeFetchFailure(err, url));
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // A proxy or WAF in front of PowerDNS answers with an HTML error page.
      throw new Error(`PowerDNS API error: ${res.status} — ${summarizeUpstreamBody(body)}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }> {
    try {
      const info = await this.request<{ version: string; daemon_type: string }>('');
      return { status: 'ok', message: `PowerDNS ${info.daemon_type}`, version: info.version };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    const zones = await this.request<PdnsZone[]>('/zones');
    return zones.map(toZone);
  }

  async getZone(name: string): Promise<DnsZone | null> {
    const normalized = fqdn(name);
    try {
      const zone = await this.request<PdnsZone>(`/zones/${normalized}`);
      return toZone(zone);
    } catch {
      return null;
    }
  }

  async createZone(name: string, kind: 'Native' | 'Master', nameservers?: string[]): Promise<DnsZone> {
    const normalized = fqdn(name);

    // Check if zone already exists
    const existing = await this.getZone(normalized);
    if (existing) return existing;

    // The NS set MUST come from the caller (the domain's provider group).
    //
    // This used to hardcode `["ns1.<zone>", "ns2.<zone>"]` — the zone's own
    // name with a label glued on the front. Those hostnames are never
    // registered and get no glue, so every zone the platform created was a
    // LAME DELEGATION: authoritative-looking, resolvable by nobody. A
    // best-effort `replaceNsRecords()` pass was supposed to correct it
    // afterwards, but it was wrapped in a swallow-everything catch, so when
    // it failed the placeholders silently survived.
    //
    // PowerDNS dedupes nothing here: a duplicated entry makes the API reject
    // the whole RRset with 422, which is how a group holding the same
    // hostname twice took out zone creation. Normalise defensively.
    const apexNs = Array.from(
      new Set((nameservers ?? []).map((ns) => (ns.endsWith('.') ? ns : `${ns}.`))),
    );
    if (apexNs.length === 0) {
      throw new Error(
        `Refusing to create zone '${normalized}' with no nameservers — ` +
          `configure ns_hostnames on the domain's DNS provider group first. ` +
          `A zone with placeholder NS records resolves for nobody.`,
      );
    }

    const zone = await this.request<PdnsZone>('/zones', {
      method: 'POST',
      body: JSON.stringify({
        name: normalized,
        kind,
        nameservers: apexNs,
      }),
    });
    return toZone(zone);
  }

  async deleteZone(name: string): Promise<void> {
    const normalized = fqdn(name);
    await this.request<void>(`/zones/${normalized}`, { method: 'DELETE' });
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    const normalized = fqdn(zone);
    const zoneData = await this.request<PdnsZoneDetail>(`/zones/${normalized}`);

    const records: DnsRecord[] = [];
    for (const rrset of zoneData.rrsets ?? []) {
      for (const rec of rrset.records ?? []) {
        records.push({
          id: `${rrset.name}|${rrset.type}|${rec.content}`,
          type: rrset.type,
          name: rrset.name,
          content: rec.content,
          ttl: rrset.ttl,
          priority: parsePriority(rrset.type, rec.content),
        });
      }
    }
    return records;
  }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const normalized = fqdn(zone);
    const recordName = qualifyName(zone, input.name);

    // Build the content FIRST: formatContent throws on a record whose
    // mandatory numeric fields are missing, and failing before the GET keeps
    // the error about the record rather than about the zone.
    const newContent = formatContent(input);

    // PowerDNS RRSets are keyed by (name, type). REPLACE replaces ALL records
    // in the set, so we must include existing records to avoid overwriting them.
    let existingRecords: Array<{ content: string; disabled: boolean }> = [];
    try {
      const zoneDetail = await this.request<{ rrsets?: Array<{ name: string; type: string; records: Array<{ content: string; disabled: boolean }> }> }>(`/zones/${normalized}`);
      // DNS names are case-insensitive and PowerDNS echoes back whatever case
      // the RRset was created with — compare case-folded or an existing set
      // gets silently clobbered.
      const rrset = zoneDetail.rrsets?.find(
        rr => rr.name.toLowerCase() === recordName.toLowerCase()
          && rr.type.toUpperCase() === input.type.toUpperCase(),
      );
      if (rrset) {
        existingRecords = rrset.records.filter(r => !r.disabled);
      }
    } catch { /* zone might not exist yet */ }

    // Don't add duplicate
    if (!existingRecords.some(r => r.content === newContent)) {
      existingRecords.push({ content: newContent, disabled: false });
    }

    await this.request<void>(`/zones/${normalized}`, {
      method: 'PATCH',
      body: JSON.stringify({
        rrsets: [{
          name: recordName,
          type: input.type,
          ttl: input.ttl ?? 3600,
          changetype: 'REPLACE',
          records: existingRecords,
        }],
      }),
    });

    return {
      id: `${recordName}|${input.type}|${newContent}`,
      type: input.type,
      name: recordName,
      content: newContent,
      ttl: input.ttl ?? 3600,
      priority: input.priority ?? null,
    };
  }

  async updateRecord(zone: string, recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    const [name, type] = recordId.split('|');
    const normalized = fqdn(zone);
    const recordName = qualifyName(zone, name);
    const recordType = (input.type ?? type).toUpperCase();

    // Route the new value through formatContent so an update lands in the
    // same wire format a create would produce — otherwise editing an MX in
    // the panel wrote a bare hostname straight back and 422'd.
    const content = formatContent({
      type: recordType,
      name: recordName,
      content: input.content ?? recordId.split('|')[2],
      priority: input.priority,
      weight: input.weight,
      port: input.port,
    });

    await this.request<void>(`/zones/${normalized}`, {
      method: 'PATCH',
      body: JSON.stringify({
        rrsets: [{
          name: recordName,
          type: recordType,
          ttl: input.ttl ?? 3600,
          changetype: 'REPLACE',
          records: [{ content, disabled: false }],
        }],
      }),
    });

    return {
      id: `${recordName}|${recordType}|${content}`,
      type: recordType,
      name: recordName,
      content,
      ttl: input.ttl ?? 3600,
      priority: input.priority ?? null,
    };
  }

  async deleteRecord(zone: string, recordId: string): Promise<void> {
    const [name, type] = recordId.split('|');
    const normalized = fqdn(zone);
    const recordName = qualifyName(zone, name);

    await this.request<void>(`/zones/${normalized}`, {
      method: 'PATCH',
      body: JSON.stringify({
        rrsets: [{
          name: recordName,
          type,
          changetype: 'DELETE',
          records: [],
        }],
      }),
    });
  }

  async createSlaveZone(name: string, masterIp: string): Promise<DnsZone> {
    const normalized = fqdn(name);

    // Check if zone already exists
    const existing = await this.getZone(normalized);
    if (existing) return existing;

    const zone = await this.request<PdnsZone>('/zones', {
      method: 'POST',
      body: JSON.stringify({
        name: normalized,
        kind: 'Slave',
        masters: [masterIp],
      }),
    });
    return toZone(zone);
  }

  /**
   * Remove a single value from an RRset, keeping the rest.
   *
   * `deleteRecord` above sends `changetype: DELETE`, which drops the
   * ENTIRE (name, type) set — correct for "delete this A record", fatal
   * for ACME DNS-01: an order covering `example.test` and
   * `*.example.test` puts two TXT values on
   * `_acme-challenge.example.test`, and cleaning up the first would
   * strip the second while Let's Encrypt is still checking it.
   *
   * Reads the current set, drops the matching value, and REPLACEs with
   * what's left (or DELETEs when nothing is).
   */
  async deleteRecordValue(zone: string, input: DnsRecordInput): Promise<void> {
    const normalized = fqdn(zone);
    const recordName = qualifyName(zone, input.name);
    const target = formatContent(input);

    let remaining: Array<{ content: string; disabled: boolean }> = [];
    try {
      const zoneDetail = await this.request<{
        rrsets?: Array<{ name: string; type: string; records: Array<{ content: string; disabled: boolean }> }>;
      }>(`/zones/${normalized}`);
      const rrset = zoneDetail.rrsets?.find(
        rr => rr.name.toLowerCase() === recordName.toLowerCase()
          && rr.type.toUpperCase() === input.type.toUpperCase(),
      );
      if (!rrset) return; // already gone — idempotent
      remaining = rrset.records.filter(r => r.content !== target);
      if (remaining.length === rrset.records.length) return; // value not present
    } catch {
      return; // zone gone — nothing to clean up
    }

    await this.request<void>(`/zones/${normalized}`, {
      method: 'PATCH',
      body: JSON.stringify({
        rrsets: [
          remaining.length > 0
            ? {
                name: recordName,
                type: input.type,
                ttl: input.ttl ?? 60,
                changetype: 'REPLACE',
                records: remaining,
              }
            : { name: recordName, type: input.type, changetype: 'DELETE', records: [] },
        ],
      }),
    });
  }

  async replaceNsRecords(zone: string, nameservers: string[]): Promise<void> {
    const normalized = fqdn(zone);
    const records = nameservers.map(ns => ({
      content: ns.endsWith('.') ? ns : `${ns}.`,
      disabled: false,
    }));

    await this.request<void>(`/zones/${normalized}`, {
      method: 'PATCH',
      body: JSON.stringify({
        rrsets: [{
          name: normalized,
          type: 'NS',
          ttl: 3600,
          changetype: 'REPLACE',
          records,
        }],
      }),
    });
  }

  async getZoneAxfrStatus(name: string): Promise<{ synced: boolean; lastSoaSerial?: number }> {
    const normalized = fqdn(name);
    try {
      const zoneData = await this.request<PdnsZoneDetail>(`/zones/${normalized}`);
      const soaRrset = zoneData.rrsets?.find((rrset) => rrset.type === 'SOA');
      if (!soaRrset || soaRrset.records.length === 0) {
        return { synced: false };
      }
      // Parse serial from SOA content (format: "primary rname serial refresh retry expire minimum")
      const soaContent = soaRrset.records[0].content;
      const parts = soaContent.split(/\s+/);
      const serial = parts.length >= 3 ? parseInt(parts[2], 10) : undefined;
      return { synced: true, lastSoaSerial: serial };
    } catch {
      return { synced: false };
    }
  }
}

// ─── PowerDNS API Types ──────────────────────────────────────────────────────

interface PdnsZone {
  readonly name: string;
  readonly kind: string;
  readonly serial: number;
  readonly rrsets?: PdnsRRSet[];
}

interface PdnsZoneDetail extends PdnsZone {
  readonly rrsets: PdnsRRSet[];
}

interface PdnsRRSet {
  readonly name: string;
  readonly type: string;
  readonly ttl: number;
  readonly records: readonly { content: string; disabled: boolean }[];
}

function toZone(z: PdnsZone): DnsZone {
  return { name: z.name, kind: z.kind, serial: z.serial };
}

function parsePriority(type: string, content: string): number | null {
  if (type === 'MX' || type === 'SRV') {
    const parts = content.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const n = parseInt(parts[0], 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
