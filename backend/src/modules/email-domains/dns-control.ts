/**
 * Proof that a tenant controls a domain's DNS before mail is turned on for it.
 *
 * Enabling email registers the domain in Stalwart, and Stalwart delivers mail
 * for the domains it hosts locally. So without a proof, a tenant could add a
 * domain it does not own (a domain other tenants' mailboxes write to, say)
 * and turn mail on: mail the platform's other mailboxes send there would stay
 * inside Stalwart and land in that tenant's mailbox instead of going out.
 *
 * Either proof is enough:
 * - the domain has passed DNS verification at least once (`verifiedAt` is
 *   written only by a real verification run, never by an API write); or
 * - its MX record already points at the platform's mail host. That is the
 *   path for a mail-only domain in cname mode, whose website lives elsewhere
 *   and so never resolves to the ingress.
 */
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import { getPlatformResolver, type DnsLike } from '../dns-resolver/service.js';
import { getMailServerHostname } from '../webmail-settings/service.js';

function bareHost(name: string): string {
  return name.trim().replace(/\.+$/, '').toLowerCase();
}

/** Whether any MX of `domainName` names `mailHost`. A failed lookup is "no". */
export async function mxPointsAt(resolver: DnsLike, domainName: string, mailHost: string): Promise<boolean> {
  const target = bareHost(mailHost);
  if (!target || !resolver.resolveMx) return false;
  try {
    const records = await resolver.resolveMx(domainName);
    return records.some((r) => bareHost(r.exchange) === target);
  } catch {
    return false;
  }
}

export interface DnsControlDeps {
  readonly resolver?: DnsLike;
  readonly mailHost?: string;
}

/**
 * Throws 409 DOMAIN_DNS_CONTROL_UNPROVEN unless the domain has been verified
 * or its MX already points here. The error names the MX value to publish.
 */
export async function assertDnsControlForMail(
  db: Database,
  domain: { readonly domainName: string; readonly verifiedAt: Date | null },
  deps: DnsControlDeps = {},
): Promise<void> {
  if (domain.verifiedAt) return;
  const mailHost = deps.mailHost ?? await getMailServerHostname(db);
  const resolver = deps.resolver ?? await getPlatformResolver(db);
  if (await mxPointsAt(resolver, domain.domainName, mailHost)) return;

  const name = bareHost(domain.domainName);
  const mx = bareHost(mailHost);
  throw new ApiError(
    'DOMAIN_DNS_CONTROL_UNPROVEN',
    `Email can be turned on for '${name}' once the domain is verified, or once its MX record points to ${mx}.`,
    409,
    {
      domain: name,
      mailHost: mx,
      operatorError: {
        code: 'DOMAIN_DNS_CONTROL_UNPROVEN',
        title: 'Domain not verified yet',
        detail: `Email can only be turned on for a domain whose DNS you control. '${name}' has not passed DNS verification, and its MX record does not point to ${mx}.`,
        remediation: [
          `Verify the domain under Domains → ${name}, then turn email on.`,
          `Or, for a domain used only for email: set its MX record to ${mx} at your DNS provider, wait for it to take effect, and try again.`,
        ],
        retryable: true,
      },
    },
  );
}
