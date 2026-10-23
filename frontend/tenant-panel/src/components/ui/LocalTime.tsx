import { formatTimestamp } from '@/lib/format-timestamp';
import { utcOffsetLabel } from '@/lib/format-traffic';

interface LocalTimeProps {
  readonly iso: string;
  readonly seconds?: boolean;
  readonly className?: string;
}

/**
 * An event's instant in the viewer's time zone, with UTC on hover. The
 * column header names today's offset; a row whose offset differs (a
 * daylight-saving change inside the listed window) names its own.
 */
export default function LocalTime({ iso, seconds = false, className }: LocalTimeProps) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return <span className={className}>—</span>;
  const offset = utcOffsetLabel(at);
  return (
    <time dateTime={at.toISOString()} title={`${formatTimestamp(at, { seconds, utc: true })} UTC`} className={className}>
      {formatTimestamp(at, { seconds })}
      {offset !== utcOffsetLabel() && <span className="block text-[10px]">{offset}</span>}
    </time>
  );
}
