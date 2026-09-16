import { inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { notifications, users } from '../../db/schema.js';
import { collectNodeSubsystemHealth } from './service.js';

// Issue 3 fix: detect worker nodes whose Calico or Longhorn CSI is
// degraded and surface the regression via the notifications table.
// In-memory state tracks the previous tick so we only fire once per
// state change instead of every minute.

interface PrevState {
  calicoHealthy: boolean;
  longhornCsiHealthy: boolean;
}

const SUBSYSTEM_INTERVAL_MS = 5 * 60 * 1000; // 5 min — fast enough to catch a join failure
const INITIAL_DELAY_MS = 60_000;

export function startNodeHealthReconciler(db: Database, k8s: K8sClients): { stop: () => void } {
  console.log('[node-health] starting reconciler (5min cadence)');
  const lastState = new Map<string, PrevState>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const reports = await collectNodeSubsystemHealth(k8s);
      const transitions: Array<{ node: string; reason: string; severity: 'error' | 'warning' | 'success' }> = [];

      for (const r of reports) {
        const calicoHealthy = r.calico === 'healthy';
        const longhornCsiHealthy = r.longhornCsi === 'healthy' && r.csiDriverRegistered;
        const prev = lastState.get(r.nodeName);
        if (!prev) {
          // first observation — record state, only fire if degraded
          lastState.set(r.nodeName, { calicoHealthy, longhornCsiHealthy });
          if (!calicoHealthy) {
            transitions.push({ node: r.nodeName, reason: `Calico is ${r.calico} on '${r.nodeName}'${r.calicoMessage ? ` — ${r.calicoMessage}` : ''}`, severity: 'error' });
          }
          if (!longhornCsiHealthy) {
            transitions.push({ node: r.nodeName, reason: `Longhorn CSI is ${r.longhornCsi} on '${r.nodeName}'${r.longhornCsiMessage ? ` — ${r.longhornCsiMessage}` : ''}`, severity: 'error' });
          }
          continue;
        }
        if (prev.calicoHealthy !== calicoHealthy) {
          transitions.push({
            node: r.nodeName,
            reason: calicoHealthy
              ? `Calico recovered on '${r.nodeName}'`
              : `Calico regressed on '${r.nodeName}' — ${r.calicoMessage ?? r.calico}`,
            severity: calicoHealthy ? 'success' : 'error',
          });
        }
        if (prev.longhornCsiHealthy !== longhornCsiHealthy) {
          transitions.push({
            node: r.nodeName,
            reason: longhornCsiHealthy
              ? `Longhorn CSI recovered on '${r.nodeName}'`
              : `Longhorn CSI regressed on '${r.nodeName}' — ${r.longhornCsiMessage ?? r.longhornCsi}`,
            severity: longhornCsiHealthy ? 'success' : 'error',
          });
        }
        lastState.set(r.nodeName, { calicoHealthy, longhornCsiHealthy });
      }

      if (transitions.length > 0) {
        // Dispatched, not inserted. This wrote a row per admin straight into
        // the notifications table with no category, so a node subsystem going
        // unhealthy could never be emailed or pushed — and the panel is
        // exactly what may be unreachable when it happens. The `node`
        // subsystem maps to an Availability category, which never relies on
        // in-app delivery.
        const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
        for (const t of transitions) {
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
