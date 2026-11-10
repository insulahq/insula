import { eq } from 'drizzle-orm';
// R5: one constant for the report address, so the published `rua=` and the
// mailbox the reconciler creates cannot drift apart.
import { DMARC_LOCAL_PART as DMARC_REPORT_LOCAL_PART } from '../mail-events/report-intake-reconciler.js';
import crypto from 'crypto';
import { dnsRecords, emailDomains, domains } from '../../db/schema.js';
import { getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { formatDkimDnsValue } from './dkim.js';
import type { Database } from '../../db/index.js';
import { qualifyName, txtText } from '../dns-servers/wire-format.js';
import { recordKey } from '../dns-records/diff.js';
import { isDmarcText, isSpfText, type ZoneRecord } from './mail-dns-check.js';

// The webmail record is a CNAME at the platform webmail hostname, so this
// module no longer resolves any IP itself. MAIL_SERVER_IP / MAIL_SERVER_IPV6
// and their INGRESS_DEFAULT_* fallbacks lived here to address
// `webmail.<domain>` directly; both are gone with the A/AAAA records they fed.

// mtaStsPolicyId helper removed along with the MTA-STS
// records — see the comment block where the records were dropped.

export interface MailDnsSyncOutcome {
  readonly status: 'published' | 'skipped' | 'failed';
  readonly message?: string;
}

export async function syncRecordToProviders(
  db: Database,
  domainId: string,
  domainName: string,
  action: 'create' | 'delete',
  record: { type: string; name: string; content: string; ttl?: number; priority?: number | null; weight?: number | null; port?: number | null; id?: string },
  encryptionKey: string,
): Promise<MailDnsSyncOutcome> {
  try {
    // Phase 2c: only push records when the platform has authority over the
    // zone. Previously this silently tried to write and swallowed errors,
    // which made debugging cname-mode domains confusing (the email provider
    // row was marked provisioned=1 even though nothing hit DNS).
    const [domain] = await db
      .select({ dnsMode: domains.dnsMode })
      .from(domains)
      .where(eq(domains.id, domainId));
    if (!domain) return { status: 'skipped', message: 'domain row not found' };

    const servers = await getActiveServersForDomain(db, domainId);
    const canManage = canManageDnsZone({
      dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
      activeServers: servers.map((s) => ({
        id: s.id,
        providerType: s.providerType,
        enabled: s.enabled,
        role: s.role,
      })),
    });
    if (!canManage) {
      console.info(
        `[email-dns] Skipping ${action} of ${record.type} '${record.name}' — platform is not authoritative for '${domainName}' (dnsMode=${domain.dnsMode})`,
      );
      return { status: 'skipped', message: `dnsMode=${domain.dnsMode}` };
    }

    const errors: string[] = [];
    for (const server of servers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        if (action === 'create') {
          await provider.createRecord(domainName, {
            type: record.type,
            name: record.name,
            content: record.content,
            ttl: record.ttl ?? 3600,
            priority: record.priority ?? undefined,
            weight: record.weight ?? undefined,
            port: record.port ?? undefined,
          });
        } else if (action === 'delete' && record.id) {
          // Deliberately the WHOLE (name, type) set: every caller deletes at a
          // name this module owns outright (`<selector>._domainkey`, `_dmarc`,
          // `webmail`), where clearing the set is what "replace" means. Never
          // route a shared name (the apex SPF TXT, MX) through here — use
          // dns-records' syncRecordToProviders, which removes one value.
          await provider.deleteRecord(domainName, `${record.name}|${record.type}|${record.content}`);
        }
      } catch (err) {
        // This was a bare `catch {}` with not even a log line. Every mail
        // record PowerDNS rejected — which, until the wire-format fix, was
        // the MX and every SRV — vanished here while the email-domain row
        // was still marked provisioned.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[email-dns] ${action} ${record.type} '${record.name}' failed on ${server.displayName}: ${message}`,
        );
        errors.push(`${server.displayName}: ${message}`);
      }
    }
    if (errors.length > 0) return { status: 'failed', message: errors.join('; ') };
    return { status: 'published' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[email-dns] could not resolve DNS servers for '${domainName}': ${message}`);
    return { status: 'failed', message };
  }
}

export type DnsRecordPurpose =
  | 'mx'
  | 'mail_host'
  | 'spf'
  | 'dkim'
  | 'dmarc'
  | 'srv'
  | 'autoconfig'
  | 'mta_sts'
  | 'webmail';

export interface DnsRecordSpec {
  readonly recordType: string;
  readonly recordName: string;
  readonly recordValue: string;
  readonly ttl: number;
  readonly priority: number | null;
  // Round-3: purpose lets the UI group/label records and the
  // update handler identify which record(s) correspond to a
  // particular email-domain feature (e.g. webmail).
  readonly purpose: DnsRecordPurpose;
}

// Exported so the read-only "view DNS records" endpoint can reuse
// the exact same list the provisioning path writes — no drift.
export function buildEmailDnsRecordsForDisplay(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  mailServerHostname: string,
  options: WebmailRecordOptions = {},
): readonly DnsRecordSpec[] {
  return buildEmailDnsRecords(
    domainName,
    dkimSelector,
    dkimPublicKey,
    mailServerHostname,
    options,
  );
}

export interface WebmailRecordOptions {
  readonly webmailEnabled?: boolean;
  /**
   * Platform webmail hostname the tenant's `webmail.<domain>` points at.
   * Resolved from `default_webmail_url`; callers that only render a preview
   * may omit it and get the documented placeholder.
   */
  readonly webmailHostname?: string;
}

function buildEmailDnsRecords(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  mailServerHostname: string,
  options: WebmailRecordOptions = {},
): readonly DnsRecordSpec[] {
  const webmailRecords: readonly DnsRecordSpec[] = options.webmailEnabled
    ? buildWebmailRecords(domainName, options.webmailHostname ?? mailServerHostname)
    : [];

  const base: readonly DnsRecordSpec[] = buildBaseRecords(
    domainName,
    dkimSelector,
    dkimPublicKey,
    mailServerHostname,
  );
  return webmailRecords.length > 0 ? [...base, ...webmailRecords] : base;
}

/**
 * `webmail.<domain>` — a single CNAME at the platform's webmail hostname.
 *
 * This used to be an A (plus an optional AAAA) at MAIL_SERVER_IP, which is the
 * MAIL server's address: webmail is served by the ingress, so the pair could
 * point at different hosts, and every ingress address change meant rewriting
 * one record per tenant. A CNAME tracks the platform hostname on its own.
 *
 * A CNAME does NOT change the SNI — the browser still presents
 * `webmail.<domain>` — so this record alone is not enough. The platform also
 * has to answer for that hostname with a certificate that covers it; see
 * `ensureWebmailIngress`, which publishes the redirect and the cert together.
 * Publishing the record without that route is what left the hostname
 * unreachable.
 */
function buildWebmailRecords(
  domainName: string,
  webmailHostname: string,
): readonly DnsRecordSpec[] {
  return [
    {
      recordType: 'CNAME',
      recordName: `webmail.${domainName}`,
      recordValue: ensureTrailingDot(webmailHostname),
      ttl: 3600,
      priority: null,
      purpose: 'webmail',
    },
  ];
}

/** CNAME targets are absolute — a missing root label re-anchors at the zone. */
export function ensureTrailingDot(host: string): string {
  const trimmed = host.trim();
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

function buildBaseRecords(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  mailServerHostname: string,
): readonly DnsRecordSpec[] {
  return [
    // ─── Core receiving records ────────────────────────────
    // MX target is the platform mail-server hostname directly (e.g.
    // mail.platformdomain.com), NOT a per-tenant mail.<domainName>
    // alias. Reasons:
    //   1. Stalwart's TLS cert covers mail.${PLATFORM_DOMAIN} (single
    //      SAN) — sending MTAs validate SNI against the cert, so
    //      pointing at a per-tenant hostname triggers a TLS-mismatch
    //      reject by strict receivers (Gmail, Microsoft).
    //   2. MTA-STS is impossible without a cert that covers the
    //      MX-target hostname — sticking with the platform hostname
    //      keeps that path open.
    //   3. One less DNS record per tenant (no per-tenant mail.A).
    {
      recordType: 'MX',
      recordName: domainName,
      recordValue: mailServerHostname,
      ttl: 3600,
      priority: 10,
      purpose: 'mx',
    },
    // ─── SPF / DKIM / DMARC ────────────────────────────────
    {
      recordType: 'TXT',
      recordName: domainName,
      recordValue: 'v=spf1 mx ~all',
      ttl: 3600,
      priority: null,
      purpose: 'spf',
    },
    // DKIM TXT — only when a selector is actually provided. Since M13
    // the enable flow passes dkimSelector='' (Stalwart owns key
    // generation; the real selector record is published inline by
    // `upsertDkimTxtRecord` from the enable flow, rotation and drift
    // repair — there is no background reconcile), which used to produce a junk
    // "._domainkey.<domain>" row with an empty selector on every
    // email-domain enable. Rotation inserts its own record directly.
    ...(dkimSelector
      ? [{
          recordType: 'TXT' as const,
          recordName: `${dkimSelector}._domainkey.${domainName}`,
          recordValue: formatDkimDnsValue(dkimPublicKey),
          ttl: 3600,
          priority: null,
          purpose: 'dkim' as const,
        }]
      : []),
    // ROADMAP R5. The `rua=` address MUST be a real principal and MUST be in
    // this same domain.
    //
    // It used to be `dmarc-reports@<domain>` — an address nothing in the
    // platform ever created. Stalwart does not bypass RCPT validation for
    // report addresses, so every aggregate report any receiver sent was
    // refused with `550 5.1.2 Mailbox does not exist` and silently discarded.
    // Confirmed on DEV: the record was published, the mailbox did
    // not exist, and no report had ever been ingested.
    //
    // Same-domain rather than a central `dmarc@<apex>`: RFC 7489 §7.1 requires
    // an authorisation record (`<domain>._report._dmarc.<apex> TXT v=DMARC1`)
    // in the REPORTING domain's zone before a reporter will send cross-domain,
    // and this builder writes into one zone only — `syncRecordToProviders` is
    // scoped to this domainId. A cross-domain rua published without that record
    // is one most reporters simply refuse, which would look identical to the
    // bug being fixed. `report-intake-reconciler` creates the matching
    // `dmarc@` mailbox for every enabled email domain.
    {
      recordType: 'TXT',
      recordName: `_dmarc.${domainName}`,
      // p=quarantine (operator decision; it was p=none for a while).
      //
      // `p=none` protects nothing: anyone may send as the domain and
      // receivers deliver it normally. A new domain starts enforcing instead.
      //
      // The cost, and why it was p=none: a newly enabled domain has no
      // evidence that its legitimate mail aligns, so mail from a sender
      // that does not (a CRM, a newsletter provider, a web form, the
      // tenant's own office server) goes to spam, and nothing tells the
      // sender. The tenant finds out when a customer says the invoice never
      // arrived. The reports collected at the rua= address show such a
      // sender; Monitoring → Mail can move a domain back to p=none while it
      // is fixed, and says when it is ready for p=reject
      // (mail-events/dmarc-policy.ts).
      //
      // This affects NEWLY provisioned records only. A domain already
      // publishing a policy keeps it: nothing rewrites a published DMARC
      // record except that apply action.
      recordValue: `v=DMARC1; p=quarantine; rua=mailto:${DMARC_REPORT_LOCAL_PART}@${domainName}`,
      ttl: 3600,
      priority: null,
      purpose: 'dmarc',
    },
    // ─── Phase 3.C.2: SRV records for mail tenant autodiscovery ─────
    // Thunderbird and Apple Mail probe SRV records before resorting
    // to guesses. Port + priority + weight per RFC 6186.
    {
      recordType: 'SRV',
      recordName: `_imaps._tcp.${domainName}`,
      recordValue: `0 1 993 ${mailServerHostname}`,
      ttl: 3600,
      priority: 0,
      purpose: 'srv',
    },
    {
      recordType: 'SRV',
      recordName: `_imap._tcp.${domainName}`,
      recordValue: `10 1 143 ${mailServerHostname}`,
      ttl: 3600,
      priority: 10,
      purpose: 'srv',
    },
    // POP3S only — Stalwart binds no plaintext POP3 (110) listener, so we
    // never advertise one. Priority 20 keeps IMAP (0/10) ahead of POP3 for
    // clients that read the whole SRV set and pick the lowest.
    {
      recordType: 'SRV',
      recordName: `_pop3s._tcp.${domainName}`,
      recordValue: `20 1 995 ${mailServerHostname}`,
      ttl: 3600,
      priority: 20,
      purpose: 'srv',
    },
    {
      recordType: 'SRV',
      recordName: `_submissions._tcp.${domainName}`,
      recordValue: `0 1 465 ${mailServerHostname}`,
      ttl: 3600,
      priority: 0,
      purpose: 'srv',
    },
    {
      recordType: 'SRV',
      recordName: `_submission._tcp.${domainName}`,
      recordValue: `10 1 587 ${mailServerHostname}`,
      ttl: 3600,
      priority: 10,
      purpose: 'srv',
    },
    // ─── autoconfig / autodiscover CNAMEs ──────
    // Previously this block created CNAMEs autoconfig.<domain> and
    // autodiscover.<domain> → platform mail hostname. The intent was
    // to let Thunderbird/Outlook discovery probes find the mail
    // server. The reality:
    //
    //   - Thunderbird probes https://autoconfig.<domain>/...
    //   - The TLS handshake's SNI = autoconfig.<domain>, but the
    //     server (Stalwart) only has a cert for the single SAN
    //     mail.${PLATFORM_DOMAIN} → cert mismatch → handshake fails
    //   - Same for autodiscover (Outlook).
    //
    // Per-tenant cert provisioning to fix this is significant infra
    // work (cert-manager Cert CR per tenant, DNS automation, lifecycle
    // hooks). It's out of scope for the TLS-bootstrap rewrite. SRV
    // records (above) are the cheap-but-effective layer that covers
    // Thunderbird, K-9, FairEmail, Mailspring, partial Apple Mail
    // without any cert issues. Outlook autodiscover support becomes
    // a separate follow-up phase if/when customer demand justifies
    // the per-tenant cert provisioning.
    //
    // The TXT/CNAME entries previously written for these records will
    // be removed from PowerDNS the next time the domain is
    // re-provisioned via the existing diff-and-reconcile path.
    // ─── MTA-STS records ───────────────────────
    // Same cert-mismatch problem as the autoconfig CNAMEs above:
    // MTA-STS spec (RFC 8461) requires the policy file to be served
    // over HTTPS at mta-sts.<domain>/.well-known/mta-sts.txt with a
    // cert that validates against mta-sts.<domain>. Stalwart's single-
    // SAN cert (mail.${PLATFORM_DOMAIN}) doesn't cover mta-sts.<tenant>
    // → policy fetch fails → strict-mode MTAs reject delivery,
    // testing-mode MTAs downgrade.
    //
    // The previously-advertised _mta-sts.<domain> TXT + mta-sts.<domain>
    // CNAME are dropped together. _mta-sts TXT alone advertises a
    // policy that can't be fetched, which is worse than no policy
    // (misleading vs. silent). Both records will be removed from
    // PowerDNS the next time the domain is re-provisioned.
    //
    // Re-introducing MTA-STS requires per-tenant cert provisioning
    // (cert-manager Cert CR per tenant domain covering at least
    // mta-sts.<tenant>). Same precondition as Outlook autodiscover —
    // tracked as a separate phase.
  ];
}

export async function provisionEmailDns(
  db: Database,
  domainId: string,
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  encryptionKey: string,
  mailServerHostname: string,
  options: WebmailRecordOptions = {},
): Promise<void> {
  const records = buildEmailDnsRecords(
    domainName,
    dkimSelector,
    dkimPublicKey,
    mailServerHostname,
    options,
  );

  // Whether the platform owns this zone. Resolved ONCE here rather than
  // per-record inside syncRecordToProviders, because the answer also decides
  // what the *_provisioned flags may claim.
  const platformOwnsZone = await isZoneWritable(db, domainId);
  const rejected: string[] = [];

  // What the domain already has. Enabling email used to add every record next
  // to whatever was there, so a domain moved in with its old provider's
  // records got a second SPF record (a permanent error: SPF fails for all of
  // its mail) and a second DMARC record (receivers then ignore DMARC).
  const keyOf = (type: string, name: string | null, content: string, priority?: number | null): string =>
    recordKey(domainName, { type, name, content, priority });
  const stored = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));
  const storedKeys = new Set(stored.map((r) => keyOf(r.recordType, r.recordName, r.recordValue ?? '', r.priority)));
  const zone = platformOwnsZone ? (await readMailZone(db, domainId, domainName)).zone : null;
  const zoneKeys = new Set((zone ?? []).map((z) => keyOf(z.type, z.name, z.content)));
  const zoneTxt = (name: string, test: (text: string) => boolean): ZoneRecord[] =>
    (zone ?? []).filter((z) => z.type.toUpperCase() === 'TXT'
      && qualifyName(domainName, z.name) === qualifyName(domainName, name) && test(txtText(z.content)));

  for (const rec of records) {
    const key = keyOf(rec.recordType, rec.recordName, rec.recordValue, rec.priority);

    // SPF and DMARC are one record per domain. A domain that already
    // publishes its own keeps it; the mail DNS check on the Settings & DNS
    // tab says what it lacks, and "Re-create mail records" replaces it.
    if ((rec.purpose === 'spf' || rec.purpose === 'dmarc') && !zoneKeys.has(key)) {
      const own = zoneTxt(rec.recordName, rec.purpose === 'spf' ? isSpfText : isDmarcText);
      if (own.length > 0) {
        console.info(`[email-dns] '${domainName}' already publishes ${rec.purpose.toUpperCase()}; the platform's record was not added next to it`);
        // The DMARC policy buttons act on a stored `_dmarc` row; give the
        // domain's own record one when it has none.
        const ownKey = keyOf('TXT', own[0].name, own[0].content);
        if (rec.purpose === 'dmarc' && own.length === 1 && !storedKeys.has(ownKey)) {
          await db.insert(dnsRecords).values({
            id: crypto.randomUUID(), domainId, recordType: 'TXT',
            recordName: rec.recordName, recordValue: txtText(own[0].content), ttl: rec.ttl, priority: null,
          });
        }
        continue;
      }
    }

    // The row is written in EVERY dnsMode, deliberately. In cname/secondary
    // mode the customer runs their own DNS, so the platform cannot publish
    // these — but the operator still needs to SEE the exact MX/SPF/DKIM/DMARC
    // values to paste into their provider. Withholding the rows would leave
    // the DNS page empty and the mail domain quietly unusable with nothing on
    // screen explaining why. A row that is already there is not written twice.
    if (!storedKeys.has(key)) {
      await db.insert(dnsRecords).values({
        id: crypto.randomUUID(),
        domainId,
        recordType: rec.recordType as 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS',
        recordName: rec.recordName,
        recordValue: rec.recordValue,
        ttl: rec.ttl,
        priority: rec.priority,
      });
      storedKeys.add(key);
    }
    if (zoneKeys.has(key)) continue;

    // No-ops (with a per-record info log) when the platform isn't
    // authoritative — never throws, so a cname-mode enable is not an error.
    const outcome = await syncRecordToProviders(db, domainId, domainName, 'create', {
      type: rec.recordType,
      name: rec.recordName,
      content: rec.recordValue,
      ttl: rec.ttl,
      priority: rec.priority,
    }, encryptionKey);
    if (outcome.status === 'failed') {
      rejected.push(`${rec.recordType} ${rec.recordName}: ${outcome.message ?? 'rejected'}`);
    }
  }

  // `*_provisioned` means "published to DNS", NOT "we know the value".
  // Setting these unconditionally claimed a cname-mode domain was fully
  // provisioned when nothing had been pushed anywhere — the operator saw four
  // green ticks and a mail domain that could never receive mail. Records are
  // recorded either way; only the flags distinguish published from pending.
  //
  // A REJECTED write counts as not-published for the same reason: until the
  // wire-format fix, PowerDNS refused the MX and every SRV, and these flags
  // still went green because only `platformOwnsZone` was consulted.
  const published = platformOwnsZone && rejected.length === 0 ? 1 : 0;
  await db
    .update(emailDomains)
    .set({
      mxProvisioned: published,
      spfProvisioned: published,
      dkimProvisioned: published,
      dmarcProvisioned: published,
    })
    .where(eq(emailDomains.domainId, domainId));

  if (platformOwnsZone && rejected.length > 0) {
    console.error(
      `[email-dns] '${domainName}': the DNS server REJECTED ${rejected.length} of `
      + `${records.length} mail record(s) — mail will not deliver until they exist. `
      + rejected.join(' | '),
    );
  }

  if (!platformOwnsZone) {
    // A warning, not an error: customer-managed DNS is a supported mode, not a
    // failure. The records are in the DB and rendered on the domain's DNS page
    // for the operator to publish by hand.
    console.warn(
      `[email-dns] '${domainName}' uses customer-managed DNS — the ${records.length} mail record(s) ` +
        `(MX/SPF/DKIM/DMARC) were saved but NOT published. Add them manually at the domain's ` +
        `DNS Records page; mail will not deliver until they exist in the authoritative zone.`,
    );
  }
}

/**
 * True when the platform can actually write this domain's zone.
 *
 * Same predicate the record push uses, hoisted so the caller can distinguish
 * "recorded" from "published" without re-deriving it per record. Any failure
 * to resolve (no servers configured at all) is treated as NOT writable — the
 * safe direction, since it only downgrades a flag and adds a warning.
 */
export async function isZoneWritable(db: Database, domainId: string): Promise<boolean> {
  try {
    const [domain] = await db
      .select({ dnsMode: domains.dnsMode })
      .from(domains)
      .where(eq(domains.id, domainId));
    if (!domain) return false;
    const servers = await getActiveServersForDomain(db, domainId);
    return canManageDnsZone({
      dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
      activeServers: servers.map((s) => ({
        id: s.id,
        providerType: s.providerType,
        enabled: s.enabled,
        role: s.role,
      })),
    });
  } catch {
    return false;
  }
}

export type MailZoneRead =
  | { readonly zone: readonly ZoneRecord[]; readonly reason: null }
  | { readonly zone: null; readonly reason: 'external_dns' | 'zone_unlisted' | 'zone_unreadable' };

/**
 * DNS server types whose record listing is the whole zone, in wire format.
 * The others cannot be checked: BIND over rndc and Route 53 list nothing,
 * Hetzner and Cloudflare stop at the first 100 records, and ClouDNS drops
 * the MX priority from the value. An incomplete listing would read as
 * missing records and hide the duplicates the check is for.
 */
const COMPLETE_LISTING = new Set(['powerdns']);

/**
 * The domain's zone as its primary server lists it — only where the platform
 * hosts it. A read that fails is `zone_unreadable`, never an empty zone: an
 * empty zone would read as "every record is missing".
 */
export async function readMailZone(db: Database, domainId: string, domainName: string): Promise<MailZoneRead> {
  if (!(await isZoneWritable(db, domainId))) return { zone: null, reason: 'external_dns' };
  try {
    const servers = await getActiveServersForDomain(db, domainId);
    const server = servers.find((s) => s.role === 'primary') ?? servers[0];
    if (!server) return { zone: null, reason: 'zone_unreadable' };
    if (!COMPLETE_LISTING.has(server.providerType)) return { zone: null, reason: 'zone_unlisted' };
    const key = process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY env var */;
    const records = await getProviderForServer(server, key).listRecords(domainName);
    return { zone: records.map((r) => ({ type: r.type, name: r.name, content: r.content })), reason: null };
  } catch (err) {
    // The cause stays in the log: the answer reaches tenants, and a provider
    // error names internal addresses.
    console.warn(`[email-dns] could not read the zone of '${domainName}': ${err instanceof Error ? err.message : String(err)}`);
    return { zone: null, reason: 'zone_unreadable' };
  }
}

// Idempotently publish the webmail.<domain> CNAME. Used by updateEmailDomain
// when webmail_enabled flips. Returns true if a DB row was inserted.
//
// Two naming conventions used to coexist here. This function wrote the record
// under its FQDN (`webmail.example.com`) while the ingress-route path writes
// the bare label (`webmail`), so neither could see the other's row and
// enabling webmail on a domain that already had a route produced a second,
// conflicting record. Both spellings are treated as the same record now.
export async function publishWebmailDnsRecord(
  db: Database,
  domainId: string,
  domainName: string,
  encryptionKey: string,
  webmailHostname: string,
): Promise<boolean> {
  const hostname = `webmail.${domainName}`;
  const value = ensureTrailingDot(webmailHostname);

  const existing = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));
  // recordName is nullable in the schema; a nameless row is not a webmail row.
  const isWebmailRow = (r: { recordName: string | null }): boolean =>
    r.recordName === hostname || r.recordName === 'webmail';

  // A/AAAA rows are the pre-CNAME shape (and, for migrated domains, a stale
  // pointer at the customer's OLD provider). Retire them, or the zone answers
  // with an address record that outranks the CNAME we are about to write.
  for (const stale of existing.filter((r) => isWebmailRow(r) && r.recordType !== 'CNAME')) {
    await db.delete(dnsRecords).where(eq(dnsRecords.id, stale.id));
    await syncRecordToProviders(
      db,
      domainId,
      domainName,
      'delete',
      { type: stale.recordType, name: stale.recordName ?? hostname, content: stale.recordValue ?? '', ttl: stale.ttl ?? 3600, priority: null },
      encryptionKey,
    );
  }

  const current = existing.find((r) => isWebmailRow(r) && r.recordType === 'CNAME');
  if (current && current.recordValue === value) return false;

  // A CNAME that exists but points somewhere else is repointed, not left
  // alone: "already has a webmail record" was the old test, and it is exactly
  // what let a wrong target survive forever.
  if (current) {
    await db.delete(dnsRecords).where(eq(dnsRecords.id, current.id));
    await syncRecordToProviders(
      db,
      domainId,
      domainName,
      'delete',
      { type: 'CNAME', name: current.recordName ?? hostname, content: current.recordValue ?? '', ttl: current.ttl ?? 3600, priority: null },
      encryptionKey,
    );
  }

  const id = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id,
    domainId,
    recordType: 'CNAME',
    recordName: hostname,
    recordValue: value,
    ttl: 3600,
    priority: null,
  });

  await syncRecordToProviders(
    db,
    domainId,
    domainName,
    'create',
    { type: 'CNAME', name: hostname, content: value, ttl: 3600, priority: null },
    encryptionKey,
  );
  return true;
}

export async function unpublishWebmailDnsRecord(
  db: Database,
  domainId: string,
  domainName: string,
  encryptionKey: string,
): Promise<boolean> {
  const hostname = `webmail.${domainName}`;
  const rows = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));
  // Match on the NAME and take whatever type is there. Filtering on `A` was
  // correct only while this module published A records; once the record became
  // a CNAME the same filter silently matched nothing, so disabling webmail
  // left the record published and the hostname still pointing at the platform.
  const matches = rows.filter(
    (r) => r.recordName === hostname || r.recordName === 'webmail',
  );
  if (matches.length === 0) return false;

  for (const m of matches) {
    await db.delete(dnsRecords).where(eq(dnsRecords.id, m.id));
    await syncRecordToProviders(
      db,
      domainId,
      domainName,
      'delete',
      {
        type: m.recordType,
        name: m.recordName ?? hostname,
        content: m.recordValue ?? '',
        ttl: m.ttl ?? 3600,
        priority: null,
        id: m.id,
      },
      encryptionKey,
    );
  }
  return true;
}

/**
 * Is this stored record one that enabling email writes (MX, SPF, DKIM, DMARC,
 * the mail-discovery SRV records, the legacy autoconfig/MTA-STS ones)? Picked
 * by (type, name pattern, value prefix), so no type allowlist is needed.
 */
export function isEmailDnsRecord(r: { recordType: string; recordName: string | null; recordValue: string | null }): boolean {
  if (r.recordType === 'MX') return true;
  if (r.recordType === 'A' && r.recordName?.startsWith('mail.')) return true;
  if (r.recordType === 'SRV') {
    // Catches every mail-discovery SRV record by name prefix
    // (_imaps._tcp / _imap._tcp / _pop3s._tcp / _submissions._tcp / _submission._tcp).
    const name = r.recordName ?? '';
    return /^_(imaps?|pop3s?|submissions?)\._tcp\./.test(name);
  }
  if (r.recordType === 'CNAME') {
    // Legacy autoconfig / autodiscover / mta-sts CNAMEs created by
    // earlier provisioning code. Cleanup
    // catches them so re-provisioning leaves no orphans in PowerDNS.
    const name = r.recordName ?? '';
    return /^(autoconfig|autodiscover|mta-sts)\./.test(name);
  }
  if (r.recordType === 'TXT') {
    const val = r.recordValue ?? '';
    return (
      val.startsWith('v=spf1') ||
      val.startsWith('v=DKIM1') ||
      val.startsWith('v=DMARC1') ||
      val.startsWith('v=STSv1')
    );
  }
  return false;
}

export async function deprovisionEmailDns(
  db: Database,
  domainId: string,
): Promise<void> {
  const allRecords = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));

  const emailRecords = allRecords.filter(isEmailDnsRecord);

  for (const record of emailRecords) {
    await db.delete(dnsRecords).where(eq(dnsRecords.id, record.id));
  }
}
