import { describe, it, expect } from 'vitest';
import { projectNode, parseCpuMillicores, parseMemoryBytes } from './k8s-sync.js';

describe('projectNode', () => {
  it('defaults unlabeled node to worker with canHostClientWorkloads=true', () => {
    const observed = projectNode({
      metadata: { name: 'node-1', labels: {} },
    });
    expect(observed.role).toBe('worker');
    expect(observed.canHostClientWorkloads).toBe(true);
  });

  it('respects platform.example.test/node-role=server label', () => {
    const observed = projectNode({
      metadata: {
        name: 'node-1',
        labels: { 'platform.example.test/node-role': 'server' },
      },
    });
    expect(observed.role).toBe('server');
    // Server with no host-client label defaults to false.
    expect(observed.canHostClientWorkloads).toBe(false);
  });

  it('respects host-client-workloads=true override on server', () => {
    const observed = projectNode({
      metadata: {
        name: 'node-1',
        labels: {
          'platform.example.test/node-role': 'server',
          'platform.example.test/host-client-workloads': 'true',
        },
      },
    });
    expect(observed.role).toBe('server');
    expect(observed.canHostClientWorkloads).toBe(true);
  });

  it('prefers ExternalIP over InternalIP for publicIp', () => {
    const observed = projectNode({
      metadata: { name: 'node-1', labels: {} },
      status: {
        addresses: [
          { type: 'InternalIP', address: '10.0.0.5' },
          { type: 'ExternalIP', address: '192.0.2.56' },
        ],
      },
    });
    expect(observed.publicIp).toBe('192.0.2.56');
  });

  it('extracts k3s version from osImage', () => {
    const observed = projectNode({
      metadata: { name: 'node-1', labels: {} },
      status: {
        nodeInfo: {
          kubeletVersion: 'v1.31.4+k3s1',
          osImage: 'K3s v1.31.4+k3s1',
        },
      },
    });
    expect(observed.kubeletVersion).toBe('v1.31.4+k3s1');
    expect(observed.k3sVersion).toBe('v1.31.4+k3s1');
  });

  it('parses taints and preserves key+value+effect', () => {
    const observed = projectNode({
      metadata: { name: 'node-1', labels: {} },
      spec: {
        taints: [
          { key: 'platform.example.test/server-only', value: 'true', effect: 'NoSchedule' },
        ],
      },
    });
    expect(observed.taints).toEqual([
      { key: 'platform.example.test/server-only', value: 'true', effect: 'NoSchedule' },
    ]);
  });
});

describe('parseCpuMillicores', () => {
  it('parses millicore-suffixed strings', () => {
    expect(parseCpuMillicores('3500m')).toBe(3500);
  });
  it('parses plain core counts as millicores', () => {
    expect(parseCpuMillicores('4')).toBe(4000);
  });
  it('returns null for undefined input', () => {
    expect(parseCpuMillicores(undefined)).toBeNull();
  });
  it('returns null for unparseable input', () => {
    expect(parseCpuMillicores('abc')).toBeNull();
  });
});

describe('parseMemoryBytes', () => {
  it('parses binary suffixes', () => {
    expect(parseMemoryBytes('16Gi')).toBe(16 * 1024 ** 3);
    expect(parseMemoryBytes('512Mi')).toBe(512 * 1024 ** 2);
  });
  it('parses decimal suffixes', () => {
    expect(parseMemoryBytes('16G')).toBe(16 * 1000 ** 3);
  });
  it('parses plain bytes', () => {
    expect(parseMemoryBytes('1024')).toBe(1024);
  });
  it('returns null for unknown suffix', () => {
    expect(parseMemoryBytes('16Xi')).toBeNull();
  });
  it('returns null for undefined', () => {
    expect(parseMemoryBytes(undefined)).toBeNull();
  });
});
