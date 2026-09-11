import { Globe, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import type { NodeDown } from '@insula/api-contracts';

interface Props {
  readonly nodesDown: readonly NodeDown[];
}

/**
 * "DNS still points at the node that just died."
 *
 * The platform does not own DNS and will not withdraw these records — that is
 * a deliberate decision (operator, 2026-09-11), not an oversight. Records are
 * usually hosted elsewhere, TTLs outlive any outage worth reacting to, and
 * rewriting a zone automatically during an incident is a good way to turn one
 * outage into two.
 *
 * But "accepted" is not the same as "invisible". Before this, the only place
 * the platform admitted it was a strikethrough on an ingress pill on the
 * Cluster Nodes page — a surface the operator had no reason to open while
 * firefighting, with no addresses to act on. Every other outage surface was
 * silent about the one step the platform cannot take for them.
 *
 * So: name the addresses, say plainly that nothing will remove them, and make
 * them copyable. Rendered only when a down node actually served ingress.
 */
export default function DnsManualActionNotice({ nodesDown }: Props) {
  const [copied, setCopied] = useState(false);
  const serving = nodesDown.filter(
    (n) => n.ingressMode !== 'none' && n.ingressAddresses.length > 0,
  );
  if (serving.length === 0) return null;

  const allAddresses = serving.flatMap((n) => n.ingressAddresses);

  const copy = () => {
    void navigator.clipboard?.writeText(allAddresses.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      data-testid="dns-manual-action-notice"
      className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm dark:border-orange-700 dark:bg-orange-900/30"
    >
      <div className="flex items-start gap-2">
        <Globe size={16} className="mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-orange-900 dark:text-orange-200">
            Manual action: DNS still points at{' '}
            {serving.map((n) => n.name).join(', ')}
          </p>
          <p className="mt-1 text-orange-800 dark:text-orange-300">
            The platform does not manage your DNS, so these records stay published and every
            request that resolves to them will time out until you withdraw them. Remove or
            repoint the following A/AAAA records at your DNS provider, then restore them when
            the node is back.
          </p>
          <ul className="mt-2 space-y-0.5" data-testid="dns-stale-addresses">
            {serving.map((n) => (
              <li key={n.name} className="font-mono text-xs text-orange-900 dark:text-orange-200">
                {n.name}: {n.ingressAddresses.join(', ')}
                {n.ingressMode === 'local' && (
                  <span className="ml-1 font-sans text-orange-700 dark:text-orange-400">
                    (served only its own routes)
                  </span>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={copy}
            data-testid="dns-copy-addresses"
            className="mt-2 inline-flex items-center gap-1 rounded border border-orange-300 px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-100 dark:border-orange-700 dark:text-orange-200 dark:hover:bg-orange-800/40"
          >
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy addresses'}
          </button>
        </div>
      </div>
    </div>
  );
}
