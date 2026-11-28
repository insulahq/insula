import { describe, expect, it } from 'vitest';
import { crlBaseUrl } from './routes.js';

describe('crlBaseUrl', () => {
  it('takes PUBLIC_URL when it is set', () => {
    expect(crlBaseUrl({ PUBLIC_URL: 'http://admin.example.test:2010', PLATFORM_BASE_DOMAIN: 'example.test' })).toBe('http://admin.example.test:2010');
  });

  it('is the admin panel on the base domain when PUBLIC_URL is not set (staging, production)', () => {
    expect(crlBaseUrl({ PLATFORM_BASE_DOMAIN: 'example.test' })).toBe('https://admin.example.test');
    expect(crlBaseUrl({ INGRESS_BASE_DOMAIN: '.example.test' })).toBe('https://admin.example.test');
  });

  it('is not "https://admin." when the platform key is there but empty', () => {
    expect(crlBaseUrl({ PLATFORM_BASE_DOMAIN: '', INGRESS_BASE_DOMAIN: 'example.test' })).toBe('https://admin.example.test');
  });

  it('is null with neither, so the request host is used and the warning stays (local dev)', () => {
    expect(crlBaseUrl({})).toBeNull();
    expect(crlBaseUrl({ PLATFORM_BASE_DOMAIN: '  ' })).toBeNull();
  });
});
