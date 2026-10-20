/**
 * A new tenant starts on CPU shares on every cluster — an upgraded one too.
 */
import { describe, it, expect } from 'vitest';
import { cpuModeForNewTenant } from './default-mode.js';

describe('cpuModeForNewTenant', () => {
  it('is tiered without asking the database — the stored per-cluster default is retired', async () => {
    // A database that would throw on any query: the answer must not depend on it.
    const db = new Proxy({}, { get() { throw new Error('the database was consulted'); } });
    await expect(cpuModeForNewTenant(db as never)).resolves.toBe('tiered');
  });
});
