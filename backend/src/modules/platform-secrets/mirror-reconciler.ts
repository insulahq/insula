import * as k8s from '@kubernetes/client-node';

/**
 * platform-secrets mirror drift-guard.
 *
 * `platform-secrets` lives in the `platform` namespace (source of truth,
 * created by bootstrap) but the sftp-gateway runs in `platform-system` and
 * k8s does not allow cross-namespace secret references — so bootstrap MIRRORS
 * the secret into `platform-system`. That mirror was historically a ONE-TIME
 * copy ("skip if exists"), so any later rotation of the `platform` copy left
 * the `platform-system` copy stale. When `internal-secret` drifts, the
 * gateway's `X-Internal-Auth` header no longer matches platform-api's
 * `PLATFORM_INTERNAL_SECRET` and EVERY SFTP auth callback 403s — SFTP breaks
 * silently for all tenants (observed on the DEV cluster 2026-07-02, drifted
 * since the 2026-06-22 rebuild; nothing exercised SFTP so it went unnoticed).
 *
 * This reconciler re-asserts the mirror on boot: it copies the source keys the
 * `platform-system` consumers need into the mirror whenever they drift. It is
 * the same detect-and-re-assert shape as the mail-master credential auto-heal.
 * Paired with the `secret.reloader.stakater.com/reload: platform-secrets`
 * annotation on the sftp-gateway Deployment, a heal here auto-restarts the
 * gateway so it loads the corrected value — no manual intervention.
 */

const SECRET_NAME = 'platform-secrets';
const SOURCE_NS = 'platform';
const MIRROR_NS = 'platform-system';

/**
 * Keys the `platform-system` consumers must keep identical to the `platform`
 * source. `internal-secret` gates the sftp-gateway↔platform-api auth callback;
 * `platform-encryption-key` decrypts mailbox credentials in the gateway.
 */
export const MIRRORED_KEYS = ['internal-secret', 'platform-encryption-key'] as const;

export interface MirrorLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export type MirrorStatus = 'in-sync' | 'healed' | 'skipped' | 'failed';

export interface MirrorResult {
  readonly status: MirrorStatus;
  /** Names (never values) of the keys that were out of sync. */
  readonly driftedKeys: readonly string[];
  readonly detail?: string;
}

async function readSecret(
  core: k8s.CoreV1Api,
  namespace: string,
): Promise<k8s.V1Secret | null> {
  try {
    return await core.readNamespacedSecret({ name: SECRET_NAME, namespace });
  } catch {
    // Missing / unreadable (fresh or partially-provisioned cluster, or a
    // transient API error). Treat as "nothing to reconcile" — never block boot.
    return null;
  }
}

/**
 * Ensure `platform-system/platform-secrets` mirrors the `platform` source for
 * {@link MIRRORED_KEYS}. Best-effort, idempotent, never throws.
 *
 * - `in-sync`  — mirror already matches (no write)
 * - `healed`   — drift detected + mirror patched to match
 * - `skipped`  — source or mirror secret absent (nothing to do)
 * - `failed`   — the patch call errored (logged; boot continues)
 */
export async function reconcilePlatformSecretsMirror(
  core: k8s.CoreV1Api,
  log?: MirrorLogger,
): Promise<MirrorResult> {
  const source = await readSecret(core, SOURCE_NS);
  if (!source) {
    return { status: 'skipped', driftedKeys: [], detail: `source ${SOURCE_NS}/${SECRET_NAME} unreadable` };
  }
  const mirror = await readSecret(core, MIRROR_NS);
  if (!mirror) {
    // Bootstrap seeds the mirror; don't create it here (avoid racing bootstrap
    // or masking a deeper provisioning gap).
    return { status: 'skipped', driftedKeys: [], detail: `mirror ${MIRROR_NS}/${SECRET_NAME} unreadable` };
  }

  const srcData = source.data ?? {};
  const mirData = mirror.data ?? {};

  // Compare base64 values directly (never decode → never log a secret value).
  const driftedKeys = MIRRORED_KEYS.filter(
    (key) => srcData[key] != null && srcData[key] !== mirData[key],
  );

  if (driftedKeys.length === 0) {
    return { status: 'in-sync', driftedKeys: [] };
  }

  // Preserve every existing mirror key; overlay only the drifted ones with the
  // source's base64 value (no re-encode).
  const newData: Record<string, string> = { ...mirData };
  for (const key of driftedKeys) newData[key] = srcData[key]!;

  const body: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: SECRET_NAME, namespace: MIRROR_NS },
    type: mirror.type ?? 'Opaque',
    data: newData,
  };

  try {
    await core.replaceNamespacedSecret({ name: SECRET_NAME, namespace: MIRROR_NS, body });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.warn?.({ driftedKeys }, `platform-secrets mirror: FAILED to heal ${MIRROR_NS}/${SECRET_NAME} drift: ${detail}`);
    return { status: 'failed', driftedKeys, detail };
  }

  log?.warn?.(
    { driftedKeys },
    `platform-secrets mirror: healed ${MIRROR_NS}/${SECRET_NAME} drift vs ${SOURCE_NS} (Reloader restarts consumers to load it)`,
  );
  return { status: 'healed', driftedKeys };
}
