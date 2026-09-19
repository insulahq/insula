import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Sidebar from '../components/layout/Sidebar';

let runtimeInfo: {
  version: string;
  branch: string | null;
  node: string | null;
  pod: string | null;
  environment: string | null;
} | null = null;

vi.mock('../hooks/use-runtime-info', () => ({ useRuntimeInfo: () => runtimeInfo }));
vi.mock('../hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'sa', role: 'super_admin' } }) }));
vi.mock('../hooks/use-system-info', () => ({ useSystemInfo: () => ({ data: { platformName: 'Insula' } }) }));

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar open onClose={() => {}} />
    </MemoryRouter>,
  );
}

describe('admin Sidebar — runtime info block', () => {
  beforeEach(() => {
    runtimeInfo = {
      version: '2026.9.24',
      branch: 'development',
      node: 'node-a',
      pod: 'platform-api-abc',
      environment: 'production',
    };
  });

  it('labels the version and prefixes it with "v"', () => {
    renderSidebar();
    const block = screen.getByTestId('sidebar-runtime-info');
    expect(block).toHaveTextContent('Installed Version: v2026.9.24');
  });

  it('labels the serving node as the current server', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar-runtime-info')).toHaveTextContent('Current Server: node-a');
  });

  // The API may hand back a version that already carries a `v` (a tag) or one
  // that does not (the platform-version ConfigMap). Prefixing blindly would
  // print "vv2026.9.24", so the prefix is normalised rather than concatenated.
  it('does not double the "v" when the API already sent one', () => {
    runtimeInfo = { ...runtimeInfo!, version: 'v2026.9.24' };
    renderSidebar();
    const text = screen.getByTestId('sidebar-runtime-info').textContent ?? '';
    expect(text).toContain('Installed Version: v2026.9.24');
    expect(text).not.toContain('vv');
  });

  it('omits the server line entirely when the node is unknown', () => {
    runtimeInfo = { ...runtimeInfo!, node: null };
    renderSidebar();
    const text = screen.getByTestId('sidebar-runtime-info').textContent ?? '';
    expect(text).toContain('Installed Version:');
    expect(text).not.toContain('Current Server');
  });

  it('renders nothing until the runtime-info fetch resolves', () => {
    runtimeInfo = null;
    renderSidebar();
    expect(screen.queryByTestId('sidebar-runtime-info')).toBeNull();
  });
});
