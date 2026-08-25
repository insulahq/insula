import { describe, expect, it, vi } from 'vitest';
import {
  buildNtfyAuthHeader,
  buildNtfyBody,
  ntfyPriorityForSeverity,
  publishNtfy,
  NtfyPublishError,
  type NtfyProviderConfig,
} from './publisher.js';

const BASE: NtfyProviderConfig = {
  serverUrl: 'https://ntfy.example.test',
  topic: 'platform-alerts',
  authMethod: 'none',
};

describe('ntfy payload building', () => {
  it('maps severities to ntfy priorities', () => {
    expect(ntfyPriorityForSeverity('critical')).toBe(5);
    expect(ntfyPriorityForSeverity('error')).toBe(4);
    expect(ntfyPriorityForSeverity('warning')).toBe(4);
    expect(ntfyPriorityForSeverity('info')).toBe(3);
  });

  it('builds a JSON body with topic, clamped title, click and tags', () => {
    const body = buildNtfyBody(BASE, {
      title: 'T'.repeat(300),
      message: 'M',
      severity: 'critical',
      clickUrl: 'https://admin.example.test/backups/system',
      tags: ['backup.failed'],
    });
    expect(body.topic).toBe('platform-alerts');
    expect((body.title as string).length).toBe(200);
    expect(body.priority).toBe(5);
    expect(body.click).toBe('https://admin.example.test/backups/system');
    expect(body.tags).toEqual(['rotating_light', 'backup.failed']);
  });

  it('token auth → Bearer header; basic auth → Basic header; none → empty', () => {
    expect(buildNtfyAuthHeader({ ...BASE, authMethod: 'token', token: 'tk_abc' }))
      .toEqual({ authorization: 'Bearer tk_abc' });
    const basic = buildNtfyAuthHeader({ ...BASE, authMethod: 'basic', username: 'ops', password: 'pw' });
    expect(basic.authorization).toBe(`Basic ${Buffer.from('ops:pw').toString('base64')}`);
    expect(buildNtfyAuthHeader(BASE)).toEqual({});
  });
});

describe('publishNtfy', () => {
  it('POSTs JSON to the server root and returns the message id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'm1' }), { status: 200 }));
    const r = await publishNtfy(BASE, { title: 't', message: 'm', severity: 'info' }, fetchMock as unknown as typeof fetch);
    expect(r.messageId).toBe('m1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.example.test');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).topic).toBe('platform-alerts');
  });

  it('401/403 → permanent error mentioning credentials', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 403 }));
    await expect(
      publishNtfy({ ...BASE, authMethod: 'token', token: 'bad' }, { title: 't', message: 'm', severity: 'info' }, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringContaining('private') });
  });

  it('network failure → transient error', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const err = await publishNtfy(BASE, { title: 't', message: 'm', severity: 'info' }, fetchMock as unknown as typeof fetch)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NtfyPublishError);
    expect((err as NtfyPublishError).permanent).toBe(false);
  });

  it('5xx → transient error', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 502 }));
    const err = await publishNtfy(BASE, { title: 't', message: 'm', severity: 'info' }, fetchMock as unknown as typeof fetch)
      .then(() => null, (e: unknown) => e);
    expect((err as NtfyPublishError).permanent).toBe(false);
  });
});
