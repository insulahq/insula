import { describe, it, expect } from 'vitest';
import { describeFetchFailure, summarizeUpstreamBody } from './fetch-error.js';

/** Shape of a real undici failure: opaque message, real code on `cause`. */
function fetchFailure(code: string): Error {
  const err = new Error('fetch failed');
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

describe('describeFetchFailure', () => {
  // The three below were reproduced from inside the live platform-api
  // container on 2026-08-03 — all three produced the identical operator-
  // facing string "Cannot connect to DNS server: fetch failed".
  it('names an unresolvable hostname and points at CoreDNS', () => {
    const msg = describeFetchFailure(fetchFailure('ENOTFOUND'), 'http://ns1.mesh.invalid:8081/api');
    expect(msg).toContain('ns1.mesh.invalid:8081');
    expect(msg).toMatch(/does not resolve/i);
    expect(msg).toMatch(/CoreDNS/);
    expect(msg).not.toContain('fetch failed');
  });

  it('tells an https://-against-plaintext mistake apart from a dead host', () => {
    const tls = describeFetchFailure(fetchFailure('ERR_SSL_WRONG_VERSION_NUMBER'), 'https://192.0.2.10:8081/api');
    const refused = describeFetchFailure(fetchFailure('ECONNREFUSED'), 'http://192.0.2.10:8081/api');
    expect(tls).toMatch(/use http:\/\/ instead of https:\/\//);
    expect(refused).toMatch(/connection refused/i);
    expect(tls).not.toBe(refused);
  });

  it('distinguishes dropped packets (firewall) from refused ones', () => {
    expect(describeFetchFailure(fetchFailure('ETIMEDOUT'), 'http://192.0.2.10:8081')).toMatch(/firewall|route/i);
    expect(describeFetchFailure(fetchFailure('EHOSTUNREACH'), 'http://192.0.2.10:8081')).toMatch(/no route/i);
  });

  it('reports TLS trust problems as trust problems, not connectivity', () => {
    expect(describeFetchFailure(fetchFailure('DEPTH_ZERO_SELF_SIGNED_CERT'), 'https://dns.example.test')).toMatch(/self-signed|does not trust/i);
    expect(describeFetchFailure(fetchFailure('CERT_HAS_EXPIRED'), 'https://dns.example.test')).toMatch(/expired/i);
  });

  it('reads a code nested one level deeper (TLS socket errors)', () => {
    const err = new Error('fetch failed');
    (err as Error & { cause?: unknown }).cause = { cause: { code: 'ECONNREFUSED' } };
    expect(describeFetchFailure(err, 'http://192.0.2.10:8081')).toMatch(/connection refused/i);
  });

  it('still says something useful when there is no code at all', () => {
    const msg = describeFetchFailure(new Error('fetch failed'), 'http://192.0.2.10:8081');
    expect(msg).toContain('192.0.2.10:8081');
    expect(msg).not.toContain('fetch failed');
  });

  it('leaves a message that already carries information alone', () => {
    const msg = describeFetchFailure(new Error('PowerDNS API error: 401 — Unauthorized'), 'http://x.test');
    expect(msg).toBe('PowerDNS API error: 401 — Unauthorized');
  });

  it('does not throw on a malformed target', () => {
    expect(describeFetchFailure(fetchFailure('ECONNREFUSED'), 'not a url')).toContain('not a url');
  });
});

describe('summarizeUpstreamBody', () => {
  // A WAF or reverse proxy in front of the upstream answers with a full HTML
  // error page; spliced raw into the message it buries the actual status.
  it('flattens an HTML error page to its text', () => {
    const page = '<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>';
    const out = summarizeUpstreamBody(page);
    expect(out).toContain('403 Forbidden');
    expect(out).not.toContain('<');
    expect(out).not.toContain('\r\n');
  });

  it('caps length so one bad upstream cannot flood the panel', () => {
    const out = summarizeUpstreamBody('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('passes a short JSON body through untouched', () => {
    expect(summarizeUpstreamBody('{"error": "Unauthorized"}')).toBe('{"error": "Unauthorized"}');
  });
});
