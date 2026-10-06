import { describe, it, expect } from 'vitest';
import {
  proxySsoProvider, markProxySsoAttempt, suppressProxySso, resetProxySso, PROXY_SSO_RETRY_WINDOW_MS,
} from '../proxy-sso';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  };
}

const base = { proxyProviderId: 'p1', providerIds: ['p0', 'p1'], callbackInProgress: false, now: 1_000_000 };

describe('proxySsoProvider', () => {
  it('starts the proxy provider on a proxy-protected panel', () => {
    expect(proxySsoProvider({ ...base, storage: memoryStorage() })).toBe('p1');
  });

  it('does nothing when the panel is not proxy-protected or the provider is not offered', () => {
    expect(proxySsoProvider({ ...base, proxyProviderId: null, storage: memoryStorage() })).toBeNull();
    expect(proxySsoProvider({ ...base, providerIds: ['p0'], storage: memoryStorage() })).toBeNull();
  });

  it('never fires while a callback is handled or its ?error= must stay readable', () => {
    expect(proxySsoProvider({ ...base, callbackInProgress: true, storage: memoryStorage() })).toBeNull();
  });

  it('fires at most once per window, so a failed sign-in cannot loop', () => {
    const storage = memoryStorage();
    markProxySsoAttempt(storage, base.now);
    expect(proxySsoProvider({ ...base, storage, now: base.now + 5_000 })).toBeNull();
    expect(proxySsoProvider({ ...base, storage, now: base.now + PROXY_SSO_RETRY_WINDOW_MS + 1 })).toBe('p1');
  });

  it('stays on the login page after an explicit sign-out until the next completed sign-in', () => {
    const storage = memoryStorage();
    suppressProxySso(storage);
    expect(proxySsoProvider({ ...base, storage })).toBeNull();
    resetProxySso(storage);
    expect(proxySsoProvider({ ...base, storage })).toBe('p1');
  });

  it('does not auto-start when storage is unavailable (no loop guard)', () => {
    const broken = { getItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(proxySsoProvider({ ...base, storage: broken })).toBeNull();
  });
});
