/**
 * use-cnpg-backup-now — operator "Backup Now" mutation hook.
 *
 * Posts to /api/v1/admin/cnpg-backup-now which creates a CNPG Backup
 * CR on the named cluster. The backend returns immediately after the
 * CR is accepted; the actual barman-cloud upload runs asynchronously.
 *
 * On success we invalidate the catalogue + health queries so the new
 * backup appears in the BackupListSection + the HealthCard's
 * last-backup-age line as soon as CNPG writes the first status update.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CnpgBackupNowRequest,
  CnpgBackupNowResponse,
} from '@k8s-hosting/api-contracts';

export function useCnpgBackupNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CnpgBackupNowRequest) =>
      apiFetch<{ data: CnpgBackupNowResponse }>('/api/v1/admin/cnpg-backup-now', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // Refresh the rolled-up health card + the per-cluster catalogue.
      // The new backup may not be visible immediately (CNPG plugin
      // sidecar takes a few seconds to start the pg_basebackup), but
      // the catalogue refetch puts it within the operator's next click.
      void qc.invalidateQueries({ queryKey: ['cnpg-backup-health'] });
      void qc.invalidateQueries({ queryKey: ['cnpg-backup-catalogue'] });
    },
  });
}
