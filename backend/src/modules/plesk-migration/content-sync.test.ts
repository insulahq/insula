import { describe, it, expect } from 'vitest';
import { webDeploymentName, webDomainsOf, runtimeCodeFor, parseContentResult, buildContentSyncJob, isSafeHostname, isSafeDocRoot } from './content-sync.js';
import type { PleskSubscription } from '@insula/api-contracts';

function sub(domains: PleskSubscription['domains']): PleskSubscription {
  return { name: 'acme.example', sysUser: 'acme', cronCount: 0, cronLines: [], mailBytes: 0, domains, databases: [], mailboxes: [] };
}

describe('webDeploymentName', () => {
  it('produces a DNS-safe web-<slug> name', () => {
    expect(webDeploymentName('acme.example')).toBe('web-acme-example');
    expect(webDeploymentName('Shop.ACME.example')).toBe('web-shop-acme-example');
  });
  it('clamps to 63 chars with no trailing hyphen', () => {
    const n = webDeploymentName('a'.repeat(80) + '.example');
    expect(n.length).toBeLessThanOrEqual(63);
    expect(n.endsWith('-')).toBe(false);
  });
});

describe('webDomainsOf', () => {
  it('keeps only domains that have a docroot', () => {
    const result = webDomainsOf(sub([
      { name: 'acme.example', docRoot: '/var/www/vhosts/acme.example/httpdocs', phpVersion: 'php8.2' },
      { name: 'parked.example', docRoot: null, phpVersion: null },
    ]));
    expect(result.map((d) => d.name)).toEqual(['acme.example']);
  });
});

describe('isSafeHostname / isSafeDocRoot (remote-shell injection guards)', () => {
  it('accepts real domains + docroots', () => {
    expect(isSafeHostname('acme.example')).toBe(true);
    expect(isSafeHostname('shop.acme-corp.example')).toBe(true);
    expect(isSafeDocRoot('/var/www/vhosts/acme.example/httpdocs')).toBe(true);
  });
  it('rejects shell-metacharacter injection in the domain name', () => {
    expect(isSafeHostname("x' || touch /tmp/pwned #")).toBe(false);
    expect(isSafeHostname('a;b')).toBe(false);
    expect(isSafeHostname('a b')).toBe(false);
  });
  it('rejects unsafe / non-absolute docroots', () => {
    expect(isSafeDocRoot('relative/path')).toBe(false);
    expect(isSafeDocRoot("/var/www/$(whoami)")).toBe(false);
    expect(isSafeDocRoot("/x'; rm -rf /")).toBe(false);
  });
});

describe('runtimeCodeFor', () => {
  it('uses apache-php when the domain ran PHP, static-apache otherwise', () => {
    expect(runtimeCodeFor({ name: 'a', docRoot: '/x', phpVersion: 'php8.2' })).toBe('apache-php');
    expect(runtimeCodeFor({ name: 'b', docRoot: '/x', phpVersion: null })).toBe('static-apache');
  });
});

describe('parseContentResult', () => {
  it('parses CONTENTRESULT + VHOSTREVIEW between sentinels', () => {
    const log = [
      '===CONTENTSYNC-BEGIN===',
      'VHOSTREVIEW acme.example has-custom-apache-directives',
      'CONTENTRESULT ok synced /src -> /dest',
      '===CONTENTSYNC-END===',
    ].join('\n');
    const r = parseContentResult(log);
    expect(r.ok).toBe(true);
    expect(r.vhostReview).toBe('custom');
  });
  it('flags no custom vhost + a failed sync', () => {
    const r = parseContentResult('===CONTENTSYNC-BEGIN===\nVHOSTREVIEW a none\nCONTENTRESULT fail rsync-error\n===CONTENTSYNC-END===');
    expect(r.ok).toBe(false);
    expect(r.vhostReview).toBe('none');
  });
  it('returns unknown/not-ok when the job emitted nothing', () => {
    const r = parseContentResult('FATAL: missing ssh key mount');
    expect(r.ok).toBe(false);
    expect(r.vhostReview).toBe('unknown');
  });
});

describe('buildContentSyncJob (hardening + RWO co-location)', () => {
  const source = {
    id: 'src98765', name: 's', hostname: 'plesk.example.test', sshPort: 22, sshUser: 'root',
    sshKeyEncrypted: 'x', pleskVersion: null, passwordStorage: null, lastDiscoveredAt: null,
    status: 'discovered', createdBy: null, createdAt: new Date(),
  } as Parameters<typeof buildContentSyncJob>[0]['source'];

  it('mounts the tenant PVC, pins to the deployment node, and is hardened', () => {
    const job = buildContentSyncJob({
      jobName: 'j', secretName: 'sec', namespace: 'tenant-x', pvcName: 'tenant-x-storage', source,
      srcPath: '/var/www/vhosts/acme.example/httpdocs', destSubPath: 'runtime/apache-php/web-acme-example',
      domain: 'acme.example', nodeName: 'worker-3',
    }) as any;
    const spec = job.spec.template.spec;
    expect(spec.nodeName).toBe('worker-3'); // RWO co-location
    expect(spec.priorityClassName).toBe('platform-tenant-overhead');
    const dataVol = spec.volumes.find((v: { name: string }) => v.name === 'data');
    expect(dataVol.persistentVolumeClaim.claimName).toBe('tenant-x-storage');
    const c = spec.containers[0];
    expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    const env = Object.fromEntries(c.env.map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(env.DEST_PATH).toBe('/data/runtime/apache-php/web-acme-example');
    expect(env.VHOST_DOMAIN).toBe('acme.example');
  });

  it('omits nodeName when the deployment node is unknown (scheduler decides)', () => {
    const job = buildContentSyncJob({
      jobName: 'j', secretName: 'sec', namespace: 'tenant-x', pvcName: 'tenant-x-storage', source,
      srcPath: '/x', destSubPath: 'p', domain: 'a.example', nodeName: undefined,
    }) as any;
    expect('nodeName' in job.spec.template.spec).toBe(false);
  });
});
