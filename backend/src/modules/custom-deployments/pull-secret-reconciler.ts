// Ensure every stored image-pull credential has its k8s Secret.
//
// WHY THIS EXISTS
// ---------------
// The credential lives in TWO places that can drift apart:
//   1. `custom_deployment_image_credentials` — the row of record, with the
//      envelope-encrypted token.
//   2. `image-pull-<deploymentId>` — a dockerconfigjson Secret in the tenant
//      namespace, which is what the kubelet actually reads.
//
// Only (1) travels in a tenant bundle. `backup-restore` restores DB rows and
// nothing else — `deployments-by-id.ts` says so in its own header — so after a
// restore the credential row is back and the Secret is not. The deployment
// then either sits there with no cluster workload at all, or (once
// re-deployed) hits ImagePullBackOff referencing a Secret that does not exist.
// The same hole opens if a tenant namespace is recreated, or if a Secret is
// deleted by hand.
//
// `deployToCluster()` re-materialises the Secret on every deploy, which covers
// the happy path. This reconciler covers everything that ISN'T a deploy:
// restore, namespace recreation, and drift. It is deliberately a separate,
// idempotent sweep rather than a hook on one code path — a hook only fires
// where someone remembered to add it.
//
// Failure is per-credential and never throws: one tenant with a rotated
// PLATFORM_ENCRYPTION_KEY must not stop the sweep for everyone else. The
// summary is returned so callers can log/surface it.

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { customDeploymentImageCredentials, deployments, tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import {
  k8sPullSecretName,
  loadDecryptedToken,
  materializePullSecret,
} from './pat-store.js';

export interface PullSecretReconcileSummary {
  /** Credential rows examined. */
  readonly examined: number;
  /** Secrets that were missing and have been created. */
  readonly repaired: number;
  /** Secrets already present — no action. */
  readonly alreadyPresent: number;
  /** Rows that could not be repaired, with a redacted reason. */
  readonly failures: readonly { readonly deploymentId: string; readonly reason: string }[];
  /** Rows skipped because the tenant has no namespace yet (not an error). */
  readonly skipped: number;
}

interface CredentialTarget {
  readonly deploymentId: string;
  readonly namespace: string | null;
}

/**
 * Every credential row joined to its tenant's namespace.
 *
 * The join goes credential → deployment → tenant because the credential table
 * has no `tenant_id` of its own (it is a grandchild). This is the same chain
 * the tenant-bundle config component uses to capture the rows, so the two stay
 * consistent by construction.
 */
async function loadTargets(db: Database, tenantId?: string): Promise<CredentialTarget[]> {
  const rows = await db
    .select({
      deploymentId: customDeploymentImageCredentials.deploymentId,
      namespace: tenants.kubernetesNamespace,
      tenantId: deployments.tenantId,
    })
    .from(customDeploymentImageCredentials)
    .innerJoin(deployments, eq(deployments.id, customDeploymentImageCredentials.deploymentId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId));

  return rows
    .filter((r) => (tenantId ? r.tenantId === tenantId : true))
    .map((r) => ({ deploymentId: r.deploymentId, namespace: r.namespace }));
}

/**
 * True when the Secret is absent.
 *
 * A read error that is NOT a 404 is rethrown, so the caller records it as a
 * failure rather than guessing. Treating an API blip as "missing" would rewrite
 * a healthy Secret every hour; treating it as "present" would silently skip a
 * genuinely broken one. Neither is better than saying so.
 */
async function secretMissing(
  k8s: K8sClients,
  namespace: string,
  deploymentId: string,
): Promise<boolean> {
  try {
    await k8s.core.readNamespacedSecret({ name: k8sPullSecretName(deploymentId), namespace });
    return false;
  } catch (err: unknown) {
    if (isNotFound(err)) return true;
    throw err;
  }
}

/**
 * Recreate any missing image-pull Secret from the stored credential rows.
 *
 * Pass `tenantId` to scope the sweep to one tenant — that is what the restore
 * path uses, so restoring one tenant does not walk every credential on the
 * cluster.
 */
export async function reconcilePullSecrets(
  db: Database,
  k8s: K8sClients,
  opts: { readonly tenantId?: string } = {},
): Promise<PullSecretReconcileSummary> {
  const encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY ?? '';
  const targets = await loadTargets(db, opts.tenantId);

  let repaired = 0;
  let alreadyPresent = 0;
  let skipped = 0;
  const failures: { deploymentId: string; reason: string }[] = [];

  for (const target of targets) {
    if (!target.namespace) {
      // `kubernetes_namespace` is NOT NULL, so this is defensive rather than
      // expected — an empty string would mean a half-provisioned tenant. Not a
      // failure either way; the deploy that creates the namespace also creates
      // the Secret.
      skipped += 1;
      continue;
    }
    try {
      if (!(await secretMissing(k8s, target.namespace, target.deploymentId))) {
        alreadyPresent += 1;
        continue;
      }
      if (!encryptionKey) {
        // Distinct from a decrypt failure: nothing is wrong with the row, the
        // platform just cannot read it right now. Say which it is.
        failures.push({
          deploymentId: target.deploymentId,
          reason: 'PLATFORM_ENCRYPTION_KEY is not set; cannot rebuild the pull Secret',
        });
        continue;
      }
      const decrypted = await loadDecryptedToken(db, target.deploymentId, encryptionKey);
      if (!decrypted) {
        failures.push({
          deploymentId: target.deploymentId,
          reason: 'stored credential could not be decrypted (key rotated?) — re-enter the PAT',
        });
        continue;
      }
      await materializePullSecret(k8s, target.namespace, target.deploymentId, decrypted);
      repaired += 1;
    } catch (err: unknown) {
      // NEVER interpolate the credential here. `loadDecryptedToken` returns
      // cleartext and an error thrown downstream of it could carry it; only
      // the message is kept, and pat-store's own errors are already redacted.
      failures.push({
        deploymentId: target.deploymentId,
        reason: err instanceof Error ? err.message.slice(0, 300) : 'unknown error',
      });
    }
  }

  return { examined: targets.length, repaired, alreadyPresent, failures, skipped };
}
