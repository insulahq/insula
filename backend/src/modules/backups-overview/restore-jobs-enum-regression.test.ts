/**
 * Regression test for 2026-05-29.
 *
 * The `loadTenantsOverview` query had a stale enum reference:
 *
 *   WHERE tenant_id = t.id AND status NOT IN ('completed', 'failed', 'cancelled')
 *
 * `restore_job_status` enum values are { draft, executing, paused, done,
 * failed } — there is no `completed` or `cancelled`. Postgres rejected
 * the query at parse time with:
 *
 *   invalid input value for enum restore_job_status: "completed"
 *
 * which broke the entire `/admin/backups/tenants/overview` endpoint and
 * blanked out the Tenant Backups page in the admin panel.
 *
 * This test reads the source file and asserts the literal enum strings
 * inside the `restore_jobs` lateral join only reference values that
 * exist in `restoreJobStatusEnum`. Cheap; runs on every test pass;
 * catches a future refactor that silently re-introduces stale literals.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { restoreJobStatusEnum } from '../../db/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const servicePath = resolve(here, 'service.ts');

describe('backups-overview: restore_jobs status literals match enum', () => {
  const source = readFileSync(servicePath, 'utf8');
  const validValues = new Set(restoreJobStatusEnum.enumValues);

  it('every quoted literal in the restore_jobs cart lateral exists in restoreJobStatusEnum', () => {
    // Narrow to the cart subquery to avoid false positives from other
    // enum references (e.g. backup_jobs.status = 'completed' is valid;
    // that enum legitimately has 'completed').
    const startIdx = source.indexOf('FROM restore_jobs');
    expect(startIdx).toBeGreaterThan(0);
    const endIdx = source.indexOf(') cart ON TRUE', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const cartSql = source.slice(startIdx, endIdx);

    // Extract every single-quoted literal — the only quoted strings in
    // this slice are enum values for the status filter.
    const literals = Array.from(cartSql.matchAll(/'([^']+)'/g), (m) => m[1]);
    expect(literals.length).toBeGreaterThan(0);

    for (const lit of literals) {
      expect(
        validValues,
        `restore_jobs cart SQL references status='${lit}' which is not in restoreJobStatusEnum (${[...validValues].join(', ')})`,
      ).toContain(lit);
    }
  });

  it('restoreJobStatusEnum still contains the values we filter against', () => {
    // Belt-and-braces: if someone removes 'done' or 'failed' from the
    // enum, this test fails loudly instead of the cart silently
    // returning every row as "in flight".
    expect(validValues).toContain('done');
    expect(validValues).toContain('failed');
  });
});
