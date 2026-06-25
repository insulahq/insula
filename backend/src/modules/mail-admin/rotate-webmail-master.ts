/**
 * Stalwart 0.16 — Roundcube webmail master password rotation.
 *
 * Wraps `rotateAdminPasswordViaJmap()` so the same JMAP + Secret-patch
 * mechanics are reused for the `master@local.host` Account that
 * Roundcube's jwt_auth plugin uses for IMAP master-user impersonation.
 *
 * Two differences vs the admin rotation:
 *
 *   1. The Secret target is `mail-secrets/STALWART_MASTER_PASSWORD`
 *      (not `stalwart-admin-creds/{adminPassword,...}`). No cross-NS
 *      mirror needed — Roundcube reads the value directly via env var
 *      injection from the same Secret in its own namespace.
 *
 *   2. Roundcube reads `STALWART_MASTER_PASSWORD` at process start
 *      (Apache+PHP-FPM), NOT via volume-mount refresh. After the Secret
 *      is patched the Roundcube Deployment must be rolled so new pods
 *      pick up the value. The Stalwart Deployment is NOT rolled — its
 *      master Account credential lives in the data store and is updated
 *      in-flight by the JMAP x:Account/set call.
 *
 * Failure modes:
 *
 *   - JMAP update succeeded but Secret patch failed → JMAP rotated,
 *     Roundcube still has old password in env. Operator captures
 *     `details.password` from the error envelope and reapplies the
 *     Secret manually. Same shape as the admin rotation handles this.
 *
 *   - Secret patched but rollout-restart failed → next Roundcube rollout
 *     (Flux apply, Reloader event) picks up the new password. NOT a
 *     hard failure — log + return success. The user-visible test is
 *     "log in to webmail with the new password"; if they cannot, they
 *     can `kubectl rollout restart deploy/roundcube -n mail` manually.
 */

import { rotateAdminPasswordViaJmap } from './rotate-jmap.js';
import { MASTER_SENTINEL_DOMAIN, MASTER_USER_KEY } from './stalwart-master-user.js';
import { rotateWebmailMasterPasswordResponseSchema, type RotateWebmailMasterPasswordResponse } from '@insula/api-contracts';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'mail-admin-rotate-webmail-master' });

export interface RotateWebmailMasterOptions {
  readonly kubeconfigPath: string | undefined;
  /** Defaults to `mail`; provided for tests / dev. */
  readonly mailNamespace?: string;
  /** Defaults to `mail-secrets`. */
  readonly secretName?: string;
  /** Defaults to `master`. The master Account in the sentinel Domain. */
  readonly masterUsername?: string;
  /** Defaults to `roundcube`. The Deployment to roll after rotation. */
  readonly roundcubeDeployment?: string;
  /**
   * Stalwart Domain that holds the master principal. Defaults to the
   * fixed `MASTER_SENTINEL_DOMAIN` (`local.host`) — decoupled from the
   * platform mail domain (2026-06-25) so a mail-domain rename never
   * strands the master. Callers normally omit this; it's still accepted
   * (lower-cased) for tests / forced migration of a legacy install.
   *
   * The rotation flow uses this for TWO purposes:
   *   1. Scoped principal lookup — `findAdminPrincipalId` filters
   *      candidates by `domainId === <id of principalDomain>` so a
   *      tenant who provisions `master@<tenant.com>` cannot collide.
   *   2. Auto-reseed target — if the principal is missing (wiped
   *      Stalwart, half-migrated install), the rotation creates it
   *      under this Domain with the new password embedded. No extra
   *      endpoint, no operator click — drift heals automatically.
   */
  readonly principalDomain?: string;
}

export async function rotateWebmailMasterPassword(
  opts: RotateWebmailMasterOptions,
): Promise<RotateWebmailMasterPasswordResponse> {
  const mailNamespace = opts.mailNamespace ?? 'mail';
  const secretName = opts.secretName ?? 'mail-secrets';
  const masterUsername = opts.masterUsername ?? 'master';
  const roundcubeDeployment = opts.roundcubeDeployment ?? 'roundcube';
  const principalDomain = (opts.principalDomain ?? MASTER_SENTINEL_DOMAIN).toLowerCase();
  const masterFqdn = `${masterUsername}@${principalDomain}`;

  const result = await rotateAdminPasswordViaJmap({
    kubeconfigPath: opts.kubeconfigPath,
    stalwartNamespace: mailNamespace,
    secretName,
    username: masterUsername,
    secretKeys: ['STALWART_MASTER_PASSWORD'],
    // Re-stamp the master FQDN in the SAME Secret patch so
    // STALWART_MASTER_USER converges to the principal we (re)seed —
    // historically this key was never written, so it drifted after a
    // mail-domain rename and stranded mailbox backup auth.
    extraStringData: { [MASTER_USER_KEY]: masterFqdn },
    skipJmapSessionVerify: true,
    principalDomain,
    autoReseed: true,
    // Mirrors the DO-NOT-DELETE warning bootstrap.sh stamps on the
    // initial provisioning so a manual `Stalwart cli` user delete still
    // sees the operator hint after auto-reseed.
    principalDescription:
      'Webmail master account (Roundcube + Bulwark JWT impersonation). DO NOT DELETE — recreate via /admin/mail/rotate-webmail-master.',
    // Admin role REQUIRED for IMAP master-auth impersonation. Without
    // this the master Account exists with `roles:User` and Stalwart
    // refuses `tenant@domain%master` IMAP LOGINs with "connection
    // closed by server" — verified on staging 2026-05-28 after a
    // role-less auto-reseed broke every tenant bundle's mailbox
    // capture. Matches `roles:{@type:'Admin'}` shape from bootstrap.sh
    // provision_stalwart_master_user.
    principalRoles: { '@type': 'Admin' },
    // No cross-NS mirror — Roundcube and the master Account share the
    // mail namespace.
  });

  // Roll Roundcube so the new env-var value lands in the running pods.
  // Best-effort: log + continue on failure. The new password is already
  // active in Stalwart + the Secret; operator can manually rollout-
  // restart if this auto-restart fails.
  try {
    await rolloutRestartDeployment({
      kubeconfigPath: opts.kubeconfigPath,
      namespace: mailNamespace,
      name: roundcubeDeployment,
    });
    log.info({ deployment: `${mailNamespace}/${roundcubeDeployment}` }, 'rolled Roundcube to pick up new master password');
  } catch (err) {
    log.warn({
      err: err instanceof Error ? err.message : String(err),
      deployment: `${mailNamespace}/${roundcubeDeployment}`,
    }, 'roundcube rollout-restart failed (non-fatal — operator must restart manually OR wait for next reconcile)');
  }

  return rotateWebmailMasterPasswordResponseSchema.parse(result);
}

/**
 * Patch the Deployment's `kubectl.kubernetes.io/restartedAt` annotation
 * — the same trigger `kubectl rollout restart` uses. Causes the
 * ReplicaSet controller to roll all pods so they re-read the Secret-
 * sourced env var.
 */
async function rolloutRestartDeployment(params: {
  kubeconfigPath: string | undefined;
  namespace: string;
  name: string;
}): Promise<void> {
  const k8s = await import('@kubernetes/client-node');
  const { JSON_PATCH } = await import('../../shared/k8s-patch.js');
  const kc = new k8s.KubeConfig();
  if (params.kubeconfigPath) kc.loadFromFile(params.kubeconfigPath);
  else kc.loadFromCluster();
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const restartedAt = new Date().toISOString();
  const ops = [
    {
      op: 'add' as const,
      path: '/spec/template/metadata/annotations',
      value: { 'kubectl.kubernetes.io/restartedAt': restartedAt },
    },
  ];
  // Use replace if annotations already exist to avoid 422 conflicts.
  // Try add-then-replace: cheaper than a pre-read + branch.
  try {
    await apps.patchNamespacedDeployment(
      { namespace: params.namespace, name: params.name, body: ops as unknown as object },
      JSON_PATCH,
    );
  } catch (err: unknown) {
    // 422 here usually means /spec/template/metadata/annotations already
    // exists. Replace just the restartedAt key instead.
    const replaceOps = [
      {
        op: 'replace' as const,
        path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt',
        value: restartedAt,
      },
    ];
    try {
      await apps.patchNamespacedDeployment(
        { namespace: params.namespace, name: params.name, body: replaceOps as unknown as object },
        JSON_PATCH,
      );
    } catch (replaceErr) {
      // Final fallback: add the key (annotations object exists, key doesn't).
      const addKeyOps = [
        {
          op: 'add' as const,
          path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt',
          value: restartedAt,
        },
      ];
      await apps.patchNamespacedDeployment(
        { namespace: params.namespace, name: params.name, body: addKeyOps as unknown as object },
        JSON_PATCH,
      );
      // Suppress lint about unused replaceErr — it's intentionally
      // swallowed; the original add-error context was already lost.
      void err; void replaceErr;
    }
  }
}
