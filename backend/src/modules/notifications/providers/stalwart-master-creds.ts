/**
 * Resolve the Stalwart master account credentials (user + password)
 * from the live `mail/mail-secrets` Secret.
 *
 * The notification worker uses this when sending via a
 * `stalwart-internal` Provider — the operator-supplied row has NO
 * password because the worker authenticates as the platform master
 * account and lets Stalwart accept the message based on that.
 *
 * Resolution:
 *   - Read `mail/mail-secrets.STALWART_MASTER_USER` and
 *     `mail/mail-secrets.STALWART_MASTER_PASSWORD`.
 *   - Both required; if either is missing/empty the helper returns
 *     null and the worker fails the delivery with a clear lastError.
 *   - 5-min cache (matches the sibling `readStalwartMasterUser`) so
 *     a steady-state cluster doesn't hit the k8s API on every
 *     delivery.
 *   - On read failure (RBAC, network) returns null — the worker
 *     surfaces a failed delivery rather than silently retrying with
 *     stale creds.
 *
 * Why a dedicated module and not extending stalwart-master-user.ts:
 *  - The user-only helper is on a different cache contract (it has a
 *    compiled-in fallback for first-boot / test fixtures because
 *    refusing to spawn a backup Job is worse than running with a
 *    stale default). Notifications need stricter semantics — no
 *    fallback, just fail loudly so the operator knows to fix the
 *    Secret mount.
 */
import type { CoreV1Api } from '@kubernetes/client-node';

// We log via console.warn — matches the existing notifications module
// pattern (see retention/purge.ts). When the worker module wires up
// app.log, we'll switch to that. eslint-disable: console used
// deliberately for cluster-visible warnings.
const log = {
  warn(_meta: Record<string, unknown>, msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[notifications/stalwart-master-creds] ${msg}`, _meta);
  },
};

export const MAIL_SECRET_NAMESPACE = 'mail';
export const MAIL_SECRET_NAME = 'mail-secrets';
export const MASTER_USER_KEY = 'STALWART_MASTER_USER';
export const MASTER_PASSWORD_KEY = 'STALWART_MASTER_PASSWORD';

export const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  readonly value: StalwartMasterCredentials;
  readonly expiresAtMs: number;
}

let cache: CacheEntry | null = null;

export function _resetCacheForTests(): void {
  cache = null;
}

export interface StalwartMasterCredentials {
  readonly user: string;
  readonly password: string;
}

export interface ReadStalwartMasterCredsDeps {
  readonly readSecret?: (namespace: string, name: string, key: string) => Promise<string | null>;
  readonly nowMs?: () => number;
}

/**
 * Returns the user+password pair for the platform master account, or
 * null when either component is unavailable. The worker translates
 * null into a failed delivery with `stalwart_master_credentials_unavailable`.
 */
export async function readStalwartMasterCredentials(
  core: CoreV1Api | null | undefined,
  deps: ReadStalwartMasterCredsDeps = {},
): Promise<StalwartMasterCredentials | null> {
  const now = deps.nowMs?.() ?? Date.now();
  if (cache && cache.expiresAtMs > now) {
    return cache.value;
  }

  const reader = deps.readSecret ?? makeDefaultReader(core);
  if (!reader) {
    return null;
  }

  try {
    const [rawUser, rawPassword] = await Promise.all([
      reader(MAIL_SECRET_NAMESPACE, MAIL_SECRET_NAME, MASTER_USER_KEY),
      reader(MAIL_SECRET_NAMESPACE, MAIL_SECRET_NAME, MASTER_PASSWORD_KEY),
    ]);
    const user = rawUser?.trim();
    const password = rawPassword?.trim();
    if (!user || !password) {
      log.warn(
        { hasUser: Boolean(user), hasPassword: Boolean(password) },
        'mail-secrets missing STALWART_MASTER_USER or STALWART_MASTER_PASSWORD',
      );
      return null;
    }
    const value: StalwartMasterCredentials = { user, password };
    cache = { value, expiresAtMs: now + CACHE_TTL_MS };
    return value;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'mail-secrets read failed; falling back to no credentials',
    );
    return null;
  }
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
