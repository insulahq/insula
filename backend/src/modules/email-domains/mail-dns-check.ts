/**
 * Mail DNS check: the domain's live zone against the mail records the
 * platform publishes for it, and what "Re-create mail records" would change.
 *
 * Pure — no DB, no network — so every rule here is unit-tested. The caller
 * (mail-dns-repair.ts) reads the zone and the stored rows.
 *
 * Why this exists: enabling email used to add MX, SPF and DMARC next to
 * whatever the zone already held. A domain moved in with its old provider's
 * records ended up with two MX targets (part of its mail went elsewhere), two
 * SPF records (a permanent error: SPF fails for all mail) and two DMARC
 * records (receivers ignore DMARC when it is published twice), and nothing on
 * screen said so.
 *
 * The rules, per record:
 *  - SPF and DMARC are one record per domain. One record of the tenant's own
 *    stands in for the platform's and is left alone (a warning says what it
 *    lacks). More than one is broken: the repair MERGES them into one, so no
 *    sender the tenant authorised and no report address is lost, and the
 *    DMARC policy is never loosened.
 *  - MX and the mail-discovery SRV records point at the platform mail host.
 *    Another target at those names is a conflict; the repair removes it unless
 *    the tenant chooses to keep it (a backup MX, a filtering gateway).
 *  - DKIM (the platform's selectors) and the webmail CNAME are the platform's
 *    names: another value there is an outdated record, replaced.
 *  - Nothing else in the zone is looked at: old `*._domainkey` selectors and
 *    unrelated TXT records say nothing about this platform's mail.
 *
 * Every removal belongs to a group with the add that replaces it. The repair
 * publishes first and removes a group's old records only once its new record
 * is in: a failed write leaves the domain as it was, never with no MX.
 */

import { qualifyName, txtText } from '../dns-servers/wire-format.js';
import { recordKey } from '../dns-records/diff.js';
import { DMARC_POLICY_ORDER, policyOf, withPolicy } from '../mail-events/dmarc-record.js';
import type { DmarcPolicy } from '../mail-events/dmarc-policy.js';
import type { DnsRecordSpec } from './dns-provisioning.js';

export { txtText };

/** One record as the zone's server lists it. */
export interface ZoneRecord {
  readonly type: string;
  readonly name: string;
  readonly content: string;
}

/** A `dns_records` row, narrowed to what the check reads. */
export interface StoredRecord {
  readonly id: string;
  readonly recordType: string;
  readonly recordName: string | null;
  readonly recordValue: string | null;
  readonly priority?: number | null;
  readonly weight?: number | null;
  readonly port?: number | null;
}

/**
 * `ok`: in the zone. `missing`: not in the zone. `replaced`: the tenant's own
 * SPF or DMARC record stands in for the platform's.
 */
export type MailRecordStatus = 'ok' | 'missing' | 'replaced';

export interface CheckedMailRecord {
  readonly spec: DnsRecordSpec;
  readonly status: MailRecordStatus;
}

export type MailDnsIssueKind =
  | 'duplicate_spf'
  | 'duplicate_dmarc'
  | 'foreign_mx'
  | 'foreign_srv'
  | 'outdated_platform_record'
  | 'spf_without_platform'
  | 'dmarc_reports_elsewhere';

/** A record in the zone that is not the platform's and gets in its way. */
export interface MailDnsIssue {
  readonly kind: MailDnsIssueKind;
  readonly severity: 'error' | 'warning';
  readonly type: string;
  /** Absolute name without the trailing dot. */
  readonly name: string;
  /** The value as a person reads it (TXT unquoted). */
  readonly value: string;
  readonly message: string;
  /** "Re-create mail records" removes this record (or merges it into one). */
  readonly removable: boolean;
}

/**
 * The records the repair treats as one change: an add and the removals it
 * replaces. `spf`, `dmarc`, `mx`, `srv:<name>`, `dkim:<name>`, `webmail`.
 */
export type RepairGroup = string;

/** A record the repair publishes. `storedIds` non-empty: the row exists, only DNS lacks it. */
export interface PlannedAdd {
  readonly group: RepairGroup;
  readonly spec: DnsRecordSpec;
  readonly storedIds: readonly string[];
}

/** A zone record the repair withdraws, with the rows that publish it. */
export interface PlannedRemoval {
  readonly group: RepairGroup;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly value: string;
  readonly storedIds: readonly string[];
  /** The tenant may keep it (another MX or SRV target); merged and outdated records may not. */
  readonly optional: boolean;
}

/** A record in the zone with no row: the repair stores it, so the panel can manage it. */
export interface PlannedAdopt {
  readonly type: string;
  readonly name: string;
  readonly value: string;
  readonly priority: number | null;
}

/** A stored SPF / DMARC row the zone does not hold: it would count as a second record. */
export interface PlannedDrop {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly value: string;
}

export interface MailDnsPlan {
  readonly add: readonly PlannedAdd[];
  readonly remove: readonly PlannedRemoval[];
  readonly adopt: readonly PlannedAdopt[];
  readonly dropStored: readonly PlannedDrop[];
}

export interface MailDnsCheck {
  readonly records: readonly CheckedMailRecord[];
  readonly issues: readonly MailDnsIssue[];
  readonly plan: MailDnsPlan;
}

export interface MailDnsCheckInput {
  readonly domainName: string;
  readonly mailHost: string;
  /** The platform's records for the domain (dns-provisioning's builder, DKIM rows, webmail). */
  readonly expected: readonly DnsRecordSpec[];
  readonly zone: readonly ZoneRecord[];
  readonly stored: readonly StoredRecord[];
}

export function isSpfText(text: string): boolean {
  return /^v=spf1(\s|$)/i.test(text.trim());
}

export function isDmarcText(text: string): boolean {
  return /^v=dmarc1\s*(;|$)/i.test(text.trim());
}

/** A DMARC tag's value (`rua`, `p`, …), or null. */
export function dmarcTag(text: string, tag: string): string | null {
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() === tag) return part.slice(eq + 1).trim();
  }
  return null;
}

export function strictestPolicy(policies: readonly (DmarcPolicy | null)[]): DmarcPolicy | null {
  let best: DmarcPolicy | null = null;
  for (const p of policies) {
    if (p && (best === null || DMARC_POLICY_ORDER.indexOf(p) > DMARC_POLICY_ORDER.indexOf(best))) best = p;
  }
  return best;
}

/**
 * Several SPF records as one: the platform's `mx` first, then every other
 * mechanism any of them listed, once, ending in the platform's `all`.
 * `redirect=` becomes `include:` — inside one record next to other
 * mechanisms that is what it meant. Two records are a permanent error, so
 * receivers already apply neither; the merge authorises everyone either did.
 */
export function mergeSpf(texts: readonly string[], ours: string): string {
  const isAll = (t: string): boolean => /^[+\-~?]?all$/i.test(t);
  const terms = (text: string): string[] => text.trim().split(/\s+/).slice(1);
  const ourTerms = terms(ours);
  const ourAll = ourTerms.find(isAll) ?? '~all';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...ourTerms, ...texts.flatMap(terms)]) {
    const term = /^redirect=/i.test(raw) ? `include:${raw.slice('redirect='.length)}` : raw;
    if (isAll(term) || /^exp=/i.test(term)) continue;
    const key = term.replace(/^\+/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return ['v=spf1', ...out, ourAll].join(' ');
}

/**
 * Several DMARC records as one: the strictest policy any of them published
 * (the repair must never quietly loosen what the domain asked receivers to
 * do), every report address any of them had plus the platform's (first, so
 * the Authentication tab gets its reports), and their other tags (`sp`,
 * `adkim`, `pct`, …), the first record's winning.
 */
export function mergeDmarc(texts: readonly string[], ours: string): string {
  const tagsOf = (text: string): Array<[string, string]> => text.split(';')
    .map((p) => p.trim())
    .filter((p) => p.includes('='))
    .map((p) => [p.slice(0, p.indexOf('=')).trim().toLowerCase(), p.slice(p.indexOf('=') + 1).trim()]);
  // From the published records: the platform's default does not get to
  // tighten what the domain chose.
  const policy = strictestPolicy(texts.map((t) => policyOf(t))) ?? policyOf(ours) ?? 'none';
  const uris = (tag: string): string[] => {
    const all = [ours, ...texts].flatMap((t) => (dmarcTag(t, tag) ?? '').split(',').map((u) => u.trim()).filter(Boolean));
    return all.filter((u, i) => all.findIndex((v) => v.toLowerCase() === u.toLowerCase()) === i);
  };
  const others = new Map<string, string>();
  for (const [k, v] of [ours, ...texts].flatMap(tagsOf)) {
    if (k === 'v' || k === 'p' || k === 'rua' || k === 'ruf') continue;
    if (!others.has(k)) others.set(k, v);
  }
  const parts = ['v=DMARC1', `p=${policy}`];
  if (uris('rua').length > 0) parts.push(`rua=${uris('rua').join(',')}`);
  if (uris('ruf').length > 0) parts.push(`ruf=${uris('ruf').join(',')}`);
  for (const [k, v] of others) parts.push(`${k}=${v}`);
  return parts.join('; ');
}

function absHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.endsWith('.') ? h : `${h}.`;
}

/** The target of an MX / SRV / CNAME value: its last field. */
function targetOf(content: string): string {
  const fields = content.trim().split(/\s+/);
  return absHost(fields[fields.length - 1] ?? '');
}

function bare(name: string): string {
  return name.replace(/\.$/, '');
}

const normText = (t: string): string => t.trim().replace(/\s+/g, ' ').replace(/\s*;\s*/g, '; ').toLowerCase();

interface ZoneEntry extends ZoneRecord {
  readonly abs: string;
  readonly text: string;
  readonly key: string;
}

export function checkMailDns(input: MailDnsCheckInput): MailDnsCheck {
  const { domainName } = input;
  const host = absHost(input.mailHost);
  const at = (name: string | null): string => qualifyName(domainName, name);
  const keyOf = (type: string, name: string | null, content: string, priority?: number | null): string =>
    recordKey(domainName, { type, name, content, priority });

  const zone: ZoneEntry[] = input.zone.map((z) => {
    const type = z.type.toUpperCase();
    return { ...z, type, abs: at(z.name), text: type === 'TXT' ? txtText(z.content) : z.content, key: keyOf(type, z.name, z.content) };
  });
  const storedByKey = new Map<string, string[]>();
  for (const r of input.stored) {
    const key = keyOf(r.recordType, r.recordName, r.recordValue ?? '', r.priority);
    storedByKey.set(key, [...(storedByKey.get(key) ?? []), r.id]);
  }
  const storedIds = (key: string): string[] => storedByKey.get(key) ?? [];
  const zoneKeys = new Set(zone.map((z) => z.key));
  const specKey = (s: DnsRecordSpec): string => keyOf(s.recordType, s.recordName, s.recordValue, s.priority);

  const apex = at('@');
  const expected = input.expected;
  const spfSpec = expected.find((s) => s.purpose === 'spf');
  const dmarcSpec = expected.find((s) => s.purpose === 'dmarc');
  const dmarcName = dmarcSpec ? at(dmarcSpec.recordName) : at(`_dmarc.${domainName}`);
  const ourRua = dmarcSpec ? (dmarcTag(dmarcSpec.recordValue, 'rua') ?? '').toLowerCase() : '';
  const srvNames = new Set(expected.filter((s) => s.purpose === 'srv').map((s) => at(s.recordName)));

  const spfs = zone.filter((z) => z.type === 'TXT' && z.abs === apex && isSpfText(z.text));
  const dmarcs = zone.filter((z) => z.type === 'TXT' && z.abs === dmarcName && isDmarcText(z.text));
  const mxs = zone.filter((z) => z.type === 'MX' && z.abs === apex);
  const srvs = zone.filter((z) => z.type === 'SRV' && srvNames.has(z.abs));

  const isOurSpf = (z: ZoneEntry): boolean => !!spfSpec && normText(z.text) === normText(spfSpec.recordValue);
  const isOurDmarc = (z: ZoneEntry): boolean =>
    ourRua !== '' && (dmarcTag(z.text, 'rua') ?? '').toLowerCase().split(',').map((s) => s.trim()).includes(ourRua);
  const isOurMx = (z: ZoneEntry): boolean => targetOf(z.content) === host;
  // RFC 6186: an SRV target of "." says the service is not offered — the
  // tenant's choice, not a conflict.
  const isOurSrv = (z: ZoneEntry): boolean => targetOf(z.content) === host || targetOf(z.content) === '.';

  const add: PlannedAdd[] = [];
  const remove: PlannedRemoval[] = [];
  const adopt: PlannedAdopt[] = [];
  const issues: MailDnsIssue[] = [];
  const records: CheckedMailRecord[] = [];

  const removal = (group: RepairGroup, z: ZoneEntry, optional = false): void => {
    remove.push({ group, type: z.type, name: bare(z.abs), content: z.content, value: z.text, storedIds: storedIds(z.key), optional });
  };
  const adoptIfUnstored = (z: ZoneEntry): void => {
    if (storedIds(z.key).length > 0) return;
    const fields = z.content.trim().split(/\s+/);
    const first = Number(fields[0]);
    const priority = z.type === 'MX' || z.type === 'SRV' ? (Number.isFinite(first) ? first : 10) : null;
    const value = z.type === 'MX' ? bare(targetOf(z.content)) : z.text;
    adopt.push({ type: z.type, name: bare(z.abs), value, priority });
  };
  const addSpec = (group: RepairGroup, spec: DnsRecordSpec): void => {
    add.push({ group, spec, storedIds: storedIds(specKey(spec)) });
  };
  const issue = (z: ZoneEntry, i: Omit<MailDnsIssue, 'type' | 'name' | 'value'>): void => {
    issues.push({ ...i, type: z.type, name: bare(z.abs), value: z.text });
  };

  // ── SPF ──
  if (spfSpec) {
    const ours = spfs.filter(isOurSpf);
    const status: MailRecordStatus = ours.length > 0 ? 'ok' : spfs.length === 1 ? 'replaced' : 'missing';
    if (spfs.length > 1) {
      const merged = mergeSpf(spfs.map((z) => z.text), spfSpec.recordValue);
      const keep = spfs.find((z) => normText(z.text) === normText(merged));
      for (const z of spfs) {
        if (z === keep) continue;
        if (!isOurSpf(z)) {
          issue(z, {
            kind: 'duplicate_spf', severity: 'error', removable: true,
            message: `${domainName} has ${spfs.length} SPF records. Receivers treat more than one as a permanent error, so SPF fails for all of its mail. Re-create mail records merges them into one.`,
          });
        }
        removal('spf', z);
      }
      if (keep) adoptIfUnstored(keep);
      else addSpec('spf', { ...spfSpec, recordValue: merged });
    } else if (spfs.length === 0) {
      addSpec('spf', spfSpec);
    } else if (ours.length === 0) {
      const text = spfs[0].text.toLowerCase();
      const mentionsPlatform = /(^|\s)[+]?mx(\s|:|\/|$)/.test(text) || text.includes(bare(host));
      if (!mentionsPlatform) {
        issue(spfs[0], {
          kind: 'spf_without_platform', severity: 'warning', removable: false,
          message: 'This SPF record does not include `mx`, so mail sent through this platform can fail SPF. Add `mx` to it in the domain\'s DNS records.',
        });
      }
    } else {
      adoptIfUnstored(ours[0]);
    }
    records.push({ spec: spfSpec, status });
  }

  // ── DMARC ──
  if (dmarcSpec) {
    let status: MailRecordStatus;
    if (dmarcs.length === 0) {
      addSpec('dmarc', dmarcSpec);
      status = 'missing';
    } else if (dmarcs.length === 1) {
      adoptIfUnstored(dmarcs[0]);
      status = isOurDmarc(dmarcs[0]) ? 'ok' : 'replaced';
      if (status === 'replaced') {
        const rua = dmarcTag(dmarcs[0].text, 'rua');
        issue(dmarcs[0], {
          kind: 'dmarc_reports_elsewhere', severity: 'warning', removable: false,
          message: rua
            ? `This DMARC record sends its reports to ${rua}, so the Authentication tab receives none.`
            : 'This DMARC record asks for no reports, so the Authentication tab receives none.',
        });
      }
    } else {
      const merged = mergeDmarc(dmarcs.map((z) => z.text), dmarcSpec.recordValue);
      const keep = dmarcs.find((z) => normText(z.text) === normText(merged));
      for (const z of dmarcs) {
        if (z === keep) continue;
        if (!isOurDmarc(z)) {
          issue(z, {
            kind: 'duplicate_dmarc', severity: 'error', removable: true,
            message: `${domainName} has ${dmarcs.length} DMARC records. Receivers ignore DMARC when it is published more than once, so no policy applies. Re-create mail records merges them into one, at the strictest policy.`,
          });
        }
        removal('dmarc', z);
      }
      if (keep) adoptIfUnstored(keep);
      else addSpec('dmarc', { ...dmarcSpec, recordValue: merged });
      status = dmarcs.some(isOurDmarc) ? 'ok' : 'missing';
    }
    records.push({ spec: dmarcSpec, status });
  }

  // ── MX ──
  const mxSpec = expected.find((s) => s.purpose === 'mx');
  if (mxSpec) {
    const ours = mxs.filter(isOurMx);
    for (const z of mxs.filter((m) => !isOurMx(m))) {
      issue(z, {
        kind: 'foreign_mx', severity: 'error', removable: true,
        message: `Mail for ${domainName} can also be delivered to ${bare(targetOf(z.content))}, so part of it never reaches this platform.`,
      });
      removal('mx', z, true);
    }
    if (ours.length === 0) addSpec('mx', mxSpec);
    else adoptIfUnstored(ours[0]);
    records.push({ spec: mxSpec, status: ours.length > 0 ? 'ok' : 'missing' });
  }

  // ── SRV (mail client discovery) ──
  for (const spec of expected.filter((s) => s.purpose === 'srv')) {
    const name = at(spec.recordName);
    const group = `srv:${bare(name)}`;
    for (const z of srvs.filter((s) => s.abs === name && !isOurSrv(s))) {
      issue(z, {
        kind: 'foreign_srv', severity: 'warning', removable: true,
        message: `Mail apps that look up ${bare(name)} are sent to ${bare(targetOf(z.content))} instead of this platform.`,
      });
      removal(group, z, true);
    }
    const ours = srvs.filter((z) => z.abs === name && isOurSrv(z));
    if (ours.length === 0) addSpec(group, spec);
    else adoptIfUnstored(ours[0]);
    records.push({ spec, status: ours.length > 0 ? 'ok' : 'missing' });
  }

  // ── DKIM and webmail: the platform's own names, checked by value ──
  for (const spec of expected.filter((s) => !['spf', 'dmarc', 'mx', 'srv'].includes(s.purpose))) {
    const name = at(spec.recordName);
    const group = spec.purpose === 'dkim' ? `dkim:${bare(name)}` : spec.purpose;
    const present = zone.find((z) => z.key === specKey(spec));
    // The same name with another value: a key the platform rotated away from,
    // a webmail CNAME at an earlier target, an A record from before the CNAME.
    // A second value next to the new one would be worse than either.
    const sameName = zone.filter((z) => z.abs === name && z !== present && (spec.purpose === 'dkim'
      ? z.type === 'TXT' && /^v=dkim1/i.test(z.text)
      : ['CNAME', 'A', 'AAAA'].includes(z.type)));
    for (const z of sameName) {
      issue(z, {
        kind: 'outdated_platform_record', severity: 'warning', removable: true,
        message: `${bare(name)} is one of the platform's mail records, but holds an old value. Re-create mail records replaces it.`,
      });
      removal(group, z);
    }
    if (!present) addSpec(group, spec);
    else adoptIfUnstored(present);
    records.push({ spec, status: present ? 'ok' : 'missing' });
  }

  // A stored SPF or DMARC row the zone does not hold is not a record anyone
  // sees, but the panel counts it: the DMARC policy buttons refuse a domain
  // with two `_dmarc` rows. A row the repair publishes again is not dropped.
  const republished = new Set(add.flatMap((a) => a.storedIds));
  const dropStored: PlannedDrop[] = input.stored
    .filter((r) => r.recordType.toUpperCase() === 'TXT' && !republished.has(r.id))
    .filter((r) => {
      const name = at(r.recordName);
      const text = txtText(r.recordValue ?? '');
      return (name === apex && isSpfText(text)) || (name === dmarcName && isDmarcText(text));
    })
    .filter((r) => !zoneKeys.has(keyOf(r.recordType, r.recordName, r.recordValue ?? '', r.priority)))
    .map((r) => ({ id: r.id, type: 'TXT', name: bare(at(r.recordName)), value: txtText(r.recordValue ?? '') }));

  // Back into the builder's order, so the table reads the same as before.
  const order = new Map(expected.map((s, i) => [s, i]));
  records.sort((a, b) => (order.get(a.spec) ?? 0) - (order.get(b.spec) ?? 0));

  return { records, issues, plan: { add, remove, adopt, dropStored } };
}

// `withPolicy` is re-exported for the caller that seeds the expected DMARC
// record with the policy the domain publishes.
export { withPolicy, policyOf };
