import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/**
 * Every table a migration writes to must actually exist.
 *
 * The failure this guards is not subtle, it is just invisible until deploy:
 * migration 0109 said `DELETE FROM monitoring_alert_state` because the Drizzle
 * export is named `alertState` and its two siblings in the same block map to
 * `monitoring_rule_overrides` / `monitoring_evaluator_lease`. The real mapped
 * name is the unprefixed `alert_state`. Postgres answered 42P01, the migration
 * runner threw, and platform-api CRASH-LOOPED on every boot — on DEV first, and
 * it would have done the same to staging and production.
 *
 * No unit test touched it and no CI guard looked, because a .sql file is opaque
 * to tsc and the migration only runs against a real database. This test closes
 * that gap by reading the same two sources the migration author should have:
 * the `pgTable('...')` literals in schema.ts (the mapped names, NOT the export
 * identifiers) plus any table a migration creates and later drops.
 */

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');
const SCHEMA_FILE = path.join(HERE, 'schema.ts');

/** Table names as MAPPED, from `pgTable('name', …)` — not the TS identifiers. */
function schemaTableNames(): Set<string> {
  const src = fs.readFileSync(SCHEMA_FILE, 'utf8');
  return new Set([...src.matchAll(/pgTable\(\s*['"]([a-zA-Z0-9_]+)['"]/g)].map((m) => m[1]));
}

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Tables any migration creates. A migration may legitimately write to a table
 * that schema.ts no longer declares — 0108 drops the retired `backups` table —
 * so the known-good set is "declared in schema.ts OR created by a migration".
 */
function migrationCreatedTables(): Set<string> {
  const names = new Set<string>();
  for (const f of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?/gi)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** DML targets — the statements that fail loudly at boot against a missing table. */
function dmlTargets(sql: string): string[] {
  const stripped = sql.replace(/^\s*--.*$/gm, '');
  const out: string[] = [];
  for (const re of [
    /DELETE\s+FROM\s+"?([a-zA-Z0-9_]+)"?/gi,
    // \b after SET matters: without it, case-insensitive `SET` matches the
    // first three letters of `setting_value`, so `ON CONFLICT … DO UPDATE
    // SET setting_value = …` parsed as "UPDATE the table named SET".
    /UPDATE\s+"?([a-zA-Z0-9_]+)"?\s+SET\b/gi,
    /INSERT\s+INTO\s+"?([a-zA-Z0-9_]+)"?/gi,
  ]) {
    for (const m of stripped.matchAll(re)) out.push(m[1]);
  }
  return out;
}

describe('migration SQL references real tables', () => {
  const known = new Set([...schemaTableNames(), ...migrationCreatedTables()]);

  it('reads a plausible schema (the guard is not vacuous)', () => {
    // If the pgTable regex ever stops matching, `known` goes empty and every
    // assertion below passes trivially while checking nothing.
    expect(schemaTableNames().size).toBeGreaterThan(50);
    expect(schemaTableNames().has('alert_state')).toBe(true);
    expect(migrationFiles().length).toBeGreaterThan(50);
  });

  it('finds DML to check (the guard is not vacuous)', () => {
    const total = migrationFiles()
      .reduce((n, f) => n + dmlTargets(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('every DELETE/UPDATE/INSERT target exists in schema.ts or is created by a migration', () => {
    const offenders: string[] = [];
    for (const f of migrationFiles()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      for (const t of dmlTargets(sql)) {
        if (!known.has(t)) offenders.push(`${f}: writes to unknown table "${t}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
