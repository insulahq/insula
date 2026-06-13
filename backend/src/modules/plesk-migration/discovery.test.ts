import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseInventory, buildDiscoveryJob, discoveryFailureReason, PLESK_MIGRATION_NAMESPACE } from './discovery.js';
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
    name: 'acme.example', sysUser: 'acme', cronCount: 2, mailBytes: 9_500_000,
    domains: [{ name: 'acme.example', docRoot: '/var/www/vhosts/acme.example', phpVersion: 'php8.2' }],
    databases: [{ name: 'wp_acme', type: 'mysql', sizeBytes: 12_000_000 }],
    mailboxes: [{ address: 'reception@acme.example', quotaMb: 1024, passwordType: 'sym' }],
  }],
};

describe('discoveryFailureReason', () => {
  it('maps an auth failure (wrong key/password)', () => {
    expect(discoveryFailureReason('...\nPermission denied, please try again.\nFATAL: ...')).toMatch(/authentication failed/i);
  });
  it('maps an unreachable host', () => {
    expect(discoveryFailureReason('ssh: connect to host x port 22: Connection timed out')).toMatch(/could not reach the host/i);
  });
  it('maps a connected-but-not-Plesk box', () => {
    expect(discoveryFailureReason("FATAL: 'plesk version' empty and 'plesk db' unreachable")).toMatch(/not a usable Plesk server/i);
  });
  it('falls back to a generic reason for an empty log', () => {
    expect(discoveryFailureReason('')).toMatch(/did not complete/i);
  });
});

describe('parseInventory', () => {
  it('extracts and validates the inventory between sentinels', () => {
    const inv = parseInventory(wrap(validInv));
    expect(inv).not.toBeNull();
    expect(inv?.subscriptions[0].name).toBe('acme.example');
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
    expect(keyVol.secret.items.find((i: any) => i.key === 'id_rsa').mode).toBe(0o600);
    expect(vols.find((v: any) => v.name === 'plesk-scripts').configMap.name).toBe('cm');
  });

  it('passes host/port/user + auth method as plain env, never the key material', () => {
    const job = buildDiscoveryJob({ jobName: 'j', secretName: 'sec', cmName: 'cm', source }) as any;
    const env = job.spec.template.spec.containers[0].env;
    expect(env.find((e: any) => e.name === 'PLESK_HOST').value).toBe('plesk.example.com');
    expect(env.find((e: any) => e.name === 'PLESK_PORT').value).toBe('2222');
    expect(env.find((e: any) => e.name === 'PLESK_AUTH_METHOD').value).toBe('key');
    // the key is delivered as a mounted Secret, never inline in env
    expect(env.some((e: any) => typeof e.value === 'string' && /BEGIN|PRIVATE|id_rsa/.test(e.value))).toBe(false);
    expect(env.some((e: any) => e.name === 'SSHPASS')).toBe(false);
  });

  it('password auth → SSHPASS env from the Secret, no key volume mounted', () => {
    const pwSource = { ...source, authMethod: 'password', sshKeyEncrypted: null, sshPasswordEncrypted: 'enc' };
    const job = buildDiscoveryJob({ jobName: 'j', secretName: 'sec', cmName: 'cm', source: pwSource }) as any;
    const podSpec = job.spec.template.spec;
    expect(podSpec.volumes.some((v: any) => v.name === 'plesk-key')).toBe(false);
    const sshpass = podSpec.containers[0].env.find((e: any) => e.name === 'SSHPASS');
    expect(sshpass.valueFrom.secretKeyRef).toMatchObject({ name: 'sec', key: 'ssh_password' });
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

  it('remote-discover.sh reads mailbox quota from mail.mbox_quota (mail_aux table does not exist)', () => {
    const sh = readFileSync(join(here, 'scripts', 'remote-discover.sh'), 'utf8');
    expect(sh).toContain('m.mbox_quota');
    expect(sh).not.toContain('mail_aux');
  });

  it('remote-discover.sh validates interpolated identifiers before SQL (injection guard)', () => {
    const sh = readFileSync(join(here, 'scripts', 'remote-discover.sh'), 'utf8');
    expect(sh).toContain('is_int "${SUBID:-}" || continue');
    expect(sh).toContain('is_name "$sub" || continue');
    expect(sh).toContain('is_name "$dn" || continue');
    // health gate: total Plesk-DB failure exits non-zero (not empty inventory)
    expect(sh).toContain('exit 3');
  });

  it('runner.sh traps /tmp cleanup on exit', () => {
    const sh = readFileSync(join(here, 'scripts', 'runner.sh'), 'utf8');
    expect(sh).toContain("trap 'rm -f /tmp/id_rsa /tmp/discover.out' EXIT");
  });

  it('runner.sh fails visibly on ssh/remote failure (no false empty inventory)', () => {
    const sh = readFileSync(join(here, 'scripts', 'runner.sh'), 'utf8');
    // capture-then-check, not a pipe that masks the ssh exit code
    expect(sh).toMatch(/if ! \$SSH .* > \/tmp\/discover\.out; then/);
    expect(sh).toContain('exit 1');
    expect(sh).toContain('python3 /etc/plesk-scripts/assemble.py < /tmp/discover.out');
  });
});
