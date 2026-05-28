import { describe, it, expect, vi } from 'vitest';
import { enqueueDelivery } from './enqueue.js';
import { NOTIFICATIONS_EMAIL_QUEUE } from './types.js';

describe('enqueueDelivery', () => {
  it('sends to the email queue with payload { deliveryId }', async () => {
    const send = vi.fn().mockResolvedValue('job-1');
    const boss = { send } as unknown as Parameters<typeof enqueueDelivery>[2];
    const result = await enqueueDelivery('d1', {}, boss);
    expect(result).toBe('job-1');
    expect(send).toHaveBeenCalledTimes(1);
    const [queue, payload, options] = send.mock.calls[0];
    expect(queue).toBe(NOTIFICATIONS_EMAIL_QUEUE);
    expect(payload).toEqual({ deliveryId: 'd1' });
    expect(options?.singletonKey).toBe('delivery:d1');
  });

  it('forwards startAfter when supplied', async () => {
    const send = vi.fn().mockResolvedValue('job-2');
    const boss = { send } as unknown as Parameters<typeof enqueueDelivery>[2];
    const when = new Date('2026-05-28T20:30:00Z');
    await enqueueDelivery('d1', { startAfter: when, singletonKey: 'd1:retry:2' }, boss);
    const [, , options] = send.mock.calls[0];
    expect(options?.startAfter).toBe(when);
    expect(options?.singletonKey).toBe('d1:retry:2');
  });

  it('returns null when pg-boss dedupes the singleton', async () => {
    const send = vi.fn().mockResolvedValue(null);
    const boss = { send } as unknown as Parameters<typeof enqueueDelivery>[2];
    const r = await enqueueDelivery('d1', {}, boss);
    expect(r).toBeNull();
  });
});
