/**
 * "Recent restore carts" on the tenant Backups page: resume and delete.
 *
 * Before this, the list was read-only. A tenant who started a restore and
 * navigated away could not get back into it — RestoreCart.tsx held the cart id
 * in component state only, so reopening the page minted a NEW cart and the old
 * one sat in this list until the 7-day sweep. That is why abandoned drafts
 * accumulate and why "resume" is the missing half of the feature.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const mutate = vi.fn();
const reset = vi.fn();
let deleteState = { mutate, reset, isPending: false, isError: false, error: null as unknown };

const CARTS = [
  { id: 'cart-with-bundle-0001', bundleId: 'bundle-abc', status: 'draft', description: 'partial restore', createdAt: '2026-08-28T10:00:00.000Z' },
  { id: 'cart-empty-0002', bundleId: null, status: 'draft', description: null, createdAt: '2026-08-28T11:00:00.000Z' },
  { id: 'cart-running-0003', bundleId: 'bundle-xyz', status: 'executing', description: 'in flight', createdAt: '2026-08-28T12:00:00.000Z' },
];

vi.mock('../hooks/use-tenant-backups', () => ({
  useTenantBundles: vi.fn(() => ({ data: { data: [] }, isLoading: false, isError: false })),
  useTenantRestoreCarts: vi.fn(() => ({ data: { data: CARTS }, isLoading: false })),
  useRunBundleNow: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isSuccess: false, error: null })),
  useDeleteRestoreCart: vi.fn(() => deleteState),
  downloadTenantDataExport: vi.fn(),
}));

vi.mock('@/hooks/use-tenant-context', () => ({ useTenantContext: () => ({ tenantId: 't1' }) }));
vi.mock('@/components/BundleProgressModal', () => ({ BundleProgressModal: () => null }));

const Backups = (await import('@/pages/Backups')).default;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Backups /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteState = { mutate, reset, isPending: false, isError: false, error: null };
});

describe('restore cart resume', () => {
  it('links a cart with a known bundle back into that cart', () => {
    renderPage();
    const link = screen.getByTestId('cart-resume-cart-with-bundle-0001');
    // The `cart` query param is what makes it a RESUME rather than a new cart.
    expect(link.getAttribute('href')).toBe(
      '/backups/restore/bundle-abc?cart=cart-with-bundle-0001',
    );
  });

  it('does not offer resume for an empty draft with no bundle', () => {
    // Nothing was selected yet, so there is no bundle to reopen onto.
    renderPage();
    expect(screen.queryByTestId('cart-resume-cart-empty-0002')).toBeNull();
  });

  it('does not offer resume for a cart that is mid-restore', () => {
    renderPage();
    expect(screen.queryByTestId('cart-resume-cart-running-0003')).toBeNull();
  });
});

describe('restore cart delete', () => {
  it('confirms before deleting rather than firing on the first click', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('cart-delete-cart-with-bundle-0001'));
    expect(screen.getByTestId('cart-delete-confirm')).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('deletes the cart that was clicked once confirmed', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('cart-delete-cart-with-bundle-0001'));
    fireEvent.click(screen.getByTestId('cart-delete-confirm-button'));
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(mutate.mock.calls[0][0]).toBe('cart-with-bundle-0001');
  });

  it('disables delete for a cart that is mid-restore', () => {
    // The server refuses this with 409; the button should not invite the click.
    renderPage();
    expect(screen.getByTestId('cart-delete-cart-running-0003')).toBeDisabled();
  });

  it('keeps the dialog open and shows the reason when the delete fails', () => {
    deleteState = {
      mutate, reset, isPending: false, isError: true,
      error: new Error('This restore is currently running and cannot be deleted.'),
    };
    renderPage();
    fireEvent.click(screen.getByTestId('cart-delete-cart-with-bundle-0001'));
    const dialog = screen.getByTestId('cart-delete-confirm');
    expect(dialog.textContent).toContain('currently running');
  });
});
