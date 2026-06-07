/**
 * Manual DKIM key rotation for a tenant email domain.
 *
 * Stalwart 0.16 ships with `Bootstrap.generateDkimKeys=false` (set
 * in bootstrap-plan-cm.yaml), so DKIM keys do NOT auto-rotate. The
 * tenant-panel offers a button per domain to trigger a manual
 * rotation when needed (annual key rotation hygiene, suspected
 * compromise, etc.).
 *
 * Rotation flow:
 *   1. Generate a new RSA-2048 key pair — the SAME algorithm initial
 *      provisioning uses (email-domains/dkim.ts). Rotation previously
 *      generated Ed25519 keys; that was triply broken: (a) Gmail and
 *      Microsoft 365 do not support RFC 8463 ed25519-sha256 (Gmail
 *      reports dkim=fail instead of ignoring it — see
 *      https://support.stalw.art/t/562), (b) the published TXT used
 *      formatDkimDnsValue's `k=rsa` tag + SPKI encoding, invalid for
 *      Ed25519 (RFC 8463 wants the raw 32-byte key), and (c) once the
 *      operator retired the old RSA key per our own 14-day guidance,
 *      the domain signed Ed25519-ONLY — no verifiable DKIM at the
 *      largest providers, DMARC left to SPF alone. Ed25519 may return
 *      later as an ADDITIVE second signature once the big verifiers
 *      support it (with proper `k=ed25519` raw-key DNS formatting).
 *   2. Pick a new selector name `default-<yyyymmddHHmm>` so we never
 *      reuse selectors and key history is auditable from DNS.
 *   3. Create the new DkimSignature in Stalwart via JMAP
 *      x:DkimSignature/set, leaving the existing signature ACTIVE
 *      (dual-signing window) so already-delivered messages continue
 *      to verify until the old DNS TXT TTL expires.
 *   4. Publish the new public key as a TXT record at
 *      `<new-selector>._domainkey.<domain>`.
 *   5. Return the new selector + public key + recommended retire
 *      date (now + 14 days = >2× typical DNS TTL) so the UI can
 *      show the operator when it's safe to deactivate the old key.
 *
 * What this does NOT do:
 *   - Automatic retirement of old keys. Operator decides when to
 *     remove the old key (after the dual-signing window) via a
 *     separate admin action (or by pruning DkimSignature rows in
 *     Stalwart manually). This is intentionally manual — auto-
 *     retirement before DNS propagation breaks signature
 *     verification on emails sitting in receivers' queues.
 *   - Re-signing of historical mail. DKIM signs at send time; a key
 *     rotation only affects new outgoing messages.
 */

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { emailDomains, dnsRecords, domains } from '../../db/schema.js';
import {
  getJmapSession,
  dkimSignatureSet,
  type JmapAccountId,
  type JmapSetResponse,
  type StalwartDkimSignatureRow,
} from '../stalwart-jmap/client.js';
import { generateDkimKeyPair, formatDkimDnsValue } from '../email-domains/dkim.js';
import { syncRecordToProviders } from '../email-domains/dns-provisioning.js';

export interface RotateDkimResult {
  readonly newSelector: string;
  readonly newPublicKey: string;
  readonly txtRecordName: string;
  readonly txtRecordValue: string;
  readonly recommendedRetireOldAt: string; // ISO-8601, 14 days hence
  readonly stalwartDkimSignatureId: string;
}

export interface RotateDkimDeps {
  /** Override the default Date.now()-based selector for tests. */
  readonly nowMs?: number;
}

export class DkimRotationError extends Error {
  constructor(message: string, readonly code: string, readonly stalwartStatus?: number) {
    super(message);
    this.name = 'DkimRotationError';
  }
}

// Key generation lives in email-domains/dkim.ts (RSA-2048) — rotation
// and initial provisioning MUST stay on the same algorithm so the
// `k=rsa` DNS formatting in formatDkimDnsValue applies to both and a
// post-rotation domain remains verifiable at Gmail/M365 (see header).

export function newDkimSelector(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  // YYYYMMDDhhmmss — second-precision so two operator clicks in the
  // same minute (legitimate retry) or two near-simultaneous rotations
  // across replicas don't collide on the Stalwart-side signature ID.
  // Selector format is DNS-safe (a-z, 0-9, hyphen).
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `dkim-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Create the new DkimSignature in Stalwart via JMAP `x:DkimSignature/set`.
 *
 * WIRE NOTE (2026-06-07): the previous implementation POSTed an NDJSON
 * plan to `/api/store/import` — that endpoint does not exist on
 * Stalwart v0.16.5 (404), so rotation never actually created the
 * signature. Registry objects are managed over the SAME JMAP surface
 * the platform already uses for principals (capability
 * urn:stalwart:jmap), which is also what stalwart-cli does internally.
 */
async function createDkimSignatureViaJmap(
  signatureTempId: string,
  domainId: string,
  selector: string,
  privateKeyPem: string,
): Promise<string> {
  const session = await getJmapSession(process.env.STALWART_MGMT_URL);
  const accountId: JmapAccountId =
    (session.primaryAccounts['urn:ietf:params:jmap:principals'] as JmapAccountId | undefined) ??
    (Object.keys(session.accounts)[0] as JmapAccountId);

  let res: JmapSetResponse<StalwartDkimSignatureRow>;
  try {
    res = await dkimSignatureSet({
      accountId,
      baseUrl: process.env.STALWART_MGMT_URL,
      create: {
        [signatureTempId]: {
          '@type': 'Dkim1RsaSha256',
          domainId,
          selector,
          canonicalization: 'relaxed/relaxed',
          headers: { From: true, To: true, Date: true, Subject: true, 'Message-ID': true },
          privateKey: { '@type': 'Text', secret: privateKeyPem },
          report: false,
          stage: 'active',
          thirdParty: null,
          thirdPartyHash: null,
          auid: null,
          expire: null,
          memberTenantId: null,
          nextTransitionAt: null,
        },
      },
    });
  } catch (err) {
    // SECURITY (CRITICAL): the request carried the PEM-encoded private
    // key and a JMAP error can echo parts of the submitted value back.
    // Scrub PEM blocks before surfacing anything to logs/audit/errors.
    const safe = redactPemBlocks(err instanceof Error ? err.message : String(err)).slice(0, 500);
    throw new DkimRotationError(
      `Stalwart DkimSignature create failed: ${safe}`,
      'STALWART_API_ERROR',
    );
  }

  const created = res.created?.[signatureTempId];
  if (!created) {
    const reason = redactPemBlocks(JSON.stringify(res.notCreated ?? {})).slice(0, 500);
    throw new DkimRotationError(
      `Stalwart rejected DkimSignature create: ${reason}`,
      'STALWART_API_ERROR',
    );
  }
  return created.id;
}

/**
 * Strip any PEM blocks (BEGIN/END markers + body) from a string.
 * Used to scrub Stalwart-echoed error bodies that might contain
 * the just-submitted private key.
 */
function redactPemBlocks(input: string): string {
  return input.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    '[REDACTED-PEM-BLOCK]',
  );
}

/**
 * Rotate the DKIM key for the email-domain identified by emailDomainId.
 *
 * Returns the new selector + public key + recommended retire date.
 * Caller is responsible for any UI surfacing or audit-log entry.
 */
export async function rotateDkimKey(
  db: Database,
  emailDomainId: string,
  encryptionKey: string,
  deps: RotateDkimDeps = {},
): Promise<RotateDkimResult> {
  // emailDomains has no domain_name column — JOIN to domains.
  const [emailDomain] = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      domainName: domains.domainName,
      stalwartDomainId: emailDomains.stalwartDomainId,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(eq(emailDomains.id, emailDomainId));

  if (!emailDomain) {
    throw new DkimRotationError(
      `Email domain '${emailDomainId}' not found`,
      'EMAIL_DOMAIN_NOT_FOUND',
    );
  }

  if (!emailDomain.stalwartDomainId) {
    throw new DkimRotationError(
      `Email domain '${emailDomain.domainName}' has not been provisioned to Stalwart yet`,
      'EMAIL_DOMAIN_NOT_PROVISIONED',
    );
  }

  const { privateKey, publicKey } = generateDkimKeyPair();
  const selector = newDkimSelector(deps.nowMs);
  const signatureTempId = `dkim-${selector}`;

  // 1. Create the DkimSignature in Stalwart (JMAP x:DkimSignature/set)
  const signatureId = await createDkimSignatureViaJmap(
    signatureTempId,
    emailDomain.stalwartDomainId,
    selector,
    privateKey,
  );

  // 2. Publish the new TXT record (in-DB + push to DNS provider).
  const txtName = `${selector}._domainkey.${emailDomain.domainName}`;
  const txtValue = formatDkimDnsValue(publicKey);

  const dnsRowId = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id: dnsRowId,
    domainId: emailDomain.domainId,
    recordType: 'TXT',
    recordName: txtName,
    recordValue: txtValue,
    ttl: 3600,
    priority: null,
  });

  await syncRecordToProviders(
    db,
    emailDomain.domainId,
    emailDomain.domainName,
    'create',
    {
      type: 'TXT',
      name: txtName,
      content: txtValue,
      ttl: 3600,
      priority: null,
    },
    encryptionKey,
  );

  // Recommended retire window: >2× typical DNS TTL (3600s) plus the
  // sender-receiver mail-queue residence time. 14 days covers
  // virtually all real-world cases.
  const retireAt = new Date((deps.nowMs ?? Date.now()) + 14 * 24 * 3600 * 1000);

  return {
    newSelector: selector,
    newPublicKey: publicKey,
    txtRecordName: txtName,
    txtRecordValue: txtValue,
    recommendedRetireOldAt: retireAt.toISOString(),
    stalwartDkimSignatureId: signatureId,
  };
}
