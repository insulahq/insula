import { DATA_SIZE_UNKNOWN_HELP, formatDataSize } from '@/lib/format-snapshot-size';

interface Props {
  /** `TenantSnapshot.dataSizeBytes` — null = not measured, 0 = measured zero. */
  readonly bytes: number | null;
  readonly testId?: string;
}

/**
 * Data-size cell. "Not measured" renders as a dotted "—" with a tooltip that
 * says why — never as 0, which would claim the snapshot is empty.
 */
export default function SnapshotDataSize({ bytes, testId }: Props) {
  if (bytes === null) {
    return (
      <span
        className="cursor-help text-gray-400 underline decoration-dotted underline-offset-2 dark:text-gray-500"
        title={DATA_SIZE_UNKNOWN_HELP}
        aria-label="Data size not measured"
        data-testid={testId}
        data-measured="false"
      >
        —
      </span>
    );
  }
  return (
    <span
      className="text-gray-600 dark:text-gray-400"
      title={`${bytes.toLocaleString()} bytes`}
      data-testid={testId}
      data-measured="true"
    >
      {formatDataSize(bytes)}
    </span>
  );
}
