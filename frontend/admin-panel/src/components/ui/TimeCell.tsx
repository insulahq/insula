/**
 * Relative timestamp with the exact wall-clock datetime on hover.
 *
 * Every backup/snapshot table shows "TIME CREATED" as a relative age;
 * operators need the absolute instant without leaving the page
 * (operator request 2026-08-26). Uses the native `title` tooltip — the
 * established pattern (MailBackupsPage, SystemBackupListSection); no
 * tooltip library exists in this panel.
 */

export function formatRelativeAge(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms <= 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/** "in 3h" / "in 2d" for future instants (snapshot expiry columns). */
export function formatRelativeUntil(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.ceil(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const d = Math.ceil(hr / 24);
  return `in ${d}d`;
}

interface TimeCellProps {
  readonly iso: string | null | undefined;
  /** 'age' = "5h ago" (default); 'until' = "in 5h" for expiry columns. */
  readonly mode?: 'age' | 'until';
  readonly className?: string;
}

export default function TimeCell({ iso, mode = 'age', className }: TimeCellProps) {
  if (!iso) return <span className={className}>{mode === 'age' ? 'never' : '—'}</span>;
  const abs = new Date(iso).toLocaleString();
  return (
    <time dateTime={iso} title={abs} className={className}>
      {mode === 'age' ? formatRelativeAge(iso) : formatRelativeUntil(iso)}
    </time>
  );
}
