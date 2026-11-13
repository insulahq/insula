import type { DmarcSourceSummary } from '@insula/api-contracts';

/**
 * What a DMARC source row is, besides its counts — computed by the API
 * (dmarc-source-facts.ts). Each pill explains itself in its tooltip (plain
 * `title`, drawn by the panel's tooltip layer; focusable so the keyboard
 * reaches it). Unknown is shown as nothing, never as "no".
 *
 * NOTE: the same component exists in tenant-panel; keep the two in step.
 */
export const DMARC_BADGE_TIPS = {
  cluster: 'Our own mail server: this address belongs to one of the platform\'s servers.',
  spf: 'Allowed to send for this domain by its current SPF record.',
  relay: 'Passed on mail our server signed: a forwarder or the recipient\'s mail filter, not another sender. '
    + 'SPF fails for it by design; DKIM fails only if it changed the message.',
} as const;

const PILL = 'inline-flex cursor-help items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

type BadgeFacts = Pick<DmarcSourceSummary, 'sourceIp' | 'isCluster' | 'inSpf' | 'isRelay'>;

export function DmarcSourceBadges({ source }: { readonly source: BadgeFacts }) {
  return (
    <>
      {source.isCluster === true && (
        <span
          tabIndex={0}
          title={DMARC_BADGE_TIPS.cluster}
          className={`${PILL} bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200`}
          data-testid={`dmarc-badge-cluster-${source.sourceIp}`}
        >
          Cluster
        </span>
      )}
      {source.inSpf === true && (
        <span
          tabIndex={0}
          title={DMARC_BADGE_TIPS.spf}
          className={`${PILL} bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200`}
          data-testid={`dmarc-badge-spf-${source.sourceIp}`}
        >
          SPF
        </span>
      )}
      {source.isRelay && (
        <span
          tabIndex={0}
          title={DMARC_BADGE_TIPS.relay}
          className={`${PILL} bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200`}
          data-testid={`dmarc-badge-relay-${source.sourceIp}`}
        >
          Relay
        </span>
      )}
    </>
  );
}

type PtrFacts = Pick<DmarcSourceSummary, 'sourceIp' | 'reverseDns' | 'reverseDnsStatus'>;

/** The address's reverse DNS (PTR) name, on its own line under the address. */
export function DmarcReverseDns({ source }: { readonly source: PtrFacts }) {
  const testId = `dmarc-ptr-${source.sourceIp}`;
  if (source.reverseDnsStatus === 'found' && source.reverseDns) {
    return (
      <div className="mt-0.5 break-all font-mono text-xs text-gray-500 dark:text-gray-400" title="Reverse DNS (PTR) of this address" data-testid={testId}>
        {source.reverseDns}
      </div>
    );
  }
  return (
    <div className="mt-0.5 text-xs italic text-gray-400 dark:text-gray-500" data-testid={testId}>
      {source.reverseDnsStatus === 'none' ? 'no reverse DNS' : 'reverse DNS did not answer'}
    </div>
  );
}
