import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    // email-domain enable until 2026-06-07).
    expect(records.some((r) => r.purpose === 'dkim')).toBe(false);
    expect(records.some((r) => r.recordName?.includes('._domainkey.'))).toBe(false);
    // Core records unaffected
    expect(records.some((r) => r.purpose === 'mx')).toBe(true);
    expect(records.some((r) => r.purpose === 'spf')).toBe(true);
  });

  it('adds a webmail.<domain> A record when webmailEnabled is true', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: true },
    );

    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail).toBeDefined();
    expect(webmail?.recordType).toBe('A');
    expect(webmail?.recordName).toBe('webmail.example.com');
    expect(webmail?.ttl).toBe(3600);
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

  // 2026-05-06 TLS-bootstrap rewrite: regression guards.
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

// Round-4 Phase 1: MAIL_SERVER_IP fallback chain
describe('MAIL_SERVER_IP fallback chain', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  beforeEach(() => {
    delete process.env.MAIL_SERVER_IP;
    delete process.env.INGRESS_DEFAULT_IPV4;
  });

  it('uses MAIL_SERVER_IP when set', () => {
    process.env.MAIL_SERVER_IP = '203.0.113.42';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('203.0.113.42');
  });

  it('falls back to INGRESS_DEFAULT_IPV4 when MAIL_SERVER_IP is unset', () => {
    process.env.INGRESS_DEFAULT_IPV4 = '198.51.100.7';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('198.51.100.7');
  });

  it('prefers MAIL_SERVER_IP over INGRESS_DEFAULT_IPV4', () => {
    process.env.MAIL_SERVER_IP = '203.0.113.42';
    process.env.INGRESS_DEFAULT_IPV4 = '198.51.100.7';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('203.0.113.42');
  });

  it('falls back to 127.0.0.1 when neither env var is set', () => {
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('127.0.0.1');
  });

  // Review round-4 HIGH-1: empty-string env var must be treated as
  // unset, not as a valid override. Otherwise `MAIL_SERVER_IP=` in a
  // Compose file silently dropped to 127.0.0.1.
  it('treats an empty MAIL_SERVER_IP as unset and falls through to INGRESS_DEFAULT_IPV4', () => {
    process.env.MAIL_SERVER_IP = '';
    process.env.INGRESS_DEFAULT_IPV4 = '198.51.100.7';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('198.51.100.7');
  });

  it('treats whitespace-only env var as unset', () => {
    process.env.MAIL_SERVER_IP = '   ';
    process.env.INGRESS_DEFAULT_IPV4 = '198.51.100.7';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('198.51.100.7');
  });
});

// R13 dual-stack: webmail.<domain> gains an AAAA sibling, but ONLY when an
// IPv6 is actually configured. Publishing an AAAA that nothing answers on is
// worse than publishing none — a v6-only client fails outright, and every
// dual-stack client pays a failed connection first.
describe('webmail AAAA (dual-stack)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  beforeEach(() => {
    delete process.env.MAIL_SERVER_IP;
    delete process.env.INGRESS_DEFAULT_IPV4;
    delete process.env.MAIL_SERVER_IPV6;
    delete process.env.INGRESS_DEFAULT_IPV6;
    process.env.MAIL_SERVER_IP = '203.0.113.42';
  });

  const webmailRecords = () =>
    buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    }).filter((r) => r.purpose === 'webmail');

  it('emits NO AAAA when neither IPv6 env var is set', () => {
    const records = webmailRecords();
    expect(records).toHaveLength(1);
    expect(records[0].recordType).toBe('A');
  });

  it('emits an AAAA alongside the A when MAIL_SERVER_IPV6 is set', () => {
    process.env.MAIL_SERVER_IPV6 = '2001:db8::25';
    const records = webmailRecords();
    expect(records).toHaveLength(2);

    const a = records.find((r) => r.recordType === 'A');
    const aaaa = records.find((r) => r.recordType === 'AAAA');
    expect(a?.recordValue).toBe('203.0.113.42');
    expect(aaaa?.recordValue).toBe('2001:db8::25');
    expect(aaaa?.recordName).toBe('webmail.example.com');
    expect(aaaa?.ttl).toBe(3600);
  });

  it('falls back to INGRESS_DEFAULT_IPV6', () => {
    process.env.INGRESS_DEFAULT_IPV6 = '2001:db8::99';
    const records = webmailRecords();
    expect(records.find((r) => r.recordType === 'AAAA')?.recordValue).toBe('2001:db8::99');
  });

  it('prefers MAIL_SERVER_IPV6 over INGRESS_DEFAULT_IPV6', () => {
    process.env.MAIL_SERVER_IPV6 = '2001:db8::25';
    process.env.INGRESS_DEFAULT_IPV6 = '2001:db8::99';
    expect(webmailRecords().find((r) => r.recordType === 'AAAA')?.recordValue).toBe('2001:db8::25');
  });

  it('treats a whitespace-only IPv6 env var as unset (no AAAA, not a blank record)', () => {
    process.env.MAIL_SERVER_IPV6 = '   ';
    const records = webmailRecords();
    expect(records).toHaveLength(1);
    expect(records[0].recordType).toBe('A');
  });

  it('emits no webmail record at all — A or AAAA — when webmail is disabled', () => {
    process.env.MAIL_SERVER_IPV6 = '2001:db8::25';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: false,
    });
    expect(records.some((r) => r.purpose === 'webmail')).toBe(false);
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
vi.mock('../dns-servers/service.js', () => ({
  getActiveServersForDomain: (...a: unknown[]) => activeServersMock(...a),
  getProviderForServer: () => ({
    createRecord: vi.fn().mockResolvedValue(undefined),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
  }),
}));

function dbFor(dnsMode: string) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const rows = [{ dnsMode }];
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return Promise.resolve(); } }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({ where: () => { updated.push(v); return Promise.resolve(); } }),
    }),
  };
  return { db, inserted, updated };
}

const PROV_ARGS = ['sel', 'PUBKEY', 'key', 'mail.platform.test'] as const;

describe('provisionEmailDns — recorded vs published', () => {
  beforeEach(() => { activeServersMock.mockReset(); });

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
