import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LifecycleGate from '../components/LifecycleGate';

let lifecycle: unknown = null;
vi.mock('../hooks/use-my-lifecycle', () => ({
  useMyLifecycle: vi.fn(() => ({ data: lifecycle, isLoading: false })),
}));

const page = <div data-testid="page">page</div>;
const state = (tenantStatus: string, storageLifecycleState: string) =>
  ({ tenantStatus, storageLifecycleState, tenantId: 't', activeStorageOperation: null });

describe('LifecycleGate', () => {
  beforeEach(() => { lifecycle = null; });

  it('replaces a page with the maintenance placeholder while a storage op runs', () => {
    lifecycle = state('active', 'restoring');
    render(<LifecycleGate>{page}</LifecycleGate>);
    expect(screen.getByTestId('lifecycle-gate-blocked')).toHaveTextContent(/Maintenance in progress/);
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
  });

  it('★ keeps an allowDuringStorageOp page mounted — a restore must not unmount its own progress', () => {
    lifecycle = state('active', 'restoring');
    render(<LifecycleGate allowDuringStorageOp>{page}</LifecycleGate>);
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('still blocks an allowDuringStorageOp page for a suspended or archived account', () => {
    lifecycle = state('suspended', 'idle');
    const { unmount } = render(<LifecycleGate allowDuringStorageOp>{page}</LifecycleGate>);
    expect(screen.getByTestId('lifecycle-gate-blocked')).toHaveTextContent(/suspended/);
    unmount();
    lifecycle = state('archived', 'idle');
    render(<LifecycleGate allowDuringStorageOp>{page}</LifecycleGate>);
    expect(screen.getByTestId('lifecycle-gate-blocked')).toHaveTextContent(/archived/);
  });
});
