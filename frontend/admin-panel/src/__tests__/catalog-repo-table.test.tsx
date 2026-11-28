/**
 * The Repositories table fits its card: four columns, with the name, URL,
 * branch, last sync and any error of a repository in its first cell. (Seven
 * columns pushed Sync and Delete past the card's edge at laptop widths, and an
 * error made the Status column 320 px.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

type Repo = {
  id: string; name: string; url: string; branch: string; autoSyncEnabled: boolean;
  lastSyncedAt: string | null; status: 'active' | 'error' | 'syncing'; lastError: string | null; createdAt: string;
};
const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id, name: `repo-${id}`, url: `https://github.com/example/${id}`, branch: 'main', autoSyncEnabled: false,
  lastSyncedAt: '2026-11-26T10:00:00Z', status: 'active', lastError: null, createdAt: '2026-11-01T00:00:00Z', ...extra,
});
let repos: Repo[] = [];
const sync = vi.fn();
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null };

vi.mock('@/hooks/use-auth', () => ({
  useAuth: vi.fn((select: (s: { user: { role: string } }) => unknown) => select({ user: { role: 'super_admin' } })),
}));

vi.mock('@/hooks/use-catalog-repos', () => ({
  useCatalogRepos: vi.fn(() => ({ data: { data: repos }, isLoading: false, isError: false, error: null })),
  useAddCatalogRepo: vi.fn(() => idle),
  useDeleteCatalogRepo: vi.fn(() => idle),
  useSyncCatalogRepo: vi.fn(() => ({ ...idle, mutateAsync: sync })),
  useRestoreDefaultCatalogRepo: vi.fn(() => idle),
  useSetCatalogRepoAutoSync: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined })),
  useCatalogRepoSettings: vi.fn(() => ({ data: { data: { allowPrivateAddresses: false } }, isLoading: false })),
  useSetCatalogRepoSettings: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
}));

const { default: CatalogRepoSettings } = await import('../components/CatalogRepoSettings');

const headings = () => within(screen.getByTestId('repos-table')).getAllByRole('columnheader').map((th) => th.textContent?.trim());
const firstCell = (id: string) => screen.getByTestId(`repo-url-${id}`).closest('td') as HTMLElement;

describe('CatalogRepoSettings — table layout', () => {
  beforeEach(() => { repos = []; sync.mockReset(); });

  it('has four columns: Repository, Status, Auto-sync, Actions', () => {
    repos = [repo('a')];
    render(<CatalogRepoSettings />);
    expect(headings()).toEqual(['Repository', 'Status', 'Auto-sync', 'Actions']);
  });

  it('shows the name, URL and branch together in the repository cell', () => {
    repos = [repo('a', { name: 'Official Catalog', branch: 'release' })];
    render(<CatalogRepoSettings />);
    const cell = firstCell('a');
    expect(cell).toHaveTextContent('Official Catalog');
    expect(cell).toHaveTextContent('https://github.com/example/a');
    expect(cell).toHaveTextContent('release');
    // The full URL stays readable when the cell truncates it.
    expect(screen.getByTestId('repo-url-a')).toHaveAttribute('title', 'https://github.com/example/a');
  });

  it('puts the last sync in the repository cell, and says when there was none', () => {
    repos = [repo('a'), repo('b', { lastSyncedAt: null })];
    render(<CatalogRepoSettings />);
    expect(firstCell('a')).toContainElement(screen.getByTestId('repo-synced-a'));
    expect(screen.getByTestId('repo-synced-a')).toHaveTextContent(/^Synced /);
    expect(screen.getByTestId('repo-synced-a').getAttribute('title')).toMatch(/^Last synced /);
    expect(screen.getByTestId('repo-synced-b')).toHaveTextContent('Never synced');
    expect(screen.getByTestId('repo-synced-b')).not.toHaveAttribute('title');
  });

  it('shows a failed repository\'s error in its repository cell, whole, with the badge in Status', () => {
    const message = 'Repository URL refused: catalog.example.test resolves to a private-network address';
    repos = [repo('a', { status: 'error', lastError: message })];
    render(<CatalogRepoSettings />);
    const error = screen.getByTestId('repo-error-a');
    expect(error).toHaveTextContent(message);
    expect(firstCell('a')).toContainElement(error);
    expect(firstCell('a').nextElementSibling).toHaveTextContent('Error');
  });

  it('does not show a stored error while the repository is healthy', () => {
    repos = [repo('a', { status: 'active', lastError: '2 entry error(s)' })];
    render(<CatalogRepoSettings />);
    expect(screen.getByTestId('repos-table')).not.toHaveTextContent('2 entry error(s)');
  });

  it('shows a failed Sync in the repository cell', async () => {
    sync.mockRejectedValue(new Error('Could not reach the repository'));
    repos = [repo('a')];
    render(<CatalogRepoSettings />);
    fireEvent.click(screen.getByTestId('sync-repo-a'));
    const error = await screen.findByTestId('sync-error-a');
    expect(error).toHaveTextContent('Could not reach the repository');
    expect(firstCell('a')).toContainElement(error);
  });

  it('Confirm and Cancel take Sync\'s place while a delete is being confirmed', () => {
    repos = [repo('a')];
    render(<CatalogRepoSettings />);
    fireEvent.click(screen.getByTestId('delete-repo-a'));
    expect(screen.getByTestId('confirm-delete-repo-a')).toBeInTheDocument();
    expect(screen.queryByTestId('sync-repo-a')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-delete-repo-a'));
    expect(screen.getByTestId('sync-repo-a')).toBeInTheDocument();
  });

  it('the empty state spans the whole table', () => {
    render(<CatalogRepoSettings />);
    const cell = screen.getByText(/No catalog repositories configured/);
    expect(cell).toHaveAttribute('colspan', '4');
  });
});
