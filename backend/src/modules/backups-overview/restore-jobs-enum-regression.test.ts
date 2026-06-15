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

  it('every restore_jobs status filter literal exists in restoreJobStatusEnum', () => {
    // Scan EVERY `FROM restore_jobs … status (NOT )?IN (…)` clause — both
    // the loadTenantsOverview lateral AND the loadTenantDetail standalone
    // openCart query. The earlier version only sliced the `) cart ON TRUE`
    // lateral, so it missed loadTenantDetail's stale `'completed'/'cancelled'`
    // literals (which Postgres rejects: invalid input value for enum
    // restore_job_status). We avoid false positives from backup_jobs /
    // storage_snapshots (where 'completed' IS valid) by anchoring on
    // `FROM restore_jobs`.
    const clauses = Array.from(
      source.matchAll(/FROM restore_jobs[\s\S]{0,200}?status\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/g),
      (m) => m[1],
    );
    expect(clauses.length).toBeGreaterThanOrEqual(2); // overview lateral + detail openCart

    for (const clause of clauses) {
      const literals = Array.from(clause.matchAll(/'([^']+)'/g), (m) => m[1]);
      expect(literals.length).toBeGreaterThan(0);
      for (const lit of literals) {
        expect(
          validValues,
          `a restore_jobs status filter references status='${lit}' which is not in restoreJobStatusEnum (${[...validValues].join(', ')})`,
        ).toContain(lit);
      }
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
