/**
 * Unit tests for the 3-mode port-exposure helpers (2026-05-28).
 *
 * Three pure-ish helpers under test:
 *   validateModeSwitch(target, settings)        → error string | null
 *   resolveDataPlaneNodes(mode, settings, nodes) → string[] of node names
 *   reconcileMailHaproxyLabels(core, dataPlane, allNodes) → adds/removes
 *     mail-haproxy=true labels on each node so the set matches dataPlane
 *
 * The first two are pure functions of their inputs. The third is a thin
 * shim over k8s patchNode; we test it with a mock CoreV1Api spy.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validateModeSwitch,
  resolveDataPlaneNodes,
  reconcileMailHaproxyLabels,
  MAIL_HAPROXY_LABEL_KEY,
} from './port-exposure-modes.js';

type Settings = {
  primaryNode: string | null;
  secondaryNode: string | null;
  tertiaryNode: string | null;
  activeNode: string | null;
};

type Node = {
  metadata: { name: string; labels: Record<string, string> };
};

function node(name: string, labels: Record<string, string> = {}): Node {
  return { metadata: { name, labels } };
}

// ─── validateModeSwitch ──────────────────────────────────────────────

describe('validateModeSwitch', () => {
  const baseSettings: Settings = {
    primaryNode: 'staging1',
    secondaryNode: 'staging2',
    tertiaryNode: 'staging3',
    activeNode: 'worker',
  };

  it('always allows switch to activeNodeOnly', () => {
    expect(validateModeSwitch('activeNodeOnly', baseSettings)).toBeNull();
    expect(validateModeSwitch('activeNodeOnly', { ...baseSettings, activeNode: null })).toBeNull();
  });

  it('always allows switch to allServerNodes', () => {
    expect(validateModeSwitch('allServerNodes', baseSettings)).toBeNull();
    expect(validateModeSwitch('allServerNodes', { ...baseSettings, activeNode: null })).toBeNull();
  });

  it('REFUSES assignedMailNodes when active is not in {primary, secondary, tertiary}', () => {
    // active=worker but assigned set is server1/2/3 → refuse
    const err = validateModeSwitch('assignedMailNodes', baseSettings);
    expect(err).not.toBeNull();
    expect(err).toMatch(/active.*not.*assigned|assigned.*does not include.*active/i);
    expect(err).toContain('worker');
  });

  it('ALLOWS assignedMailNodes when active equals primary', () => {
    expect(
      validateModeSwitch('assignedMailNodes', { ...baseSettings, activeNode: 'staging1' }),
    ).toBeNull();
  });

  it('ALLOWS assignedMailNodes when active equals secondary', () => {
    expect(
      validateModeSwitch('assignedMailNodes', { ...baseSettings, activeNode: 'staging2' }),
    ).toBeNull();
  });

  it('ALLOWS assignedMailNodes when active equals tertiary', () => {
    expect(
      validateModeSwitch('assignedMailNodes', { ...baseSettings, activeNode: 'staging3' }),
    ).toBeNull();
  });

  it('REFUSES assignedMailNodes when no nodes assigned at all', () => {
    const err = validateModeSwitch('assignedMailNodes', {
      primaryNode: null, secondaryNode: null, tertiaryNode: null, activeNode: 'worker',
    });
    expect(err).not.toBeNull();
    expect(err).toMatch(/no.*nodes.*assigned|empty.*assigned/i);
  });

  it('REFUSES assignedMailNodes when active is null', () => {
    const err = validateModeSwitch('assignedMailNodes', { ...baseSettings, activeNode: null });
    expect(err).not.toBeNull();
    expect(err).toMatch(/no active mail node/i);
  });
});

// ─── resolveDataPlaneNodes ───────────────────────────────────────────

describe('resolveDataPlaneNodes', () => {
  const allNodes = [
    node('staging1', { 'platform.phoenix-host.net/node-role': 'server' }),
    node('staging2', { 'platform.phoenix-host.net/node-role': 'server' }),
    node('staging3', { 'platform.phoenix-host.net/node-role': 'server' }),
    node('worker',   { 'platform.phoenix-host.net/node-role': 'worker' }),
  ];

  const baseSettings: Settings = {
    primaryNode: 'staging1',
    secondaryNode: 'staging2',
    tertiaryNode: 'staging3',
    activeNode: 'worker',
  };

  it('activeNodeOnly returns only the active node', () => {
    const r = resolveDataPlaneNodes('activeNodeOnly', baseSettings, allNodes);
    expect(r).toEqual(['worker']);
  });

  it('activeNodeOnly returns [] when no active node', () => {
    const r = resolveDataPlaneNodes('activeNodeOnly', { ...baseSettings, activeNode: null }, allNodes);
    expect(r).toEqual([]);
  });

  it('assignedMailNodes returns the {primary, secondary, tertiary} set (deduplicated)', () => {
    const r = resolveDataPlaneNodes('assignedMailNodes', baseSettings, allNodes);
    expect(r.sort()).toEqual(['staging1', 'staging2', 'staging3']);
  });

  it('assignedMailNodes ignores null entries', () => {
    const r = resolveDataPlaneNodes('assignedMailNodes', {
      primaryNode: 'staging1', secondaryNode: null, tertiaryNode: 'worker', activeNode: 'staging1',
    }, allNodes);
    expect(r.sort()).toEqual(['staging1', 'worker']);
  });

  it('allServerNodes returns all server-role nodes', () => {
    const r = resolveDataPlaneNodes('allServerNodes', { ...baseSettings, activeNode: 'staging2' }, allNodes);
    expect(r.sort()).toEqual(['staging1', 'staging2', 'staging3']);
  });

  it('allServerNodes ALSO includes active node when active is worker', () => {
    const r = resolveDataPlaneNodes('allServerNodes', baseSettings, allNodes); // active=worker
    expect(r.sort()).toEqual(['staging1', 'staging2', 'staging3', 'worker']);
  });

  it('allServerNodes deduplicates active when active is a server', () => {
    const r = resolveDataPlaneNodes('allServerNodes', { ...baseSettings, activeNode: 'staging1' }, allNodes);
    expect(r.sort()).toEqual(['staging1', 'staging2', 'staging3']);
  });

  it('skips assigned node names that do not exist in the cluster', () => {
    const r = resolveDataPlaneNodes('assignedMailNodes', {
      primaryNode: 'staging1', secondaryNode: 'ghost-node', tertiaryNode: 'staging3', activeNode: 'staging1',
    }, allNodes);
    expect(r.sort()).toEqual(['staging1', 'staging3']);
  });
});

// ─── reconcileMailHaproxyLabels ──────────────────────────────────────

describe('reconcileMailHaproxyLabels', () => {
  function makeMockCore(initialNodes: Node[]) {
    const patches: Array<{ name: string; body: unknown }> = [];
    const core = {
      patchNode: vi.fn(async (args: { name: string; body: unknown }) => {
        patches.push({ name: args.name, body: args.body });
        return undefined;
      }),
    };
    return { core, patches };
  }

  const nodes = [
    node('staging1', { 'platform.phoenix-host.net/node-role': 'server' }),
    node('staging2', { 'platform.phoenix-host.net/node-role': 'server', 'platform.phoenix-host.net/mail-haproxy': 'true' }),
    node('staging3', { 'platform.phoenix-host.net/node-role': 'server', 'platform.phoenix-host.net/mail-haproxy': 'true' }),
    node('worker',   { 'platform.phoenix-host.net/node-role': 'worker' }),
  ];

  it('labels nodes in the data plane set that are NOT yet labelled', async () => {
    const { core, patches } = makeMockCore(nodes);
    await reconcileMailHaproxyLabels(core, ['staging1', 'staging2', 'staging3'], nodes);
    // staging1 was unlabelled → expect SET patch
    const s1 = patches.find((p) => p.name === 'staging1');
    expect(s1).toBeDefined();
    const body = s1!.body as { metadata?: { labels?: Record<string, string | null> } };
    expect(body.metadata?.labels?.[MAIL_HAPROXY_LABEL_KEY]).toBe('true');
  });

  it('removes label from nodes that are NOT in the data plane set but ARE currently labelled', async () => {
    const { core, patches } = makeMockCore(nodes);
    // Data plane = only staging1 → staging2 + staging3 must be unlabelled
    await reconcileMailHaproxyLabels(core, ['staging1'], nodes);
    const removed = patches.filter((p) => {
      const body = p.body as { metadata?: { labels?: Record<string, string | null> } };
      return body.metadata?.labels?.[MAIL_HAPROXY_LABEL_KEY] === null;
    });
    expect(removed.map((p) => p.name).sort()).toEqual(['staging2', 'staging3']);
  });

  it('does NOT patch nodes whose current label state already matches the desired state', async () => {
    const { core, patches } = makeMockCore(nodes);
    // staging2 + staging3 already labelled; data plane keeps them → no-op for those.
    // staging1 not labelled, not in data plane → no-op. worker not labelled, not in data plane → no-op.
    await reconcileMailHaproxyLabels(core, ['staging2', 'staging3'], nodes);
    expect(patches.map((p) => p.name)).toEqual([]);
  });

  it('handles include-worker case (allServerNodes mode with active=worker)', async () => {
    const { core, patches } = makeMockCore(nodes);
    await reconcileMailHaproxyLabels(
      core,
      ['staging1', 'staging2', 'staging3', 'worker'],
      nodes,
    );
    // staging2 + staging3 already labelled — no-op
    // staging1 needs SET; worker needs SET
    expect(patches.map((p) => p.name).sort()).toEqual(['staging1', 'worker']);
    for (const p of patches) {
      const body = p.body as { metadata?: { labels?: Record<string, string | null> } };
      expect(body.metadata?.labels?.[MAIL_HAPROXY_LABEL_KEY]).toBe('true');
    }
  });
});
