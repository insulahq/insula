import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationCategoryResponse } from '@insula/api-contracts';

const getActiveTemplateMock = vi.fn();
vi.mock('../templates/service.js', () => ({ getActiveTemplate: getActiveTemplateMock }));

const renderTemplateAsyncMock = vi.fn();
vi.mock('../templates/renderer.js', () => ({ renderTemplateAsync: renderTemplateAsyncMock }));

const enqueueNtfyDeliveryMock = vi.fn();
vi.mock('../queue/enqueue.js', () => ({ enqueueNtfyDelivery: enqueueNtfyDeliveryMock }));

const { emitNtfyForEvent } = await import('./ntfy.js');

const CATEGORY: NotificationCategoryResponse = {
  id: 'admin.node_down',
  displayName: 'Node down',
  description: null,
  audience: 'admin',
  defaultSeverity: 'critical',
  defaultChannels: ['in_app', 'email', 'ntfy'],
  isMandatory: false,
  gdprBasis: 'legitimate_interest',
  rateLimitWindowS: null,
  rateLimitMax: null,
  isActive: true,
  emailProviderId: null,
};

const PROVIDER = { id: 'prov-1', ntfyTopic: 'insula-alerts' };

/**
 * Minimal drizzle stand-in: each terminal call shifts the next canned
 * result. Query order in emitNtfyForEvent is provider → [dupe] → settings.
 */
function fakeDb(results: unknown[][]) {
  const queue = [...results];
  const inserted: Record<string, unknown>[] = [];
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      limit: () => Promise.resolve(queue.shift() ?? []),
    };
    return c;
  };
  const db = {
    select: () => chain(),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof emitNtfyForEvent>[0], inserted };
}

const baseInput = {
  eventId: 'evt-1',
  category: CATEGORY,
  tenantId: null,
  variables: {},
  dedupeKey: undefined,
  hashSalt: 'salt',
};

beforeEach(() => {
  getActiveTemplateMock.mockReset();
  renderTemplateAsyncMock.mockReset();
  enqueueNtfyDeliveryMock.mockReset();
  renderTemplateAsyncMock.mockResolvedValue({ subject: 'Node down', body: 'Node sv1 is NotReady.' });
});

describe('emitNtfyForEvent template lookup', () => {
  it("renders the category's OWN ntfy template, not the in_app one", async () => {
    const ntfyTpl = { id: 'tpl-ntfy', version: 3, channel: 'ntfy' };
    getActiveTemplateMock.mockResolvedValue(ntfyTpl);
    const { db, inserted } = fakeDb([[PROVIDER], [{ adminPanelUrl: 'https://admin.example.test' }]]);

    const res = await emitNtfyForEvent(db, baseInput);

    expect(res.status).toBe('queued');
    // The FIRST lookup must ask for 'ntfy'. Before this change the ntfy leg
    // borrowed the in_app row, so the push text could never be edited.
    expect(getActiveTemplateMock).toHaveBeenNthCalledWith(1, db, 'admin.node_down', 'ntfy', 'en');
    expect(renderTemplateAsyncMock).toHaveBeenCalledWith(ntfyTpl, {});
    // The delivery row records WHICH template rendered it, so the log and
    // the version history line up with the channel the operator edited.
    expect(inserted[0]?.templateId).toBe('tpl-ntfy');
    expect(inserted[0]?.templateVersion).toBe(3);
    expect(inserted[0]?.channel).toBe('ntfy');
  });

  it('falls back to in_app only when no ntfy template exists', async () => {
    const inAppTpl = { id: 'tpl-inapp', version: 1, channel: 'in_app' };
    getActiveTemplateMock
      .mockResolvedValueOnce(null) // ntfy
      .mockResolvedValueOnce(inAppTpl); // in_app fallback
    const { db, inserted } = fakeDb([[PROVIDER], [{ adminPanelUrl: null }]]);

    const res = await emitNtfyForEvent(db, baseInput);

    expect(res.status).toBe('queued');
    expect(getActiveTemplateMock).toHaveBeenNthCalledWith(2, db, 'admin.node_down', 'in_app', 'en');
    expect(inserted[0]?.templateId).toBe('tpl-inapp');
  });

  it('skips with no_template when neither channel has one', async () => {
    getActiveTemplateMock.mockResolvedValue(null);
    const { db, inserted } = fakeDb([[PROVIDER]]);

    const res = await emitNtfyForEvent(db, baseInput);

    expect(res).toEqual({ status: 'skipped', error: 'no_template' });
    expect(inserted).toHaveLength(0);
    expect(enqueueNtfyDeliveryMock).not.toHaveBeenCalled();
  });

  it('carries the rendered subject and body into the queued push payload', async () => {
    getActiveTemplateMock.mockResolvedValue({ id: 'tpl-ntfy', version: 1 });
    renderTemplateAsyncMock.mockResolvedValue({ subject: 'Node sv1 down', body: 'kubelet stopped heartbeating.' });
    const { db, inserted } = fakeDb([[PROVIDER], [{ adminPanelUrl: 'https://admin.example.test/' }]]);

    await emitNtfyForEvent(db, baseInput);

    const payload = (inserted[0]?.eventVariables as { __ntfy: Record<string, unknown> }).__ntfy;
    expect(payload.title).toBe('Node sv1 down');
    expect(payload.message).toBe('kubelet stopped heartbeating.');
    expect(payload.severity).toBe('critical');
    expect(enqueueNtfyDeliveryMock).toHaveBeenCalledOnce();
  });

  it('skips when no default ntfy provider is enabled', async () => {
    const { db } = fakeDb([[]]);
    const res = await emitNtfyForEvent(db, baseInput);
    expect(res).toEqual({ status: 'skipped', error: 'no_ntfy_provider' });
    expect(getActiveTemplateMock).not.toHaveBeenCalled();
  });
});
