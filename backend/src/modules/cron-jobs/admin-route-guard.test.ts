/**
 * A cross-tenant listing must refuse a tenant.
 *
 * `/admin/cron-jobs` served one. The file's blanket hooks read like
 * protection and are not: `requireTenantRoleByMethod()` permits
 * tenant_admin and tenant_user on GET, and `requireTenantAccess()` only
 * compares a `:tenantId` PATH PARAM against the caller's claim — an
 * /admin/* route has no such param, so the comparison never runs and the
 * request is allowed through. Verified against the running cluster with a
 * real tenant-panel token before the fix: HTTP 200, every tenant's jobs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FILES = [
  'src/modules/cron-jobs/routes.ts',
  'src/modules/sftp-users/routes.ts',
];

describe('cross-tenant admin listings name their own role', () => {
  for (const file of FILES) {
    it(`${file} guards every /admin/* route`, () => {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      const offenders: string[] = [];
      lines.forEach((line, i) => {
        if (!/app\.(get|post|put|patch|delete)\(\s*'\/admin\//.test(line)) return;
        const block = lines.slice(i, i + 4).join('\n');
        // Either its own guard, or a requireRole hook earlier in the file.
        const scopeHasHook = lines.slice(0, i)
          .some((l) => /addHook\(\s*'onRequest'\s*,\s*requireRole/.test(l));
        if (!/requireRole/.test(block) && !scopeHasHook) {
          offenders.push(`${file}:${i + 1} ${line.trim().slice(0, 60)}`);
        }
      });
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }

  it('the blanket tenant hooks alone are NOT a guard', () => {
    // Stated as a test so the next person to add an /admin/* route to a
    // tenant-scoped file cannot conclude from the hooks at the top that
    // they are covered.
    const auth = readFileSync('src/middleware/auth.ts', 'utf8');
    // requireTenantAccess keys on a path param an /admin/* route lacks…
    expect(auth).toMatch(/const requestedTenantId = params\.tenantId \?\? params\.id;/);
    expect(auth).toMatch(/if \(requestedTenantId && requestedTenantId !== user\.tenantId\)/);
    // …and the by-method role list admits tenant roles on reads.
    expect(auth).toMatch(/'super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user',/);
  });
});
