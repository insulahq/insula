/**
 * Loads what `banRefusal` checks against, and the allowlist check, for a ban
 * about to be issued. Fails CLOSED: when the platform's own addresses or the
 * allowlist cannot be read, the ban is refused rather than issued blind.
 */
import type { Database } from '../../db/index.js';
import { getIngressSettings, parseIngressIps } from '../ingress-routes/service.js';
import { resolveTrustSources } from './crowdsec-l4.js';
import { isIpInAllowlist, listAllowlistEntries } from './crowdsec-allowlists.js';
import { banRefusal, parseBanTarget, type BanRefusal } from './ban-safety.js';

export interface BanSafetyDeps {
  readonly db: Database;
  readonly kubeconfigPath: string | undefined;
}

/**
 * The platform's own addresses (nodes, peers, ingress) and trusted ranges, or
 * null when the node list cannot be read — resolveTrustSources answers empty
 * arrays on a kube-API error, and a working cluster always has nodes.
 */
export async function loadPlatformBanContext(
  deps: BanSafetyDeps,
): Promise<{ platformAddresses: string[]; trustedRanges: string[] } | null> {
  const trust = await resolveTrustSources(deps.kubeconfigPath);
  const nodes = [...trust.clusterPeersV4, ...trust.clusterPeersV6];
  if (nodes.length === 0) return null;
  const ingress = await getIngressSettings(deps.db);
  return {
    platformAddresses: [
      ...nodes,
      ...parseIngressIps(ingress.ingressDefaultIpv4),
      ...parseIngressIps(ingress.ingressDefaultIpv6),
    ],
    trustedRanges: [...trust.trustedRangesV4, ...trust.trustedRangesV6],
  };
}

/** Why `value` must not be banned by an operator, or null. */
export async function checkBanAllowed(
  deps: BanSafetyDeps,
  value: string,
  operatorIp: string | null,
): Promise<BanRefusal | null> {
  const target = parseBanTarget(value);
  if (!target) return banRefusal(value, { operatorIp, platformAddresses: [], trustedRanges: [] });

  const platform = await loadPlatformBanContext(deps);
  if (!platform) {
    return { code: 'BAN_TARGET_PROTECTED', message: 'Could not read the cluster\'s node addresses, so the ban cannot be checked against them — try again.' };
  }
  const refusal = banRefusal(value, { operatorIp, ...platform });
  if (refusal) return refusal;

  return allowlistRefusal(deps.kubeconfigPath, value, target.prefix === (target.family === 'ipv4' ? 32 : 128));
}

async function allowlistRefusal(
  kubeconfigPath: string | undefined,
  value: string,
  singleHost: boolean,
): Promise<BanRefusal | null> {
  const refused = (detail: string): BanRefusal => ({
    code: 'BAN_TARGET_PROTECTED',
    message: `${value} ${detail} — remove it from the allowlist first if the ban is really meant.`,
  });
  if (singleHost) {
    // isIpInAllowlist fails closed: an unreachable LAPI reads as allowlisted.
    return (await isIpInAllowlist(kubeconfigPath, parseBanTarget(value)?.network ?? value))
      ? refused('is on the CrowdSec allowlist (or the allowlist could not be checked)')
      : null;
  }
  let entries: Awaited<ReturnType<typeof listAllowlistEntries>>;
  try {
    entries = await listAllowlistEntries(kubeconfigPath);
  } catch {
    return refused('could not be checked against the CrowdSec allowlist');
  }
  const target = parseBanTarget(value);
  for (const e of entries) {
    const entry = parseBanTarget(e.value);
    if (!target || !entry || entry.family !== target.family) continue;
    const r = banRefusal(value, { operatorIp: null, platformAddresses: [], trustedRanges: [e.value] });
    if (r) return refused(`overlaps the allowlisted ${e.value}`);
  }
  return null;
}
