import { useEffect } from 'react';
import { CheckCircle, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { useTenantContext } from '@/hooks/use-tenant-context';
import { useResourceAvailability } from '@/hooks/use-resource-availability';

interface ResourceRequirementCheckProps {
  readonly minimumCpu?: string;
  readonly minimumMemory?: string;
  readonly minimumStorage?: string;
  readonly onFitsChange?: (fits: boolean) => void;
}

function parseCpu(value: string): number {
  if (value.endsWith('m')) return Number(value.slice(0, -1)) / 1000;
  return Number(value) || 0;
}

function parseMemoryGi(value: string): number {
  if (value.endsWith('Gi')) return Number(value.slice(0, -2));
  if (value.endsWith('Mi')) return Number(value.slice(0, -2)) / 1024;
  return Number(value) || 0;
}

function parseStorageGi(value: string): number {
  if (value.endsWith('Gi')) return Number(value.slice(0, -2));
  if (value.endsWith('Mi')) return Number(value.slice(0, -2)) / 1024;
  return Number(value) || 0;
}

interface ResourceRow {
  readonly label: string;
  readonly available: number;
  readonly required: number;
  readonly unit: string;
  readonly fits: boolean;
}

/**
 * Compare in whole milli-cores / MiB rather than in cores / Gi.
 *
 * `available` arrives as a JSON float. Anything that accumulates
 * per-deployment values can land a few ulps below the true remainder
 * (19 x 0.1 === 1.9000000000000006), which made an exact fit read as a
 * shortfall and disabled the Deploy button. Kubernetes has no unit finer
 * than 1m, so rounding to it cannot mask a real difference.
 */
const SCALE: Record<string, number> = { cores: 1000, Gi: 1024 };

function fitsWithin(available: number, required: number, unit: string): boolean {
  const scale = SCALE[unit] ?? 1000;
  return Math.round(available * scale) >= Math.round(required * scale);
}

/**
 * Show enough precision that two printed numbers are never equal while the
 * row says "Insufficient" — a 0.095 vs 0.100 shortfall both printed as
 * "0.10" and read as a contradiction.
 */
function formatValue(value: number, unit: string): string {
  if (unit === 'cores') {
    const precise = value.toFixed(3);
    return `${precise.endsWith('0') ? precise.slice(0, -1) : precise} ${unit}`;
  }
  return `${value.toFixed(2)} Gi`;
}

export default function ResourceRequirementCheck({
  minimumCpu,
  minimumMemory,
  minimumStorage,
  onFitsChange,
}: ResourceRequirementCheckProps) {
  const { tenantId } = useTenantContext();
  const { data, isLoading, isError } = useResourceAvailability(tenantId ?? undefined);

  const availability = data?.data;

  const rows: readonly ResourceRow[] = (() => {
    if (!availability) return [];
    const result: ResourceRow[] = [];

    if (minimumCpu) {
      const required = parseCpu(minimumCpu);
      const available = availability.cpuAvailable;
      result.push({ label: 'CPU', available, required, unit: 'cores', fits: fitsWithin(available, required, 'cores') });
    }
    if (minimumMemory) {
      const required = parseMemoryGi(minimumMemory);
      const available = availability.memoryAvailableGi;
      result.push({ label: 'Memory', available, required, unit: 'Gi', fits: fitsWithin(available, required, 'Gi') });
    }
    if (minimumStorage) {
      const required = parseStorageGi(minimumStorage);
      const available = availability.storageAvailableGi;
      result.push({ label: 'Storage', available, required, unit: 'Gi', fits: fitsWithin(available, required, 'Gi') });
    }
    return result;
  })();

  const allFit = rows.length === 0 || rows.every(r => r.fits);

  useEffect(() => {
    if (!isLoading && !isError && onFitsChange) {
      onFitsChange(allFit);
    }
  }, [allFit, isLoading, isError, onFitsChange]);

  // Permissive on error: allow deploy
  useEffect(() => {
    if (isError && onFitsChange) {
      onFitsChange(true);
    }
  }, [isError, onFitsChange]);

  // Don't render if no requirements specified
  if (!minimumCpu && !minimumMemory && !minimumStorage) {
    return null;
  }

  return (
    <div
      className="rounded-lg border border-gray-200 dark:border-gray-700 p-4"
      data-testid="resource-requirement-check"
    >
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
        Resource Requirements
      </h4>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          <span>Checking resource availability...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle size={16} />
          <span>Unable to check resource availability. You may proceed with deployment.</span>
        </div>
      )}

      {!isLoading && !isError && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map(row => (
            <div key={row.label} className="flex items-center gap-2 text-sm">
              {row.fits ? (
                <CheckCircle size={16} className="shrink-0 text-green-600 dark:text-green-400" />
              ) : (
                <XCircle size={16} className="shrink-0 text-red-600 dark:text-red-400" />
              )}
              <span className={row.fits ? 'text-gray-700 dark:text-gray-300' : 'text-red-600 dark:text-red-400'}>
                {row.label}: {formatValue(row.available, row.unit)} available ({formatValue(row.required, row.unit)} required)
                {!row.fits && <span className="font-medium"> — Insufficient</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
