import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stalwart-jmap/client.js', () => ({
  webHookGet: vi.fn(),
  webHookSet: vi.fn(),
}));

import {
  ensureMailEventsWebhook,
  desiredWebhookObject,
  SUBSCRIBED_EVENTS,
  WEBHOOK_DESCRIPTION,
} from './webhook-reconciler.js';
import * as jmap from '../stalwart-jmap/client.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const get = vi.mocked(jmap.webHookGet);
const set = vi.mocked(jmap.webHookSet);

const okSet = {
  accountId: 'x', oldState: null, newState: 'n',
  created: { w: { id: 'new' } }, updated: null, destroyed: null,
  notCreated: null, notUpdated: null, notDestroyed: null,
} as never;

function k8sMock() {
  const deleteCollectionNamespacedPod = vi.fn().mockResolvedValue({});
  return {
    clients: { core: { deleteCollectionNamespacedPod } } as never,
    deleteCollectionNamespacedPod,
  };
}

const env = { PLATFORM_INTERNAL_SECRET: 'master' } as NodeJS.ProcessEnv;

function liveInSync() {
  const want = desiredWebhookObject('master');
  return {
    id: 'wh1',
    description: WEBHOOK_DESCRIPTION,
    url: want.url as string,
    enable: true,
    lossy: false,
    eventsPolicy: 'include',
    events: want.events as Record<string, boolean>,
    signatureKey: { '@type': 'Value', secret: '****' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  set.mockResolvedValue(okSet);
});

describe('desiredWebhookObject', () => {
  it('always uses include policy and a Value signature key', () => {
    const d = desiredWebhookObject('master');
    expect(d.eventsPolicy).toBe('include');
    expect((d.signatureKey as { '@type': string })['@type']).toBe('Value');
    expect(Object.keys(d.events as Record<string, boolean>).sort()).toEqual([...SUBSCRIBED_EVENTS].sort());
    expect(d.lossy).toBe(false);
  });
});

describe('ensureMailEventsWebhook', () => {
  it('creates the webhook and rolls the stalwart pod when absent', async () => {
    get.mockResolvedValue([]);
    const { clients, deleteCollectionNamespacedPod } = k8sMock();

    const res = await ensureMailEventsWebhook(clients, silentLogger, { env });
    expect(res.action).toBe('created');
    expect(res.restarted).toBe(true);
    expect(deleteCollectionNamespacedPod).toHaveBeenCalledWith({
      namespace: 'mail',
      labelSelector: 'app=stalwart-mail',
    });
  });

  it('no-ops (and does NOT roll the pod) when in sync', async () => {
    get.mockResolvedValue([liveInSync()]);
    const { clients, deleteCollectionNamespacedPod } = k8sMock();

    const res = await ensureMailEventsWebhook(clients, silentLogger, { env });
    expect(res.action).toBe('none');
    expect(res.restarted).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(deleteCollectionNamespacedPod).not.toHaveBeenCalled();
  });

  it('updates + rolls when the event set drifted', async () => {
    const stale = liveInSync();
    const events = { ...stale.events };
    delete events['queue.quota-exceeded'];
    get.mockResolvedValue([{ ...stale, events }]);
    const { clients, deleteCollectionNamespacedPod } = k8sMock();

    const res = await ensureMailEventsWebhook(clients, silentLogger, { env });
    expect(res.action).toBe('updated');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ update: expect.any(Object) }));
    expect(deleteCollectionNamespacedPod).toHaveBeenCalled();
  });

  it('updates + rolls when eventsPolicy is the dangerous exclude default', async () => {
    get.mockResolvedValue([{ ...liveInSync(), eventsPolicy: 'exclude' }]);
    const { clients } = k8sMock();
    const res = await ensureMailEventsWebhook(clients, silentLogger, { env });
    expect(res.action).toBe('updated');
  });

  it('skips without a master secret', async () => {
    const res = await ensureMailEventsWebhook(undefined, silentLogger, { env: {} as NodeJS.ProcessEnv });
    expect(res.skipped).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('skips when Stalwart is unreachable', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await ensureMailEventsWebhook(undefined, silentLogger, { env });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('stalwart unreachable');
  });

  it('creates without restarting when no k8s client (logged, retried later)', async () => {
    get.mockResolvedValue([]);
    const res = await ensureMailEventsWebhook(undefined, silentLogger, { env });
    expect(res.action).toBe('created');
    expect(res.restarted).toBe(false);
  });
});
