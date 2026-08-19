/**
 * LIVE PowerDNS integration test.
 *
 * Skipped unless `PDNS_API_URL` is set — `scripts/integration-dns-powerdns.sh`
 * starts a real PowerDNS and sets it.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * The mocked provider tests asserted the request body the adapter *sent*.
 * They could never catch the actual defect: PowerDNS REJECTED that body.
 * MX, SRV and CAA had never once been written successfully, and every
 * mail record was published to `<apex>.<apex>.`, because the sync layer
 * swallowed the 422 and the API still answered 201 Created.
 *
 * ── The rule this test enforces ───────────────────────────────────────
 * Every record type offered in the tenant UI must be creatable using ONLY
 * the inputs that UI can produce. Request bodies are built the way the
 * panel builds them — type / name / value / ttl, plus priority, weight and
 * port exactly where `dnsRecordFieldsFor` says the form renders them — and
 * are validated through the real `createDnsRecordSchema` before being
 * handed to the provider. A type that needs a field the form does not
 * collect is a bug in the form, and fails here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDnsRecordSchema, dnsRecordFieldsFor } from '@insula/api-contracts';
import { PowerDnsProvider } from './powerdns.js';

const API_URL = process.env.PDNS_API_URL;
const API_KEY = process.env.PDNS_API_KEY ?? 'probekey';
const ZONE = 'example.test';
const NS = ['ns1.platform.test', 'ns2.platform.test'];

/** Exactly the tenant panel's Type dropdown. Keep in lockstep. */
const UI_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR', 'ALIAS', 'DNAME'] as const;

/**
 * What a tenant types into Name and Value, plus the numeric fields the
 * form shows for that type. Nothing here is pre-formatted: values are
 * written the way a human writes them (no trailing dots, no packed
 * `10 host` content) — which is precisely what used to be rejected.
 */
const UI_INPUT: Record<(typeof UI_TYPES)[number], {
  name: string;
  value: string;
  priority?: number;
  weight?: number;
  port?: number;
  /** What the record must look like once PowerDNS has stored it. */
  expected: string;
}> = {
  A:     { name: 'www',       value: '203.0.113.10',               expected: '203.0.113.10' },
  AAAA:  { name: 'www6',      value: '2001:db8::1',                expected: '2001:db8::1' },
  CNAME: { name: 'blog',      value: 'slug.ingress.platform.test', expected: 'slug.ingress.platform.test.' },
  MX:    { name: '',          value: 'mail.platform.test',         priority: 10, expected: '10 mail.platform.test.' },
  TXT:   { name: '',          value: 'v=spf1 mx ~all',             expected: '"v=spf1 mx ~all"' },
  SRV:   { name: '_sip._tcp', value: 'sip.platform.test',          priority: 10, weight: 5, port: 5060, expected: '10 5 5060 sip.platform.test.' },
  NS:    { name: 'sub',       value: 'ns1.other.test',             expected: 'ns1.other.test.' },
  CAA:   { name: '',          value: '0 issue "letsencrypt.org"',  expected: '0 issue "letsencrypt.org"' },
  PTR:   { name: '10',        value: 'host.platform.test',         expected: 'host.platform.test.' },
  ALIAS: { name: 'alias',     value: 'target.platform.test',       expected: 'target.platform.test.' },
  DNAME: { name: 'old',       value: 'new.platform.test',          expected: 'new.platform.test.' },
};

/** Build the POST body the panel would send — and nothing more. */
function panelBody(type: string) {
  const ui = UI_INPUT[type as (typeof UI_TYPES)[number]];
  const fields = dnsRecordFieldsFor(type);
  const body: Record<string, unknown> = {
    record_type: type,
    record_name: ui.name || undefined,
    record_value: ui.value,
    ttl: 3600, // the form's default
  };
  if (fields.priority) body.priority = ui.priority;
  if (fields.srvFields) { body.weight = ui.weight; body.port = ui.port; }
  return body;
}

describe.skipIf(!API_URL)('PowerDnsProvider against a live PowerDNS', () => {
  // Built in beforeAll, not here: `describe.skipIf` still EVALUATES the
  // describe body, so constructing the provider at collection time crashed
  // the whole file when PDNS_API_URL was unset (i.e. every normal test run).
  let provider!: PowerDnsProvider;

  beforeAll(async () => {
    provider = new PowerDnsProvider({
      api_url: API_URL!, api_key: API_KEY, server_id: 'localhost', api_version: 'v4',
    });
    const conn = await provider.testConnection();
    expect(conn.status, `cannot reach PowerDNS at ${API_URL}: ${conn.message}`).toBe('ok');
    try { await provider.deleteZone(ZONE); } catch { /* first run */ }
    await provider.createZone(ZONE, 'Native', NS);
  });

  afterAll(async () => {
    try { await provider.deleteZone(ZONE); } catch { /* already gone */ }
  });

  it.each(UI_TYPES)('creates a %s record from tenant-UI inputs alone', async (type) => {
    const parsed = createDnsRecordSchema.safeParse(panelBody(type));
    expect(
      parsed.success,
      `the tenant form cannot produce a valid ${type}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
    ).toBe(true);
    if (!parsed.success) return;

    await provider.createRecord(ZONE, {
      type: parsed.data.record_type,
      name: parsed.data.record_name ?? '@',
      content: parsed.data.record_value,
      ttl: parsed.data.ttl,
      priority: parsed.data.priority,
      weight: parsed.data.weight,
      port: parsed.data.port,
    });

    // Read it back from the server — the only proof that matters.
    const ui = UI_INPUT[type];
    const expectedName = ui.name ? `${ui.name}.${ZONE}.` : `${ZONE}.`;
    const stored = (await provider.listRecords(ZONE))
      .filter((r) => r.type === type && r.name === expectedName);

    expect(stored.map((r) => r.content)).toContain(ui.expected);
  });

  it('refuses SOA at the contract, because the server owns the zone SOA', () => {
    const parsed = createDnsRecordSchema.safeParse({
      record_type: 'SOA',
      record_value: 'ns1.platform.test. hostmaster.example.test. 1 10800 3600 604800 3600',
      ttl: 3600,
    });
    expect(parsed.success).toBe(false);
  });

  it('adds a second MX value without dropping the first', async () => {
    await provider.createRecord(ZONE, { type: 'MX', name: '@', content: 'mail2.platform.test', ttl: 3600, priority: 20 });
    const mx = (await provider.listRecords(ZONE)).filter((r) => r.type === 'MX' && r.name === `${ZONE}.`);
    expect(mx.map((r) => r.content).sort()).toEqual(['10 mail.platform.test.', '20 mail2.platform.test.']);
  });

  // The bug that sent every SPF/DKIM/DMARC record to `<apex>.<apex>.`:
  // email-domains/dns-provisioning.ts passes the FULL record name.
  it('writes a record whose name is already fully qualified to the right place', async () => {
    await provider.createRecord(ZONE, { type: 'TXT', name: `_dmarc.${ZONE}`, content: 'v=DMARC1; p=none', ttl: 3600 });
    const names = (await provider.listRecords(ZONE)).map((r) => r.name);
    expect(names).toContain(`_dmarc.${ZONE}.`);
    expect(names.filter((n) => n.includes(`${ZONE}.${ZONE}`))).toEqual([]);
  });

  it('removes one value from a multi-value set and leaves the rest', async () => {
    await provider.deleteRecordValue(ZONE, { type: 'MX', name: '@', content: 'mail2.platform.test', priority: 20 });
    const mx = (await provider.listRecords(ZONE)).filter((r) => r.type === 'MX' && r.name === `${ZONE}.`);
    expect(mx.map((r) => r.content)).toEqual(['10 mail.platform.test.']);
  });
});
