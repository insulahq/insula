import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * In-place Longhorn snapshot-revert primitive.
 *
 * Reverting the EXISTING volume to one of its snapshots (replicas stay
 * healthy, no clone) is the supported way to restore a Longhorn volume.
 * The alternative — provisioning a NEW PVC from a `type=snap`
 * VolumeSnapshot via `spec.dataSource` — copies the data but then sticks
 * the new volume in `copy-completed-awaiting-healthy` while detached and
 * never reliably becomes attachable, so it's unusable for a destructive
 * restore. This module replaces that path.
 *
 * The mechanics here were first proven on the system-PVC restore path
 * (system-snapshots/service.ts). They're extracted so BOTH the system
 * path and the tenant path share one implementation. The caller is
 * responsible for scaling consumers to 0 BEFORE calling
 * {@link revertVolumeToSnapshot} and scaling back up after — this module
 * only drives the Longhorn side (wait-detach → maintenance-attach →
 * snapshotRevert → detach-maintenance).
 */

export const LH_GROUP = 'longhorn.io';
export const LH_VERSION = 'v1beta2';
export const LH_NS = 'longhorn-system';

/** longhorn-manager REST API. Override via LONGHORN_API_BASE for tests/dev. */
export const DEFAULT_LONGHORN_API_BASE = 'http://longhorn-backend.longhorn-system:9500';

export interface RevertStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** Thrown with a numeric `.code` (HTTP-ish) and the partial `.steps` trace so
 *  callers can surface which step failed. */
export class RevertError extends Error {
  readonly code: number;
  readonly steps: ReadonlyArray<RevertStep>;
  constructor(message: string, code: number, steps: ReadonlyArray<RevertStep>) {
    super(message);
    this.name = 'RevertError';
    this.code = code;
    this.steps = steps;
  }
}

export interface RevertCoreOpts {
  readonly apiBase?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  /** Wait for the volume to detach after consumers scaled to 0. Longhorn
   *  delays the detach handshake until any in-flight rebuild/upgrade
   *  finishes, so this defaults generously. */
  readonly detachTimeoutMs?: number;
  /** Per-REST-call timeout + the maintenance-attached wait window. */
  readonly revertTimeoutMs?: number;
  /** Progress sink — fed a short human string per phase. */
  readonly onStep?: (step: RevertStep) => Promise<void> | void;
}

type CustomGet = {
  getNamespacedCustomObject: (a: {
    group: string; version: string; namespace: string; plural: string; name: string;
  }) => Promise<unknown>;
};

async function lhGet<T>(k8s: K8sClients, plural: string, name: string): Promise<T> {
  return (k8s.custom as unknown as CustomGet).getNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural, name,
  }) as Promise<T>;
}

/**
 * Poll the Longhorn Volume CR until it reaches the expected condition.
 *
 * For `detached` we accept EITHER state=detached OR "no csi-attacher
 * ticket": Longhorn's snapshot-controller holds VolumeAttachment tickets
 * for pending snapshot work, which keeps `state` reading "attached" even
 * after the consumer pod releases the volume. What matters for
 * snapshotRevert is that no consumer pod is mounting the frontend — but
 * we ALSO require the engine to actually be detached (state=detached) so
 * the revert doesn't race a mid-`detaching` engine teardown (Longhorn
 * returns HTTP 500 "failed to revert snapshot" in that window).
 *
 * For `attached` we require state=attached AND a csi ticket present (the
 * consumer pod has rebound).
 */
export async function pollVolumeState(
  k8s: K8sClients,
  volumeName: string,
  expected: 'detached' | 'attached',
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly state: string | undefined }> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    try {
      const [v, va] = await Promise.all([
        lhGet<{ status?: { state?: string } }>(k8s, 'volumes', volumeName),
        lhGet<{ spec?: { attachmentTickets?: Record<string, { type?: string }> } }>(k8s, 'volumeattachments', volumeName)
          .catch(() => ({ spec: { attachmentTickets: {} as Record<string, { type?: string }> } })),
      ]);
      last = v.status?.state;
      const tickets = va.spec?.attachmentTickets ?? {};
      const hasCsi = Object.values(tickets).some((t) => t.type === 'csi-attacher');
      if (expected === 'detached' && last === 'detached' && !hasCsi) return { ok: true, state: last };
      if (expected === 'attached' && last === 'attached' && hasCsi) return { ok: true, state: last };
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { ok: false, state: last };
}

/**
 * Pre-flight checks that must pass BEFORE the caller scales consumers to
 * zero — so we don't bounce a workload only to fail mid-flight:
 *   - the snapshot exists (404)
 *   - it belongs to `volumeName` (409)
 *   - it's `readyToUse` (poll up to 30s, else 409)
 *   - the volume is not `faulted` (409) — a faulted volume has no healthy
 *     replica to serve the revert. `degraded` is fine.
 */
export async function assertSnapshotRevertable(
  k8s: K8sClients,
  volumeName: string,
  snapshotName: string,
  opts: { readonly readinessTimeoutMs?: number } = {},
): Promise<void> {
  type SnapShape = { spec?: { volume?: string }; status?: { readyToUse?: boolean } };
  let snap: SnapShape;
  try {
    snap = await lhGet<SnapShape>(k8s, 'snapshots', snapshotName);
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) throw new RevertError(`Snapshot '${snapshotName}' not found`, 404, []);
    throw err;
  }
  if (snap?.spec?.volume !== volumeName) {
    throw new RevertError(`Snapshot '${snapshotName}' does not belong to volume '${volumeName}'`, 409, []);
  }

  const readyDeadline = Date.now() + (opts.readinessTimeoutMs ?? 30_000);
  while (Date.now() < readyDeadline) {
    if (snap.status?.readyToUse === true) break;
    await new Promise((r) => setTimeout(r, 2_000));
    try { snap = await lhGet<SnapShape>(k8s, 'snapshots', snapshotName); } catch { /* keep polling */ }
  }
  if (snap.status?.readyToUse !== true) {
    throw new RevertError(`Snapshot '${snapshotName}' is not ready to use`, 409, []);
  }

  try {
    const v = await lhGet<{ status?: { robustness?: string } }>(k8s, 'volumes', volumeName);
    if (v.status?.robustness === 'faulted') {
      throw new RevertError(`Volume '${volumeName}' is faulted — restore refused. Recover it in the Longhorn UI before retrying.`, 409, []);
    }
  } catch (err) {
    if (err instanceof RevertError) throw err;
    /* non-fatal: continue if we can't read the volume */
  }
}

/**
 * Drive the Longhorn side of an in-place revert. Caller MUST have already
 * scaled every consumer of the volume to 0 (the volume is detaching).
 *
 *   1. wait for the volume to fully detach
 *   2. maintenance-attach (engine up, frontend disabled — block device not
 *      exposed to any pod) to a node holding a replica
 *   3. wait for state=attached AND frontendDisabled
 *   4. POST /v1/volumes/<vol>?action=snapshotRevert {name}
 *   5. detach so the consumer's CSI attach can rebind cleanly
 *
 * Returns the step trace. Throws {@link RevertError} (with the partial
 * trace) on any failure.
 */
export async function revertVolumeToSnapshot(
  k8s: K8sClients,
  volumeName: string,
  snapshotName: string,
  opts: RevertCoreOpts = {},
): Promise<ReadonlyArray<RevertStep>> {
  const apiBase = (opts.apiBase ?? process.env.LONGHORN_API_BASE ?? DEFAULT_LONGHORN_API_BASE).replace(/\/$/, '');
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const detachTimeoutMs = opts.detachTimeoutMs ?? 300_000;
  const revertTimeoutMs = opts.revertTimeoutMs ?? 60_000;
  const steps: RevertStep[] = [];
  const record = async (step: RevertStep): Promise<void> => {
    steps.push(step);
    if (opts.onStep) await opts.onStep(step);
  };
  const fail = (message: string, code: number): never => {
    throw new RevertError(message, code, steps);
  };

  const detach = await pollVolumeState(k8s, volumeName, 'detached', detachTimeoutMs);
  await record({ step: 'wait-detach', ok: detach.ok, detail: `final=${detach.state ?? 'unknown'}` });
  if (!detach.ok) fail(`Volume did not detach within ${Math.round(detachTimeoutMs / 1000)}s (last=${detach.state ?? 'unknown'})`, 504);

  // Pick a node that already holds a replica (ownerID) to minimise rebuild.
  const volForAttach = await lhGet<{ status?: { ownerID?: string } }>(k8s, 'volumes', volumeName);
  const targetNode = volForAttach.status?.ownerID;
  if (!targetNode) fail('Cannot determine a node to attach the volume on for revert', 409);

  const attachUrl = `${apiBase}/v1/volumes/${encodeURIComponent(volumeName)}?action=attach`;
  const attachResp = await fetchFn(attachUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId: targetNode, disableFrontend: true, attachedBy: 'platform-snapshot-revert' }),
    signal: AbortSignal.timeout(revertTimeoutMs),
  });
  if (!attachResp.ok) {
    const body = await attachResp.text().catch(() => '<no body>');
    fail(`Longhorn maintenance-attach failed: HTTP ${attachResp.status} ${body.slice(0, 240)}`, 502);
  }
  await record({ step: 'attach-maintenance', ok: true, detail: `node=${targetNode}` });

  // From here on the volume is attached in maintenance mode. ANY failure
  // before we detach would leave it `attached+frontendDisabled`, which the
  // consumer pod can't remount when the caller scales back up — so the
  // wait-maintenance + revert run inside a try whose catch always attempts a
  // best-effort detach before rethrowing.
  const detachUrl = `${apiBase}/v1/volumes/${encodeURIComponent(volumeName)}?action=detach`;
  const detachFromMaintenance = (): Promise<boolean> => fetchFn(detachUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(revertTimeoutMs),
  }).then((r) => r.ok).catch(() => false);

  try {
    // Wait for the engine to come up with the frontend disabled.
    const maintDeadline = Date.now() + revertTimeoutMs;
    let maintReady = false;
    while (Date.now() < maintDeadline) {
      try {
        const v = await lhGet<{ status?: { state?: string; frontendDisabled?: boolean } }>(k8s, 'volumes', volumeName);
        if (v.status?.state === 'attached' && v.status?.frontendDisabled === true) { maintReady = true; break; }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!maintReady) fail('Volume did not enter maintenance-attached state in time', 504);
    await record({ step: 'wait-maintenance', ok: true });

    const revertUrl = `${apiBase}/v1/volumes/${encodeURIComponent(volumeName)}?action=snapshotRevert`;
    const revertResp = await fetchFn(revertUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: snapshotName }),
      signal: AbortSignal.timeout(revertTimeoutMs),
    });
    if (!revertResp.ok) {
      const body = await revertResp.text().catch(() => '<no body>');
      fail(`Longhorn snapshotRevert failed: HTTP ${revertResp.status} ${body.slice(0, 240)}`, 502);
    }
    await record({ step: 'longhorn-revert', ok: true });
  } catch (err) {
    const ok = await detachFromMaintenance();
    await record({ step: 'detach-maintenance', ok, detail: 'after-failure' });
    throw err;
  }

  // Normal-path detach so the consumer's CSI attach rebinds cleanly.
  const detachOk = await detachFromMaintenance();
  await record({ step: 'detach-maintenance', ok: detachOk });

  return steps;
}

/**
 * Resolve a CSI VolumeSnapshot to the underlying Longhorn volume +
 * snapshot name. Longhorn encodes a `type=snap` snapshot as
 * `snap://<volume-name>/<snapshot-name>` in the VolumeSnapshotContent's
 * `status.snapshotHandle` (verified live on Longhorn v1.11). The
 * `<snapshot-name>` is the `snapshots.longhorn.io` CR name that
 * {@link revertVolumeToSnapshot} reverts to.
 */
export async function resolveLonghornSnapshotFromCsi(
  k8s: K8sClients,
  namespace: string,
  volumeSnapshotName: string,
): Promise<{ readonly volumeName: string; readonly snapshotName: string }> {
  const vs = await (k8s.custom as unknown as {
    getNamespacedCustomObject: (a: {
      group: string; version: string; namespace: string; plural: string; name: string;
    }) => Promise<{ status?: { boundVolumeSnapshotContentName?: string; readyToUse?: boolean } }>;
  }).getNamespacedCustomObject({
    group: 'snapshot.storage.k8s.io', version: 'v1',
    namespace, plural: 'volumesnapshots', name: volumeSnapshotName,
  }).catch((err: unknown) => {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) throw new RevertError(`VolumeSnapshot '${volumeSnapshotName}' not found`, 404, []);
    throw err;
  });

  const contentName = vs.status?.boundVolumeSnapshotContentName;
  if (!contentName) throw new RevertError(`VolumeSnapshot '${volumeSnapshotName}' has no bound content yet`, 409, []);

  const content = await (k8s.custom as unknown as {
    getClusterCustomObject: (a: { group: string; version: string; plural: string; name: string }) => Promise<{ status?: { snapshotHandle?: string } }>;
  }).getClusterCustomObject({
    group: 'snapshot.storage.k8s.io', version: 'v1',
    plural: 'volumesnapshotcontents', name: contentName,
  });

  const handle = content.status?.snapshotHandle;
  if (!handle) throw new RevertError(`VolumeSnapshotContent '${contentName}' has no snapshotHandle yet`, 409, []);
  return parseSnapshotHandle(handle);
}

/** Parse a Longhorn CSI snapshotHandle (`snap://<volume>/<snapshot>`). */
export function parseSnapshotHandle(handle: string): { readonly volumeName: string; readonly snapshotName: string } {
  const stripped = handle.startsWith('snap://') ? handle.slice('snap://'.length) : handle;
  const slash = stripped.indexOf('/');
  if (slash <= 0 || slash >= stripped.length - 1) {
    throw new RevertError(`Unrecognised Longhorn snapshotHandle '${handle}' — expected snap://<volume>/<snapshot>`, 422, []);
  }
  return { volumeName: stripped.slice(0, slash), snapshotName: stripped.slice(slash + 1) };
}
