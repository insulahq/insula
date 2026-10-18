/**
 * Is this Longhorn replica a usable copy of its volume's data?
 *
 * While a volume is attached, only a `running` replica serves it — a stopped
 * or errored one is out of the engine (failed, or still rebuilding). A
 * DETACHED volume has no engine, so every replica is `stopped` by design; its
 * copies are the replicas that have not failed (`spec.failedAt` empty).
 * Counting only `running` replicas made every detached volume read as having
 * no healthy copy at all, so a retained 3-replica volume nothing mounts
 * flagged "last replica" on every node that held a copy and blocked the drain
 * there.
 */
export interface ReplicaCopyFacts {
  readonly spec?: { readonly failedAt?: string };
  readonly status?: { readonly currentState?: string };
}

/** Pure. `volumeState` is the Longhorn Volume's `status.state` (`attached`, `detached`, …). */
export function isUsableCopy(replica: ReplicaCopyFacts, volumeState: string | undefined): boolean {
  if (replica.status?.currentState === 'running') return true;
  return volumeState === 'detached' && !replica.spec?.failedAt;
}
