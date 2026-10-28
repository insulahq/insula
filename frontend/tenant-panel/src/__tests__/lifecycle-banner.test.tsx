import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LifecycleBanner from '../components/LifecycleBanner';
import { lifecyclePollMs } from '../hooks/use-my-lifecycle';

let lifecycle: unknown = null;
vi.mock('../hooks/use-my-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/use-my-lifecycle')>()),
  useMyLifecycle: vi.fn(() => ({ data: lifecycle, isLoading: false })),
}));

const state = (storageLifecycleState: string, storageNotice?: unknown) =>
  ({ tenantStatus: 'active', storageLifecycleState, tenantId: 't', activeStorageOperation: null, storageNotice });

describe('LifecycleBanner', () => {
  beforeEach(() => { lifecycle = null; });

  it('renders nothing for a healthy, idle account', () => {
    lifecycle = state('idle', null);
    render(<LifecycleBanner />);
    expect(screen.queryByTestId('lifecycle-banner')).not.toBeInTheDocument();
  });

  it('★ names the application a failed automatic restart left down — not "until the operation completes"', () => {
    // Production: the tenant read "A storage operation failed … until the
    // operation completes" while nothing ran and sitewright was down.
    lifecycle = state('failed', { kind: 'workloads_down', workloads: ['sitewright'] });
    render(<LifecycleBanner />);
    const banner = screen.getByTestId('lifecycle-banner');
    expect(banner).toHaveTextContent('sitewright is not running.');
    expect(banner).toHaveTextContent('our operators have been notified');
    expect(banner).not.toHaveTextContent(/until the operation completes/i);
  });

  it('joins several down applications', () => {
    lifecycle = state('failed', { kind: 'workloads_down', workloads: ['blog', 'shop', 'wiki'] });
    render(<LifecycleBanner />);
    expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('blog, shop and wiki are not running.');
  });

  it('says nothing once a failed automatic restart has nothing left down', () => {
    lifecycle = state('failed', null);
    render(<LifecycleBanner />);
    expect(screen.queryByTestId('lifecycle-banner')).not.toBeInTheDocument();
  });

  it('names a failed storage operation and what is on hold', () => {
    lifecycle = state('failed', { kind: 'operation_failed', opType: 'resize' });
    render(<LifecycleBanner />);
    expect(screen.getByTestId('lifecycle-banner'))
      .toHaveTextContent('The last storage resize on your account did not finish.');
  });

  it('describes a running automatic restart as one', () => {
    lifecycle = state('quiescing', { kind: 'operation_running', opType: 'autoheal' });
    render(<LifecycleBanner />);
    expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Restarting your applications automatically.');
  });

  it('keeps the state label for a running operation', () => {
    lifecycle = state('resizing', { kind: 'operation_running', opType: 'resize' });
    render(<LifecycleBanner />);
    expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Resizing your storage.');
  });

  it('falls back to the bare state for an API without the notice', () => {
    lifecycle = state('failed');
    render(<LifecycleBanner />);
    expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('storage operation on your account did not finish');
  });
});

describe('lifecyclePollMs', () => {
  it('polls fast only while an operation runs', () => {
    expect(lifecyclePollMs('resizing', 'active')).toBe(3000);
    expect(lifecyclePollMs('failed', 'active')).toBe(30000);
    expect(lifecyclePollMs('idle', 'suspended')).toBe(10000);
  });
});
