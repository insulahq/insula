import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeNameFromSubject, nodeNamePinState, pinnedNodeNames, readNodeNamePin } from './node-name-pin.js';

describe('node-name pin — pure parts', () => {
  it('reads the node name from the kubelet certificate subject, never anything else', () => {
    expect(nodeNameFromSubject('O=system:nodes\nCN=system:node:sv1')).toBe('sv1');
    expect(nodeNameFromSubject('O=system:nodes, CN=system:node:sv2.example.test')).toBe('sv2.example.test');
    expect(nodeNameFromSubject('CN=sv1')).toBeNull(); // the serving cert, not the client cert
    expect(nodeNameFromSubject('CN=system:node:Bad_Name')).toBeNull();
  });

  it('finds every node-name in config.yaml and drop-ins, quoted or not, ignoring other keys and comments', () => {
    expect(pinnedNodeNames(['kubelet-arg+:\n  - max-pods=500\n', 'node-name: "sv2.example.test" # pinned\n']))
      .toEqual({ pins: ['sv2.example.test'], unreadable: false });
    expect(pinnedNodeNames(['node-name: a\n', "node-name: 'a'\n", '"node-name" : a\n'])).toEqual({ pins: ['a'], unreadable: false });
    expect(pinnedNodeNames(['# node-name: commented\n'])).toEqual({ pins: [], unreadable: false });
  });

  it('a node-name it cannot read is flagged, never guessed at (block scalar, indented, flow style)', () => {
    expect(pinnedNodeNames(['node-name: >-\n  sv1\n']).unreadable).toBe(true);
    expect(pinnedNodeNames(['  node-name: nested\n']).unreadable).toBe(true);
    expect(pinnedNodeNames(['{node-name: sv1}\n']).unreadable).toBe(true);
    expect(nodeNamePinState('sv1', ['sv1'], true)).toEqual({ state: 'mismatch', registeredAs: 'sv1', pinnedAs: null });
  });

  it('pinned / unpinned / mismatch', () => {
    expect(nodeNamePinState('sv1', ['sv1'])).toEqual({ state: 'pinned', registeredAs: 'sv1', pinnedAs: 'sv1' });
    expect(nodeNamePinState('sv1', [])).toEqual({ state: 'unpinned', registeredAs: 'sv1', pinnedAs: null });
    expect(nodeNamePinState('sv1', ['other'])).toMatchObject({ state: 'mismatch', pinnedAs: 'other' });
    expect(nodeNamePinState('sv1', ['other', 'sv1'])).toMatchObject({ state: 'mismatch', pinnedAs: 'other, sv1' });
  });
});

describe('readNodeNamePin — against files, with a real kubelet certificate', () => {
  let dir: string;
  let paths: { kubeletCert: string; k3sConfig: string; k3sConfigDir: string };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'node-name-pin-'));
    paths = { kubeletCert: join(dir, 'client-kubelet.crt'), k3sConfig: join(dir, 'config.yaml'), k3sConfigDir: join(dir, 'config.yaml.d') };
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/O=system:nodes/CN=system:node:sv3.example.test',
      '-keyout', join(dir, 'key.pem'), '-out', paths.kubeletCert], { stdio: 'ignore' });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('an unpinned node — the state production was in before the reboot', () => {
    expect(readNodeNamePin(paths)).toEqual({ state: 'unpinned', registeredAs: 'sv3.example.test', pinnedAs: null });
  });

  it('pinned by the drop-in bootstrap and the host-migration write', () => {
    mkdirSync(paths.k3sConfigDir, { recursive: true });
    writeFileSync(join(paths.k3sConfigDir, '10-node-name.yaml'), '# comment\nnode-name: sv3.example.test\n');
    writeFileSync(join(paths.k3sConfigDir, '55-pod-capacity.yaml'), 'kubelet-arg+:\n  - max-pods=500\n');
    expect(readNodeNamePin(paths)).toMatchObject({ state: 'pinned' });
  });

  it('a config.yaml naming another node is a mismatch', () => {
    writeFileSync(paths.k3sConfig, 'node-name: someone-else\n');
    expect(readNodeNamePin(paths)).toMatchObject({ state: 'mismatch', registeredAs: 'sv3.example.test' });
    rmSync(paths.k3sConfig);
  });

  it('not a k3s node, or an unreadable certificate: null — not a guess', () => {
    expect(readNodeNamePin({ ...paths, kubeletCert: join(dir, 'absent.crt') })).toBeNull();
    writeFileSync(join(dir, 'garbage.crt'), 'not a certificate');
    expect(readNodeNamePin({ ...paths, kubeletCert: join(dir, 'garbage.crt') })).toBeNull();
  });
});
