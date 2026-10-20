/**
 * Node reboot lifecycle — "this node is going down" and "this node is back".
 *
 * Operator request, after a production reboot where the only
 * notifications that arrived were five FALSE OOM alerts (see
 * lib/container-termination.ts). Nothing told the admin the node had rebooted
 * at all, so the real event was invisible and the noise was misleading.
 *
 * TWO SIGNALS, DELIBERATELY DIFFERENT
 * -----------------------------------
 * `startup-complete` keys on the kubelet's **bootID** (`status.nodeInfo.bootID`)
 * — a UUID the kernel regenerates on every boot. A changed bootID is PROOF the
 * machine rebooted; it cannot be faked by a kubelet restart, an API blip or a
 * NotReady flap, all of which would fool a Ready-transition check. This fires
 * reliably on every topology, including a single-node cluster, because by the
 * time we observe it the API server is back up.
 *
 * `shutting-down` keys on the KUBELET saying so: during a graceful node
 * shutdown it holds Ready=False with "node is shutting down" in the message,
 * for the length of its shutdown grace period. It used to key on the node
 * leaving Ready at all, and announced "rebooting" for a server that was being
 * shut down — and for a crash, where nothing was draining anything. Leaving
 * Ready without that message is a node DOWN (fast-down-watch.ts), not a
 * shutdown, and a shutdown is not known to be a reboot until it is back.
 * The notice is only observable by an API server that is still running, so:
 *
 *   multi-node  — fires live, from a surviving node. Mostly from the 30-second
 *                 down-watch: the message lasts one grace period, which a
 *                 5-minute reconciler tick usually misses.
 *   SINGLE-node — usually CANNOT fire. The control plane is on the node that is
 *                 going down. With `shutdownGracePeriodByPodPriority` the API
 *                 pod (priority 10000) is drained ~70s into a 120s budget, so a
 *                 5-minute reconciler tick has roughly a 1-in-10 chance of
 *                 landing in the window where the node is NotReady AND the API
 *                 still answers. Do not pretend otherwise.
 *
 * That asymmetry is why `startup-complete` carries the whole story — it reports
 * the downtime and says explicitly whether the shutdown was ever announced — so
 * a single-node operator still gets one truthful message per reboot rather than
 * silence. See docs/operations/CLUSTER_NETWORK.md.
 */

/** Node facts this detector needs, read straight off the Node object. */
export interface BootFacts {
  readonly nodeName: string;
  /** `status.nodeInfo.bootID`. null when the kubelet has not reported one. */
  readonly bootId: string | null;
  readonly ready: boolean;
  /** `lastTransitionTime` of the Ready condition — the boot moment, in practice. */
  readonly readySince: Date | null;
  /** The kubelet reports a graceful shutdown in progress (kubeletReportsShutdown). */
  readonly shuttingDown: boolean;
}

/**
 * The kubelet's own graceful-shutdown signal: Ready=False whose message carries
 * "node is shutting down" (kubelet nodeshutdown manager, fed into the Ready
 * condition with the other readiness errors). A crash, a power cut or a lost
 * network shows Ready=Unknown "Kubelet stopped posting node status" instead.
 */
export function kubeletReportsShutdown(
  ready: { readonly status?: string; readonly message?: string } | undefined,
): boolean {
  return ready?.status === 'False' && /node is shutting down/i.test(ready.message ?? '');
}

/** What we remember about a node between ticks. */
export interface PrevBootState {
  readonly bootId: string | null;
  readonly ready: boolean;
  /** When the reconciler last successfully observed this node. */
  readonly observedAt: Date | null;
  /** Whether a `shutting-down` notice already went out for the CURRENT boot. */
  readonly rebootAnnounced: boolean;
}

export interface ShuttingDownTransition {
  readonly kind: 'shutting-down';
  readonly nodeName: string;
}

export interface StartupCompleteTransition {
  readonly kind: 'startup-complete';
  readonly nodeName: string;
  /** The new boot's ID — proof this was a real reboot, not a flap. */
  readonly bootId: string;
  /** When the node became Ready on the new boot, if the kubelet reported it. */
  readonly bootedAt: Date | null;
  /**
   * Approximate outage, from the last tick that saw the node to the moment it
   * came back Ready. "Approximate" is load-bearing: the lower bound is the tick
   * interval, so this OVERSTATES by up to one tick and the wording must hedge.
   */
  readonly downtimeMs: number | null;
  /** False when the shutdown was never announced (the single-node case). */
  readonly rebootWasAnnounced: boolean;
}

export type BootTransition = ShuttingDownTransition | StartupCompleteTransition;

/** Render an approximate duration for an operator: "6m 50s", "1h 04m". */
export function formatDowntime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Diff observed node facts against the last tick's state.
 *
 * Pure — unit tested directly. Returns at most one transition per node per
 * tick; a node that rebooted between two ticks yields `startup-complete` only,
 * because the `shutting-down` moment is already in the past and announcing it
 * now would be a lie about the present.
 */
export function detectBootTransitions(
  facts: ReadonlyArray<BootFacts>,
  prevByName: ReadonlyMap<string, PrevBootState>,
  now: Date = new Date(),
): BootTransition[] {
  const out: BootTransition[] = [];

  for (const f of facts) {
    const prev = prevByName.get(f.nodeName);

    // First sighting of a node: record it, never notify. Otherwise a fresh
    // install, a restored database or a newly joined worker would announce a
    // "reboot" that nobody performed.
    if (!prev) continue;

    // ── Back from a reboot ────────────────────────────────────────
    // A CHANGED bootID is the proof. Requires a previous bootID to compare
    // against: if we never recorded one (upgrade from before this column
    // existed), adopt the current value silently rather than claim a reboot.
    const bootChanged =
      f.bootId !== null && prev.bootId !== null && f.bootId !== prev.bootId;

    if (bootChanged && f.ready) {
      // Prefer the kubelet's own Ready transition as the "back up" moment; fall
      // back to now (we have just observed it Ready, so now is an upper bound).
      const backAt = f.readySince ?? now;
      const downtimeMs = prev.observedAt
        ? Math.max(0, backAt.getTime() - prev.observedAt.getTime())
        : null;
      out.push({
        kind: 'startup-complete',
        nodeName: f.nodeName,
        bootId: f.bootId as string,
        bootedAt: f.readySince,
        downtimeMs,
        rebootWasAnnounced: prev.rebootAnnounced,
      });
      continue;
    }

    // ── Shutting down ─────────────────────────────────────────────
    // The kubelet reports a graceful shutdown on the SAME boot. Gating on an
    // unchanged bootID keeps this from firing for a node that already rebooted
    // and is still coming up: that case is the startup path above. A node that
    // just left Ready without that report is down, not shutting down — the
    // down notice covers it.
    const sameBoot = f.bootId === null || prev.bootId === null || f.bootId === prev.bootId;
    if (sameBoot && prev.ready && f.shuttingDown && !prev.rebootAnnounced) {
      out.push({ kind: 'shutting-down', nodeName: f.nodeName });
    }
  }

  return out;
}
