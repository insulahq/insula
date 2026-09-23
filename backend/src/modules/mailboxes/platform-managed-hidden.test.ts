import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `postmaster@` is the PLATFORM's address on a tenant's domain. It exists to
 * receive DMARC and TLS reports, has no owner to support, and no quota an
 * admin would ever change. On production that is 19 rows among 53 real
 * mailboxes — enough to push the ones an operator came to find off the first
 * page. `platform_managed` is exactly this set: every postmaster row carries
 * it, and no other row does.
 *
 * Every surface that lists mailboxes AS ACCOUNTS has to agree on that, or the
 * admin list and the quota alert disagree about how many mailboxes exist. The
 * alert already filtered; the list did not.
 */
describe('platform-managed mailboxes stay out of account listings', () => {
  const read = (...p: string[]): string =>
    readFileSync(join(__dirname, '..', '..', ...p), 'utf8');

  it('the admin mailbox list filters them out', () => {
    const src = read('modules', 'mailboxes', 'routes.ts');
    expect(src).toMatch(/eq\(mailboxes\.platformManaged,\s*false\)/);
  });

  it('the mailbox-quota alert filters them out, on the same flag', () => {
    // Two different predicates here would mean the dashboard counts mailboxes
    // the list page will not show.
    const src = read('modules', 'dashboard', 'alerts.ts');
    expect(src).toMatch(/platform_managed\s*=\s*FALSE/i);
  });
});
