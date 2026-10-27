import { describe, expect, it } from 'vitest';
import {
  SOURCE_SHIM_LAUNCHER,
  SOURCE_SHIM_LABEL,
  buildSourceShimObjects,
  sourceShimConfigHash,
  sourceShimEndpoint,
  sourceShimId,
  sourceShimName,
} from './manifests.js';

const TARGET = '0b6f2f8e-3c1d-4b8e-9a51-2f7d3c9e8a10';

function build(overrides: Partial<Parameters<typeof buildSourceShimObjects>[0]> = {}) {
  return buildSourceShimObjects({
    targetId: TARGET,
    image: 'ghcr.io/example/backup-rclone@sha256:abc',
    rendered: {
      upstreamEnv: 'ROOT_ACCESS_KEY=a\nROOT_SECRET_KEY=b\n',
      rcloneConf: '[upstream_x]\ntype = sftp\n[combined]\ntype = combine\nupstreams = tenant=upstream_x:backups/tenant\n',
      sshKeys: [{ fileName: 'upstream_x.pem', pemContent: '-----BEGIN KEY-----\nx\n' }, { fileName: 'empty.pem', pemContent: '  ' }],
    },
    configHash: 'h1',
    now: new Date('2026-10-27T10:00:00Z'),
    ...overrides,
  });
}

type Pod = {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  containers: Array<{ image: string; securityContext: { readOnlyRootFilesystem: boolean; privileged?: boolean }; readinessProbe: { tcpSocket?: { port: number } } }>;
  volumes: Array<{ name: string; secret?: { secretName: string }; configMap?: { name: string }; hostPath?: unknown }>;
};

describe('source shim objects', () => {
  it('names everything after the target, short and stable', () => {
    expect(sourceShimId(TARGET)).toMatch(/^[0-9a-f]{8}$/);
    expect(sourceShimId(TARGET)).toBe(sourceShimId(TARGET));
    expect(sourceShimName(TARGET)).toBe(`backup-source-${sourceShimId(TARGET)}`);
    expect(sourceShimEndpoint(TARGET)).toBe(`http://backup-source-${sourceShimId(TARGET)}.platform.svc.cluster.local:9000`);
    expect(sourceShimId('another-target')).not.toBe(sourceShimId(TARGET));
  });

  it('is never selected by the real shim Service', () => {
    const o = build();
    const dep = o.deployment as { metadata: { labels: Record<string, string> }; spec: { template: { metadata: { labels: Record<string, string> } } } };
    expect(dep.metadata.labels.app).toBe('backup-source-shim');
    expect(dep.spec.template.metadata.labels.app).toBe('backup-source-shim');
    expect(JSON.stringify(o)).not.toContain('"app":"backup-rclone-shim"');
    const svc = o.service as { spec: { selector: Record<string, string> } };
    expect(svc.spec.selector).toEqual({ app: 'backup-source-shim', [SOURCE_SHIM_LABEL]: sourceShimId(TARGET) });
  });

  it('runs as the default ServiceAccount without a token, unprivileged, read-only root', () => {
    const pod = (build().deployment as { spec: { template: { spec: Pod } } }).spec.template.spec;
    expect(pod.serviceAccountName).toBeUndefined();
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
    expect(pod.containers[0].securityContext.privileged).toBeUndefined();
    expect(pod.volumes.some((v) => v.hostPath)).toBe(false);
    expect(pod.containers[0].image).toBe('ghcr.io/example/backup-rclone@sha256:abc');
  });

  it('is Ready only once it serves :9000', () => {
    const pod = (build().deployment as { spec: { template: { spec: Pod } } }).spec.template.spec;
    expect(pod.containers[0].readinessProbe.tcpSocket?.port).toBe(9000);
  });

  it('mounts its own Secrets and launcher, not the real shim\'s', () => {
    const pod = (build().deployment as { spec: { template: { spec: Pod } } }).spec.template.spec;
    const name = sourceShimName(TARGET);
    expect(pod.volumes.find((v) => v.name === 'rclone-credentials')?.secret?.secretName).toBe(`${name}-credentials`);
    expect(pod.volumes.find((v) => v.name === 'rclone-ssh-keys')?.secret?.secretName).toBe(`${name}-ssh-keys`);
    expect(pod.volumes.find((v) => v.name === 'rclone-static')?.configMap?.name).toBe(`${name}-static`);
  });

  it('serves read-only, plain shell (no Flux $$ escaping)', () => {
    expect(SOURCE_SHIM_LAUNCHER).toContain('--read-only');
    expect(SOURCE_SHIM_LAUNCHER).not.toContain('$$');
    expect(SOURCE_SHIM_LAUNCHER).not.toContain('--vfs-cache-mode writes');
    expect(SOURCE_SHIM_LAUNCHER).toMatch(/combined:\s*$/);
  });

  it('carries the rendered config and only non-empty SSH keys', () => {
    const o = build();
    const creds = o.credentials as { data: Record<string, string> };
    expect(Buffer.from(creds.data['rclone.conf'], 'base64').toString()).toContain('upstreams = tenant=upstream_x:backups/tenant');
    expect(Buffer.from(creds.data['upstream.env'], 'base64').toString()).toContain('ROOT_ACCESS_KEY=a');
    const ssh = o.sshKeys as { data: Record<string, string> };
    expect(Object.keys(ssh.data)).toEqual(['upstream_x.pem']);
  });

  it('stamps the input hash on the pod, so a changed target means a new pod', () => {
    const dep = build({ configHash: 'h2' }).deployment as { metadata: { annotations: Record<string, string> }; spec: { template: { metadata: { annotations: Record<string, string> } } } };
    expect(dep.metadata.annotations['insula.host/config-hash']).toBe('h2');
    expect(dep.spec.template.metadata.annotations['insula.host/config-hash']).toBe('h2');
    expect(dep.metadata.annotations['insula.host/last-used']).toBe('2026-10-27T10:00:00.000Z');
  });

  it('hashes the inputs, not the rendered text (which carries a random IV)', () => {
    const a = sourceShimConfigHash({ keyFingerprint: 'f', target: { id: TARGET, sshPassword: 'p' }, image: 'i' });
    expect(a).toBe(sourceShimConfigHash({ keyFingerprint: 'f', target: { id: TARGET, sshPassword: 'p' }, image: 'i' }));
    expect(a).not.toBe(sourceShimConfigHash({ keyFingerprint: 'f', target: { id: TARGET, sshPassword: 'q' }, image: 'i' }));
    expect(a).not.toBe(sourceShimConfigHash({ keyFingerprint: 'f', target: { id: TARGET, sshPassword: 'p' }, image: 'j' }));
    expect(a).not.toBe(sourceShimConfigHash({ keyFingerprint: 'g', target: { id: TARGET, sshPassword: 'p' }, image: 'i' }));
  });
});
