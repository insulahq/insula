/**
 * DNS presentation-format helpers (RFC 1035 §5.1).
 *
 * Not PowerDNS-specific: this is the canonical on-the-wire text form of a
 * record. It lives outside `providers/` because two callers need it —
 * the provider adapters that write records, and `dns-records/service.ts`,
 * which has to compare local rows against provider rows in ONE form. When
 * the diff normalised differently from the writer, every CNAME/NS/MX row
 * showed as a permanent conflict and Sync Records could never converge.
 */

import type { DnsRecordInput } from './providers/types.js';

/** Record types whose entire content is a hostname and must therefore be
 *  canonical (trailing dot) on the wire. */
const HOSTNAME_CONTENT_TYPES = new Set(['CNAME', 'NS', 'PTR', 'DNAME', 'ALIAS']);

/** Canonicalise a hostname: PowerDNS rejects a non-canonical target with
 *  `Not in expected format (parsed as '<x>.')`. */
export function fqdn(host: string): string {
  const trimmed = host.trim();
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

/**
 * True when `content` already carries its own leading numeric fields.
 *
 * A record READ BACK from a provider (or pulled into the local DB by the
 * Sync Records dialog) stores the full wire content — `10 mail.example.test.`
 * for MX. Re-prefixing that with the `priority` column would yield
 * `10 10 mail.example.test.`, so detect and pass it through instead.
 */
function hasNumericPrefix(content: string, count: number): boolean {
  const parts = content.trim().split(/\s+/);
  if (parts.length !== count + 1) return false;
  return parts.slice(0, count).every((p) => /^\d+$/.test(p));
}

/**
 * Build the PowerDNS wire content for a record.
 *
 * Throws — rather than emitting content the server will reject — when a
 * type's mandatory numeric fields are missing. The thrown message is
 * operator-facing: it reaches the panel via the DNS_RECORD_INVALID error
 * raised in dns-records/service.ts.
 *
 * Every branch here exists because a real PowerDNS 4.9 rejected the
 * previous output with a 422 that the sync layer then swallowed:
 *   MX  'mail.example.test'    → expected digits at position 0
 *   MX  '10 mail.example.test' → Not in expected format (parsed as '…test.')
 *   SRV 'sip.example.test'     → expected digits at position 0
 *   CAA 'letsencrypt.org'      → expected digits at position 0
 */
export function formatContent(input: DnsRecordInput): string {
  const type = input.type.toUpperCase();
  const raw = input.content.trim();

  if (type === 'MX') {
    if (hasNumericPrefix(raw, 1)) {
      const [pref, target] = raw.split(/\s+/);
      return `${pref} ${fqdn(target)}`;
    }
    if (input.priority == null) {
      throw new Error(
        "MX records require a priority (preference) — PowerDNS parses MX content as "
        + "'<priority> <hostname>' and rejects a bare hostname.",
      );
    }
    return `${input.priority} ${fqdn(raw)}`;
  }

  if (type === 'SRV') {
    if (hasNumericPrefix(raw, 3)) {
      const [prio, weight, port, target] = raw.split(/\s+/);
      return `${prio} ${weight} ${port} ${fqdn(target)}`;
    }
    if (input.priority == null || input.weight == null || input.port == null) {
      throw new Error(
        "SRV records require priority, weight and port — PowerDNS parses SRV content as "
        + "'<priority> <weight> <port> <target>'.",
      );
    }
    return `${input.priority} ${input.weight} ${input.port} ${fqdn(raw)}`;
  }

  if (type === 'CAA') {
    // `<flags> <tag> "<value>"`, e.g. `0 issue "letsencrypt.org"`. The value
    // is quoted; flags and tag are not. Accept an unquoted value and quote it.
    const m = /^(\d+)\s+([a-z0-9]+)\s+(.+)$/i.exec(raw);
    if (!m) {
      throw new Error(
        'CAA records must be written as \'<flags> <tag> "<value>"\', '
        + 'e.g. \'0 issue "letsencrypt.org"\'.',
      );
    }
    const [, flags, tag, value] = m;
    const quoted = value.startsWith('"') && value.endsWith('"') ? value : `"${value}"`;
    return `${flags} ${tag.toLowerCase()} ${quoted}`;
  }

  // PowerDNS requires TXT/SPF records to be double-quoted.
  if (type === 'TXT' || type === 'SPF') {
    return raw.startsWith('"') && raw.endsWith('"') ? raw : `"${raw}"`;
  }

  if (HOSTNAME_CONTENT_TYPES.has(type)) return fqdn(raw);

  return raw;
}

/**
 * Resolve a record name to the absolute name PowerDNS expects.
 *
 * Handles all three shapes callers actually pass:
 *   '@' / ''                 → the zone apex
 *   'www'                    → 'www.<zone>.'
 *   'www.<zone>' / '<zone>'  → left alone (already fully qualified)
 *
 * That last case is the one that broke email DNS: dns-provisioning.ts
 * passes the FULL record name (`<apex>`, `<selector>._domainkey.<apex>`),
 * and gluing the zone on a second time published every mail record to
 * `<apex>.<apex>.` — accepted by PowerDNS, resolvable by nobody.
 *
 * A relative label that happens to end with the zone name (zone `test`,
 * label `example.test`) is read as already-qualified. That matches every
 * DNS UI and is the only interpretation that can be expressed at all.
 */
export function qualifyName(zone: string, name: string | null | undefined): string {
  const zoneFqdn = fqdn(zone).toLowerCase();
  const zoneBare = zoneFqdn.slice(0, -1);
  const raw = (name ?? '').trim().toLowerCase();

  if (raw === '' || raw === '@') return zoneFqdn;
  if (raw.endsWith('.')) return raw;
  if (raw === zoneBare) return zoneFqdn;
  if (raw.endsWith(`.${zoneBare}`)) return `${raw}.`;
  return `${raw}.${zoneFqdn}`;
}

/**
 * The same record, decomposed for provider APIs that take the numeric
 * fields SEPARATELY rather than packed into the RDATA string.
 *
 * Two shapes exist in the wild and both must be produced from one source:
 *   * COMPOSED (`formatContent`) — PowerDNS, BIND/rndc, Hetzner, Route53:
 *     the value IS the presentation-format RDATA, `10 mail.example.test.`
 *   * SPLIT (this) — Cloudflare, ClouDNS: `content` is the bare target and
 *     priority/weight/port ride alongside as their own API fields.
 *
 * Every provider previously rolled its own half-version of this, and all of
 * them were wrong in the same direction: Hetzner and Route53 sent a bare
 * hostname as an MX value, Cloudflare and ClouDNS never sent weight or port
 * so SRV could not be created, and rndc composed MX without the trailing dot.
 */
export interface SplitRecordContent {
  /** Bare RDATA target — canonicalised hostname, TXT left unquoted. */
  readonly content: string;
  readonly priority?: number;
  readonly weight?: number;
  readonly port?: number;
}

export function splitContent(input: DnsRecordInput): SplitRecordContent {
  const type = input.type.toUpperCase();
  const raw = input.content.trim();

  if (type === 'MX') {
    if (hasNumericPrefix(raw, 1)) {
      const [pref, target] = raw.split(/\s+/);
      return { content: fqdn(target), priority: Number(pref) };
    }
    if (input.priority == null) {
      throw new Error(
        "MX records require a priority (preference) — it is a distinct field, "
        + 'not part of the hostname.',
      );
    }
    return { content: fqdn(raw), priority: input.priority };
  }

  if (type === 'SRV') {
    if (hasNumericPrefix(raw, 3)) {
      const [prio, weight, port, target] = raw.split(/\s+/);
      return { content: fqdn(target), priority: Number(prio), weight: Number(weight), port: Number(port) };
    }
    if (input.priority == null || input.weight == null || input.port == null) {
      throw new Error('SRV records require priority, weight and port.');
    }
    return { content: fqdn(raw), priority: input.priority, weight: input.weight, port: input.port };
  }

  // TXT stays unquoted here: these APIs quote it themselves, and a
  // double-quoted value comes back with literal quotes in the answer.
  if (type === 'TXT' || type === 'SPF') {
    return { content: raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw };
  }

  if (HOSTNAME_CONTENT_TYPES.has(type)) return { content: fqdn(raw) };

  return { content: raw };
}
