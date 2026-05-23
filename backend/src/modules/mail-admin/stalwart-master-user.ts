/**
 * Resolve Stalwart's master-user FQDN from the live `mail-secrets`
 * Secret.
 *
 * Why this helper exists
 * ----------------------
 * Both the tenant-bundle orchestrator's mailbox capture path
 * (`tenant-bundles/orchestrator.ts`) and the restore executor
 * (`backup-restore/executors/mailboxes-by-address.ts`) need to pass
 * `--master-user <fqdn>` to the mail-backup-tools image's
 * `imap-sync.py` / `jmap-sync.py` / `imap-restore.py` / etc.
 *
 * Historically both call sites fell back to a hardcoded
 * `MASTER_USER_DEFAULT = 'master@master.local'`. That worked on the
 * unit-test fixture but breaks any real cluster: bootstrap.sh
 * provisions the master user as `master@<PLATFORM_DOMAIN>` — e.g.
 * `master@staging.example.test` — and stores the FQDN in
 * `mail/mail-secrets.STALWART_MASTER_USER`. Without this lookup
 * Stalwart returns `AUTHENTICATIONFAILED` and the bundle Job exits
 * non-zero, failing the entire mailboxes component.
 *
 * Resolution order:
 *
 *   1. `mail/mail-secrets.STALWART_MASTER_USER` (the source of truth —
 *      bootstrap writes this and `scripts/admin/rotate-webmail-master`
 *      maintains it).
 *   2. Cached value from a previous successful read (5 min TTL — picks
 *      up rotation/redeploy without restarting platform-api, but
 *      avoids hammering the k8s API on every capture).
 *   3. The compiled-in default `'master@master.local'` — only used
 *      when neither the Secret nor the cache is available (fresh
 *      install before bootstrap completes, unit-test fixtures, etc).
 *      Reaching this is logged at WARN so operators see the fallback.
 *
 * Read failures (RBAC, network) are best-effort — they log a warning
 * and return the cache (or the default). Refusing to spawn a backup
 * Job because a transient secret-read blip would lose tenants their
 * scheduled backup entirely, which is worse than running with a
 * possibly-stale master FQDN.
 */
import type { CoreV1Api } from '@kubernetes/client-node';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'stalwart-master-user' });

/** Where the secret lives — matches roundcube-db-reconciler constants. */
export const MAIL_SECRET_NAMESPACE = 'mail';
export const MAIL_SECRET_NAME = 'mail-secrets';
export const MASTER_USER_KEY = 'STALWART_MASTER_USER';

/** Compiled-in fallback. Matches the historical default used by both
 * the orchestrator and the restore executor before this helper landed.
 * Only reached when the Secret cannot be read AT ALL — see header. */
export const MASTER_USER_FALLBACK = 'master@master.local';

/** Cache TTL — picks up rotations within 5 min without restart. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  readonly value: string;
  readonly expiresAtMs: number;
}

let cache: CacheEntry | null = null;

/** Test-only — reset the cache between unit tests. */
export function _resetCacheForTests(): void {
  cache = null;
}

export interface ReadStalwartMasterUserDeps {
  /** Override the underlying readNamespacedSecret call (tests). */
  readonly readSecret?: (namespace: string, name: string, key: string) => Promise<string | null>;
  /** Override the clock (tests). */
  readonly nowMs?: () => number;
}

export async function readStalwartMasterUser(
  core: CoreV1Api | null | undefined,
  deps: ReadStalwartMasterUserDeps = {},
): Promise<string> {
  const now = deps.nowMs?.() ?? Date.now();
  if (cache && cache.expiresAtMs > now) {
    return cache.value;
  }

  const reader = deps.readSecret ?? makeDefaultReader(core);
  if (!reader) {
    // No k8s client + no test injection — first-run / test fixture path.
    log.warn(
      { fallback: MASTER_USER_FALLBACK },
      'no k8s client available; falling back to compiled-in default master user',
    );
    return MASTER_USER_FALLBACK;
  }

  try {
    const value = await reader(MAIL_SECRET_NAMESPACE, MAIL_SECRET_NAME, MASTER_USER_KEY);
    if (value && value.trim().length > 0) {
      const trimmed = value.trim();
      cache = { value: trimmed, expiresAtMs: now + CACHE_TTL_MS };
      return trimmed;
    }
    // Secret exists but key is empty — log + fallback.
    log.warn(
      { secret: `${MAIL_SECRET_NAMESPACE}/${MAIL_SECRET_NAME}`, key: MASTER_USER_KEY,
        fallback: MASTER_USER_FALLBACK },
      'mail-secrets missing or empty STALWART_MASTER_USER; falling back to default',
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err),
        cache: cache?.value, fallback: MASTER_USER_FALLBACK },
      'mail-secrets read failed; falling back to cached value or default',
    );
    if (cache) return cache.value; // honour the last good read even past TTL
  }
  return MASTER_USER_FALLBACK;
}

function makeDefaultReader(
  core: CoreV1Api | null | undefined,
): ((namespace: string, name: string, key: string) => Promise<string | null>) | null {
  if (!core) return null;
  return async (namespace, name, key) => {
    const secret = (await core.readNamespacedSecret({
      namespace, name,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0])) as {
      data?: Record<string, string>;
    };
    const b64 = secret.data?.[key];
    if (!b64) return null;
    return Buffer.from(b64, 'base64').toString('utf8');
  };
}
