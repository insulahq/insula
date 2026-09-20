/**
 * After a destructive resize, offer to remove the volume it replaced.
 *
 * A destructive resize recreates the tenant's PVC; the old Longhorn volume
 * survives Released, because the tenant StorageClass is `reclaimPolicy:
 * Retain`, and keeps its FULL provisioned size charged against schedulable
 * capacity however little is written in it. Nothing reclaims it.
 *
 * The moment the operator learns the resize worked is the moment to offer the
 * clean-up: they are there, and the volume is unambiguously the one they just
 * replaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const NS = 'tenant-acme-1234';
const orphan = (over: Record<string, unknown> = {}) => ({
  pvName: 'pvc-old', longhornVolumeName: 'pvc-old', namespace: NS, pvcName: `${NS}-storage`,
  sizeBytes: 256 * 1024 ** 3, nodes: [], reason: 'pv_released_recent', ageDays: 0,
  ownerLabel: 'Acme', canonicalRole: null, canonicalOwner: null, ...over,
});

const Offer = (await import('@/components/ReleasedSourceVolumeOffer')).default;

function renderOffer(namespace = NS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<Offer namespace={namespace} />, { wrapper });
}

beforeEach(() => vi.clearAllMocks());

describe('ReleasedSourceVolumeOffer', () => {
  it('offers the released volume, named by its size', async () => {
    apiFetch.mockResolvedValue({ data: { orphans: [orphan()], totalCount: 1, totalBytes: 0, stalePvThresholdDays: 7 } });
    renderOffer();
    await waitFor(() => expect(screen.getByTestId('released-source-volume-offer')).toBeInTheDocument());
    expect(screen.getByTestId('delete-released-source-volume').textContent).toContain('256 GiB');
  });

  it('deletes by the volume name from the scan, not a guessed one', async () => {
    // A name composed from a convention would be wrong the first time the
    // convention changed, and would delete nothing while looking like it had
    // worked.
    apiFetch.mockResolvedValue({ data: { orphans: [orphan()], totalCount: 1, totalBytes: 0, stalePvThresholdDays: 7 } });
    renderOffer();
    fireEvent.click(await screen.findByTestId('delete-released-source-volume'));
    await waitFor(() => {
      expect(apiFetch.mock.calls.some(([u, o]) =>
        String(u).includes('/admin/orphaned-volumes/pvc-old')
        && (o as { method?: string })?.method === 'DELETE')).toBe(true);
    });
  });

  it('confirms once the volume is gone', async () => {
    apiFetch.mockResolvedValue({ data: { orphans: [orphan()], totalCount: 1, totalBytes: 0, stalePvThresholdDays: 7 } });
    renderOffer();
    fireEvent.click(await screen.findByTestId('delete-released-source-volume'));
    await waitFor(() => expect(screen.getByTestId('released-source-deleted')).toBeInTheDocument());
  });

  it('offers nothing when the resize released nothing', async () => {
    // An in-place grow keeps the same volume — there is correctly nothing to
    // clean up, and an offer would point at some unrelated older orphan.
    apiFetch.mockResolvedValue({ data: { orphans: [], totalCount: 0, totalBytes: 0, stalePvThresholdDays: 7 } });
    const { container } = renderOffer();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores another tenant’s released volume', async () => {
    apiFetch.mockResolvedValue({
      data: { orphans: [orphan({ namespace: 'tenant-other-9999' })], totalCount: 1, totalBytes: 0, stalePvThresholdDays: 7 },
    });
    const { container } = renderOffer();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('picks the most recently released volume when the tenant has several', async () => {
    // The one this operation just produced, not a week-old leftover.
    apiFetch.mockResolvedValue({
      data: {
        orphans: [
          orphan({ pvName: 'pvc-older', longhornVolumeName: 'pvc-older', ageDays: 9, sizeBytes: 5 * 1024 ** 3 }),
          orphan({ ageDays: 0 }),
        ],
        totalCount: 2, totalBytes: 0, stalePvThresholdDays: 7,
      },
    });
    renderOffer();
    const btn = await screen.findByTestId('delete-released-source-volume');
    expect(btn.textContent).toContain('256 GiB');
  });
});
