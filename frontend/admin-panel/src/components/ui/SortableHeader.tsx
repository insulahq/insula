import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import type { SortDirection } from '@/hooks/use-sortable';

interface SortableHeaderProps {
  readonly label: string;
  readonly sortKey: string;
  readonly currentKey: string;
  readonly direction: SortDirection;
  readonly onSort: (key: string) => void;
  readonly className?: string;
  /** Optional native tooltip explaining what the column measures. */
  readonly title?: string;
  /** Cell padding — override to match a table whose cells are not `px-5`. */
  readonly padding?: string;
}

export default function SortableHeader({ label, sortKey, currentKey, direction, onSort, className = '', title, padding = 'px-5 py-3' }: SortableHeaderProps) {
  const isActive = currentKey === sortKey;

  return (
    <th
      className={`${padding} cursor-pointer select-none hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${className}`}
      onClick={() => onSort(sortKey)}
      data-testid={`sort-${sortKey}`}
      title={title}
    >
      <div className="inline-flex items-center gap-1">
        <span>{label}</span>
        {isActive ? (
          direction === 'asc' ? (
            <ChevronUp size={14} className="text-brand-500" />
          ) : (
            <ChevronDown size={14} className="text-brand-500" />
          )
        ) : (
          <ChevronsUpDown size={12} className="text-gray-300 dark:text-gray-600" />
        )}
      </div>
    </th>
  );
}
