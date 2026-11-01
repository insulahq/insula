/**
 * renewal-policy.ts as SQL, for the dashboard summaries that aggregate
 * certificates in one query. Same constants, same 90-day assumption while a
 * row's not_before is still unknown — `renewal-policy.integration.test.ts`
 * runs both against the same certificates so the two cannot drift.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  EXPIRING_REMAINING_FRACTION,
  MANAGED_CERT_PLACEHOLDER,
  MANUAL_CERT_EXPIRING_DAYS,
  RENEW_BEFORE_PERCENTAGE,
} from './renewal-policy.js';

/** Aliases are code constants, never input: they are spliced in raw. */
const ALIAS = /^[a-z_][a-z0-9_]*$/;

function checked(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error(`renewal-policy-sql: bad alias ${alias}`);
  return alias;
}

function lifetime(cert: string): string {
  checked(cert);
  return `(${cert}.expires_at - COALESCE(${cert}.not_before, ${cert}.expires_at - INTERVAL '90 days'))`;
}

/**
 * TRUE when the platform renews the certificate: its domain auto-renews AND the
 * row is a cert-manager one, not an uploaded certificate (`domain` may be a
 * LEFT JOINed alias; no domain row counts as auto-renewing, the column default).
 */
export function autoRenewedSql(cert: string, domain: string): SQL {
  return sql.raw(`(COALESCE(${checked(domain)}.ssl_auto_renew, 1) = 1`
    + ` AND ${checked(cert)}.private_key_encrypted = '${MANAGED_CERT_PLACEHOLDER}')`);
}

/**
 * When the certificate is due: cert-manager renews it with a third of its
 * lifetime left; an uploaded one is due when it turns "expiring", 30 days out.
 */
export function renewalAtSql(cert: string, autoRenewed: SQL): SQL {
  return sql`(CASE WHEN ${autoRenewed}
    THEN ${sql.raw(`${cert}.expires_at - ${lifetime(cert)} * ${RENEW_BEFORE_PERCENTAGE / 100}`)}
    ELSE ${sql.raw(`${cert}.expires_at - INTERVAL '${MANUAL_CERT_EXPIRING_DAYS} days'`)} END)`;
}

/**
 * TRUE when the certificate is "expiring" or expired by the policy.
 * `autoRenewed` is a boolean SQL expression (the domain's ssl_auto_renew).
 */
export function renewalOverdueSql(cert: string, autoRenewed: SQL): SQL {
  const life = lifetime(cert);
  return sql`(${sql.raw(`${cert}.expires_at`)} IS NOT NULL AND (
    ${sql.raw(`${cert}.expires_at`)} <= NOW()
    OR (${autoRenewed} AND ${sql.raw(`${cert}.expires_at`)} - NOW() < ${sql.raw(`${life} * ${EXPIRING_REMAINING_FRACTION}`)})
    OR (NOT (${autoRenewed}) AND ${sql.raw(`${cert}.expires_at`)} - NOW() < ${sql.raw(`INTERVAL '${MANUAL_CERT_EXPIRING_DAYS} days'`)})
  ))`;
}
