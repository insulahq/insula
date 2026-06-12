import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shared secret for the Stalwart → platform-api webhook (R6 PR 2).
 *
 * Derived (never stored) from PLATFORM_INTERNAL_SECRET, same pattern
 * as the file-manager per-tenant secret (deriveFmSecret): the webhook
 * reconciler writes the derived value into the Stalwart WebHook
 * object's signatureKey, and the ingest route recomputes it to verify
 * the X-Signature header. Rotating PLATFORM_INTERNAL_SECRET rotates
 * this too (the periodic reconciler re-asserts the WebHook object).
 */
export function deriveMailWebhookKey(masterSecret: string): string {
  return createHmac('sha256', masterSecret).update('mail-webhook:v1').digest('base64url');
}

/**
 * Stalwart signs the raw request body with HMAC-SHA256 and sends
 * `X-Signature: base64(tag)` (standard alphabet) — see Stalwart
 * crates/common/src/telemetry/webhooks (verified against v0.16.5).
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  key: string,
): boolean {
  if (!signatureHeader) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHeader, 'base64');
  } catch {
    return false;
  }
  const expected = createHmac('sha256', key).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
