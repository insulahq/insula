/**
 * The mail archive is switched off: its routes are not registered and its
 * scheduler is not started. The code stays in the repository (see
 * archive-dormant.ts), so what keeps it off is one constant and two `if`s —
 * this pins both, so that the feature cannot come back half-way: routes
 * without the card, or a timer nobody asked for.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIL_ARCHIVE_ENABLED } from './archive-dormant.js';

const SRC = join(import.meta.dirname, '..', '..');
const routes = readFileSync(join(SRC, 'modules/mail-admin/routes.ts'), 'utf8');
const app = readFileSync(join(SRC, 'app.ts'), 'utf8');

/** The source text of the `if (MAIL_ARCHIVE_ENABLED) { … }` block: from the `if` to its closing brace at the same indent. */
function gatedBlock(source: string): string {
  const m = /^( *)if \(MAIL_ARCHIVE_ENABLED\) \{$/m.exec(source);
  if (!m) return '';
  const start = m.index;
  const close = source.indexOf(`\n${m[1]}}\n`, start);
  return close < 0 ? '' : source.slice(start, close);
}

describe('the mail archive is dormant', () => {
  it('is switched off', () => {
    expect(MAIL_ARCHIVE_ENABLED).toBe(false);
  });

  it('every archive route is registered only inside the switch', () => {
    const block = gatedBlock(routes);
    const all = routes.match(/'\/admin\/mail\/archive[^']*'/g) ?? [];
    const inside = block.match(/'\/admin\/mail\/archive[^']*'/g) ?? [];
    expect(all.length).toBe(7);
    expect(inside.length).toBe(all.length);
  });

  it('the scheduler timer is started only inside the switch', () => {
    const block = gatedBlock(app);
    expect(block).toContain('maybeFireArchiveSchedule');
    expect(app.split('maybeFireArchiveSchedule').length).toBe(block.split('maybeFireArchiveSchedule').length);
    expect(app.split('mailArchiveTimer').length).toBe(block.split('mailArchiveTimer').length);
  });
});
