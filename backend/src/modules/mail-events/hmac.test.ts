import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { deriveMailWebhookKey, verifyWebhookSignature } from './hmac.js';

describe('deriveMailWebhookKey', () => {
  it('is deterministic and master-dependent', () => {
    expect(deriveMailWebhookKey('m1')).toBe(deriveMailWebhookKey('m1'));
    expect(deriveMailWebhookKey('m1')).not.toBe(deriveMailWebhookKey('m2'));
  });
});

describe('verifyWebhookSignature', () => {
  const key = deriveMailWebhookKey('master');
  const body = Buffer.from('{"events":[]}');
  const goodSig = createHmac('sha256', key).update(body).digest('base64');

  it('accepts a valid Stalwart-style signature (base64 standard)', () => {
    expect(verifyWebhookSignature(body, goodSig, key)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifyWebhookSignature(body, undefined, key)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyWebhookSignature(Buffer.from('{"events":[{}]}'), goodSig, key)).toBe(false);
  });

  it('rejects a signature made with another key', () => {
    const otherSig = createHmac('sha256', 'other').update(body).digest('base64');
    expect(verifyWebhookSignature(body, otherSig, key)).toBe(false);
  });

  it('rejects garbage signatures without throwing', () => {
    expect(verifyWebhookSignature(body, '!!!not-base64!!!', key)).toBe(false);
    expect(verifyWebhookSignature(body, '', key)).toBe(false);
  });
});
