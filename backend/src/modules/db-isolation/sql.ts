/**
 * Database connection-isolation SQL (ROADMAP R36) — pure builders + parsers.
 *
 * Postgres grants `CONNECT` on every database to `PUBLIC` unless it is
 * explicitly revoked, and nothing in this repo revoked it. So every per-service
 * login role the platform creates (`roundcube`, `crowdsec`, and any future one)
 * could authenticate into the **`platform`** database with its own credentials.
 *
 * That was never a data breach: table privileges are not granted to `PUBLIC` on
 * PostgreSQL 15+, and no migration issues `GRANT … TO PUBLIC`. It is a
 * *connection-layer* gap — a leak of the WAF's database credentials should buy
 * an attacker a CrowdSec database and nothing else, where today it also bought
 * an authenticated session against the platform database to probe from.
 *
 * This module is deliberately free of Kubernetes and `pg` imports so the SQL
 * and the parsing can be unit-tested on their own.
 *
 * ## The one thing that makes this dangerous
 *
 * `cnpg_metrics_exporter` **connects to every database**, not just the app one:
 * the `pg_extensions` collector in `cnpg-default-monitoring` carries
 * `target_databases: ['*']` and its query calls `current_database()`, which
 * only answers from inside each database. Proven on DEV 2026-09-13 by sampling
 * `pg_stat_activity` across forced scrapes — connections from all four of
 * `platform`, `crowdsec`, `roundcube`, `postgres`.
 *
 * A bare `REVOKE CONNECT … FROM PUBLIC` therefore breaks the metrics collector
 * on every database, and it breaks it *silently* — the pod stays Running, the
 * endpoint keeps answering, and only `cnpg_collector_last_collection_error`
 * moves. Hence the GRANT to the exporter, applied BEFORE the revoke.
 *
 * (Sampling note for whoever re-verifies this: `pg_stat_activity` is snapshot-
 * cached per transaction, so a polling loop inside one transaction returns the
 * same rows forever. Call `pg_stat_clear_snapshot()` each iteration or you will
 * conclude the exporter never connects.)
 */

/** The CNPG-internal role that scrapes metrics out of every database. */
export const METRICS_EXPORTER_ROLE = 'cnpg_metrics_exporter';

/**
 * Converge connection isolation across every connectable, non-template
 * database in the cluster.
 *
 * Order is load-bearing: the explicit GRANTs are issued BEFORE the REVOKE, so
 * the statement sequence never describes a state in which the owner or the
 * metrics exporter has lost its path in. A `DO` block runs in a single
 * transaction, so this is atomic in practice too — but the ordering is what
 * makes the intent readable, and a future refactor that splits the block keeps
 * the safety property for free.
 *
 * Scope guards:
 *   - `datistemplate = false` — never touch `template0`/`template1`. Revoking
 *     there would propagate the ACL into every database created afterwards,
 *     which is a much larger change than the one being made here.
 *   - `datallowconn = true` — a database nobody may connect to has nothing to
 *     revoke.
 *
 * Explicit grants already present in `datacl` are preserved: `REVOKE … FROM
 * PUBLIC` removes only the `PUBLIC` entry, so a deliberate per-role grant made
 * by an operator survives. Removing the blanket is the whole change; nothing
 * here second-guesses a decision someone made on purpose.
 *
 * Note this does NOT revoke `TEMP`, the other half of the default `=Tc` ACL.
 * Temp-table creation is a resource-consumption question, not an isolation one,
 * and bundling it in would widen the blast radius of a change whose entire
 * value is being easy to reason about.
 */
export function buildDbIsolationSql(): string {
  return `DO $do$
DECLARE
  d record;
${HAS_EXPORTER_DECL}
BEGIN
  FOR d IN
    SELECT datname, pg_catalog.pg_get_userbyid(datdba) AS owner
      FROM pg_catalog.pg_database
     WHERE datistemplate = false
       AND datallowconn  = true
  LOOP
${ISOLATE_ONE_BODY}
  END LOOP;
END
$do$;`;
}

/**
 * The three statements, shared verbatim by the all-databases converger and the
 * single-database form the creation paths append.
 *
 * One body, two callers: a creation path that drifts from the converger is a
 * database that is isolated differently depending on which code touched it
 * last, which is the kind of difference nobody notices until it matters.
 */
const ISOLATE_ONE_BODY = [
  `    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', d.datname, d.owner);`,
  `    IF has_exporter THEN`,
  `      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', d.datname, '${METRICS_EXPORTER_ROLE}');`,
  `    END IF;`,
  `    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', d.datname);`,
].join('\n');

const HAS_EXPORTER_DECL =
  `  has_exporter boolean := EXISTS (\n`
  + `    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${METRICS_EXPORTER_ROLE}'\n`
  + `  );`;

/**
 * Isolation SQL for exactly one database, for appending to a creation path.
 *
 * `crowdsec-db` and `roundcube-db-reconciler` both CREATE a database and then
 * GRANT on it. Without this, a database created between two ticks of the
 * converger sits with the `PUBLIC` blanket for up to five minutes — short, but
 * it is the window during which the service that just came up is the one thing
 * connecting to the cluster.
 *
 * A database that does not exist yet is not an error: the block returns
 * quietly, so this is safe to append unconditionally to a script whose CREATE
 * may have been skipped.
 *
 * @param datname literal database name; must be a plain lowercase identifier.
 */
export function buildSingleDbIsolationSql(datname: string): string {
  // The two call sites pass module constants, not user input — but this
  // function is exported, and a name spliced into a SQL literal is exactly the
  // thing that stops being constant in a year. Reject rather than escape: a
  // name we cannot represent safely is a bug to surface, not a string to mangle.
  if (!/^[a-z_][a-z0-9_]*$/.test(datname)) {
    throw new Error(`db-isolation: refusing to build SQL for unexpected database name ${datname}`);
  }
  return `DO $do$
DECLARE
  d record;
${HAS_EXPORTER_DECL}
BEGIN
  SELECT p.datname, pg_catalog.pg_get_userbyid(p.datdba) AS owner INTO d
    FROM pg_catalog.pg_database p
   WHERE p.datname = '${datname}'
     AND p.datistemplate = false
     AND p.datallowconn  = true;
  IF NOT FOUND THEN
    RETURN;
  END IF;
${ISOLATE_ONE_BODY}
END
$do$;`;
}

/**
 * Read back the isolation state, as JSON, for the admin UI and for assertions.
 *
 * Asked of `pg_database.datacl` — the running object — rather than of whatever
 * the converger believes it applied. A converger that reports its own intent
 * is the shape of green that survives the thing it claims to check being
 * broken.
 *
 * `aclexplode` is used instead of matching on the `datacl` text because the
 * text form (`{=Tc/platform,platform=CTc/platform}`) encodes the PUBLIC entry
 * as an empty grantee, which is easy to mis-grep and impossible to read.
 *
 * `json_agg` over an empty set yields SQL NULL rather than `[]`, so the
 * `coalesce` is what stops the parser from seeing an empty string on a cluster
 * with no connectable databases.
 */
export function buildDbIsolationStateSql(): string {
  return `SELECT coalesce(json_agg(row_to_json(r) ORDER BY r.datname), '[]'::json)::text
FROM (
  SELECT d.datname                                        AS datname,
         pg_catalog.pg_get_userbyid(d.datdba)             AS owner,
         EXISTS (
           SELECT 1
             FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
            WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT'
         )                                                AS public_connect,
         coalesce((
           SELECT array_agg(pg_catalog.pg_get_userbyid(a.grantee) ORDER BY 1)
             FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
            WHERE a.grantee <> 0 AND a.privilege_type = 'CONNECT'
         ), '{}') AS connect_grantees
    FROM pg_catalog.pg_database d
   WHERE d.datistemplate = false
     AND d.datallowconn  = true
) r;`;
}

/**
 * Roles that are connected RIGHT NOW but could not reconnect.
 *
 * This is the alarm for the failure this change could plausibly cause: a role
 * somewhere that was relying on the `PUBLIC` blanket. DEV's full connection set
 * was enumerated before the change, but DEV is not production and this
 * converger runs on clusters nobody enumerated.
 *
 * An existing session is unaffected by a revoke — CONNECT is checked at
 * connection time — so such a role keeps working until its next reconnect and
 * then fails. That delay is exactly what makes it worth reporting rather than
 * waiting to discover.
 *
 * `has_database_privilege` is evaluated against the live catalog, so this is a
 * question about the state as it now is, not about what was intended.
 */
export function buildAtRiskRolesSql(): string {
  return `SELECT coalesce(json_agg(row_to_json(r) ORDER BY r.datname, r.usename), '[]'::json)::text
FROM (
  SELECT DISTINCT s.datname AS datname, s.usename AS usename
    FROM pg_catalog.pg_stat_activity s
   WHERE s.datname IS NOT NULL
     AND s.usename IS NOT NULL
     AND NOT pg_catalog.has_database_privilege(s.usename, s.datname, 'CONNECT')
) r;`;
}

/** One database's connection-isolation state, as read back from `pg_database`. */
export interface DbIsolationEntry {
  readonly datname: string;
  readonly owner: string;
  /** True while `PUBLIC` still holds CONNECT — i.e. the gap is still open. */
  readonly publicConnect: boolean;
  /** Roles holding an explicit CONNECT grant, owner included. */
  readonly connectGrantees: readonly string[];
}

/** A role connected now that would be refused on its next connection attempt. */
export interface AtRiskRole {
  readonly datname: string;
  readonly usename: string;
}

/**
 * Parse the isolation-state JSON.
 *
 * Returns `null` — never `[]` — when the payload cannot be read. An empty array
 * is a legitimate answer ("no connectable databases"), so collapsing a parse
 * failure into one would turn a broken readout into a confident, wrong "all
 * clear" in the UI.
 */
export function parseDbIsolationState(raw: string): DbIsolationEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: DbIsolationEntry[] = [];
  for (const row of parsed) {
    const r = row as Record<string, unknown>;
    if (typeof r.datname !== 'string' || typeof r.owner !== 'string') return null;
    if (typeof r.public_connect !== 'boolean') return null;
    const grantees = Array.isArray(r.connect_grantees)
      ? r.connect_grantees.filter((g): g is string => typeof g === 'string')
      : [];
    out.push({
      datname: r.datname,
      owner: r.owner,
      publicConnect: r.public_connect,
      connectGrantees: grantees,
    });
  }
  return out;
}

/** Parse the at-risk-roles JSON. `null` on an unreadable payload, as above. */
export function parseAtRiskRoles(raw: string): AtRiskRole[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: AtRiskRole[] = [];
  for (const row of parsed) {
    const r = row as Record<string, unknown>;
    if (typeof r.datname !== 'string' || typeof r.usename !== 'string') return null;
    out.push({ datname: r.datname, usename: r.usename });
  }
  return out;
}
