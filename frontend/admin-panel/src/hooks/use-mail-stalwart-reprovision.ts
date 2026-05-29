import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { StalwartReprovisionResponse } from '@insula/api-contracts';

interface Envelope {
  readonly data: StalwartReprovisionResponse;
}

/**
 * Trigger the Stalwart re-provision reconciler on demand.
 *
 * Idempotent — safe to click multiple times. The first click on a
 * fully-configured cluster will return `noOp: true` plus `acmeRenewalFired`
 * (Stalwart's AcmeRenewal task is itself idempotent: it checks current
 * cert freshness before contacting Let's Encrypt).
 *
 * On success, invalidates mail-health so the operator sees the
 * downstream effects (cert flips from rcgen → LE; ports 587/143
 * become reachable) without manual refresh.
 */
export function useMailStalwartReprovision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<Envelope>('/api/v1/admin/mail/stalwart-reprovision', {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mail', 'health'] });
    },
  });
}
