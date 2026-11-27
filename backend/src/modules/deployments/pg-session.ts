/**
 * The platform's superuser session in a tenant PostgreSQL database, as an
 * `sh -c` prefix: `sh -c "$PG_SAFE_SESSION_SH" sh psql …` runs psql with
 *   - search_path pinned to pg_catalog, pg_temp — a tenant's
 *     `public.format()` cannot stand in for pg_catalog's in the platform's SQL;
 *   - from PostgreSQL 17, event_triggers off — an event trigger a tenant left
 *     while it held the superuser (login triggers included) would run as the
 *     platform. pg-hardening.ts disables those for good; this covers every
 *     connection until then, and after a restore brings one back.
 * Also default_transaction_read_only off, and standard_conforming_strings on
 * (the platform's literals are quoted for it), either of which a tenant could
 * have set otherwise for its database. Startup options outrank ALTER ROLE/DATABASE … SET, so neither
 * undoes them.
 */
/**
 * Sets and exports PGOPTIONS (plus `extra` options) for an inline `sh -c`
 * script. The server's major version comes from `postgres -V`, or psql's when
 * the server binary is not on PATH (same image, same major).
 */
export function pgSafeEnvSh(extra = ''): string {
  return "v=$({ postgres -V || psql -V; } 2>/dev/null | head -n 1 | sed -E 's/[^0-9]*([0-9]+).*/\\1/'); "
    + `PGOPTIONS='-c search_path=pg_catalog,pg_temp -c default_transaction_read_only=off -c standard_conforming_strings=on -c backslash_quote=safe_encoding${extra ? ` ${extra}` : ''}'; `
    + 'case "$v" in \'\'|*[!0-9]*) ;; *) [ "$v" -ge 17 ] && PGOPTIONS="$PGOPTIONS -c event_triggers=off";; esac; '
    + 'export PGOPTIONS;';
}

/** For db-manager: no time limits (a restore or a dump may run for hours). */
export const PG_SAFE_ENV_SH = pgSafeEnvSh();

/** The same, then `exec "$@"`. */
export const PG_SAFE_SESSION_SH = `${PG_SAFE_ENV_SH} exec "$@"`;

/**
 * The reconciler's sessions also give up instead of waiting: a tenant holding
 * a lock, or setting statement_timeout/lock_timeout for its database, must not
 * stall the pass over every other tenant.
 */
export const PG_RECONCILER_SESSION_SH = `${pgSafeEnvSh('-c statement_timeout=300000 -c lock_timeout=30000 -c idle_in_transaction_session_timeout=0')} exec "$@"`;
