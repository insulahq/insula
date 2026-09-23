import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Database } from '../../db/index.js';

const settings = vi.hoisted(() => ({
  value: { timezone: 'Africa/Windhoek' } as { timezone: string | null } | null,
  throws: false,
}));
vi.mock('./service.js', () => ({
  getSettings: vi.fn(async () => {
    if (settings.throws) throw new Error('database is starting up');
    return settings.value;
  }),
}));

import { resolvePlatformTimeZone } from './platform-timezone.js';

const db = {} as Database;

afterEach(() => {
  settings.value = { timezone: 'Africa/Windhoek' };
  settings.throws = false;
});

describe('resolvePlatformTimeZone', () => {
  it('returns the configured zone', async () => {
    await expect(resolvePlatformTimeZone(db)).resolves.toBe('Africa/Windhoek');
  });

  it('trims a zone an operator pasted with whitespace', async () => {
    settings.value = { timezone: '  Europe/Berlin  ' };
    await expect(resolvePlatformTimeZone(db)).resolves.toBe('Europe/Berlin');
  });

  it('falls back to UTC when unset or blank', async () => {
    for (const v of [null, '', '   ']) {
      settings.value = { timezone: v };
      await expect(resolvePlatformTimeZone(db)).resolves.toBe('UTC');
    }
  });

  it('falls back to UTC — and SAYS SO — when settings cannot be read', async () => {
    // A schedule quietly running hours off is the kind of thing nobody
    // notices for months, so the degraded path has to be audible.
    settings.throws = true;
    const warn = vi.fn();
    await expect(resolvePlatformTimeZone(db, { warn })).resolves.toBe('UTC');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatch(/UTC/);
  });

  it('does not throw when no logger is supplied', async () => {
    settings.throws = true;
    await expect(resolvePlatformTimeZone(db)).resolves.toBe('UTC');
  });
});
