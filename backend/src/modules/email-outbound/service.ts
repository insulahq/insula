/**
 * Outbound email reconciler — Phase 3.B.1 + R6 PR 1.
 *
 * Two halves:
 *   1. Relays: reads smtp_relay_configs and writes a Stalwart TOML
 *      fragment into a ConfigMap in the `mail` namespace (legacy
 *      Phase 3.B.1 path, unchanged here).
 *   2. Send limits: reconciles plan-based per-tenant limits into
 *      Stalwart MtaOutboundThrottle / MtaQueueQuota registry objects
 *      via JMAP (stalwart-throttles.ts). The old [queue.throttle]
 *      TOML rendering was dead config on Stalwart v0.16 (nothing
 *      mounted the ConfigMap and v0.16 doesn't read those keys) and
 *      was removed in R6 PR 1.
 *
 * Called:
 *   - on smtp_relay_configs CRUD (create / update / delete)
 *   - on tenant status change (suspend / unsuspend)
 *   - on tenant rate-limit / outbound-suspension update
 *   - on hosting-plan limit update
 *   - on email-domain enable/disable
 *   - periodically (startup + interval) as a self-heal safety net
 *   - manually via POST /api/v1/admin/mail/outbound/reconcile
 */

import { smtpRelayConfigs } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import { renderQueueOutboundToml, type OutboundRelay } from './renderer.js';
import { reconcileStalwartSendLimits } from './stalwart-throttles.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const MAIL_NAMESPACE = 'mail';
const OUTBOUND_CONFIGMAP_NAME = 'stalwart-outbound-config';

export interface OutboundReconcileLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const noopLogger: OutboundReconcileLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface ReconcileOutboundResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly configMapName?: string;
  readonly relaysConfigured?: number;
  /** Summary of the Stalwart throttle/quota reconcile (R6 PR 1). */
  readonly sendLimits?: import('./stalwart-throttles.js').ThrottleReconcileResult;
}

/**
 * Build the outbound relay TOML from the current DB state.
 */
export async function renderCurrentOutboundConfig(
  db: Database,
): Promise<{ outbound: string }> {
  const encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);

  // Load and decrypt relays
  const relayRows = await db.select().from(smtpRelayConfigs);
  const relays: OutboundRelay[] = relayRows.map((row) => {
    // Decrypt password (auth_password_encrypted) or api_key_encrypted
    let password: string | null = null;
    if (row.authPasswordEncrypted) {
      try {
        password = decrypt(row.authPasswordEncrypted, encryptionKey);
      } catch {
        password = null;
      }
    } else if (row.apiKeyEncrypted) {
      try {
        password = decrypt(row.apiKeyEncrypted, encryptionKey);
      } catch {
        password = null;
      }
    }
    return {
      id: row.id,
      name: row.name,
      providerType: row.providerType,
      isDefault: row.isDefault,
      enabled: row.enabled,
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      authUsername: row.authUsername,
      authPassword: password,
    };
  });

  return { outbound: renderQueueOutboundToml({ relays }) };
}

function k8sStatusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { statusCode?: number }; code?: number };
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.statusCode === 'number') return e.response.statusCode;
  if (typeof e?.code === 'number') return e.code;
  return undefined;
}

/**
 * Write the rendered TOML into a ConfigMap in the `mail` namespace.
 *
 * Operators mount this ConfigMap into the Stalwart pod as an
 * additional config file via a production overlay patch. Stalwart's
 * config include syntax (or a simple concatenation at pod init time)
 * combines it with the base config.
 *
 * For local dev we just write the ConfigMap. The operator-facing
 * integration comes in the production overlay (follow-up).
 */
export async function reconcileOutboundConfig(
  db: Database,
  k8s: K8sClients | undefined,
  logger: OutboundReconcileLogger = noopLogger,
): Promise<ReconcileOutboundResult> {
  // Send limits go over JMAP directly — no k8s client needed, so they
  // reconcile even when the ConfigMap half is skipped below.
  const limits = await reconcileStalwartSendLimits(db, logger);

  if (!k8s) {
    logger.warn({}, 'reconcileOutboundConfig: no k8s client, ConfigMap half skipped');
    return {
      skipped: true,
      reason: 'no k8s client',
      sendLimits: limits,
    };
  }

  const { outbound } = await renderCurrentOutboundConfig(db);
  const combinedToml = `${outbound}\n`;

  const body = {
    metadata: {
      name: OUTBOUND_CONFIGMAP_NAME,
      namespace: MAIL_NAMESPACE,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'stalwart-outbound-config',
        'app.kubernetes.io/managed-by': 'insula',
      },
      annotations: {
        'insula.host/rendered-at': new Date().toISOString(),
      },
    },
    data: {
      'outbound.toml': combinedToml,
    },
  };

  try {
    await k8s.core.createNamespacedConfigMap({
      namespace: MAIL_NAMESPACE,
      body,
    });
  } catch (err) {
    if (k8sStatusCode(err) === 409) {
      await k8s.core.replaceNamespacedConfigMap({
        name: OUTBOUND_CONFIGMAP_NAME,
        namespace: MAIL_NAMESPACE,
        body,
      });
    } else {
      logger.error({ err }, 'reconcileOutboundConfig: ConfigMap write failed');
      throw err;
    }
  }

  // Count enabled relays for the return value
  const relayRows = await db.select().from(smtpRelayConfigs);
  const enabledRelays = relayRows.filter((r) => r.enabled === 1).length;

  logger.info(
    { relays: enabledRelays, sendLimits: limits },
    'reconcileOutboundConfig: Stalwart outbound ConfigMap updated',
  );

  return {
    skipped: false,
    configMapName: OUTBOUND_CONFIGMAP_NAME,
    relaysConfigured: enabledRelays,
    sendLimits: limits,
  };
}
