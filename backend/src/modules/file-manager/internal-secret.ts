import { createHmac } from 'node:crypto';

/**
 * Per-tenant secret for the file-manager hidden-path bypass
 * (the `X-Platform-Internal` header).
 *
 * Historically the raw global `PLATFORM_INTERNAL_SECRET` was injected verbatim
 * into EVERY tenant file-manager pod — and the same value also gates the
 * platform-api internal SFTP endpoints. A tenant who read it out of their own
 * (root, per-tenant) file-manager pod could therefore authenticate to those
 * internal endpoints and act across tenants. (F5)
 *
 * We now derive a distinct value per namespace: it is an HMAC of the master
 * secret over the namespace, so the backend can recompute it on demand without
 * persisting per-tenant secrets, while a leak only affects the tenant's own
 * file-manager (which they already fully control) and never equals the global
 * secret used elsewhere.
 */
export function deriveFmSecret(masterSecret: string, namespace: string): string {
  return createHmac('sha256', masterSecret).update(`fm:${namespace}`).digest('base64url');
}
