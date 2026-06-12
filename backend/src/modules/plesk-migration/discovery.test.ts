import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseInventory, buildDiscoveryJob, PLESK_MIGRATION_NAMESPACE } from './discovery.js';
import { INVENTORY_BEGIN, INVENTORY_END } from './discovery-scripts.js';

const here = dirname(fileURLToPath(import.meta.url));

function wrap(json: unknown): string {
  return `some job log noise\n${INVENTORY_BEGIN}\n${JSON.stringify(json)}\n${INVENTORY_END}\ntrailing\n`;
}

const validInv = {
  pleskVersion: 'Plesk Obsidian 18.0.78',
  osVersion: 'Debian 12',
  passwordStorage: 'sym',
  subscriptions: [{
    name: 'kayec.org.na', sysUser: 'kayec', cronCount: 2, mailBytes: 9_500_000,
    domains: [{ name: 'kayec.org.na', docRoot: '/var/www/vhosts/kayec.org.na', phpVersion: 'php8.2' }],
    databases: [{ name: 'wp_kayec', type: 'mysql', sizeBytes: 12_000_000 }],
    mailboxes: [{ address: 'reception@kayec.org.na', quotaMb: 1024, passwordType: 'sym' }],
  }],
};

describe('parseInventory', () => {
  it('extracts and validates the inventory between sentinels', () => {
    const inv = parseInventory(wrap(validInv));
    expect(inv).not.toBeNull();
    expect(inv?.subscriptions[0].name).toBe('kayec.org.na');
    expect(inv?.passwordStorage).toBe('sym');
  });

  it('returns null when sentinels are absent', () => {
    expect(parseInventory('just some logs, no json')).toBeNull();
  });

  it('returns null on malformed JSON between sentinels', () => {
    expect(parseInventory(`${INVENTORY_BEGIN}\n{not json\n${INVENTORY_END}`)).toBeNull();
  });

  it('returns null when JSON fails the schema', () => {
    expect(parseInventory(wrap({ subscriptions: 'not-an-array' }))).toBeNull();
  });
});

describe('buildDiscoveryJob', () => {
  const source = {
    id: 's1', name: 'src', hostname: 'plesk.example.com', sshPort: 2222, sshUser: 'root',
    sshKeyEncrypted: 'x', pleskVersion: null, passwordStorage: null,
    lastDiscoveredAt: null, status: 'registered', createdBy: null, createdAt: new Date(),
  };

  it('is hardened: non-root, no privilege escalation, readonly fs, drops ALL caps, seccomp', () => {
    const job = buildDiscoveryJob({ jobName: 'j', secretName: 'sec', cmName: 'cm', source }) as any;
    const podSpec = job.spec.template.spec;
    expect(podSpec.securityContext.runAsNonRoot).toBe(true);
    expect(podSpec.securityContext.seccompProfile.type).toBe('RuntimeDefault');
    const c = podSpec.containers[0].securityContext;
    expect(c.allowPrivilegeEscalation).toBe(false);
    expect(c.readOnlyRootFilesystem).toBe(true);
    expect(c.capabilities.drop).toContain('ALL');
  });

  it('mounts the key Secret read-only at 0600 and the scripts ConfigMap', () => {
    const job = buildDiscoveryJob({ jobName: 'j', secretName: 'sec', cmName: 'cm', source }) as any;
    const vols = job.spec.template.spec.volumes;
    const keyVol = vols.find((v: any) => v.name === 'plesk-key');
    expect(keyVol.secret.secretName).toBe('sec');
    expect(keyVol.secret.defaultMode).toBe(0o600);
    expect(vols.find((v: any) => v.name === 'plesk-scripts').configMap.name).toBe('cm');
  });

  it('passes host/port/user as plain env (not the key)', () => {
    const job = buildDiscoveryJob({ jobName: 'j', secretName: 'sec', cmName: 'cm', source }) as any;
    const env = job.spec.template.spec.containers[0].env;
    expect(env.find((e: any) => e.name === 'PLESK_HOST').value).toBe('plesk.example.com');
    expect(env.find((e: any) => e.name === 'PLESK_PORT').value).toBe('2222');
    expect(env.some((e: any) => /key|secret/i.test(JSON.stringify(e)))).toBe(false);
  });

  it('auto-cleans (ttl + activeDeadline) and never retries', () => {
    const job = buildDiscoveryJob({ jobName: 'j', secretName: 'sec', cmName: 'cm', source }) as any;
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(job.spec.activeDeadlineSeconds).toBeGreaterThan(0);
    expect(job.metadata.namespace).toBe(PLESK_MIGRATION_NAMESPACE);
  });
});

describe('discovery scripts', () => {
  it('assemble.py prints the same sentinels the parser expects (drift guard)', () => {
    const py = readFileSync(join(here, 'scripts', 'assemble.py'), 'utf8');
    expect(py).toContain(INVENTORY_BEGIN);
    expect(py).toContain(INVENTORY_END);
  });

  it('remote-discover.sh is read-only — no plesk writes, rm, mysqldump, or chmod', () => {
    const sh = readFileSync(join(here, 'scripts', 'remote-discover.sh'), 'utf8');
    // SELECT-only DB access; no destructive verbs.
    expect(sh).not.toMatch(/\b(rm|mysqldump|DELETE|UPDATE|INSERT|DROP|chmod|chown)\b/i);
    expect(sh).toContain('plesk db -Ne');
  });

  it('remote-discover.sh validates interpolated identifiers before SQL (injection guard)', () => {
    const sh = readFileSync(join(here, 'scripts', 'remote-discover.sh'), 'utf8');
    expect(sh).toContain('is_int "${SUBID:-}" || continue');
    expect(sh).toContain('is_name "$sub" || continue');
    expect(sh).toContain('is_name "$dn" || continue');
    // health gate: total Plesk-DB failure exits non-zero (not empty inventory)
    expect(sh).toContain('exit 3');
  });

  it('runner.sh traps /tmp key cleanup on exit', () => {
    const sh = readFileSync(join(here, 'scripts', 'runner.sh'), 'utf8');
    expect(sh).toContain("trap 'rm -f /tmp/id_rsa' EXIT");
  });
});
