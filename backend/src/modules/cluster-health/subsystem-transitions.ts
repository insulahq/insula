/**
 * Per-node Calico / Longhorn CSI transitions — the pure half of the
 * cluster-health scheduler, so it can be tested without timers or k8s.
 *
 * Join grace (node-health/join-grace.ts): a node that is still joining has no
 * Calico or CSI pod YET, which used to be reported as "Calico is missing" the
 * moment the node registered. A joining node is now neither announced nor
 * remembered — and any healthy state remembered for that name is FORGOTTEN — so
 * the first observation after its window closes is treated as a first
 * sighting: still degraded then means one alert, healthy means silence. A node
 * already announced as degraded keeps the normal rules.
 */
import type { NodeSubsystemReport } from './service.js';

export interface SubsystemState {
  readonly calicoHealthy: boolean;
  readonly longhornCsiHealthy: boolean;
}

export interface SubsystemTransition {
  readonly node: string;
  readonly reason: string;
  readonly severity: 'error' | 'warning' | 'success';
}

export interface SubsystemTickResult {
  readonly transitions: readonly SubsystemTransition[];
  readonly nextState: ReadonlyMap<string, SubsystemState>;
  /** Nodes skipped because they are inside their join grace window. */
  readonly suppressed: readonly string[];
}

function firstSighting(r: NodeSubsystemReport, state: SubsystemState): SubsystemTransition[] {
  const out: SubsystemTransition[] = [];
  if (!state.calicoHealthy) {
    out.push({ node: r.nodeName, reason: `Calico is ${r.calico} on '${r.nodeName}'${r.calicoMessage ? ` — ${r.calicoMessage}` : ''}`, severity: 'error' });
  }
  if (!state.longhornCsiHealthy) {
    out.push({ node: r.nodeName, reason: `Longhorn CSI is ${r.longhornCsi} on '${r.nodeName}'${r.longhornCsiMessage ? ` — ${r.longhornCsiMessage}` : ''}`, severity: 'error' });
  }
  return out;
}

function changes(r: NodeSubsystemReport, prev: SubsystemState, state: SubsystemState): SubsystemTransition[] {
  const out: SubsystemTransition[] = [];
  if (prev.calicoHealthy !== state.calicoHealthy) {
    out.push({
      node: r.nodeName,
      reason: state.calicoHealthy
        ? `Calico recovered on '${r.nodeName}'`
        : `Calico regressed on '${r.nodeName}' — ${r.calicoMessage ?? r.calico}`,
      severity: state.calicoHealthy ? 'success' : 'error',
    });
  }
  if (prev.longhornCsiHealthy !== state.longhornCsiHealthy) {
    out.push({
      node: r.nodeName,
      reason: state.longhornCsiHealthy
        ? `Longhorn CSI recovered on '${r.nodeName}'`
        : `Longhorn CSI regressed on '${r.nodeName}' — ${r.longhornCsiMessage ?? r.longhornCsi}`,
      severity: state.longhornCsiHealthy ? 'success' : 'error',
    });
  }
  return out;
}

/**
 * Diff this tick's reports against the remembered state.
 *
 * Unchanged behaviour for every node outside a join window: the first
 * observation fires only if degraded, later ones fire on change.
 */
export function computeSubsystemTransitions(
  reports: readonly NodeSubsystemReport[],
  prevState: ReadonlyMap<string, SubsystemState>,
  joining: ReadonlyMap<string, unknown>,
): SubsystemTickResult {
  const transitions: SubsystemTransition[] = [];
  const suppressed: string[] = [];
  const nextState = new Map(prevState);

  for (const r of reports) {
    const prev = prevState.get(r.nodeName);
    // Held only while nothing bad about this node has been announced: the
    // window holds back news, it must not swallow the "recovered" for a
    // problem the operator was already told about.
    const announcedBad = prev !== undefined && !(prev.calicoHealthy && prev.longhornCsiHealthy);
    if (joining.has(r.nodeName) && !announcedBad) {
      suppressed.push(r.nodeName);
      nextState.delete(r.nodeName);
      continue;
    }
    const state: SubsystemState = {
      calicoHealthy: r.calico === 'healthy',
      longhornCsiHealthy: r.longhornCsi === 'healthy' && r.csiDriverRegistered,
    };
    transitions.push(...(prev ? changes(r, prev, state) : firstSighting(r, state)));
    nextState.set(r.nodeName, state);
  }

  return { transitions, nextState, suppressed };
}
