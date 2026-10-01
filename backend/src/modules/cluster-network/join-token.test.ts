import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBootstrapTokenSecret,
  clusterCaHash,
  fetchClusterCaBundle,
  formatK10Token,
  generateBootstrapTokenParts,
  rfc3339Utc,
  K3S_NODE_TOKEN_AUTH_GROUP,
} from './join-token.js';

// A /cacerts body exactly as k3s serves it: PEM with a trailing newline.
const CA_BODY = Buffer.from(
  '-----BEGIN CERTIFICATE-----\n' +
    'MIIBdzCCAR2gAwIBAgIBADAKBggqhkjOPQQDAjAjMSEwHwYDVQQDDBhrM3Mtc2Vy\n' +
    '-----END CERTIFICATE-----\n',
);
// `sha256sum` of CA_BODY, computed outside this code base.
const CA_BODY_SHA256 = '6628fcd12aa9b89e8ca455d3dd92a0f5a00fb63cda48d708909fcefaeb07fa6c';
// …and of the same body WITHOUT its trailing newline — what `$(curl …)` would hash.
const CA_BODY_NO_NEWLINE_SHA256 = '192b9e5751e49ca2f69d741fb23cb9f200de161b4a08666b63feccd2e7661ff9';

describe('clusterCaHash', () => {
  it('hashes the RAW /cacerts bytes, trailing newline included', () => {
    expect(clusterCaHash(CA_BODY)).toBe(CA_BODY_SHA256);
    expect(clusterCaHash(CA_BODY)).not.toBe(CA_BODY_NO_NEWLINE_SHA256);
  });

  it('refuses a body with no certificate', () => {
    expect(() => clusterCaHash(Buffer.from('<html>nope</html>'))).toThrow(/no PEM certificate/);
  });

  it('refuses a multi-certificate (custom CA) bundle k3s would hash by its root', () => {
    const bundle = Buffer.concat([CA_BODY, CA_BODY]);
    expect(() => clusterCaHash(bundle)).toThrow(/2 certificates/);
  });
});

describe('formatK10Token', () => {
  it('composes K10<sha256(raw CA)>::<id>.<secret>', () => {
    const t = formatK10Token(clusterCaHash(CA_BODY), { id: 'abcdef', secret: '0123456789abcdef' });
    expect(t).toBe(`K10${CA_BODY_SHA256}::abcdef.0123456789abcdef`);
    // The shape bootstrap.sh's join preflight parses to compare CA hashes.
    expect(t).toMatch(/^K10([0-9a-f]{64})::/);
  });

  it('rejects malformed parts', () => {
    expect(() => formatK10Token('xyz', { id: 'abcdef', secret: '0123456789abcdef' })).toThrow();
    expect(() => formatK10Token(CA_BODY_SHA256, { id: 'ABCDEF', secret: '0123456789abcdef' })).toThrow();
    expect(() => formatK10Token(CA_BODY_SHA256, { id: 'abcdef', secret: 'short' })).toThrow();
  });
});

describe('generateBootstrapTokenParts', () => {
  it('yields [a-z0-9]{6}.[a-z0-9]{16} and does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generateBootstrapTokenParts();
      expect(p.id).toMatch(/^[a-z0-9]{6}$/);
      expect(p.secret).toMatch(/^[a-z0-9]{16}$/);
      seen.add(`${p.id}.${p.secret}`);
    }
    expect(seen.size).toBe(50);
  });
});

describe('buildBootstrapTokenSecret', () => {
  const expiresAt = new Date('2026-10-01T14:00:00.123Z');

  it('matches the Secret `k3s token create` writes', () => {
    const s = buildBootstrapTokenSecret({
      token: { id: 'abcdef', secret: '0123456789abcdef' },
      description: 'Insula join token: worker 192.0.2.50 (ClusterPendingPeer w3)',
      expiresAt,
      owner: { name: 'w3', uid: '11111111-2222-3333-4444-555555555555' },
    });
    expect(s.metadata?.name).toBe('bootstrap-token-abcdef');
    expect(s.metadata?.namespace).toBe('kube-system');
    expect(s.type).toBe('bootstrap.kubernetes.io/token');
    expect(s.stringData).toEqual({
      'token-id': 'abcdef',
      'token-secret': '0123456789abcdef',
      description: 'Insula join token: worker 192.0.2.50 (ClusterPendingPeer w3)',
      // Go time.RFC3339 in UTC — no fractional seconds.
      expiration: '2026-10-01T14:00:00Z',
      'usage-bootstrap-authentication': 'true',
      'usage-bootstrap-signing': 'true',
      'auth-extra-groups': 'system:bootstrappers:k3s:default-node-token',
    });
    expect(K3S_NODE_TOKEN_AUTH_GROUP).toBe('system:bootstrappers:k3s:default-node-token');
  });

  it('is owned by the ClusterPendingPeer, so deleting the pre-enrolment revokes it', () => {
    const s = buildBootstrapTokenSecret({
      token: { id: 'abcdef', secret: '0123456789abcdef' },
      description: 'd',
      expiresAt,
      owner: { name: 'w3', uid: 'uid-1' },
    });
    expect(s.metadata?.ownerReferences).toEqual([
      { apiVersion: 'networking.insula.host/v1alpha1', kind: 'ClusterPendingPeer', name: 'w3', uid: 'uid-1' },
    ]);
    expect(s.metadata?.labels?.['insula.host/pending-peer']).toBe('w3');
  });

  it('omits the ownerReference when the uid is unknown (a wrong uid would GC it at once)', () => {
    const s = buildBootstrapTokenSecret({
      token: { id: 'abcdef', secret: '0123456789abcdef' },
      description: 'd',
      expiresAt,
      owner: { name: 'w3', uid: null },
    });
    expect(s.metadata?.ownerReferences).toBeUndefined();
  });

  it('refuses a token outside the bootstrap-token alphabet', () => {
    expect(() =>
      buildBootstrapTokenSecret({
        token: { id: 'abc', secret: '0123456789abcdef' },
        description: 'd',
        expiresAt,
        owner: { name: 'w3', uid: null },
      }),
    ).toThrow();
  });
});

describe('rfc3339Utc', () => {
  it('drops milliseconds', () => {
    expect(rfc3339Utc(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z');
  });
});

// ─── fetchClusterCaBundle — the real HTTPS path ─────────────────────────────
// A local TLS server with a throwaway self-signed cert (generated per run by
// the openssl CLI — no key material is committed). Proves the fetch pins the
// kubeconfig's CA: the right CA gets the raw bytes, a different CA is refused.

const HAS_OPENSSL = spawnSync('openssl', ['version']).status === 0;

function makeCert(dir: string, name: string): { cert: string; key: string } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${name}`,
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr.toString()}`);
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
}

function kubeconfig(dir: string, server: string, caPem: string): string {
  const p = join(dir, `kubeconfig-${Math.random().toString(36).slice(2)}`);
  writeFileSync(
    p,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: c',
      '  cluster:',
      `    server: ${server}`,
      `    certificate-authority-data: ${Buffer.from(caPem).toString('base64')}`,
      'users:',
      '- name: u',
      '  user:',
      '    token: test',
      'contexts:',
      '- name: x',
      '  context: {cluster: c, user: u}',
      'current-context: x',
      '',
    ].join('\n'),
  );
  return p;
}

describe.skipIf(!HAS_OPENSSL)('fetchClusterCaBundle (real TLS)', () => {
  let dir = '';
  let server: Server;
  let url = '';
  let served: { cert: string; key: string };
  let other: { cert: string; key: string };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cacerts-test-'));
    served = makeCert(dir, 'served');
    other = makeCert(dir, 'other');
    server = createServer({ cert: served.cert, key: served.key }, (req, res) => {
      if (req.url === '/cacerts') {
        res.writeHead(200);
        res.end(served.cert);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the RAW /cacerts bytes when the server proves the kubeconfig CA', async () => {
    const body = await fetchClusterCaBundle({ kubeconfigPath: kubeconfig(dir, url, served.cert) });
    expect(body.equals(Buffer.from(served.cert))).toBe(true);
    expect(clusterCaHash(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a server whose certificate the kubeconfig CA does not sign', async () => {
    await expect(fetchClusterCaBundle({ kubeconfigPath: kubeconfig(dir, url, other.cert) })).rejects.toThrow(
      /certificate|self[- ]signed|verify/i,
    );
  });

  it('refuses a non-https API server URL', async () => {
    await expect(
      fetchClusterCaBundle({ kubeconfigPath: kubeconfig(dir, url.replace('https:', 'http:'), served.cert) }),
    ).rejects.toThrow(/non-https/);
  });
});
