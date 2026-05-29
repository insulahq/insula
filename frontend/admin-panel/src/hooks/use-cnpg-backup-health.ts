import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CnpgClusterBackupHealth } from '@insula/api-contracts';

interface Envelope {
  readonly data: CnpgClusterBackupHealth[];
}

const KEY = ['cnpg-backup-health'] as const;

/**
 * Read CNPG Backup CR health snapshot. Polls every 5 minutes (matches
 * the typical backup-cadence; faster polling burns API quota for no
 * benefit since backups don't change second-to-second).
 */
export function useCnpgBackupHealth() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<Envelope>('/api/v1/admin/cnpg-backup-health'),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60_000,
    retry: false,
  });
}
