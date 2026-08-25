import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../db/index.js';
import { processNtfyDelivery } from './ntfy-worker.js';
import { NtfyPublishError } from '../ntfy/publisher.js';

interface Fixture {
  delivery?: Record<string, unknown> | null;
  provider?: Record<string, unknown> | null;
}

const DELIVERY = {
  id: 'd1',
  channel: 'ntfy',
  status: 'queued',
  attempt: 0,
  providerId: 'p1',
  eventVariables: { __ntfy: { title: 'Backup failed', message: 'boom', severity: 'critical', clickUrl: null, tags: [] } },
};
const PROVIDER = {
  id: 'p1',
  enabled: true,
  ntfyServerUrl: 'https://ntfy.example.test',
  ntfyTopic: 'alerts',
  ntfyAuthMethod: 'none',
  ntfyTokenEncrypted: null,
  authUsername: null,
  authPasswordEncrypted: null,
};

function fakeDb(fx: Fixture) {
  const updates: Array<Record<string, unknown>> = [];
  let call = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain.then = (resolve: (rows: unknown[]) => unknown) => {
    call += 1;
    const rows = call === 1
      ? (fx.delivery === null ? [] : [fx.delivery ?? DELIVERY])
      : (fx.provider === null ? [] : [fx.provider ?? PROVIDER]);
    return Promise.resolve(rows).then(resolve);
  };
  const db = {
    select: vi.fn(() => chain),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        updates.push(patch);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  } as unknown as Database;
  return { db, updates };
}

const boss = { send: vi.fn(async () => 'job1') };

describe('processNtfyDelivery', () => {
  it('publishes and marks sent', async () => {
    const { db, updates } = fakeDb({});
    const publish = vi.fn(async () => ({ messageId: 'm7' }));
    const r = await processNtfyDelivery('d1', { db, boss: boss as never, publish: publish as never });
    expect(r.status).toBe('sent');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'alerts', serverUrl: 'https://ntfy.example.test' }),
      expect.objectContaining({ title: 'Backup failed', severity: 'critical' }),
    );
    expect(updates.at(-1)).toMatchObject({ status: 'sent', providerMessageId: 'm7' });
  });

  it('permanent publish error (bad credentials) → DLQ, no retry enqueue', async () => {
    const { db, updates } = fakeDb({});
    const publish = vi.fn(async () => { throw new NtfyPublishError('403 forbidden', true); });
    boss.send.mockClear();
    const r = await processNtfyDelivery('d1', { db, boss: boss as never, publish: publish as never });
    expect(r.status).toBe('dlq');
    expect(updates.at(-1)).toMatchObject({ status: 'dlq' });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('transient error → failed + retry enqueued with backoff', async () => {
    const { db, updates } = fakeDb({});
    const publish = vi.fn(async () => { throw new NtfyPublishError('unreachable', false); });
    boss.send.mockClear();
    const r = await processNtfyDelivery('d1', { db, boss: boss as never, publish: publish as never });
    expect(r.status).toBe('failed');
    expect(updates.at(-1)).toMatchObject({ status: 'failed', attempt: 1 });
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it('disabled provider → DLQ with provider_disabled', async () => {
    const { db } = fakeDb({ provider: { ...PROVIDER, enabled: false } });
    const r = await processNtfyDelivery('d1', { db, boss: boss as never });
    expect(r).toMatchObject({ status: 'dlq', error: 'provider_disabled' });
  });

  it('wrong channel / terminal rows are skipped untouched', async () => {
    const { db: db1 } = fakeDb({ delivery: { ...DELIVERY, channel: 'email' } });
    expect((await processNtfyDelivery('d1', { db: db1 })).error).toBe('channel_not_ntfy');
    const { db: db2 } = fakeDb({ delivery: { ...DELIVERY, status: 'sent' } });
    expect((await processNtfyDelivery('d1', { db: db2 })).error).toBe('terminal_status:sent');
    const { db: db3 } = fakeDb({ delivery: null });
    expect((await processNtfyDelivery('d1', { db: db3 })).error).toBe('delivery_not_found');
  });
});
