/**
 * Provider create/update travel as application/octet-stream.
 *
 * They carry operator-authored HTML (the email header/footer). Sent as
 * application/json the edge WAF parses it into ARGS and the CRS XSS rules
 * refuse an ordinary `<a href>` footer with a bare 403 the API never sees —
 * measured on DEV. The body is the same JSON; only the label changes (ADR-060,
 * WAF rule 9000116).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn().mockResolvedValue({ data: {} });
const invalidateQueries = vi.fn();

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryFn: () => unknown }) => { opts.queryFn(); return { data: undefined }; },
  useMutation: (opts: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: () => void }) => ({
    mutateAsync: async (v?: unknown) => { const r = await opts.mutationFn(v); opts.onSuccess?.(); return r; },
  }),
  useQueryClient: () => ({ invalidateQueries }),
}));

beforeEach(() => { apiFetch.mockClear(); invalidateQueries.mockClear(); });

type Init = { method?: string; headers?: Record<string, string>; body: string };

describe('notification provider hooks', () => {
  it('create sends the JSON body labelled application/octet-stream', async () => {
    const { useCreateNotificationProvider } = await import('./use-notification-providers.js');
    const input = { name: 'p', providerType: 'smtp', emailFooterHtml: '<a href="https://example.test">x</a>' };
    await useCreateNotificationProvider().mutateAsync(input as never);
    const [url, init] = apiFetch.mock.calls[0] as [string, Init];
    expect(url).toBe('/api/v1/admin/notifications/providers');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it('update sends the JSON body labelled application/octet-stream', async () => {
    const { useUpdateNotificationProvider } = await import('./use-notification-providers.js');
    await useUpdateNotificationProvider().mutateAsync({ id: 'p1', input: { emailHeaderHtml: '<p>H</p>' } });
    const [url, init] = apiFetch.mock.calls[0] as [string, Init];
    expect(url).toBe('/api/v1/admin/notifications/providers/p1');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(JSON.parse(init.body)).toEqual({ emailHeaderHtml: '<p>H</p>' });
  });

  it('the test send stays plain JSON (its route is not in the WAF exclusion)', async () => {
    const { useTestNotificationProvider } = await import('./use-notification-providers.js');
    await useTestNotificationProvider().mutateAsync({ id: 'p1', input: { recipientEmail: 'ops@example.test' } });
    const [url, init] = apiFetch.mock.calls[0] as [string, Init];
    expect(url).toBe('/api/v1/admin/notifications/providers/p1/test');
    expect(init.headers).toBeUndefined();
  });

  it('reads the preview sample from the route that exists', async () => {
    const { useEmailChromePreviewSample } = await import('./use-notification-providers.js');
    useEmailChromePreviewSample(true);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/notifications/email-chrome/preview-sample');
  });
});
