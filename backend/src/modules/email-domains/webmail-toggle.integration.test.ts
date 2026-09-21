import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  isDbAvailable,
  runMigrations,
  cleanTables,
  closeTestDb,
  getTestDb,
} from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { emailDomains, dnsRecords } from '../../db/schema.js';
import { enableEmailForDomain, updateEmailDomain, ensureWebmailIngress } from './service.js';
import { getDefaultWebmailUrl } from '../webmail-settings/service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Email domain webmail DNS toggle (integration)', () => {
  let tenantId: string;

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await cleanTables();
    const db = getTestDb();
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    const tenant = await seedTenant(db, region.id, plan.id);
    tenantId = tenant.id;
  });

  // per-tenant webmail defaults OFF. The test was inverted
  // from "publishes by default" to "no record published by default,
  // opt-in publishes it" to match the new contract.
  it('enableEmailForDomain does NOT publish webmail.<domain> A record by default', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, tenantId, { domainName: 'webmail-test.example.com' });
    await enableEmailForDomain(
      db as never,
      tenantId,
      domain.id,
      {},
      '0'.repeat(64),
    );

    const records = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));

    const webmailRecord = records.find(
      (r) => r.recordType === 'CNAME' && r.recordName === 'webmail.webmail-test.example.com',
    );
    expect(webmailRecord).toBeUndefined();
  });

  it('enableEmailForDomain with webmail_enabled=true publishes the webmail A record (opt-in)', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, tenantId, { domainName: 'webmail-optin.example.com' });
    await enableEmailForDomain(
      db as never,
      tenantId,
      domain.id,
      { webmail_enabled: true } as never,
      '0'.repeat(64),
    );

    const records = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));

    const webmailRecord = records.find(
      (r) => r.recordType === 'CNAME' && r.recordName === 'webmail.webmail-optin.example.com',
    );
    expect(webmailRecord).toBeDefined();
    expect(webmailRecord?.recordValue).toBeTruthy();
  });

  it('updateEmailDomain with webmail_enabled=false removes the webmail DNS record', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, tenantId, { domainName: 'toggle-test.example.com' });
    await enableEmailForDomain(
      db as never,
      tenantId,
      domain.id,
      { webmail_enabled: true } as never,
      '0'.repeat(64),
    );

    // Pre-condition: webmail record exists
    const before = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));
    expect(
      before.some((r) => r.recordType === 'CNAME' && r.recordName === 'webmail.toggle-test.example.com'),
    ).toBe(true);

    // Toggle webmail off
    await updateEmailDomain(db as never, tenantId, domain.id, { webmail_enabled: false });

    const after = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));
    expect(
      after.some((r) => r.recordType === 'CNAME' && r.recordName === 'webmail.toggle-test.example.com'),
    ).toBe(false);

    // Verify the email_domains row also reflects the change
    const [updatedEd] = await db
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.domainId, domain.id));
    expect(updatedEd.webmailEnabled).toBe(0);
  });

  it('updateEmailDomain with webmail_enabled=true re-publishes the webmail DNS record', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, tenantId, { domainName: 'republish-test.example.com' });
    await enableEmailForDomain(
      db as never,
      tenantId,
      domain.id,
      { webmail_enabled: true } as never,
      '0'.repeat(64),
    );

    // Toggle off and then back on
    await updateEmailDomain(db as never, tenantId, domain.id, { webmail_enabled: false });
    await updateEmailDomain(db as never, tenantId, domain.id, { webmail_enabled: true });

    const records = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));

    const webmailRecord = records.find(
      (r) => r.recordType === 'CNAME' && r.recordName === 'webmail.republish-test.example.com',
    );
    expect(webmailRecord).toBeDefined();

    const [ed] = await db
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.domainId, domain.id));
    expect(ed.webmailEnabled).toBe(1);
  });

  // ─── Round-4 Phase 2: webmail_status lifecycle ────────────────

  // Build a fake K8sClients that fakes Service / Ingress / Cert
  // creation. The test asserts the `webmail_status` column transitions
  // through the expected lifecycle.
  /**
   * Fake K8sClients for the Traefik CRD path.
   *
   * The webmail hostname is published as an IngressRoute + redirect
   * Middleware (custom objects), not as a networking.k8s.io Ingress. The
   * previous fake only stubbed `createNamespacedIngress`, which is exactly
   * the object the cluster ignored — a fake that still accepted it would keep
   * this test green against code that serves nothing.
   */
  function makeFakeK8s(opts: {
    certShouldFail?: boolean;
    ingressShouldFail?: boolean;
  } = {}): { k8s: K8sClients; applied: Array<Record<string, unknown>> } {
    const applied: Array<Record<string, unknown>> = [];
    const createCustom = (args: Record<string, unknown>) => {
      const plural = args.plural as string;
      if (opts.ingressShouldFail && plural === 'ingressroutes') {
        return Promise.reject(new Error('forced ingress failure'));
      }
      applied.push(args);
      return Promise.resolve({});
    };
    const k8s = {
      core: {
        createNamespacedService: () => Promise.resolve({}),
        replaceNamespacedService: () => Promise.resolve({}),
      },
      networking: {
        createNamespacedIngress: () => Promise.resolve({}),
        replaceNamespacedIngress: () => Promise.resolve({}),
      },
      apps: {} as never,
      batch: {} as never,
      custom: {
        getNamespacedCustomObject: opts.certShouldFail
          ? () => Promise.reject(new Error('cert not ready'))
          : () => Promise.resolve({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
        createNamespacedCustomObject: createCustom,
        replaceNamespacedCustomObject: createCustom,
        deleteNamespacedCustomObject: () => Promise.resolve({}),
      },
    } as unknown as K8sClients;
    return { k8s, applied };
  }

  it('ensureWebmailIngress writes status=ready when cert + ingress succeed', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, tenantId, {
      domainName: 'status-ok.example.com',
      dnsMode: 'primary',
    });
    const enabled = await enableEmailForDomain(
      db as never,
      tenantId,
      domain.id,
      { webmail_enabled: true } as never,
      '0'.repeat(64),
    );

    // Mock cert manager to succeed.
    const { k8s, applied } = makeFakeK8s({});
    // ensureRouteCertificate is invoked dynamically inside
    // ensureWebmailIngress — to keep this test focused on the status
    // write paths, we skip cert provisioning by passing a fake k8s
    // tenant whose namespacedCustomObject succeeds. The actual cert
    // logic is tested separately in webmail-reconciler.test.ts.
    const result = await ensureWebmailIngress(
      db as never,
      k8s,
      enabled.id,
    );
    expect(result.ingressCreated).toBe(true);
    // Status is `ready` when TLS was attached, otherwise `ready_no_tls`.
    expect(['ready', 'ready_no_tls']).toContain(result.status);

    const [ed] = await db
      .select({ status: emailDomains.webmailStatus })
      .from(emailDomains)
      .where(eq(emailDomains.id, enabled.id));
    expect(['ready', 'ready_no_tls']).toContain(ed.status);

    // What actually reached the cluster: a Traefik IngressRoute matching the
    // tenant hostname, and a redirect Middleware sending 302 to the platform
    // webmail. Asserting the status column alone was what allowed a route
    // nothing could serve to read as 'ready'.
    const plurals = applied.map((a) => a.plural);
    expect(plurals).toContain('ingressroutes');
    expect(plurals).toContain('middlewares');

    const route = applied.find((a) => a.plural === 'ingressroutes')!
      .body as { spec: { routes: Array<{ match: string; services: Array<{ name: string }> }> } };
    expect(route.spec.routes[0].match).toBe('Host(`webmail.status-ok.example.com`)');

    const mw = applied.find((a) => a.plural === 'middlewares')!
      .body as { spec: { redirectRegex: { replacement: string; permanent: boolean } } };
    expect(mw.spec.redirectRegex.permanent).toBe(false); // 302, not 301
    expect(mw.spec.redirectRegex.replacement).toMatch(/^https?:\/\//);

    // No nginx Ingress, and no per-engine ExternalName upstream: the redirect
    // is engine-agnostic, so neither object has a reason to exist.
    expect(plurals).not.toContain('ingresses');
  });

  it('does NOT publish a route when the hostname IS the platform webmail host', async () => {
    // The SYSTEM tenant owns the apex domain (ADR-040), so enabling webmail on
    // the apex email domain arrives here with hostname === the redirect
    // target. Publishing would mint a CNAME to itself, a router that redirects
    // the host to itself, and a second IngressRoute competing with the
    // platform's own for that hostname.
    const db = getTestDb();
    const url = new URL(await getDefaultWebmailUrl(db as never));
    // webmail.<apex> is the platform webmail host; derive the apex from it.
    const apex = url.hostname.replace(/^webmail\./, '');
    const domain = await seedDomain(db, tenantId, {
      domainName: apex,
      dnsMode: 'primary',
    });
    const enabled = await enableEmailForDomain(
      db as never,
      tenantId,
      domain.id,
      { webmail_enabled: true } as never,
      '0'.repeat(64),
    );

    const { k8s, applied } = makeFakeK8s({});
    const result = await ensureWebmailIngress(db as never, k8s, enabled.id);

    expect(result.ingressCreated).toBe(false);
    expect(result.status).toBe('ready');
    expect(applied).toEqual([]);

    // And no self-referential CNAME.
    const records = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));
    const selfCname = records.find(
      (r) => r.recordName === `webmail.${apex}` && (r.recordValue ?? '').startsWith(`webmail.${apex}`),
    );
    expect(selfCname).toBeUndefined();
  });

  it('ensureWebmailIngress writes status=failed when ingress create throws', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, tenantId, {
      domainName: 'status-fail.example.com',
      dnsMode: 'primary',
    });
    const enabled = await enableEmailForDomain(
      db as never,
      tenantId,
      domain.id,
      { webmail_enabled: true } as never,
      '0'.repeat(64),
    );

    const { k8s } = makeFakeK8s({ ingressShouldFail: true });

    await expect(
      ensureWebmailIngress(db as never, k8s, enabled.id),
    ).rejects.toThrow(/forced ingress failure/);

    const [ed] = await db
      .select({
        status: emailDomains.webmailStatus,
        message: emailDomains.webmailStatusMessage,
      })
      .from(emailDomains)
      .where(eq(emailDomains.id, enabled.id));
    expect(ed.status).toBe('failed');
    expect(ed.message).toContain('Ingress create failed');
  });
});
