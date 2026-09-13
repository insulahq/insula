import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  METRICS_EXPORTER_ROLE,
  buildAtRiskRolesSql,
  buildDbIsolationSql,
  buildDbIsolationStateSql,
  buildSingleDbIsolationSql,
  parseAtRiskRoles,
  parseDbIsolationState,
} from './sql.js';

describe('buildDbIsolationSql', () => {
  const sql = buildDbIsolationSql();

  it('grants to the owner and the metrics exporter BEFORE revoking from PUBLIC', () => {
    // Ordering is the safety property: at no point in the statement sequence
    // does the exporter lack a path in. A refactor that moves the REVOKE up
    // reintroduces the silent metrics break this whole module is shaped around.
    const grantOwner = sql.indexOf("GRANT CONNECT ON DATABASE %I TO %I', d.datname, d.owner");
    const grantExporter = sql.indexOf(`'${METRICS_EXPORTER_ROLE}'`);
    const revoke = sql.indexOf('REVOKE CONNECT ON DATABASE %I FROM PUBLIC');
    expect(grantOwner).toBeGreaterThan(-1);
    expect(grantExporter).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(-1);
    expect(grantOwner).toBeLessThan(revoke);
    expect(grantExporter).toBeLessThan(revoke);
  });

  it('grants the exporter only when that role exists', () => {
    // On a cluster without the CNPG exporter role, an unconditional GRANT
    // aborts the whole DO block and nothing gets revoked anywhere.
    expect(sql).toContain('has_exporter boolean');
    expect(sql).toContain('IF has_exporter THEN');
  });

  it('never touches template databases', () => {
    // Revoking on template0/template1 would propagate the ACL into every
    // database created afterwards — a far larger change than this one.
    expect(sql).toContain('datistemplate = false');
  });

  it('skips databases that already refuse connections', () => {
    expect(sql).toContain('datallowconn  = true');
  });

  it('quotes every identifier through format(%I)', () => {
    // Database and role names are read from the catalog, but they are still
    // spliced into executed SQL. %I is what keeps a database named `my db`
    // (or worse) from being a syntax error or an injection.
    const executes = sql.match(/EXECUTE format\([^)]*\)/g) ?? [];
    expect(executes.length).toBe(3);
    for (const stmt of executes) expect(stmt).toContain('%I');
    expect(sql).not.toMatch(/EXECUTE '[^']*' \|\|/);
  });

  it('leaves TEMP alone', () => {
    // The default ACL is `=Tc` — CONNECT *and* TEMP. Revoking TEMP is a
    // resource-consumption decision, deliberately out of scope here.
    expect(sql).not.toContain('TEMP');
    expect(sql).not.toContain('TEMPORARY');
  });
});

describe('bootstrap.sh parity', () => {
  // `bootstrap.sh` carries a bash copy of the converger's SQL so a fresh
  // install is isolated before platform-api ever starts. Two copies of the
  // same statements is exactly the arrangement that drifts, and the drift
  // would be invisible: both halves keep running, and the install path just
  // stops applying whatever the converger learned later.
  //
  // ci-db-isolation-check.sh checks the bash side's shape. This checks the
  // thing that guard structurally cannot — that the bytes the two writers
  // send to psql are the same bytes — because sql.ts spells the role through
  // a constant, so only the BUILT string is comparable.
  const bootstrapPath = resolve(__dirname, '../../../../scripts/bootstrap.sh');

  function heredocBody(): string {
    const script = readFileSync(bootstrapPath, 'utf8');
    const start = script.indexOf("<<'DBISOSQL'");
    expect(start, 'bootstrap.sh: DBISOSQL heredoc not found').toBeGreaterThan(-1);
    const bodyStart = script.indexOf('\n', start) + 1;
    const end = script.indexOf('\nDBISOSQL\n', bodyStart);
    expect(end, 'bootstrap.sh: DBISOSQL heredoc is not terminated').toBeGreaterThan(-1);
    return script.slice(bodyStart, end);
  }

  it('sends byte-identical SQL from bootstrap.sh and the converger', () => {
    expect(heredocBody().trim()).toBe(buildDbIsolationSql().trim());
  });

  it('uses a quoted heredoc delimiter, so bash expands nothing', () => {
    // The SQL is full of `$do$`, `%I` and `$$`. An unquoted delimiter would
    // let bash eat them, producing a script that is syntactically valid and
    // semantically wrong.
    const script = readFileSync(bootstrapPath, 'utf8');
    expect(script).toContain("<<'DBISOSQL'");
    expect(script).not.toContain('<<DBISOSQL');
  });
});

describe('buildSingleDbIsolationSql', () => {
  it('shares the statement body with the all-databases converger', () => {
    // One body, two callers. A creation path that drifts from the converger
    // isolates a database differently depending on which code touched it last.
    const all = buildDbIsolationSql();
    const one = buildSingleDbIsolationSql('crowdsec');
    for (const stmt of [
      "GRANT CONNECT ON DATABASE %I TO %I', d.datname, d.owner",
      `GRANT CONNECT ON DATABASE %I TO %I', d.datname, '${METRICS_EXPORTER_ROLE}'`,
      "REVOKE CONNECT ON DATABASE %I FROM PUBLIC', d.datname",
    ]) {
      expect(all).toContain(stmt);
      expect(one).toContain(stmt);
    }
  });

  it('returns quietly when the database does not exist', () => {
    // Appended unconditionally to a script whose CREATE may have been skipped.
    const sql = buildSingleDbIsolationSql('roundcube');
    expect(sql).toContain('IF NOT FOUND THEN');
    expect(sql).toContain('RETURN;');
  });

  it('scopes to exactly the named database', () => {
    const sql = buildSingleDbIsolationSql('roundcube');
    expect(sql).toContain("p.datname = 'roundcube'");
    expect(sql).not.toContain('FOR d IN');
  });

  it('refuses a name it cannot splice safely', () => {
    // Both call sites pass module constants today. This is exported, and a
    // name spliced into a SQL literal is exactly the thing that stops being
    // constant later.
    expect(() => buildSingleDbIsolationSql("x'; DROP DATABASE platform; --")).toThrow(/unexpected database name/);
    expect(() => buildSingleDbIsolationSql('Mixed_Case')).toThrow();
    expect(() => buildSingleDbIsolationSql('')).toThrow();
  });
});

describe('buildDbIsolationStateSql', () => {
  const sql = buildDbIsolationStateSql();

  it('reads the ACL from the catalog, not from an applied intent', () => {
    expect(sql).toContain('pg_catalog.pg_database');
    expect(sql).toContain('aclexplode');
  });

  it('falls back to acldefault when datacl is NULL', () => {
    // A database nobody has ever run GRANT against has datacl = NULL, which
    // means "the default" — and the default INCLUDES PUBLIC CONNECT. Treating
    // NULL as "no grants" would report the most-open databases as the safest.
    expect(sql).toContain("acldefault('d', d.datdba)");
  });

  it('identifies PUBLIC as grantee 0', () => {
    expect(sql).toContain('a.grantee = 0');
  });

  it('coalesces an empty aggregate to a JSON array', () => {
    // json_agg over no rows is SQL NULL, which reaches the parser as an empty
    // string and would be read as a failure rather than as "no databases".
    expect(sql).toContain("'[]'::json");
  });
});

describe('buildAtRiskRolesSql', () => {
  it('asks the live catalog who could not reconnect', () => {
    const sql = buildAtRiskRolesSql();
    expect(sql).toContain('pg_stat_activity');
    expect(sql).toContain("has_database_privilege(s.usename, s.datname, 'CONNECT')");
    expect(sql).toContain('NOT pg_catalog.has_database_privilege');
  });
});

describe('parseDbIsolationState', () => {
  it('parses a well-formed payload', () => {
    const rows = parseDbIsolationState(
      '[{"datname":"platform","owner":"platform","public_connect":false,'
        + '"connect_grantees":["platform","cnpg_metrics_exporter"]}]',
    );
    expect(rows).toEqual([
      {
        datname: 'platform',
        owner: 'platform',
        publicConnect: false,
        connectGrantees: ['platform', 'cnpg_metrics_exporter'],
      },
    ]);
  });

  it('parses the real DEV payload shape verbatim', () => {
    // Captured from `psql -At` against system-db-1 on 2026-09-13, pre-change.
    // Parsers built from a doc rather than from the emitted bytes are how the
    // format drifts out from under the code.
    const raw = '[{"datname":"crowdsec","owner":"crowdsec","public_connect":true,"connect_grantees":["crowdsec"]}, '
      + '{"datname":"platform","owner":"platform","public_connect":true,"connect_grantees":["platform"]}, '
      + '{"datname":"postgres","owner":"postgres","public_connect":true,"connect_grantees":["postgres"]}, '
      + '{"datname":"roundcube","owner":"roundcube","public_connect":true,"connect_grantees":["roundcube"]}]';
    const rows = parseDbIsolationState(raw);
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(4);
    expect(rows?.every((r) => r.publicConnect)).toBe(true);
  });

  it('returns an empty array for a legitimately empty result', () => {
    expect(parseDbIsolationState('[]')).toEqual([]);
  });

  it('returns null — not [] — on malformed JSON', () => {
    // The distinction is the whole point: [] renders in the UI as "every
    // database is isolated", which is exactly what a broken readout must not
    // be allowed to claim.
    expect(parseDbIsolationState('not json')).toBeNull();
    expect(parseDbIsolationState('')).toBeNull();
  });

  it('returns null when a row is missing a field', () => {
    expect(parseDbIsolationState('[{"datname":"platform","owner":"platform"}]')).toBeNull();
    expect(
      parseDbIsolationState('[{"owner":"platform","public_connect":true,"connect_grantees":[]}]'),
    ).toBeNull();
  });

  it('returns null when public_connect is a string rather than a boolean', () => {
    // psql -At renders booleans as t/f; a future switch away from json output
    // would hand us "t", and `Boolean("f")` is true.
    expect(
      parseDbIsolationState('[{"datname":"d","owner":"o","public_connect":"f","connect_grantees":[]}]'),
    ).toBeNull();
  });

  it('returns null when the payload is a JSON object rather than an array', () => {
    expect(parseDbIsolationState('{"datname":"platform"}')).toBeNull();
  });
});

describe('parseAtRiskRoles', () => {
  it('parses rows', () => {
    expect(parseAtRiskRoles('[{"datname":"platform","usename":"roundcube"}]')).toEqual([
      { datname: 'platform', usename: 'roundcube' },
    ]);
  });

  it('treats the empty list as the good case, not as a failure', () => {
    expect(parseAtRiskRoles('[]')).toEqual([]);
  });

  it('returns null on malformed input', () => {
    expect(parseAtRiskRoles('{')).toBeNull();
    expect(parseAtRiskRoles('[{"datname":"platform"}]')).toBeNull();
  });
});
