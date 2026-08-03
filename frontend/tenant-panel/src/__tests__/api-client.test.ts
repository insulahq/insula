import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, ApiError } from '../lib/api-client';

// NB: apiFetch reads localStorage on every call, so we clear it in beforeEach
// to prevent cross-test state leakage.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(response: Response) {
  globalThis.fetch = vi.fn().mockResolvedValue(response);
}

describe('apiFetch', () => {
  describe('empty-body handling', () => {
    it('returns undefined for HTTP 204', async () => {
      mockFetch(new Response(null, { status: 204 }));
      const result = await apiFetch<void>('/api/v1/test');
      expect(result).toBeUndefined();
    });

    it('returns undefined for HTTP 200 with an empty body', async () => {
      mockFetch(new Response('', { status: 200 }));
      const result = await apiFetch<void>('/api/v1/test');
      expect(result).toBeUndefined();
    });

    it('returns undefined for HTTP 201 with an empty body', async () => {
      mockFetch(new Response('', { status: 201 }));
      const result = await apiFetch<void>('/api/v1/test', { method: 'POST' });
      expect(result).toBeUndefined();
    });

    it('returns undefined for HTTP 202 with an empty body', async () => {
      mockFetch(new Response('', { status: 202 }));
      const result = await apiFetch<void>('/api/v1/test');
      expect(result).toBeUndefined();
    });

    it('returns undefined when Content-Length is 0', async () => {
      mockFetch(
        new Response('', {
          status: 200,
          headers: { 'Content-Length': '0' },
        }),
      );
      const result = await apiFetch<void>('/api/v1/test');
      expect(result).toBeUndefined();
    });
  });

  describe('JSON parsing', () => {
    it('parses JSON body for 200 responses', async () => {
      mockFetch(
        new Response(JSON.stringify({ data: { id: 'abc' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const result = await apiFetch<{ data: { id: string } }>('/api/v1/test');
      expect(result.data.id).toBe('abc');
    });

    it('parses JSON body for 201 responses', async () => {
      mockFetch(
        new Response(JSON.stringify({ data: { id: 'new' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const result = await apiFetch<{ data: { id: string } }>('/api/v1/test', { method: 'POST' });
      expect(result.data.id).toBe('new');
    });

    it('throws descriptive ApiError when JSON parsing fails on a 2xx response', async () => {
      // Use a fresh Response per call because Response bodies can only be
      // consumed once.
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response('<<not json>>', {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': '12',
            },
          }),
        ),
      );
      await expect(apiFetch<unknown>('/api/v1/broken')).rejects.toThrow(ApiError);
      await expect(apiFetch<unknown>('/api/v1/broken')).rejects.toThrow(/\/api\/v1\/broken/);
    });
  });

  describe('error handling', () => {
    it('throws ApiError for 4xx responses', async () => {
      mockFetch(
        new Response(
          JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'nope' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(apiFetch<unknown>('/api/v1/test')).rejects.toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
      });
    });

    it('throws ApiError for 5xx responses with empty body', async () => {
      mockFetch(new Response('', { status: 500 }));
      await expect(apiFetch<unknown>('/api/v1/test')).rejects.toMatchObject({
        status: 500,
        code: 'UNKNOWN',
      });
    });
  });

  /**
   * The body below is byte-for-byte what ModSecurity returned when CRS rule
   * 931100 blocked POST /api/v1/admin/dns-servers because the operator entered
   * a DNS API URL as an IP literal (2026-08-03). It never reaches the platform
   * API, so there is no envelope — the panel used to render a bare 403.
   */
  it("names the WAF when ModSecurity blocks the request", async () => {
    const nginx403 = [
      "<html>", "<head><title>403 Forbidden</title></head>", "<body>",
      "<center><h1>403 Forbidden</h1></center>", "<hr><center>nginx</center>",
      "</body>", "</html>",
    ].join("\\r\\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 403, statusText: "",
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve(nginx403),
    }));

    const err = (await apiFetch("/api/test").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("WAF_REQUEST_BLOCKED");
    expect(err.message).toMatch(/Web Application Firewall/i);
    expect(err.message).toMatch(/WAF Events/);
    // The operator must not be sent hunting through their own input first.
    expect(err.message).toMatch(/IP address/i);
    // Raw markup must never reach the panel.
    expect(err.message).not.toContain("<center>");
  });

  it("does not blame the WAF for a genuine API 403", async () => {
    const envelope = JSON.stringify({ error: { code: "INSUFFICIENT_ROLE", message: "Requires super_admin" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 403, statusText: "",
      json: () => Promise.resolve(JSON.parse(envelope)),
      text: () => Promise.resolve(envelope),
    }));
    const err = (await apiFetch("/api/test").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("INSUFFICIENT_ROLE");
    expect(err.message).not.toMatch(/Web Application Firewall/i);
  });

});
