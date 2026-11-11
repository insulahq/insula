import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dnsRecords } from '../../db/schema.js';
import { buildEmailDnsRecordsForDisplay } from './dns-provisioning.js';

const MOCK_DKIM_SELECTOR = 'default';
const MOCK_DKIM_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----';
const MOCK_MAIL_HOSTNAME = 'mail.platform.test';

describe('buildEmailDnsRecordsForDisplay', () => {
  it('includes core mail records without webmail when webmailEnabled is false or absent', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
    );

    // Core records must be present
    expect(records.some((r) => r.purpose === 'mx')).toBe(true);
    expect(records.some((r) => r.purpose === 'dkim')).toBe(true);
    expect(records.some((r) => r.purpose === 'spf')).toBe(true);
    expect(records.some((r) => r.purpose === 'dmarc')).toBe(true);
    // Webmail record must be absent
    expect(records.some((r) => r.purpose === 'webmail')).toBe(false);
  });

  it('omits the DKIM record entirely when dkimSelector is empty (M13 production path)', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      '', // dkimSelector — the enable flow passes empty since M13
      '',
      MOCK_MAIL_HOSTNAME,
    );

    // No DKIM record — and specifically no junk "._domainkey.<domain>"
    // row with an empty selector (regression: was inserted on every
    // email-domain enable).
    expect(records.some((r) => r.purpose === 'dkim')).toBe(false);
    expect(records.some((r) => r.recordName?.includes('._domainkey.'))).toBe(false);
    // Core records unaffected
    expect(records.some((r) => r.purpose === 'mx')).toBe(true);
    expect(records.some((r) => r.purpose === 'spf')).toBe(true);
  });

  it('adds a webmail.<domain> CNAME at the platform webmail host', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: true, webmailHostname: 'webmail.platform.test' },
    );

    const webmail = records.filter((r) => r.purpose === 'webmail');
    expect(webmail).toHaveLength(1);
    expect(webmail[0].recordType).toBe('CNAME');
    expect(webmail[0].recordName).toBe('webmail.example.com');
    expect(webmail[0].recordValue).toBe('webmail.platform.test.');
    expect(webmail[0].ttl).toBe(3600);
  });

  it('emits NO address record for webmail — the CNAME is the whole record set', () => {
    // The previous shape was an A (+ optional AAAA) at the MAIL server's
    // address. An address record alongside a CNAME is also invalid at the
    // same owner name, so this is a correctness assertion, not a preference.
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: true, webmailHostname: 'webmail.platform.test' },
    );
    const webmail = records.filter((r) => r.recordName === 'webmail.example.com');
    expect(webmail.map((r) => r.recordType)).toEqual(['CNAME']);
  });

  it('falls back to the mail hostname when no webmail host is supplied', () => {
    // Preview callers may not have resolved the setting. Rendering a record
    // with an empty target would be worse than naming a real host.
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: true },
    );
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe(`${MOCK_MAIL_HOSTNAME}.`);
  });

  it('tags every record with a `purpose` field so the UI can group them', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: true },
    );
    for (const r of records) {
      expect(typeof r.purpose).toBe('string');
      expect(r.purpose.length).toBeGreaterThan(0);
    }
  });

  it('does NOT add the webmail record when webmailEnabled is explicitly false', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: false },
    );
    expect(records.some((r) => r.purpose === 'webmail')).toBe(false);
  });

  // TLS-bootstrap rewrite: regression guards.
  it('points the MX record at the platform mail-server hostname (not a per-tenant mail.<domain> alias)', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com', MOCK_DKIM_SELECTOR, MOCK_DKIM_PUBLIC_KEY, MOCK_MAIL_HOSTNAME,
    );
    const mx = records.find((r) => r.purpose === 'mx');
    expect(mx).toBeDefined();
    expect(mx?.recordValue).toBe(MOCK_MAIL_HOSTNAME);
    // Negative — must NOT use the old mail.<domain> form
    expect(mx?.recordValue).not.toBe('mail.example.com');
  });

  it('does NOT emit a per-tenant mail.<domain> A record (was redundant + cert-mismatch source)', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com', MOCK_DKIM_SELECTOR, MOCK_DKIM_PUBLIC_KEY, MOCK_MAIL_HOSTNAME,
    );
    const stray = records.find((r) =>
      r.recordType === 'A' && r.recordName === 'mail.example.com',
    );
    expect(stray).toBeUndefined();
  });

  it('does NOT emit autoconfig.<domain> or autodiscover.<domain> CNAMEs (cert-mismatch dead path; SRV is the right layer)', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com', MOCK_DKIM_SELECTOR, MOCK_DKIM_PUBLIC_KEY, MOCK_MAIL_HOSTNAME,
    );
    expect(records.some((r) => r.recordName === 'autoconfig.example.com')).toBe(false);
    expect(records.some((r) => r.recordName === 'autodiscover.example.com')).toBe(false);
    expect(records.some((r) => r.purpose === 'autoconfig')).toBe(false);
  });

  it('does NOT emit MTA-STS records (cert-mismatch dead path; same precondition as Outlook autodiscover)', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com', MOCK_DKIM_SELECTOR, MOCK_DKIM_PUBLIC_KEY, MOCK_MAIL_HOSTNAME,
    );
    expect(records.some((r) => r.recordName === '_mta-sts.example.com')).toBe(false);
    expect(records.some((r) => r.recordName === 'mta-sts.example.com')).toBe(false);
    expect(records.some((r) => r.purpose === 'mta_sts')).toBe(false);
  });

  it('SRV records target the platform mail-server hostname (correct cert SAN match)', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com', MOCK_DKIM_SELECTOR, MOCK_DKIM_PUBLIC_KEY, MOCK_MAIL_HOSTNAME,
    );
    const srvs = records.filter((r) => r.purpose === 'srv');
    expect(srvs.length).toBeGreaterThan(0);
    for (const srv of srvs) {
      // Format: "<priority> <weight> <port> <target>"
      const target = srv.recordValue.split(/\s+/).pop();
      expect(target).toBe(MOCK_MAIL_HOSTNAME);
    }
  });
});

// ─── provisionEmailDns: recorded vs published ────────────────────────────────
//
// Customer-managed DNS (cname/secondary) is a SUPPORTED mode, not a failure.
// The platform still has to compute and store the exact MX/SPF/DKIM/DMARC
// values so the operator can publish them by hand — but it must not claim they
// are provisioned, because nothing was pushed anywhere.

vi.mock('./dkim.js', () => ({ formatDkimDnsValue: (k: string) => `v=DKIM1; p=${k}` }));

const activeServersMock = vi.fn();
const zoneMock = vi.fn();
const createRecordMock = vi.fn();
vi.mock('../dns-servers/service.js', () => ({
  getActiveServersForDomain: (...a: unknown[]) => activeServersMock(...a),
  getProviderForServer: () => ({
    createRecord: (...a: unknown[]) => createRecordMock(...a),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
    listRecords: (...a: unknown[]) => zoneMock(...a),
  }),
}));

function dbFor(dnsMode: string, storedRows: Record<string, unknown>[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const rows = [{ dnsMode }];
  const db = {
    // dns_records answers with the domain's stored rows; every other table
    // with the domain row.
    select: () => ({ from: (table: unknown) => ({ where: () => Promise.resolve(table === dnsRecords ? storedRows : rows) }) }),
    insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return Promise.resolve(); } }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({ where: () => { updated.push(v); return Promise.resolve(); } }),
    }),
  };
  return { db, inserted, updated };
}

const PROV_ARGS = ['sel', 'PUBKEY', 'key', 'mail.platform.test'] as const;

describe('provisionEmailDns — recorded vs published', () => {
  beforeEach(() => {
    activeServersMock.mockReset();
    zoneMock.mockReset().mockResolvedValue([]);
    createRecordMock.mockReset().mockResolvedValue(undefined);
  });

  it('primary + enabled primary server → records stored AND flagged provisioned', async () => {
    activeServersMock.mockResolvedValue([
      { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
    ]);
    const { db, inserted, updated } = dbFor('primary');
    const { provisionEmailDns } = await import('./dns-provisioning.js');
    await provisionEmailDns(db as never, 'dom-1', 'example.test', PROV_ARGS[0], PROV_ARGS[1], PROV_ARGS[2], PROV_ARGS[3]);

    expect(inserted.length).toBeGreaterThan(0);
    expect(updated.at(-1)).toMatchObject({
      mxProvisioned: 1, spfProvisioned: 1, dkimProvisioned: 1, dmarcProvisioned: 1,
    });
  });

  // The regression: flags used to be set unconditionally, so a cname domain
  // showed four green ticks while nothing had been published anywhere.
  it('cname → records STILL stored, but flags stay 0 (recorded, not published)', async () => {
    activeServersMock.mockResolvedValue([
      { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
    ]);
    const { db, inserted, updated } = dbFor('cname');
    const { provisionEmailDns } = await import('./dns-provisioning.js');
    await provisionEmailDns(db as never, 'dom-2', 'example.test', PROV_ARGS[0], PROV_ARGS[1], PROV_ARGS[2], PROV_ARGS[3]);

    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.some((r) => r.recordType === 'MX')).toBe(true);
    expect(inserted.some((r) => r.recordType === 'TXT')).toBe(true);
    expect(updated.at(-1)).toMatchObject({
      mxProvisioned: 0, spfProvisioned: 0, dkimProvisioned: 0, dmarcProvisioned: 0,
    });
  });

  it('secondary → same as cname: recorded, not published', async () => {
    activeServersMock.mockResolvedValue([
      { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
    ]);
    const { db, inserted, updated } = dbFor('secondary');
    const { provisionEmailDns } = await import('./dns-provisioning.js');
    await provisionEmailDns(db as never, 'dom-3', 'example.test', PROV_ARGS[0], PROV_ARGS[1], PROV_ARGS[2], PROV_ARGS[3]);
    expect(inserted.length).toBeGreaterThan(0);
    expect(updated.at(-1)).toMatchObject({ mxProvisioned: 0 });
  });

  it('cname enable does NOT throw — customer-managed DNS is supported, not an error', async () => {
    activeServersMock.mockResolvedValue([]);
    const { db } = dbFor('cname');
    const { provisionEmailDns } = await import('./dns-provisioning.js');
    await expect(
      provisionEmailDns(db as never, 'dom-4', 'example.test', PROV_ARGS[0], PROV_ARGS[1], PROV_ARGS[2], PROV_ARGS[3]),
    ).resolves.toBeUndefined();
  });

  it('warns the operator that the records need publishing by hand', async () => {
    activeServersMock.mockResolvedValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = dbFor('cname');
    const { provisionEmailDns } = await import('./dns-provisioning.js');
    await provisionEmailDns(db as never, 'dom-5', 'example.test', PROV_ARGS[0], PROV_ARGS[1], PROV_ARGS[2], PROV_ARGS[3]);
    const msg = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(msg).toMatch(/customer-managed DNS/i);
    expect(msg).toMatch(/NOT published/i);
    expect(msg).toMatch(/DNS Records page/i);
    warn.mockRestore();
  });
});

// Enabling email on a domain moved in from another provider used to add every
// record next to what the zone held: a second SPF record (a permanent error,
// SPF fails for all mail) and a second DMARC record (receivers ignore both).
describe('provisionEmailDns — what the domain already has', () => {
  const PRIMARY = [{ id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' }];
  const published = () => createRecordMock.mock.calls.map((c) => (c[1] as { type: string; name: string; content: string }));
  const run = async (db: unknown) => {
    const { provisionEmailDns } = await import('./dns-provisioning.js');
    await provisionEmailDns(db as never, 'dom-9', 'example.test', '', '', 'key', 'mail.platform.test');
  };

  beforeEach(() => {
    activeServersMock.mockReset().mockResolvedValue(PRIMARY);
    zoneMock.mockReset().mockResolvedValue([]);
    createRecordMock.mockReset().mockResolvedValue(undefined);
  });

  it("keeps the zone's own SPF and DMARC records instead of adding a second one", async () => {
    zoneMock.mockResolvedValue([
      { type: 'TXT', name: 'example.test.', content: '"v=spf1 include:_spf.old-provider.test ~all"' },
      { type: 'TXT', name: '_dmarc.example.test.', content: '"v=DMARC1; p=reject; rua=mailto:r@old-provider.test"' },
    ]);
    const { db, inserted } = dbFor('primary');
    await run(db);

    expect(published().some((r) => r.type === 'TXT')).toBe(false);
    expect(published().some((r) => r.type === 'MX')).toBe(true);
    // The tenant's DMARC record gets a row (the policy buttons act on it); no SPF row is added.
    const txtRows = inserted.filter((r) => r.recordType === 'TXT');
    expect(txtRows).toEqual([expect.objectContaining({
      recordName: '_dmarc.example.test', recordValue: 'v=DMARC1; p=reject; rua=mailto:r@old-provider.test',
    })]);
  });

  it('does not publish what the zone already holds, nor store a row twice', async () => {
    zoneMock.mockResolvedValue([{ type: 'MX', name: 'example.test.', content: '10 mail.platform.test.' }]);
    const { db, inserted } = dbFor('primary', [
      { id: 'r1', recordType: 'MX', recordName: 'example.test', recordValue: 'mail.platform.test', priority: 10 },
    ]);
    await run(db);
    expect(published().some((r) => r.type === 'MX')).toBe(false);
    expect(inserted.some((r) => r.recordType === 'MX')).toBe(false);
    // Everything else is still written.
    expect(published().some((r) => r.type === 'TXT' && r.name === 'example.test')).toBe(true);
  });

  it('a zone it cannot read is not taken for an empty one: every record is still published', async () => {
    zoneMock.mockRejectedValue(new Error('PowerDNS API error: 503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = dbFor('primary');
    await run(db);
    expect(published().map((r) => r.type).sort()).toEqual(['MX', 'SRV', 'SRV', 'SRV', 'SRV', 'SRV', 'TXT', 'TXT']);
    warn.mockRestore();
  });
});

describe('the published DMARC policy for a NEW domain', () => {
  const dmarcOf = (domain = 'example.com') =>
    buildEmailDnsRecordsForDisplay(domain, MOCK_DKIM_SELECTOR, MOCK_DKIM_PUBLIC_KEY, MOCK_MAIL_HOSTNAME)
      .find((r) => r.purpose === 'dmarc');

  it('starts at p=quarantine — enforcing, but not yet rejecting', () => {
    // An operator decision: p=none protects nothing. p=reject stays a step
    // the reports must earn (mail-events/dmarc-policy.ts), because on a new
    // domain an unaligned legitimate sender would stop being delivered at all.
    // Pinned so the default cannot change without a deliberate decision.
    expect(dmarcOf()?.recordValue).toMatch(/^v=DMARC1; p=quarantine;/);
    expect(dmarcOf()?.recordValue).not.toContain('p=none');
    expect(dmarcOf()?.recordValue).not.toContain('p=reject');
  });

  it('leaves alignment relaxed (no adkim=/aspf=): a subdomain sender of the tenant still aligns', () => {
    // Strict alignment would fail mail From a subdomain signed by the parent,
    // and senders that align only through a bounce subdomain. The threat
    // strict guards against, someone else controlling a subdomain, is closed
    // where the domain is added (domains/overlap.ts).
    expect(dmarcOf()?.recordValue).not.toMatch(/adkim=|aspf=/);
  });

  it('points rua= at a same-domain address the platform actually creates', () => {
    // `dmarc@<domain>` has a real mailbox (report-intake-reconciler). It used
    // to be `dmarc-reports@`, which nothing ever created, so Stalwart refused
    // every report at RCPT with 550 and they were discarded.
    expect(dmarcOf()?.recordValue).toContain('rua=mailto:dmarc@example.com');
    expect(dmarcOf()?.recordValue).not.toContain('dmarc-reports@');
    expect(dmarcOf()?.recordValue).not.toContain('postmaster@');
  });

  it('keeps rua= inside the policy domain, so no RFC 7489 §7.1 authorisation is needed', () => {
    const v = dmarcOf('tenant.example.net')?.recordValue ?? '';
    expect(v).toContain('rua=mailto:dmarc@tenant.example.net');
  });

  it('publishes _dmarc at the conventional name', () => {
    expect(dmarcOf()?.recordName).toBe('_dmarc.example.com');
  });
});
