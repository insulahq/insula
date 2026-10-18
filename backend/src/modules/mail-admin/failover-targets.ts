/**
 * Which configured mail failover targets could take the stack right now.
 *
 * A target is usable when its Node exists, is Ready and is NOT cordoned: a
 * cordoned node is Ready but takes no new pod, so a failover onto it sits
 * Pending until the migration gives up (seen on production). The node the
 * stack already runs on is never a target.
 *
 * Shared by the "Mail cannot fail over" banner and the drain / cordon notice,
 * so both say the same thing. dr-watcher applies the same rule node by node.
 */
export interface FailoverNode {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly unschedulable?: boolean };
  readonly status?: { readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }> };
}

export type FailoverTargetState = 'usable' | 'missing' | 'not-ready' | 'cordoned';

export function failoverTargetState(node: FailoverNode | undefined): FailoverTargetState {
  if (!node) return 'missing';
  const ready = (node.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
  if (!ready) return 'not-ready';
  return node.spec?.unschedulable === true ? 'cordoned' : 'usable';
}

/**
 * Pure. `usable`: the candidates (in priority order) that could take the
 * stack; `skipped`: the others, as "name (why)" for operator text.
 */
export function usableFailoverTargets(
  candidates: ReadonlyArray<string | null | undefined>,
  activeNode: string | null,
  nodes: readonly FailoverNode[],
): { usable: string[]; skipped: string[] } {
  const byName = new Map(nodes.map((n) => [n.metadata?.name ?? '', n]));
  const usable: string[] = [];
  const skipped: string[] = [];
  for (const c of candidates) {
    if (!c || c === activeNode || usable.includes(c)) continue;
    const state = failoverTargetState(byName.get(c));
    if (state === 'usable') usable.push(c);
    else skipped.push(`${c} (${state === 'not-ready' ? 'not Ready' : state})`);
  }
  return { usable, skipped };
}
