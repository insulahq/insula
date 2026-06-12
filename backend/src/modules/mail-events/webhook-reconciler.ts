/**
 * Stalwart WebHook provisioning (R6 PR 2).
 *
 * Ensures exactly one platform-managed x:WebHook object exists in
 * Stalwart pointing at the mail-events ingest endpoint, with:
 *   - eventsPolicy "include" (the default is "exclude" — which would
 *     firehose every server event INCLUDING http.request-body frames
 *     that leak Authorization headers; never ship exclude mode)
 *   - the event set for send accounting + the incoming-report family
 *     (pre-subscribed for R4 so its PR needs no Stalwart restart)
 *   - an HMAC signatureKey derived from PLATFORM_INTERNAL_SECRET
 *   - lossy=false so batches survive restarts (discardAfter default 5m)
 *
 * Stalwart only loads webhook config at boot (proven live 2026-06-12),
 * so any create/update here must roll the stalwart pod: we DELETE the
 * pod and let the ReplicaSet recreate it (never rollout-restart — Flux
 * reverts the annotation). Drift in signatureKey is undetectable (the
 * key is masked on /get), so we re-assert it only when something else
 * drifts or on create.
 */

import {
  webHookGet,
  webHookSet,
  type StalwartWebHookRow,
} from '../stalwart-jmap/client.js';
import { deriveMailWebhookKey } from './hmac.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// WebHook objects have NO description field (live-proven: create with
// one is rejected `invalidPatch description`) — the ingest URL is the
// identity key instead.
export const INGEST_URL =
  process.env.MAIL_EVENTS_WEBHOOK_URL
  ?? 'http://platform-api.platform.svc.cluster.local:3000/api/v1/internal/mail/events';

/** Include-filtered event set. Order-insensitive (compared as sets). */
export const SUBSCRIBED_EVENTS: readonly string[] = [
  // R6 accounting
  'queue.authenticated-message-queued',
  'queue.rate-limit-exceeded',
  'queue.quota-exceeded',
  // R4 pre-subscription (ingest ignores these until PR 3 consumes them)
  'incoming-report.abuse-report',
  'incoming-report.auth-failure-report',
  'incoming-report.fraud-report',
  'incoming-report.arf-parse-failed',
  'incoming-report.dmarc-report',
];

export function desiredWebhookObject(masterSecret: string): Record<string, unknown> {
  return {
    url: INGEST_URL,
    enable: true,
    lossy: false,
    eventsPolicy: 'include',
    events: Object.fromEntries(SUBSCRIBED_EVENTS.map((e) => [e, true])),
    // SecretKeyOptional tagged union: {"@type":"Value","secret":...}
    // (masked to "****" on /get — drift in the key itself is
    // undetectable, so it is only re-asserted alongside other drift).
    signatureKey: { '@type': 'Value', secret: deriveMailWebhookKey(masterSecret) },
  };
}

function eventsDrifted(live: StalwartWebHookRow): boolean {
  const liveEvents = new Set(Object.keys(live.events ?? {}).filter((k) => live.events?.[k]));
  if (liveEvents.size !== SUBSCRIBED_EVENTS.length) return true;
  return SUBSCRIBED_EVENTS.some((e) => !liveEvents.has(e));
}

// MAIL_WEBHOOK_FORCE_UPDATE applies ONCE per process boot — without
// this latch a persistently-set env var would re-update and roll the
// mail pod on every 5-minute ensure pass.
let forceUpdateApplied = false;

export interface WebhookEnsureResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly action: 'none' | 'created' | 'updated';
  readonly restarted: boolean;
}

async function rollStalwartPod(
  k8s: K8sClients | undefined,
  logger: OutboundReconcileLogger,
): Promise<boolean> {
  if (!k8s) {
    logger.warn({}, 'mail-events webhook: no k8s client — Stalwart restart required for webhook config; will retry');
    return false;
  }
  // Delete-pod, never rollout-restart (Flux treats the restart
  // annotation as drift and scales the new RS back to 0).
  await k8s.core.deleteCollectionNamespacedPod({
    namespace: 'mail',
    labelSelector: 'app=stalwart-mail',
  });
  logger.info({}, 'mail-events webhook: rolled stalwart pod to load webhook config');
  return true;
}

export async function ensureMailEventsWebhook(
  k8s: K8sClients | undefined,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<WebhookEnsureResult> {
  const master = (opts.env ?? process.env).PLATFORM_INTERNAL_SECRET;
  if (!master) {
    logger.warn({}, 'mail-events webhook: PLATFORM_INTERNAL_SECRET unset, skipping');
    return { skipped: true, reason: 'no master secret', action: 'none', restarted: false };
  }

  let live: readonly StalwartWebHookRow[];
  try {
    live = await webHookGet(opts);
  } catch (err) {
    logger.warn({ err }, 'mail-events webhook: Stalwart JMAP unreachable, skipped');
    return { skipped: true, reason: 'stalwart unreachable', action: 'none', restarted: false };
  }

  const desired = desiredWebhookObject(master);
  const existing = live.find((w) => w.url === INGEST_URL);

  try {
    if (!existing) {
      const res = await webHookSet({ create: { w: desired }, ...opts });
      if (res.notCreated && Object.keys(res.notCreated).length > 0) {
        logger.error({ failures: res.notCreated }, 'mail-events webhook: create failed');
        return { skipped: true, reason: 'create rejected', action: 'none', restarted: false };
      }
      const restarted = await rollStalwartPod(k8s, logger);
      logger.info({ url: INGEST_URL }, 'mail-events webhook: created');
      return { skipped: false, action: 'created', restarted };
    }

    // signatureKey drift is undetectable (masked on /get). After a
    // PLATFORM_INTERNAL_SECRET rotation set MAIL_WEBHOOK_FORCE_UPDATE=1
    // for one deploy: the next ensure pass re-asserts the full object
    // (incl. the new key) and rolls the pod. Ingest-side symptom of a
    // missed rotation: every webhook request logged as
    // "webhook signature rejected".
    const forceUpdate =
      (opts.env ?? process.env).MAIL_WEBHOOK_FORCE_UPDATE === '1' && !forceUpdateApplied;
    if (forceUpdate) forceUpdateApplied = true;

    const drifted =
      forceUpdate
      || existing.enable !== true
      || existing.lossy !== false
      || String(existing.eventsPolicy).toLowerCase() !== 'include'
      || eventsDrifted(existing);

    if (!drifted) {
      return { skipped: false, action: 'none', restarted: false };
    }

    const res = await webHookSet({ update: { [existing.id]: desired }, ...opts });
    if (res.notUpdated && Object.keys(res.notUpdated).length > 0) {
      logger.error({ failures: res.notUpdated }, 'mail-events webhook: update failed');
      return { skipped: true, reason: 'update rejected', action: 'none', restarted: false };
    }
    const restarted = await rollStalwartPod(k8s, logger);
    logger.info({}, 'mail-events webhook: updated (drift corrected)');
    return { skipped: false, action: 'updated', restarted };
  } catch (err) {
    logger.warn({ err }, 'mail-events webhook: ensure failed, will retry');
    return { skipped: true, reason: 'set failed', action: 'none', restarted: false };
  }
}
