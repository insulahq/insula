/**
 * Orphaned volumes are surfaced where operators already are.
 *
 * The modal listing them lives on the Storage tab, which nobody opens
 * unprompted. A 256 GiB volume sat Released on production holding 63% of the
 * cluster's schedulable storage and the only symptom was a capacity warning
 * that did not say why.
 *
 * What these pin: it appears when there is something to say, it stays SILENT
 * otherwise — including while loading and on error, because a card that shows
 * up empty or broken on every dashboard load gets trained away — and the
 * per-tenant placement shows only that tenant's volumes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const NS = 'tenant-acme-1234';
const entry = (over: Record<string, unknown> = {}) => ({
  pvName: 'pvc-1', longhornVolumeName: 'pvc-1', namespace: NS, pvcName: `${NS}-storage`,
  sizeBytes: 256 * 1024 ** 3, nodes: [], reason: 'pv_released_recent', ageDays: 0,
  ownerLabel: 'Acme', canonicalRole: null, canonicalOwner: null, ...over,
});

const Alert = (await import('@/components/OrphanedVolumesAlert')).default;

function renderAlert(props: { namespace?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
  );
  return render(<Alert {...props} />, { wrapper });
}

beforeEach(() => vi.clearAllMocks());

describe('OrphanedVolumesAlert', () => {
  it('on the dashboard, shows just the count', async () => {
    // The dashboard says SOMETHING IS THERE; the modal explains it. A summary
    // repeated between the health banner and the incident cards would be
    // noise on a page read during incidents.
    apiFetch.mockResolvedValue({
      data: { orphans: [entry(), entry({ pvName: 'pvc-2' })], totalCount: 2, totalBytes: 0, stalePvThresholdDays: 7 },
    });
    renderAlert();
    await waitFor(() => expect(screen.getByTestId('dashboard-orphaned-volumes-alert')).toBeInTheDocument());
    const text = screen.getByTestId('dashboard-orphaned-volumes-alert').textContent ?? '';
    expect(text).toContain('2');
    expect(text).toContain('orphaned volumes');
    // Not a size breakdown, not a per-volume list — that is the modal's job.
    expect(text).not.toContain('GiB');
    expect(text).not.toContain('pv released');
  });

  it('opens the management modal on click, rather than navigating away', async () => {
    // An operator who clicks a count wants the list, not a settings page they
    // then have to find the button on.
    apiFetch.mockResolvedValue({ data: { orphans: [entry()], totalCount: 1, totalBytes: 0, stalePvThresholdDays: 7 } });
    renderAlert();
    const card = await screen.findByTestId('dashboard-orphaned-volumes-alert');
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByText(/Manage Orphaned Volumes/i)).toBeInTheDocument());
  });

  it('on a tenant page, shows the volumes themselves including their size', async () => {
    // Different question here — "what is MINE" — and the answer is short.
    apiFetch.mockResolvedValue({ data: { orphans: [entry()], totalCount: 1, totalBytes: 0, stalePvThresholdDays: 7 } });
    renderAlert({ namespace: NS });
    await waitFor(() => expect(screen.getByTestId('tenant-orphaned-volumes-alert')).toBeInTheDocument());
    const text = screen.getByTestId('tenant-orphaned-volumes-alert').textContent ?? '';
    // The SIZE is the reason this matters — a near-empty volume still holds
    // its full provisioned size against schedulable capacity.
    expect(text).toContain('256 GiB');
  });

  it('renders nothing when there are none', async () => {
    apiFetch.mockResolvedValue({ data: { orphans: [], totalCount: 0, totalBytes: 0, stalePvThresholdDays: 7 } });
    const { container } = renderAlert();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent while the scan is still running', async () => {
    apiFetch.mockImplementation(() => new Promise(() => {}));
    const { container } = renderAlert();
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent when the scan fails', async () => {
    // An errored card on every dashboard load is noise, and the modal is
    // still there for a real answer.
    apiFetch.mockRejectedValue(new Error('cluster unreachable'));
    const { container } = renderAlert();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('scoped to a tenant, shows only that tenant’s volumes', async () => {
    apiFetch.mockResolvedValue({
      data: {
        orphans: [entry(), entry({ pvName: 'pvc-2', namespace: 'tenant-other-9999', ownerLabel: 'Other' })],
        totalCount: 2, totalBytes: 0, stalePvThresholdDays: 7,
      },
    });
    renderAlert({ namespace: NS });
    await waitFor(() => expect(screen.getByTestId('tenant-orphaned-volumes-alert')).toBeInTheDocument());
    const text = screen.getByTestId('tenant-orphaned-volumes-alert').textContent ?? '';
    expect(text).toContain('1 orphaned volume');
    expect(text).not.toContain('Other');
  });

  it('scoped to a tenant with none, renders nothing even though the cluster has some', async () => {
    apiFetch.mockResolvedValue({
      data: { orphans: [entry({ namespace: 'tenant-other-9999' })], totalCount: 1, totalBytes: 0, stalePvThresholdDays: 7 },
    });
    const { container } = renderAlert({ namespace: NS });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
