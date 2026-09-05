import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NOTIFICATION_CHANNEL_ID } from '@insula/api-contracts';
import { ALL_CATEGORIES } from './seed.js';

/**
 * Adding a delivery channel must switch it on everywhere, with no second edit.
 *
 * `ntfy` is why this exists. It shipped complete — provider, templates,
 * worker, admin UI — and was off on all fifty sources, because the defaults
 * were a hand-written `['in_app', 'email']` in three places that nobody
 * revisited. The operator had to enable it by hand, per source.
 *
 * These lock the three places to the channel enum, so the next channel is on
 * by default the moment it is added — or the suite fails and says where.
 */
describe('every notification source defaults to every channel', () => {
  // seed.ts rebuilds the channel list from a total Record instead of importing
  // it as a value, because the coverage guard executes that file with node's
  // type-stripping loader and cannot resolve a runtime package import. That
  // makes the list a duplicate of the enum, so assert the duplicate agrees.
  it('the seed file lists every channel in its EVERY_CHANNEL record', () => {
    const src = readFileSync(new URL('./seed.ts', import.meta.url), 'utf8');
    const m = /const EVERY_CHANNEL: Record<NotificationChannelId, true> = \{([^}]*)\}/.exec(src);
    expect(m, 'EVERY_CHANNEL record not found in seed.ts').toBeTruthy();
    const listed = [...m![1].matchAll(/^\s*([a-z_]+):/gm)].map((x) => x[1]).sort();
    expect(listed).toEqual([...NOTIFICATION_CHANNEL_ID].sort());
  });

  it('no seeded category ships a narrower channel set', () => {
    const narrower = ALL_CATEGORIES
      .filter((c) => [...c.defaultChannels].sort().join() !== [...NOTIFICATION_CHANNEL_ID].sort().join())
      .map((c) => `${c.id}: [${c.defaultChannels.join(', ')}]`);
    expect(narrower).toEqual([]);
  });

  it('covers every category (guards against an empty catalogue passing vacuously)', () => {
    expect(ALL_CATEGORIES.length).toBeGreaterThan(40);
  });

  // The SQL default governs rows the seeder does not insert, and SQL cannot
  // read the TypeScript enum — so it is duplicated by necessity. Assert the
  // duplicate agrees, or a new channel is silently missing from it.
  it('the Drizzle column default lists every channel', () => {
    const schema = readFileSync(new URL('../../../db/schema.ts', import.meta.url), 'utf8');
    const m = /defaultChannels: text\('default_channels'\)[\s\S]*?ARRAY\[([^\]]*)\]/.exec(schema);
    expect(m, 'default_channels column not found in schema.ts').toBeTruthy();
    const listed = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(listed).toEqual([...NOTIFICATION_CHANNEL_ID].sort());
  });

  it('the migration that widened the default lists every channel', () => {
    const sql = readFileSync(
      new URL('../../../db/migrations/0099_notification_channels_all_by_default.sql', import.meta.url),
      'utf8',
    );
    const m = /SET DEFAULT ARRAY\[([^\]]*)\]/.exec(sql);
    expect(m, 'SET DEFAULT not found in migration 0099').toBeTruthy();
    const listed = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(listed).toEqual([...NOTIFICATION_CHANNEL_ID].sort());
  });
});
