import { describe, expect, it } from 'vitest';
import { aliasNodeNames, aliasNodeNamesInVariables, buildNodeLabels, nodeLabel } from './labels.js';

const labels = buildNodeLabels([
  { name: 'sv1', displayName: 'Primary', hostname: 'sv1' },
  { name: 'sv2.cluster.example.test', displayName: ' Secondary ', hostname: 'sv2' },
  { name: 'worker-3', displayName: null, hostname: 'worker-3' },
  { name: 'worker-4', displayName: '   ', hostname: null },
]);

describe('nodeLabel', () => {
  it('uses the alias when one is set', () => {
    expect(nodeLabel('sv1', labels)).toBe('Primary');
    expect(nodeLabel('sv2.cluster.example.test', labels)).toBe('Secondary');
  });

  it('finds the node by its hostname too', () => {
    expect(nodeLabel('sv2', labels)).toBe('Secondary');
  });

  it('falls back to the name when no alias is set, blank counts as unset', () => {
    expect(nodeLabel('worker-3', labels)).toBe('worker-3');
    expect(nodeLabel('worker-4', labels)).toBe('worker-4');
    expect(nodeLabel('unknown-node', labels)).toBe('unknown-node');
  });
});

describe('aliasNodeNames', () => {
  it('replaces node names inside text, longest first, on word boundaries only', () => {
    expect(aliasNodeNames('Mail failed over from sv2.cluster.example.test to sv1.', labels))
      .toBe('Mail failed over from Secondary to Primary.');
    expect(aliasNodeNames('running on sv2, primary sv1', labels)).toBe('running on Secondary, primary Primary');
  });

  it('leaves names that are part of something else alone', () => {
    expect(aliasNodeNames('volume sv10 and host sv1.other.test and pvc-sv1', labels))
      .toBe('volume sv10 and host sv1.other.test and pvc-sv1');
  });

  it('leaves code spans alone — a command must keep the real name', () => {
    expect(aliasNodeNames('sv1 is cordoned; run `kubectl uncordon sv1` to undo', labels))
      .toBe('Primary is cordoned; run `kubectl uncordon sv1` to undo');
    expect(aliasNodeNames('unclosed ` sv1', labels)).toBe('unclosed ` Primary');
  });

  it('is a no-op without aliases', () => {
    expect(aliasNodeNames('worker-3 is down', labels)).toBe('worker-3 is down');
    expect(aliasNodeNames('sv1', buildNodeLabels([]))).toBe('sv1');
  });
});

describe('aliasNodeNamesInVariables', () => {
  it('aliases descriptive text and leaves links and paths alone', () => {
    expect(aliasNodeNamesInVariables({
      nodeName: 'sv1', detail: 'sv2 is back', count: 3, details: ['acme on sv2', 'beta on sv1'],
      actionUrl: 'https://admin.example.test/cluster/nodes/sv1', nodePath: '/cluster/nodes/sv1', other: '/x/sv1',
    }, labels)).toEqual({
      nodeName: 'Primary', detail: 'Secondary is back', count: 3, details: ['acme on Secondary', 'beta on Primary'],
      actionUrl: 'https://admin.example.test/cluster/nodes/sv1', nodePath: '/cluster/nodes/sv1', other: '/x/sv1',
    });
  });
});
