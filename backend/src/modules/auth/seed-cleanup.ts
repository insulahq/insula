/**
 * Admin seed Secret cleanup — one-shot delete after first-real-password-change.
 *
 * The `platform-admin-seed` Secret in `platform` namespace carries the
 * bootstrap-time admin password (`ADMIN_PASSWORD`). It's the credential
 * the operator sees in the bootstrap log + the secrets bundle, and the
 * value the seed re-runs INSERT-on-conflict with on every platform-api
 * boot. Once the admin has logged in and rotated the password through
 * the UI, the Secret's value is permanently out of sync with
 * `users.password_hash`. Keeping it around creates a silent trap:
 *
 *   - secrets bundle still ships it ("look like" a valid credential)
 *   - operators inspecting the Secret value during incident response
 *     get a password that won't work
 *   - if the user row is ever recreated from seed (DB cold-restore
 *     without the user's reset hash), the Secret's password would
 *     suddenly work again — surprising on a security review.
 *
 * The break-glass path is `scripts/admin-password-reset.sh` which
 * runs bcrypt INSIDE the platform-api pod over kubectl exec, so
 * keeping the stale Secret around buys nothing operational. We
 * delete it on the first successful PATCH /auth/password and let
 * the bundle script observe the absence as "post-first-login state".
 *
 * Implementation notes:
 *   - Best-effort only: a 404 (already deleted, or never existed
 *     because operator pre-deleted it manually) is treated as
 *     success — the password change itself has already committed
 *     to the DB.
 *   - In-cluster kubeconfig is the only mode supported. Tests
 *     inject a stub via deps.
 *   - The deletion is fire-and-forget from the caller's POV: any
 *     non-404 K8s API error is logged at WARN and swallowed so a
 *     transient apiserver hiccup doesn't bounce a successful
 *     password change back to a confusing 5xx.
 */

import * as k8s from '@kubernetes/client-node';
import { isNotFound } from '../../shared/k8s-errors.js';

export const BOOTSTRAP_SEED_NAMESPACE = 'platform';
export const BOOTSTRAP_SEED_NAME = 'platform-admin-seed';

export interface SeedCleanupDeps {
  /**
   * Delete a namespaced Secret. Stubbable for tests. Default impl
   * uses CoreV1Api against the in-cluster ServiceAccount token
   * (the same path k8s-provisioner / ingress-reconciler use).
   */
  readonly deleteSecret: (namespace: string, name: string) => Promise<void>;
}

export type SeedCleanupResult =
  | { readonly cleared: true; readonly reason: 'deleted' }
  | { readonly cleared: false; readonly reason: 'not_found' | 'error'; readonly error?: string };

function defaultDeps(): SeedCleanupDeps {
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  return {
    deleteSecret: async (namespace, name) => {
      await core.deleteNamespacedSecret({ namespace, name });
    },
  };
}

/**
 * Delete the bootstrap admin-seed Secret. Idempotent: 404 → cleared=false
 * with reason='not_found' (treated as already-clean by callers).
 *
 * Any other error returns cleared=false with reason='error' and the
 * message string — callers should log this but NOT abort their own
 * transaction (the password change already committed to the DB).
 */
export async function deleteAdminSeedSecret(
  deps: SeedCleanupDeps = defaultDeps(),
): Promise<SeedCleanupResult> {
  try {
    await deps.deleteSecret(BOOTSTRAP_SEED_NAMESPACE, BOOTSTRAP_SEED_NAME);
    return { cleared: true, reason: 'deleted' };
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return { cleared: false, reason: 'not_found' };
    }
    return {
      cleared: false,
      reason: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
