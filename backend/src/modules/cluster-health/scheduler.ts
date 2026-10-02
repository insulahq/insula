import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectNodeSubsystemHealth } from './service.js';
import { computeSubsystemTransitions, type SubsystemState } from './subsystem-transitions.js';
import { describeSuppression, loadJoinGrace, type RawGraceNode } from '../node-health/join-grace.js';

// Issue 3 fix: detect worker nodes whose Calico or Longhorn CSI is
// degraded and surface the regression via the notifications table.
// In-memory state tracks the previous tick so we only fire once per
// state change instead of every minute. Nodes inside their join grace
// window are skipped (see subsystem-transitions.ts).

const SUBSYSTEM_INTERVAL_MS = 5 * 60 * 1000; // 5 min — fast enough to catch a join failure
const INITIAL_DELAY_MS = 60_000;

export function startNodeHealthReconciler(db: Database, k8s: K8sClients): { stop: () => void } {
  console.log('[node-health] starting reconciler (5min cadence)');
  let lastState: ReadonlyMap<string, SubsystemState> = new Map();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      // One Node list feeds both the subsystem report and the join grace window.
      const nodes = await k8s.core.listNode();
      const reports = await collectNodeSubsystemHealth(k8s, nodes);
      const now = new Date();
      const joining = await loadJoinGrace(k8s, (nodes.items ?? []) as readonly RawGraceNode[], now);
      const result = computeSubsystemTransitions(reports, lastState, joining);
      lastState = result.nextState;

      for (const name of result.suppressed) {
        const verdict = joining.get(name);
        if (verdict) console.log(`[node-health] ${describeSuppression(name, verdict, 'Calico / Longhorn CSI alerts')}`);
      }

      if (result.transitions.length > 0) {
        // Dispatched, not inserted. This wrote a row per admin straight into
        // the notifications table with no category, so a node subsystem going
        // unhealthy could never be emailed or pushed — and the panel is
        // exactly what may be unreachable when it happens. The `node`
        // subsystem maps to an Availability category, which never relies on
        // in-app delivery.
        const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
        for (const t of result.transitions) {
          await notifyAdminOperationalEvent(db, 'node', {
            subsystem: 'Node subsystem health',
            objectLabel: t.node,
            detail: t.reason,
            severityLabel: t.severity === 'success' ? 'recovered' : t.severity,
            recommendedAction: t.severity === 'success'
              ? ''
              : 'Check the node in Cluster → Nodes; Calico or the Longhorn CSI may need attention.',
          }, `node-subsystem:${t.node}:${t.severity}:${new Date().toISOString().slice(0, 13)}`)
            .catch((err) => console.error('[node-health] notification dispatch failed:', (err as Error).message));
        }
      }
    } catch (err) {
      console.error('[node-health] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, SUBSYSTEM_INTERVAL_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
