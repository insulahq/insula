import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomUpdatesCard } from '../components/custom-deployments/CustomUpdatesCard';

/**
 * A custom application's details modal offers the updates the Custom
 * Containers tab does. It offered none: the catalog's upgrade card refuses a
 * custom app and rendered nothing.
 */

const { updateNow, setAuto, checkResult } = vi.hoisted(() => ({
  updateNow: vi.fn(),
  setAuto: vi.fn(),
  checkResult: { current: undefined as unknown },
}));
vi.mock('@/hooks/use-custom-deployments', () => ({
  useCheckUpdatesBatch: vi.fn(() => ({ data: { data: { results: { d1: checkResult.current } } }, isLoading: false })),
  useUpdateNowCustomDeployment: vi.fn(() => ({ mutate: updateNow, isPending: false, error: null })),
  useSetAutoUpdate: vi.fn(() => ({ mutate: setAuto, isPending: false, error: null })),
  useUpgradeTag: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));
vi.mock('@/hooks/use-can-manage', () => ({ useCanManage: () => true }));

const simple = {
  id: 'd1', name: 'private-app',
  customSpec: { sourceMode: 'simple', autoUpdate: false, services: { 'private-app': { image: 'ghcr.io/acme/private:1.0.0' } } },
} as never;

function renderCard(deployment = simple) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CustomUpdatesCard tenantId="t1" deployment={deployment} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  checkResult.current = { status: 'minor', current: '1.0.0', latest: '1.2.0', reason: null, checkedAt: new Date().toISOString() };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('CustomUpdatesCard', () => {
  it('shows a newer tag and opens the upgrade dialog at it', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /minor → 1\.2\.0/ }));
    expect(screen.getByDisplayValue('ghcr.io/acme/private:1.2.0')).toBeInTheDocument();
  });

  it('re-pulls the current tag', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('custom-detail-update-now'));
    expect(updateNow).toHaveBeenCalledWith('d1', expect.anything());
  });

  it('turns auto-update on for a single container', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('custom-detail-auto-update'));
    expect(setAuto).toHaveBeenCalledWith({ id: 'd1', enabled: true }, expect.anything());
  });

  it('offers no auto-update for a stack — it has no single digest to follow', () => {
    renderCard({ ...(simple as object), customSpec: { sourceMode: 'compose', services: { a: { image: 'x:1' }, b: { image: 'y:1' } } } } as never);
    expect(screen.queryByTestId('custom-detail-auto-update')).not.toBeInTheDocument();
    expect(screen.getByTestId('custom-detail-update-now')).toBeInTheDocument();
  });
});
