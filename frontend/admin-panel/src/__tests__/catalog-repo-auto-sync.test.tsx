/**
 * Each catalog repository has an auto-sync switch: on, it is synced once a day.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const repo = (id: string, autoSyncEnabled: boolean) => ({
  id, name: `repo-${id}`, url: `https://github.com/example/${id}`, branch: 'main', autoSyncEnabled,
  lastSyncedAt: '2026-11-26T10:00:00Z', status: 'active' as const, lastError: null, createdAt: '2026-11-01T00:00:00Z',
});
const setAutoSync = vi.fn();
const setPrivate = vi.fn();
const addRepo = vi.fn();
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null };
let role = 'super_admin';
let allowPrivate = false;

vi.mock('@/hooks/use-auth', () => ({
  useAuth: vi.fn((select: (s: { user: { role: string } }) => unknown) => select({ user: { role } })),
}));

vi.mock('@/hooks/use-catalog-repos', () => ({
  useCatalogRepos: vi.fn(() => ({ data: { data: [repo('a', true), repo('b', false)] }, isLoading: false, isError: false, error: null })),
  useAddCatalogRepo: vi.fn(() => ({ ...idle, mutateAsync: addRepo })),
  useDeleteCatalogRepo: vi.fn(() => idle),
  useSyncCatalogRepo: vi.fn(() => idle),
  useRestoreDefaultCatalogRepo: vi.fn(() => idle),
  useSetCatalogRepoAutoSync: vi.fn(() => ({ mutateAsync: setAutoSync, isPending: false, variables: undefined })),
  useCatalogRepoSettings: vi.fn(() => ({ data: { data: { allowPrivateAddresses: allowPrivate } }, isLoading: false })),
  useSetCatalogRepoSettings: vi.fn(() => ({ mutate: setPrivate, isPending: false, error: null })),
}));

const { default: CatalogRepoSettings } = await import('../components/CatalogRepoSettings');

describe('CatalogRepoSettings — auto-sync', () => {
  beforeEach(() => { setAutoSync.mockReset(); setPrivate.mockReset(); addRepo.mockReset(); role = 'super_admin'; allowPrivate = false; });

  it('shows each repository\'s switch in its state', () => {
    render(<CatalogRepoSettings />);
    expect(screen.getByTestId('auto-sync-repo-a')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('auto-sync-repo-b')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('turns auto-sync off and on through the update', async () => {
    setAutoSync.mockResolvedValue({ data: repo('a', false) });
    render(<CatalogRepoSettings />);
    fireEvent.click(screen.getByTestId('auto-sync-repo-a'));
    fireEvent.click(screen.getByTestId('auto-sync-repo-b'));
    await waitFor(() => expect(setAutoSync).toHaveBeenCalledTimes(2));
    expect(setAutoSync).toHaveBeenNthCalledWith(1, { id: 'a', enabled: false });
    expect(setAutoSync).toHaveBeenNthCalledWith(2, { id: 'b', enabled: true });
  });

  it('says so when the change fails', async () => {
    setAutoSync.mockRejectedValue(new Error('Repository not found'));
    render(<CatalogRepoSettings />);
    fireEvent.click(screen.getByTestId('auto-sync-repo-a'));
    expect(await screen.findByTestId('auto-sync-error-a')).toHaveTextContent('Repository not found');
  });

  it('a super admin switches private-network repositories on', () => {
    render(<CatalogRepoSettings />);
    const sw = screen.getByTestId('repo-private-setting-toggle');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(setPrivate).toHaveBeenCalledWith(true);
  });

  it('anyone else sees the setting but cannot change it', () => {
    role = 'admin';
    allowPrivate = true;
    render(<CatalogRepoSettings />);
    const sw = screen.getByTestId('repo-private-setting-toggle');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toBeDisabled();
    expect(screen.getByText(/Only a super admin can change this/)).toBeInTheDocument();
  });

  it('a new repository is added with daily sync off unless it is ticked', async () => {
    addRepo.mockResolvedValue({ data: repo('c', false) });
    render(<CatalogRepoSettings />);
    fireEvent.click(screen.getByTestId('add-repo-button'));
    expect(screen.getByTestId('repo-auto-sync-input')).not.toBeChecked();
    fireEvent.change(screen.getByTestId('repo-name-input'), { target: { value: 'mine' } });
    fireEvent.change(screen.getByTestId('repo-url-input'), { target: { value: 'https://catalog.example.test/c' } });
    fireEvent.click(screen.getByTestId('submit-repo-button'));
    await waitFor(() => expect(addRepo).toHaveBeenCalledWith(expect.objectContaining({ name: 'mine', auto_sync_enabled: false })));
  });
});
