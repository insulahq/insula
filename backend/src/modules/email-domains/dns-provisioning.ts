import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { dnsRecords, emailDomains, domains } from '../../db/schema.js';
import { getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { formatDkimDnsValue } from './dkim.js';
import type { Database } from '../../db/index.js';

// Round-4 Phase 1: multi-step fallback so deployments only need to
// set the one env var they already have. INGRESS_DEFAULT_IPV4 is
// already wired into docker-compose.local.yml for the local stack
// and should be the canonical platform ingress IP in production.
// 127.0.0.1 is a last-resort dev fallback — a WARN fires the first
// time a record is built so operators see it in logs.
//
// Review HIGH-1 fix: an empty string in a Docker Compose / systemd
// env file (e.g. `MAIL_SERVER_IP=`) is functionally undefined, NOT
// a valid override. Normalize blank values to undefined before the
// truthiness gate so the fallback chain progresses correctly.
let mailServerIpWarned = false;
const normalizeEnv = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};
const MAIL_SERVER_IP = (): string => {
  const explicit = normalizeEnv(process.env.MAIL_SERVER_IP);
  if (explicit) return explicit;
  const ingressIp = normalizeEnv(process.env.INGRESS_DEFAULT_IPV4);
  if (ingressIp) return ingressIp;
  if (!mailServerIpWarned) {
    console.warn(
      '[email-dns] Neither MAIL_SERVER_IP nor INGRESS_DEFAULT_IPV4 is set — '
      + 'falling back to 127.0.0.1 for mail.<domain> and webmail.<domain> A records. '
      + 'This is almost certainly wrong in production.',
    );
    mailServerIpWarned = true;
  }
  return '127.0.0.1';
};

// IPv6 sibling of MAIL_SERVER_IP. Deliberately returns undefined rather than a
// fallback: a wrong AAAA is worse than no AAAA. A published AAAA that nothing
// answers on makes a v6-only client fail outright and costs every dual-stack
// client a connection timeout first, so the record is emitted ONLY when the
// operator has actually configured an address.
const MAIL_SERVER_IPV6 = (): string | undefined =>
  normalizeEnv(process.env.MAIL_SERVER_IPV6)
  ?? normalizeEnv(process.env.INGRESS_DEFAULT_IPV6);

// mtaStsPolicyId() helper removed 2026-05-06 along with the MTA-STS
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
  options: { readonly webmailEnabled?: boolean } = {},
): readonly DnsRecordSpec[] {
  return buildEmailDnsRecords(
    domainName,
    dkimSelector,
    dkimPublicKey,
    mailServerHostname,
    options,
  );
}

function buildEmailDnsRecords(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  mailServerHostname: string,
  options: { readonly webmailEnabled?: boolean } = {},
): readonly DnsRecordSpec[] {
  const webmailRecords: readonly DnsRecordSpec[] = options.webmailEnabled
    ? buildWebmailRecords(domainName)
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
 * `webmail.<domain>` — A always, AAAA only when an IPv6 is configured.
 *
 * The MX target is the platform hostname (see buildBaseRecords), so this is the
 * only per-tenant record that points at the platform's own address and the only
 * one that needs a v6 sibling here.
 */
function buildWebmailRecords(domainName: string): readonly DnsRecordSpec[] {
  const records: DnsRecordSpec[] = [
    {
      recordType: 'A',
      recordName: `webmail.${domainName}`,
      recordValue: MAIL_SERVER_IP(),
      ttl: 3600,
      priority: null,
      purpose: 'webmail',
    },
  ];

  const ipv6 = MAIL_SERVER_IPV6();
  if (ipv6) {
    records.push({
      recordType: 'AAAA',
      recordName: `webmail.${domainName}`,
      recordValue: ipv6,
      ttl: 3600,
      priority: null,
      purpose: 'webmail',
    });
  }

  return records;
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
    // generation; dns-sync publishes the real selector records from
    // Stalwart's zone expectation), which used to produce a junk
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
    {
      recordType: 'TXT',
      recordName: `_dmarc.${domainName}`,
      recordValue: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domainName}`,
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
    // ─── autoconfig / autodiscover CNAMEs (REMOVED 2026-05-06) ──────
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
    // ─── MTA-STS records (REMOVED 2026-05-06) ───────────────────────
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
  options: { readonly webmailEnabled?: boolean } = {},
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

  for (const rec of records) {
    // The row is written in EVERY dnsMode, deliberately. In cname/secondary
    // mode the customer runs their own DNS, so the platform cannot publish
    // these — but the operator still needs to SEE the exact MX/SPF/DKIM/DMARC
    // values to paste into their provider. Withholding the rows would leave
    // the DNS page empty and the mail domain quietly unusable with nothing on
    // screen explaining why.
    const id = crypto.randomUUID();
    await db.insert(dnsRecords).values({
      id,
      domainId,
      recordType: rec.recordType as 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS',
      recordName: rec.recordName,
      recordValue: rec.recordValue,
      ttl: rec.ttl,
      priority: rec.priority,
    });

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
async function isZoneWritable(db: Database, domainId: string): Promise<boolean> {
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

// Round-3: idempotently publish / unpublish the webmail.<domain> A
// record. Used by updateEmailDomain when webmail_enabled flips.
// Returns true if a DB row was inserted/deleted.
export async function publishWebmailDnsRecord(
  db: Database,
  domainId: string,
  domainName: string,
  encryptionKey: string,
): Promise<boolean> {
  const hostname = `webmail.${domainName}`;
  const value = MAIL_SERVER_IP();

  // Idempotent insert — if the record already exists, leave it.
  const existing = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));
  const alreadyHasWebmail = existing.some(
    (r) => r.recordType === 'A' && r.recordName === hostname,
  );
  if (alreadyHasWebmail) return false;

  const id = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id,
    domainId,
    recordType: 'A',
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
    { type: 'A', name: hostname, content: value, ttl: 3600, priority: null },
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
  const matches = rows.filter(
    (r) => r.recordType === 'A' && r.recordName === hostname,
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
        type: 'A',
        name: hostname,
        content: m.recordValue ?? '',
        ttl: 3600,
        priority: null,
        id: m.id,
      },
      encryptionKey,
    );
  }
  return true;
}

export async function deprovisionEmailDns(
  db: Database,
  domainId: string,
): Promise<void> {
  // Find all email-related DNS records for this domain. The filter
  // below picks them by (type, name-pattern, value-prefix) — so a
  // generic recordType allowlist is unnecessary.
  const allRecords = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));

  const emailRecords = allRecords.filter((r) => {
    if (r.recordType === 'MX') return true;
    if (r.recordType === 'A' && r.recordName?.startsWith('mail.')) return true;
    if (r.recordType === 'SRV') {
      // Catches all four mail-discovery SRV records by name prefix
      // (_imaps._tcp / _imap._tcp / _submissions._tcp / _submission._tcp).
      const name = r.recordName ?? '';
      return /^_(imaps?|submissions?)\._tcp\./.test(name);
    }
    if (r.recordType === 'CNAME') {
      // Legacy autoconfig / autodiscover / mta-sts CNAMEs created by
      // earlier provisioning code (removed 2026-05-06). Cleanup
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
  });

  for (const record of emailRecords) {
    await db.delete(dnsRecords).where(eq(dnsRecords.id, record.id));
  }
}
