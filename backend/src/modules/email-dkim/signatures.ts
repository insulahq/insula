/**
 * Shared Stalwart DkimSignature helpers used by both the rotation
 * flow (./rotate.ts) and the enable/drift-repair normalization flow
 * (./normalize.ts).
 *
 * WIRE NOTE (2026-06-07): registry objects (DkimSignature et al.)
 * have NO REST endpoint on Stalwart v0.16.5 — they are managed over
 * the same JMAP surface the platform already uses for principals
 * (capability urn:stalwart:jmap), which is also what stalwart-cli
 * does internally.
 */

import {
  getJmapSession,
  dkimSignatureSet,
  type JmapAccountId,
  type JmapSetResponse,
  type StalwartDkimSignatureRow,
} from '../stalwart-jmap/client.js';

export const RSA_SIGNATURE_TYPE = 'Dkim1RsaSha256';

/** Resolve the principals account id from the JMAP session. */
export async function resolveDkimAccountId(baseUrl?: string): Promise<JmapAccountId> {
  const session = await getJmapSession(baseUrl);
  return (
    (session.primaryAccounts['urn:ietf:params:jmap:principals'] as JmapAccountId | undefined) ??
    (Object.keys(session.accounts)[0] as JmapAccountId)
  );
}

/**
 * Strip any PEM blocks (BEGIN/END markers + body) from a string.
 * Used to scrub Stalwart-echoed error bodies that might contain
 * the just-submitted private key.
 */
export function redactPemBlocks(input: string): string {
  return input.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    '[REDACTED-PEM-BLOCK]',
  );
}

export class DkimSignatureCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DkimSignatureCreateError';
  }
}

/**
 * Create an active RSA-2048 DkimSignature in Stalwart via JMAP
 * `x:DkimSignature/set` and return the server-assigned id.
 *
 * Throws DkimSignatureCreateError with a PEM-scrubbed message on any
 * failure — the request carries the private key and a JMAP error can
 * echo parts of the submitted value back.
 */
export async function createRsaDkimSignature(params: {
  accountId: JmapAccountId;
  stalwartDomainId: string;
  selector: string;
  privateKeyPem: string;
  baseUrl?: string;
}): Promise<string> {
  const { accountId, stalwartDomainId, selector, privateKeyPem, baseUrl } = params;
  const signatureTempId = `create-${selector}`;

  let res: JmapSetResponse<StalwartDkimSignatureRow>;
  try {
    res = await dkimSignatureSet({
      accountId,
      baseUrl,
      create: {
        [signatureTempId]: {
          '@type': RSA_SIGNATURE_TYPE,
          domainId: stalwartDomainId,
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
    // SECURITY (CRITICAL): scrub PEM blocks before surfacing anything
    // to logs/audit/errors.
    const safe = redactPemBlocks(err instanceof Error ? err.message : String(err)).slice(0, 500);
    throw new DkimSignatureCreateError(`Stalwart DkimSignature create failed: ${safe}`);
  }

  const created = res.created?.[signatureTempId];
  if (!created) {
    const reason = redactPemBlocks(JSON.stringify(res.notCreated ?? {})).slice(0, 500);
    throw new DkimSignatureCreateError(`Stalwart rejected DkimSignature create: ${reason}`);
  }
  return created.id;
}
