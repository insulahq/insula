import clsx from 'clsx';
import { resourceBarColor, resourcePercent, resourceRatio } from '@/lib/resource-usage';

interface ResourceBarProps {
  readonly used: number;
  readonly total: number;
  readonly label?: string;
  readonly unit?: string;
}

export default function ResourceBar({ used, total, label, unit = '' }: ResourceBarProps) {
  // Shared policy — see lib/resource-usage.ts. Was 70/90 here, 80/100 on the
  // tenant Resource Usage page and 50/80 in the metrics modal, so the same
  // utilisation rendered as three different severities depending on the screen.
  const percentage = resourcePercent(used, total);
  const color = resourceBarColor(resourceRatio(used, total));

  return (
    <div data-testid="resource-bar">
      {label && (
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">{label}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {used}
            {unit} / {total}
            {unit}
          </span>
        </div>
      )}
      <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={clsx('h-full rounded-full transition-all', color)}
          style={{ width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}
