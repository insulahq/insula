/**
 * Stalwart 0.16 JMAP-backed admin password rotation.
 *
 * Stalwart 0.16 supports in-flight password rotation via JMAP
 * Principal/set — no pod restart needed. The new password takes effect
 * immediately on the Stalwart side.
 *
 * Steps:
 *   1. Generate a fresh random password.
 *   2. Locate the admin principal via JMAP Principal/get (name='admin').
 *   3. Update via JMAP Principal/set patch { 'secrets/0': newPassword }.
 *   4. Patch the `stalwart-admin-creds` k8s Secret so the volume-mounted
 *      file that platform-api reads is updated; kubelet refreshes it
 *      within ~60s, no platform-api restart required.
 *   5. Verify the new credentials by calling JMAP session (GET /jmap/session)
 *      with the new password. Retry until success or timeout.
 *
 * On failure after step 3 (JMAP updated but k8s Secret patch failed):
 *   - Stalwart already accepts the new password.
 *   - The k8s Secret still holds the old value; platform-api will fail
 *     to authenticate to Stalwart until the operator manually patches
 *     the secret or re-runs rotation.
 *   - The error message makes this explicit.
 */

import { randomBytes } from 'node:crypto';
import {
  getJmapSession,
  principalGet,
  updatePrincipal,
  type JmapAccountId,
} from '../stalwart-jmap/client.js';
import { rotateStalwartPasswordResponseSchema, type RotateStalwartPasswordResponse } from '@k8s-hosting/api-contracts';

export interface RotateJmapOptions {
  readonly kubeconfigPath: string | undefined;
  readonly stalwartNamespace: string;
  readonly secretName: string;
  readonly username: string;
  /** Timeout for credential verification in ms. Default: 30s. */
  readonly verifyTimeoutMs?: number;
}

export async function rotateAdminPasswordViaJmap(
  opts: RotateJmapOptions,
): Promise<RotateStalwartPasswordResponse> {
  return rotateAdminPasswordViaJmapImpl(opts, defaultDeps(opts.kubeconfigPath));
}

// ── Dependency injection seam ─────────────────────────────────────────────────

export interface RotateJmapDeps {
  generatePassword(): string;
  getJmapAccountId(env?: NodeJS.ProcessEnv): Promise<JmapAccountId>;
  findAdminPrincipalId(accountId: JmapAccountId, username: string): Promise<string | null>;
  updateAdminPassword(accountId: JmapAccountId, principalId: string, newPassword: string): Promise<void>;
  patchK8sSecret(req: { namespace: string; name: string; stringData: Record<string, string> }): Promise<void>;
  verifyNewPassword(password: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export async function rotateAdminPasswordViaJmapImpl(
  opts: RotateJmapOptions,
  deps: RotateJmapDeps,
): Promise<RotateStalwartPasswordResponse> {
  const plain = deps.generatePassword();
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 30_000;

  // 1. Resolve JMAP account ID
  const accountId = await deps.getJmapAccountId();

  // 2. Find admin principal ID
  const principalId = await deps.findAdminPrincipalId(accountId, opts.username);
  if (!principalId) {
    throw new Error(
      `JMAP: admin principal '${opts.username}' not found in Stalwart — cannot rotate password.`,
    );
  }

  // 3. Update Stalwart's admin secret via JMAP (in-flight, no restart)
  await deps.updateAdminPassword(accountId, principalId, plain);

  // 4. Patch the k8s Secret mirror so platform-api picks up the new
  //    cleartext via volume-mount refresh (~60s, no restart needed).
  try {
    await deps.patchK8sSecret({
      namespace: opts.stalwartNamespace,
      name: opts.secretName,
      stringData: {
        adminPassword: plain,
        ADMIN_SECRET_PLAIN: plain,
      },
    });
  } catch (err) {
    // Stalwart already has the new password. Alert the operator that the
    // k8s Secret mirror is stale but don't fail the rotation response —
    // the new password IS active and should be shown to the operator.
    throw new Error(
      `JMAP rotation succeeded but k8s Secret patch failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Stalwart now uses the new password. Manually patch secret '${opts.stalwartNamespace}/${opts.secretName}' ` +
        `with the new password, or platform-api will fail to authenticate after its volume refresh.`,
    );
  }

  // 5. Verify new credentials work
  const deadline = deps.now().getTime() + verifyTimeoutMs;
  let ok = false;
  while (deps.now().getTime() < deadline) {
    ok = await deps.verifyNewPassword(plain);
    if (ok) break;
    await deps.sleep(2_000);
  }
  if (!ok) {
    throw new Error(
      'JMAP rotation and k8s Secret patch succeeded but credential verification timed out. ' +
        'The new password is active — verify manually that Stalwart is healthy.',
    );
  }

  return rotateStalwartPasswordResponseSchema.parse({
    username: opts.username,
    password: plain,
    rotatedAt: deps.now().toISOString(),
  });
}

// ── Default production implementations ───────────────────────────────────────

/**
 * Build real deps for the production code path.
 *
 * `@kubernetes/client-node` is loaded lazily (dynamic import inside
 * `patchK8sSecret`) so the module-level import of rotate-jmap.ts does NOT
 * pull in the heavy k8s package. This keeps the test worker from OOM-ing when
 * the test only exercises `rotateAdminPasswordViaJmapImpl` with injected deps.
 */
function defaultDeps(kubeconfigPath: string | undefined): RotateJmapDeps {
  const baseUrl = process.env.STALWART_MGMT_URL ?? 'http://stalwart-mail-mgmt.mail.svc.cluster.local:8080';

  return {
    generatePassword: () =>
      randomBytes(32).toString('base64url').replace(/=+$/, ''),

    async getJmapAccountId(env = process.env): Promise<JmapAccountId> {
      const session = await getJmapSession(baseUrl, env);
      const id = session.primaryAccounts['urn:ietf:params:jmap:principals'];
      if (!id) throw new Error('JMAP session has no principals account');
      return id;
    },

    async findAdminPrincipalId(accountId: JmapAccountId, username: string): Promise<string | null> {
      const result = await principalGet({
        accountId,
        ids: null,
        properties: ['id', 'name', 'type'],
        baseUrl,
      });
      const admin = result.list.find(
        (p) => p.type === 'individual' && p.name === username,
      );
      return admin?.id ?? null;
    },

    async updateAdminPassword(accountId: JmapAccountId, principalId: string, newPassword: string): Promise<void> {
      await updatePrincipal({
        accountId,
        id: principalId,
        patch: { 'secrets/0': newPassword },
        baseUrl,
      });
    },

    async patchK8sSecret({ namespace, name, stringData }) {
      // Lazy-load @kubernetes/client-node so this file doesn't pull in the
      // heavy k8s bundle at import time (avoids OOM in test workers).
      const k8s = await import('@kubernetes/client-node');
      const kc = new k8s.KubeConfig();
      if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
      else kc.loadFromCluster();
      const core = kc.makeApiClient(k8s.CoreV1Api);

      const ops = Object.entries(stringData).map(([k, v]) => ({
        op: 'replace' as const,
        path: `/data/${k}`,
        value: Buffer.from(v, 'utf8').toString('base64'),
      }));
      await core.patchNamespacedSecret({ namespace, name, body: ops as unknown as object });
    },

    async verifyNewPassword(password: string): Promise<boolean> {
      const username = process.env.STALWART_ADMIN_USER?.trim() || 'admin';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const res = await fetch(`${baseUrl}/jmap/session`, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        return res.ok;
      } catch {
        return false;
      }
    },

    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}
