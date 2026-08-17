/**
 * Startup wiring for the platform's ACME DNS-01 solver webhook.
 *
 * Opt-in by presence, not by flag: the webhook starts when its serving
 * certificate is mounted (the k8s/base/acme-webhook overlay does that)
 * and stays quiet everywhere else — local dev, unit tests, and any
 * cluster where the operator has not deployed it.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { startAcmeDns01Webhook } from './webhook-server.js';
import type { RunningWebhook } from './webhook-server.js';
import type { SolverLogger } from './solver.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export const DEFAULT_TLS_DIR = '/etc/acme-webhook-tls';
export const DEFAULT_PORT = 8443;

/**
 * ConfigMap holding the CA that signs the aggregator's client
 * certificates. Every aggregated API server verifies against this.
 */
const REQUESTHEADER_CM = 'extension-apiserver-authentication';
const REQUESTHEADER_CM_NS = 'kube-system';
const REQUESTHEADER_CM_KEY = 'requestheader-client-ca-file';

export interface StartOptions {
  readonly db: Database;
  readonly k8s: K8sClients | null;
  readonly logger: SolverLogger;
  readonly encryptionKey: string;
}

/**
 * Read the cluster's requestheader client CA.
 *
 * Needs `get` on that one ConfigMap in kube-system (granted by
 * k8s/base/acme-webhook/rbac.yaml). Returns null when unavailable —
 * callers must then NOT start the webhook.
 */
export async function readRequestheaderClientCa(
  k8s: K8sClients,
): Promise<string | null> {
  try {
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: REQUESTHEADER_CM,
      namespace: REQUESTHEADER_CM_NS,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as unknown as {
      data?: Record<string, string>;
    };
    const pem = cm?.data?.[REQUESTHEADER_CM_KEY];
    return pem && pem.includes('BEGIN CERTIFICATE') ? pem : null;
  } catch {
    return null;
  }
}

export async function startAcmeDns01WebhookIfConfigured(
  opts: StartOptions,
): Promise<RunningWebhook | null> {
  const tlsDir = process.env.ACME_WEBHOOK_TLS_DIR ?? DEFAULT_TLS_DIR;
  const tlsCertPath = path.join(tlsDir, 'tls.crt');
  const tlsKeyPath = path.join(tlsDir, 'tls.key');

  if (!existsSync(tlsCertPath) || !existsSync(tlsKeyPath)) {
    opts.logger.info(
      { tlsDir },
      'acme-dns01: no serving certificate mounted — solver webhook not started',
    );
    return null;
  }

  if (!opts.k8s) {
    opts.logger.warn(
      {},
      'acme-dns01: serving certificate present but no k8s client — solver webhook not started',
    );
    return null;
  }

  const clientCaPem = await readRequestheaderClientCa(opts.k8s);
  if (!clientCaPem) {
    // Fail closed. Without the CA we cannot tell the apiserver apart
    // from anything else that can reach this port, and this endpoint
    // writes DNS records into customer zones.
    opts.logger.error(
      { configMap: `${REQUESTHEADER_CM_NS}/${REQUESTHEADER_CM}` },
      'acme-dns01: cannot read requestheader client CA — refusing to start the solver webhook',
    );
    return null;
  }

  const allowedUsers = (process.env.ACME_WEBHOOK_ALLOWED_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return startAcmeDns01Webhook({
    db: opts.db,
    encryptionKey: opts.encryptionKey,
    logger: opts.logger,
    port: Number(process.env.ACME_WEBHOOK_PORT ?? DEFAULT_PORT),
    tlsCertPath,
    tlsKeyPath,
    clientCaPem,
    ...(allowedUsers.length > 0 ? { allowedUsers } : {}),
  });
}

/** Exposed for the readiness probe / diagnostics. */
export function webhookServingCertFingerprintPath(): string {
  return path.join(process.env.ACME_WEBHOOK_TLS_DIR ?? DEFAULT_TLS_DIR, 'tls.crt');
}

/** Read the mounted serving cert (diagnostics only; never logged whole). */
export function readServingCert(): string | null {
  const p = webhookServingCertFingerprintPath();
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
