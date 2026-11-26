import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseFoldersResponse } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import ProtectedDatabaseFolder from '@/components/files/ProtectedDatabaseFolder';
import DatabaseDataModal from '@/components/DatabaseDataModal';

// R48: the file manager's view of the protected `database` folder, and the
// Detach / Attach dialog. The real hooks run against a mocked transport.

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: vi.fn(),
}));
const mockApiFetch = vi.mocked(apiFetch);

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
}

const folders: DatabaseFoldersResponse = {
  root: 'database',
  keptRoot: 'kept-databases',
  instances: [
    { deploymentId: 'd1', name: 'shop', catalogCode: 'mariadb', status: 'running', detachedPath: null, folder: 'database/mariadb/shop', sizeBytes: 52_428_800 },
    { deploymentId: 'd2', name: 'old', catalogCode: 'postgresql', status: 'stopped', detachedPath: 'kept-databases/old', folder: 'kept-databases/old', sizeBytes: null },
    { deploymentId: 'd3', name: 'shared', catalogCode: 'mariadb', status: 'running', detachedPath: null, folder: 'media/db', sizeBytes: 10 },
  ],
  orphans: [],
};

describe('ProtectedDatabaseFolder', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('explains the folder and lists the instances with their data sizes', async () => {
    mockApiFetch.mockResolvedValue({ data: folders });
    const onOpenKept = vi.fn();
    render(wrap(<ProtectedDatabaseFolder tenantId="t1" onOpenKept={onOpenKept} />));
    expect(screen.getByText(/Raw file access is disabled while a/)).toBeInTheDocument();
    expect(screen.getByText(/Detach data/)).toBeInTheDocument();
    const shop = await screen.findByTestId('protected-database-row-shop');
    expect(shop).toHaveTextContent('Attached, running');
    expect(shop).toHaveTextContent('50.0 MB');
    expect(screen.getByTestId('protected-database-row-old')).toHaveTextContent('Data detached');
    expect(screen.getByTestId('protected-database-row-old')).toHaveTextContent('—');
    expect(screen.getByTestId('protected-database-row-shared')).toHaveTextContent('Not protected yet');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/tenants/t1/database-folders');
    fireEvent.click(screen.getByRole('button', { name: 'kept-databases' }));
    expect(onOpenKept).toHaveBeenCalled();
  });

  it('lists folders that belong to no instance and moves them out on request', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/release-orphans')) return { data: { moved: [{ from: 'database/mariadb/x', to: 'kept-databases/x' }] } };
      return { data: { ...folders, orphans: [{ folder: 'database/mariadb/x', sizeBytes: 1024 }] } };
    });
    render(wrap(<ProtectedDatabaseFolder tenantId="t1" onOpenKept={() => undefined} />));
    expect(await screen.findByTestId('protected-database-orphans')).toHaveTextContent('database/mariadb/x');
    fireEvent.click(screen.getByTestId('release-orphan-folders'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/tenants/t1/database-folders/release-orphans', { method: 'POST' }));
  });

  it('says so when the list cannot be loaded', async () => {
    mockApiFetch.mockRejectedValue(new Error('file manager unavailable'));
    render(wrap(<ProtectedDatabaseFolder tenantId="t1" onOpenKept={() => undefined} />));
    expect(await screen.findByTestId('protected-database-folder-error')).toHaveTextContent('file manager unavailable');
  });
});

describe('DatabaseDataModal', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('detaches: explains the stop and posts to detach-data', async () => {
    mockApiFetch.mockResolvedValue({ data: { detachedPath: 'kept-databases/shop' } });
    const onClose = vi.fn();
    render(wrap(<DatabaseDataModal tenantId="t1" deploymentId="d1" deploymentName="shop" detachedPath={null} onClose={onClose} />));
    expect(screen.getByTestId('database-detach-explainer')).toHaveTextContent('/kept-databases/shop');
    fireEvent.click(screen.getByTestId('database-data-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/tenants/t1/deployments/d1/detach-data', { method: 'POST' });
  });

  it('attaches the detached folder by default and shows a refusal', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/attach-data')) throw new Error('The folder kept-databases/old is used by site.');
      return { data: { basePath: 'kept-databases', parentPath: '', folders: [] } };
    });
    const onClose = vi.fn();
    render(wrap(<DatabaseDataModal tenantId="t1" deploymentId="d2" deploymentName="old" detachedPath="kept-databases/old" onClose={onClose} />));
    fireEvent.click(screen.getByTestId('database-data-submit'));
    expect(await screen.findByTestId('database-data-error')).toHaveTextContent('is used by site');
    expect(onClose).not.toHaveBeenCalled();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/tenants/t1/deployments/d2/attach-data', { method: 'POST', body: JSON.stringify({ path: 'kept-databases/old' }) });
  });
});
