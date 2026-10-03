/**
 * Guard: the admin panel never prints a node's Kubernetes name where its alias
 * belongs. A node field rendered straight into JSX (`{e.nodeName}`,
 * `{d.currentNodeName ?? '—'}`, `{v.replicaNodes.join(', ')}`) shows
 * `sv2.cluster.example.test` to an operator who named that node "Secondary".
 * Render it through `<NodeName>` / `<NodeList>` / `useNodeLabel()` instead.
 *
 * Deliberately raw — and so not matched here — are attribute values (keys,
 * test ids, select values, URLs) and typed confirmations, which must carry
 * the real name. If a raw render is genuinely meant (a `kubectl` command
 * line), keep it out of this pattern by writing it as an attribute or a code
 * span built from a variable, and say why next to it.
 */
import { describe, it, expect } from 'vitest';

/** Every component source, raw. Vite's glob, not `node:fs` — the panel build typechecks tests without Node types. */
const SOURCES = import.meta.glob<string>(
  ['../**/*.tsx', '!../**/__tests__/**', '!../**/*.test.tsx'],
  { query: '?raw', import: 'default', eager: true },
);

/** Fields that hold a node name (or a list of them) in the panel's data. */
const NODE_FIELD = String.raw`(?:node|nodeName|currentNodeName|currentWorker|primaryNode|secondaryNode|tertiaryNode|targetNode|sourceNode|activeNode|pvcNode|expectedActiveNode|pinnedNode|movedFromNode|currentNode|worstNode)`;
const NODE_LIST = String.raw`(?:replicaNodes|returnedNodes|actualNodes|workloadNodes|attachedNodes|dataNodes|nodesBefore|nodesAfter)`;

/** `{a.b.field}` or `{a.field ?? '—'}` as a JSX child — not an attribute value or a template slot. */
const RAW_FIELD = new RegExp(String.raw`(?<![=$\w])\{\s*[A-Za-z_][\w.?!]*\.${NODE_FIELD}\s*(?:\?\?\s*'[^']*'\s*)?\}`, 'g');
/** `{a.replicaNodes.join(', ')}` as a JSX child. */
const RAW_LIST = new RegExp(String.raw`(?<![=$\w])\{\s*[A-Za-z_][\w.?!]*\.${NODE_LIST}\.join\(`, 'g');

export function rawNodeRenders(text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const hits = [...line.matchAll(RAW_FIELD), ...line.matchAll(RAW_LIST)];
    return hits.length > 0 ? [`${i + 1}: ${line.trim()}`] : [];
  });
}

describe('node names render by alias', () => {
  it('no admin-panel component prints a node field raw', () => {
    const files = Object.entries(SOURCES);
    // An empty glob would pass the check below on nothing.
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap(([file, text]) => rawNodeRenders(text).map((hit) => `${file}:${hit}`));
    expect(offenders).toEqual([]);
  });

  it('catches each shape it exists for, and passes the safe ones', () => {
    expect(rawNodeRenders('<td>{e.nodeName}</td>')).toHaveLength(1);
    expect(rawNodeRenders("<td>{d.currentNodeName ?? '—'}</td>")).toHaveLength(1);
    expect(rawNodeRenders("<span>{v.replicaNodes.join(', ')}</span>")).toHaveLength(1);
    expect(rawNodeRenders('Move to {current.drift.primaryNode} now')).toHaveLength(1);
    expect(rawNodeRenders('<td>{pod.node}</td>')).toHaveLength(1);
    expect(rawNodeRenders('Re-pinned to {res.data.currentWorker}.')).toHaveLength(1);
    expect(rawNodeRenders('{n.nodeCount} nodes')).toEqual([]);
    expect(rawNodeRenders('<NodeName name={e.nodeName} />')).toEqual([]);
    expect(rawNodeRenders('<tr key={e.nodeName} data-testid={`row-${e.nodeName}`}>')).toEqual([]);
    expect(rawNodeRenders('<option value={c.targetNode}>{label}</option>')).toEqual([]);
  });
});
