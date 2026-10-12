/**
 * Every scope the API accepts must be a scope the database accepts.
 *
 * `wafRuleExclusionScopeSchema` gained 'args' — the scope both panels
 * preselect — and the table's CHECK did not: every exclusion created with it
 * was refused by the database, for as long as nobody compared the two lists.
 * This reads the constraint as the migrations leave it and compares.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wafRuleExclusionScopeSchema } from '@insula/api-contracts';

const MIGRATIONS = join(import.meta.dirname, '../../db/migrations');

/** The scopes `waf_rule_exclusions_scope_enum` allows once every migration has run: its last definition wins. */
function scopesTheDatabaseAllows(): string[] {
  let last: string[] | null = null;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--.*$/gm, '');
    for (const m of sql.matchAll(/CONSTRAINT\s+waf_rule_exclusions_scope_enum\s+CHECK\s*\(\s*scope\s+IN\s*\(([^)]*)\)/gi)) {
      last = [...m[1]!.matchAll(/'([^']+)'/g)].map((v) => v[1]!);
    }
  }
  if (!last) throw new Error('no definition of waf_rule_exclusions_scope_enum found in the migrations');
  return last;
}

describe('WAF rule exclusion scopes', () => {
  it('the database constraint allows exactly the scopes the API accepts', () => {
    expect([...scopesTheDatabaseAllows()].sort()).toEqual([...wafRuleExclusionScopeSchema.options].sort());
  });

  it("includes 'args', the scope the panels preselect", () => {
    expect(scopesTheDatabaseAllows()).toContain('args');
  });
});
