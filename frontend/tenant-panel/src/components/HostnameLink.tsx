import { ExternalLink } from 'lucide-react';

interface HostnameLinkProps {
  /** The hostname to open (rendered as https://host). */
  readonly host: string;
  /** Optional path appended to both the link and the displayed text. */
  readonly path?: string | null;
  readonly className?: string;
}

/**
 * Render a hostname as a link that opens the live site in a NEW TAB.
 *
 * Wildcard hosts (`*.example.com`) are not valid URLs, so they render as plain
 * text — there is no single page to open for a wildcard.
 */
export function HostnameLink({ host, path, className }: HostnameLinkProps) {
  const suffix = path && path !== '/' ? path : '';
  const display = `${host}${suffix}`;

  if (host.startsWith('*.')) {
    return <span className={className}>{display}</span>;
  }

  return (
    <a
      href={`https://${host}${suffix}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 hover:underline ${className ?? ''}`}
      title={`Open https://${host}${suffix} in a new tab`}
    >
      {display}
      <ExternalLink size={14} className="opacity-60 shrink-0" aria-hidden="true" />
    </a>
  );
}
