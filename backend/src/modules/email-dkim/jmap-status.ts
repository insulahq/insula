/**
 * M12 — Read-only DKIM status endpoint backed by Stalwart JMAP.
 *
 * Stalwart 0.16 owns DKIM key generation and rotation natively.
 * The platform no longer manages `email_dkim_keys` rows.
 *
 * This module reads the live DKIM status from Stalwart's JMAP
 * `dnsZoneFile` field on the domain principal and parses out any
 * TXT records whose name contains `_domainkey`.
 *
 * Endpoint:
 *   GET /api/v1/admin/email/domains/:domainId/dkim-status
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { emailDomains } from '../../db/schema.js';
import { getDomainDnsZoneFile, getJmapSession } from '../stalwart-jmap/client.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export interface DkimSelector {
  readonly name: string;
  readonly publicKey: string | null;
  /** The raw TXT value from the zone file, e.g. "v=DKIM1; k=rsa; p=..." */
  readonly txtValue: string;
  /** True if the record looks like a well-formed DKIM TXT record */
  readonly valid: boolean;
}

export interface DkimStatusResponse {
  readonly domainId: string;
  /** Detected from the zone file comment or record names; empty when unavailable */
  readonly domainName: string;
  /** false when Stalwart hasn't populated the zone-file yet or is unreachable */
  readonly zoneFileAvailable: boolean;
  readonly selectors: readonly DkimSelector[];
  /**
   * Raw zone-file lines that matched `_domainkey` — useful for
   * debugging when the parse doesn't produce selector entries.
   */
  readonly rawLines: readonly string[];
}

/**
 * Parse DKIM selector entries from a Stalwart DNS zone file.
 *
 * Zone-file format (standard BIND / RFC 1035):
 *   <name> [<ttl>] IN TXT "<value>"
 *
 * Stalwart may emit multi-chunk values across multiple quoted TXT
 * strings. We join all quoted fragments and return the concatenated
 * value.
 *
 * Does NOT require knowing the domain name up front — matches any
 * line whose record name contains `_domainkey`.
 *
 * Exported for unit tests.
 */
export function parseDkimSelectorsFromZoneFile(zoneFile: string): {
  selectors: DkimSelector[];
  rawLines: string[];
  detectedDomain: string;
} {
  const rawLines: string[] = [];
  const selectors: DkimSelector[] = [];

  for (const rawLine of zoneFile.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    if (!/\bTXT\b/i.test(line)) continue;
    if (!/_domainkey/i.test(line)) continue;

    rawLines.push(line);

    // Name is the first token
    const firstSpace = line.search(/\s/);
    if (firstSpace === -1) continue;
    const name = line.slice(0, firstSpace).toLowerCase();

    // Collect all double-quoted fragments and join them
    const fragments: string[] = [];
    const quotedRe = /"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = quotedRe.exec(line)) !== null) {
      fragments.push(m[1]);
    }
    const txtValue = fragments.join('');

    // Extract p= (public key base64) from v=DKIM1 record
    const pMatch = /\bp=([A-Za-z0-9+/=]+)/.exec(txtValue);
    const publicKey = pMatch ? pMatch[1] : null;

    const valid =
      txtValue.startsWith('v=DKIM1') &&
      !!publicKey &&
      publicKey.length > 0;

    selectors.push({ name, publicKey, txtValue, valid });
  }

  // Try to detect the domain name from a zone-file header comment
  // e.g. "; Zone file for example.com"
  const commentMatch = /;\s*zone\s+file\s+for\s+([^\s\n]+)/i.exec(zoneFile);
  const domainFromComment = commentMatch ? commentMatch[1] : '';

  // Fallback: extract from the first selector name (selector._domainkey.domain)
  let domainFromRecord = '';
  if (!domainFromComment && selectors.length > 0) {
    const dkeyMatch = /\._domainkey\.(.+)$/.exec(selectors[0].name);
    if (dkeyMatch) domainFromRecord = dkeyMatch[1];
  }

  const detectedDomain = domainFromComment || domainFromRecord;

  return { selectors, rawLines, detectedDomain };
}

/**
 * Register the DKIM status read-only route.
 * Scoped to admin/support only — clients cannot see raw DNS zone data.
 */
export async function emailDkimStatusRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/email/domains/:domainId/dkim-status
  app.get('/admin/email/domains/:domainId/dkim-status', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support')],
  }, async (request): Promise<{ data: DkimStatusResponse }> => {
    const { domainId } = request.params as { domainId: string };

    const [emailDomain] = await app.db
      .select({
        id: emailDomains.id,
        stalwartDomainId: emailDomains.stalwartDomainId,
      })
      .from(emailDomains)
      .where(eq(emailDomains.id, domainId));

    if (!emailDomain) {
      throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email domain '${domainId}' not found`, 404);
    }

    const empty: DkimStatusResponse = {
      domainId,
      domainName: '',
      zoneFileAvailable: false,
      selectors: [],
      rawLines: [],
    };

    if (!emailDomain.stalwartDomainId) {
      // Domain exists in platform DB but hasn't been provisioned to
      // Stalwart yet (or principals-sync hasn't run).
      return success(empty);
    }

    // Fetch the JMAP session to resolve accountId
    let accountId: string;
    try {
      const session = await getJmapSession();
      accountId =
        session.primaryAccounts['urn:ietf:params:jmap:principals'] ??
        Object.keys(session.accounts)[0] ??
        'admin';
    } catch {
      // Stalwart unreachable — return graceful empty rather than 500
      return success(empty);
    }

    let zoneFile: string | null;
    try {
      zoneFile = await getDomainDnsZoneFile({
        accountId,
        domainPrincipalId: emailDomain.stalwartDomainId,
      });
    } catch {
      zoneFile = null;
    }

    if (!zoneFile) {
      return success(empty);
    }

    const { selectors, rawLines, detectedDomain } =
      parseDkimSelectorsFromZoneFile(zoneFile);

    return success<DkimStatusResponse>({
      domainId,
      domainName: detectedDomain,
      zoneFileAvailable: true,
      selectors,
      rawLines,
    });
  });
}
