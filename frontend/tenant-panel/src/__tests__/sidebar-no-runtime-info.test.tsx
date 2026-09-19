import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import Sidebar from '../components/layout/Sidebar';

// If the runtime-info block ever comes back, it will come back through this
// hook — so the mock returns a FULLY POPULATED payload on purpose. Asserting
// absence against a null hook would pass even with the block restored, which
// is the failure mode this test exists to prevent.
vi.mock('@/hooks/use-runtime-info', () => ({
  useRuntimeInfo: () => ({
    version: '2026.9.24',
    branch: 'development',
    node: 'node-a',
    pod: 'platform-api-abc',
    environment: 'production',
  }),
}));
vi.mock('@/hooks/use-system-info', () => ({
  useSystemInfo: () => ({ data: { platformName: 'Insula' } }),
}));

describe('tenant Sidebar — platform internals stay hidden', () => {
  it('renders no runtime-info block', () => {
    render(<MemoryRouter><Sidebar open onClose={() => {}} /></MemoryRouter>);
    expect(screen.queryByTestId('sidebar-runtime-info')).toBeNull();
  });

  it('leaks neither the platform version nor the serving node anywhere in the sidebar', () => {
    render(<MemoryRouter><Sidebar open onClose={() => {}} /></MemoryRouter>);
    const text = screen.getByTestId('sidebar').textContent ?? '';
    expect(text).not.toContain('2026.9.24');
    expect(text).not.toContain('node-a');
    expect(text).not.toContain('development');
  });

  it('still renders the nav it is actually for', () => {
    render(<MemoryRouter><Sidebar open onClose={() => {}} /></MemoryRouter>);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByText('Applications')).toBeInTheDocument();
  });
});
