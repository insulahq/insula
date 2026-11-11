/**
 * The mail DNS check and "Re-create mail records" for one email domain.
 *
 * mail-dns-check.ts decides; this module reads what it decides on (the live
 * zone, the stored rows, the platform's records) and carries the plan out
 * through the ordinary record paths, so every write publishes to the DNS
 * server and is withdrawn or restored the way a panel edit would be.
 *
 * Only a zone the platform hosts is read or changed. A domain whose DNS is
 * elsewhere gets `checked: false`; its owner publishes the records shown.
 */

import { and, eq, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { MailDnsCheck, MailDnsRepairRequest, MailDnsRepairResult } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { dnsRecords, domains, emailDomains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { mailLogger } from '../../shared/mail-logger.js';
import {
  createDnsRecord,
  deleteDnsRecord,
  describeSyncFailure,
  removeRemoteDnsRecord,
  syncRecordToProviders,
} from '../dns-records/service.js';
import { readPublishedDkimRecords, withPublishedDkim } from '../email-dkim/keys.js';
import { managedDmarcRecords } from '../mail-events/dmarc-record.js';
import { getDefaultWebmailUrl, getMailServerHostname } from '../webmail-settings/service.js';
import { buildEmailDnsRecordsForDisplay, readMailZone, type DnsRecordSpec, type MailZoneRead } from './dns-provisioning.js';
import {
  checkMailDns,
  policyOf,
  strictestPolicy,
  withPolicy,
  type MailDnsCheck as PlanCheck,
  type PlannedRemoval,
} from './mail-dns-check.js';

const log = mailLogger().child({ module: 'mail-dns-repair' });

/**
 * Where `webmail.<domain>` points: the platform webmail host, the same target
 * the webmail toggle publishes. Null when the two are the same name (a CNAME
 * to itself is a loop, and the toggle skips it too); undefined when the
 * webmail URL cannot be read, and the builder falls back to the mail host.
 */
export async function webmailCnameTarget(db: Database, domainName: string): Promise<string | null | undefined> {
  let host: string;
  try {
    host = new URL(await getDefaultWebmailUrl(db)).hostname;
  } catch (err) {
    log.warn({ domainName, err: err instanceof Error ? err.message : String(err) }, 'webmail URL unreadable; webmail CNAME falls back to the mail host');
    return undefined;
  }
  return host.toLowerCase() === `webmail.${domainName}`.toLowerCase() ? null : host;
}

/**
 * The mail records the platform publishes for a domain, DKIM rows included.
 * The DMARC record carries the policy the domain publishes (its stored rows),
 * not the builder's default: a domain stepped up to p=reject that lost its
 * record must get p=reject back.
 */
export async function expectedMailDnsRecords(
  db: Database,
  ed: { readonly domainId: string; readonly domainName: string; readonly webmailEnabled: boolean },
): Promise<{ readonly mailHost: string; readonly records: readonly DnsRecordSpec[] }> {
  const mailHost = await getMailServerHostname(db);
  const webmailHost = ed.webmailEnabled ? await webmailCnameTarget(db, ed.domainName) : null;
  const specs = buildEmailDnsRecordsForDisplay(ed.domainName, '', '', mailHost, {
    webmailEnabled: webmailHost !== null,
    webmailHostname: webmailHost ?? undefined,
  });
  const storedDmarc = ((await managedDmarcRecords(db, [ed.domainName])).get(ed.domainName) ?? [])
    .filter((r) => r.domainId === ed.domainId);
  const policy = strictestPolicy(storedDmarc.map((r) => policyOf(r.recordValue)));
  const withStoredPolicy = policy
    ? specs.map((s) => (s.purpose === 'dmarc' ? { ...s, recordValue: withPolicy(s.recordValue, policy) } : s))
    : specs;
  return { mailHost, records: withPublishedDkim(withStoredPolicy, await readPublishedDkimRecords(db, ed.domainId, ed.domainName)) };
}

interface MailDnsState {
  readonly domainId: string;
  readonly domainName: string;
  readonly read: MailZoneRead;
  readonly plan: PlanCheck | null;
}

async function loadState(db: Database, tenantId: string, domainId: string): Promise<MailDnsState> {
  const [ed] = await db
    .select({ domainName: domains.domainName, webmailEnabled: emailDomains.webmailEnabled })
    .from(emailDomains)
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(and(eq(emailDomains.domainId, domainId), eq(emailDomains.tenantId, tenantId), eq(domains.tenantId, tenantId)));
  if (!ed) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email is not enabled for domain '${domainId}'`, 404);
  }
  const { mailHost, records: expected } = await expectedMailDnsRecords(db, {
    domainId, domainName: ed.domainName, webmailEnabled: ed.webmailEnabled === 1,
  });
  const read = await readMailZone(db, domainId, ed.domainName);
  const stored = read.zone
    ? await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId))
    : [];
  const plan = read.zone
    ? checkMailDns({ domainName: ed.domainName, mailHost, expected, zone: read.zone, stored })
    : null;
  return { domainId, domainName: ed.domainName, read, plan };
}

function toResponse(state: MailDnsState): MailDnsCheck {
  if (!state.plan) {
    return {
      checked: false,
      reason: state.read.reason,
      // Nothing read, so nothing is claimed present or absent; the records
      // to publish are the dns-records endpoint's.
      records: [],
      issues: [],
      repair: { add: [], remove: [], storedFixes: 0 },
    };
  }
  const { records, issues, plan } = state.plan;
  return {
    checked: true,
    reason: null,
    records: records.map((r) => ({
      type: r.spec.recordType, name: r.spec.recordName, value: r.spec.recordValue,
      ttl: r.spec.ttl, priority: r.spec.priority, purpose: r.spec.purpose, status: r.status,
    })),
    issues: issues.map((i) => ({ ...i })),
    repair: {
      add: plan.add.map((a) => ({ type: a.spec.recordType, name: a.spec.recordName, value: a.spec.recordValue, priority: a.spec.priority })),
      remove: plan.remove.map((r) => ({ type: r.type, name: r.name, value: r.value, optional: r.optional })),
      storedFixes: plan.adopt.length + plan.dropStored.length,
    },
  };
}

export async function getMailDnsCheck(db: Database, tenantId: string, domainId: string): Promise<MailDnsCheck> {
  return toResponse(await loadState(db, tenantId, domainId));
}

/** A packed SRV value (`0 1 993 host`) as the record form's separate fields. */
function srvFields(spec: DnsRecordSpec): { record_value: string; priority?: number; weight?: number; port?: number } {
  const [priority, weight, port, target] = spec.recordValue.trim().split(/\s+/);
  if (target === undefined) return { record_value: spec.recordValue, priority: spec.priority ?? undefined };
  return { record_value: target.replace(/\.$/, ''), priority: Number(priority), weight: Number(weight), port: Number(port) };
}

/**
 * What a tenant is told when one step fails. An ApiError from the record
 * paths is already worded for the panel; anything else (a socket error, a
 * provider's raw answer) names internal hosts, so it goes to the log only.
 */
function failureText(domainName: string, err: unknown): string {
  if (err instanceof ApiError) return err.message;
  log.warn({ domainName, err: err instanceof Error ? err.message : String(err) }, 'mail DNS repair step failed');
  return 'The DNS server did not accept the change. Try again in a few minutes.';
}

const sameRef = (a: { type: string; name: string; value: string }, b: { type: string; name: string; value: string }): boolean =>
  a.type.toUpperCase() === b.type.toUpperCase()
  && a.name.replace(/\.$/, '').toLowerCase() === b.name.replace(/\.$/, '').toLowerCase()
  && a.value.trim() === b.value.trim();

/**
 * Re-create the domain's mail records.
 *
 * One transaction, holding a per-domain lock so two repairs never interleave.
 * Every step runs on it — no second pooled connection is held while this one
 * waits. A step's DNS write is not undone by a later failure; the result says
 * which steps failed, and running the repair again converges.
 *
 * Within each group the new record is published first, and the old ones go
 * only once it is in: a refused MX leaves the old MX, not none.
 */
export async function repairMailDns(
  db: Database,
  tenantId: string,
  domainId: string,
  request: MailDnsRepairRequest = {},
): Promise<MailDnsRepairResult> {
  const keepRefs = request.keep ?? [];
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mail-dns-repair/${domainId}`}, 0))`);

    const state = await loadState(tx, tenantId, domainId);
    if (!state.plan) {
      if (state.read.reason === 'external_dns') {
        throw new ApiError(
          'DNS_NOT_AUTHORITATIVE',
          `The DNS of ${state.domainName} is hosted elsewhere, so the platform cannot change its records. Publish the records shown at your DNS provider.`,
          409,
        );
      }
      if (state.read.reason === 'zone_unlisted') {
        throw new ApiError(
          'DNS_ZONE_NOT_LISTABLE',
          `The DNS server of ${state.domainName} cannot list its records, so the platform cannot tell which are missing.`,
          409,
        );
      }
      throw new ApiError(
        'DNS_PROVIDER_ERROR',
        `The DNS server for ${state.domainName} could not be read, so nothing was changed. Try again in a few minutes.`,
        503,
      );
    }

    const { plan } = state.plan;
    const failures: MailDnsRepairResult['failures'] = [];
    const failedGroups = new Set<string>();
    let added = 0;
    let removed = 0;
    let kept = 0;

    // Each step in its own savepoint: a step whose SQL fails is undone alone
    // and does not abort the steps after it.
    const step = <T>(fn: (sp: Database) => Promise<T>): Promise<T> =>
      tx.transaction(async (sp) => fn(sp as unknown as Database));

    for (const a of plan.add) {
      try {
        await step(async (sp) => {
          if (a.storedIds.length > 0) {
            // The row is there and the server lost the value: publish it again.
            const outcome = await syncRecordToProviders(sp, state.domainName, 'create', {
              type: a.spec.recordType, name: a.spec.recordName, content: a.spec.recordValue,
              ttl: a.spec.ttl, priority: a.spec.priority,
            }, domainId);
            if (outcome.status === 'failed') {
              throw new ApiError('DNS_PUBLISH_FAILED', `The DNS server rejected this record: ${describeSyncFailure(outcome)}`, 502);
            }
          } else {
            await createDnsRecord(sp, tenantId, domainId, {
              record_type: a.spec.recordType as 'MX' | 'TXT' | 'SRV' | 'CNAME',
              record_name: a.spec.recordName,
              ttl: a.spec.ttl,
              ...(a.spec.recordType === 'SRV'
                ? srvFields(a.spec)
                : { record_value: a.spec.recordValue, priority: a.spec.priority ?? undefined }),
            });
          }
        });
        added += 1;
      } catch (err) {
        failedGroups.add(a.group);
        failures.push({ action: 'add', type: a.spec.recordType, name: a.spec.recordName, value: a.spec.recordValue, message: failureText(state.domainName, err) });
      }
    }

    const removeOne = (r: PlannedRemoval): Promise<void> => step(async (sp) => {
      if (r.storedIds.length > 0) {
        // The last row's delete withdraws the value from the server.
        for (const id of r.storedIds) await deleteDnsRecord(sp, tenantId, domainId, id);
      } else {
        await removeRemoteDnsRecord(sp, tenantId, domainId, { type: r.type, name: r.name, value: r.content });
      }
    });
    for (const r of plan.remove) {
      const ref = { type: r.type, name: r.name, value: r.value };
      if (r.optional && keepRefs.some((k) => sameRef(k, ref))) {
        kept += 1;
        continue;
      }
      if (failedGroups.has(r.group)) {
        failures.push({ action: 'remove', ...ref, message: 'Kept, because the record that replaces it could not be published.' });
        continue;
      }
      try {
        await removeOne(r);
        removed += 1;
      } catch (err) {
        failures.push({ action: 'remove', ...ref, message: failureText(state.domainName, err) });
      }
    }

    // Bookkeeping: rows for records the zone holds without one (the DMARC
    // buttons need the row), and stored SPF / DMARC rows the zone does not
    // hold. Neither changes DNS.
    for (const a of plan.adopt) {
      await tx.insert(dnsRecords).values({
        id: crypto.randomUUID(),
        domainId,
        recordType: a.type as typeof dnsRecords.$inferInsert['recordType'],
        recordName: a.name,
        recordValue: a.value,
        ttl: 3600,
        priority: a.priority,
      });
    }
    for (const d of plan.dropStored) {
      await tx.delete(dnsRecords).where(and(eq(dnsRecords.id, d.id), eq(dnsRecords.domainId, domainId)));
    }

    log.info(
      { domainName: state.domainName, added, removed, kept, failures: failures.length, storedFixes: plan.adopt.length + plan.dropStored.length },
      're-created mail DNS records',
    );
    return { added, removed, kept, failures, check: toResponse(await loadState(tx, tenantId, domainId)) };
  });
}
