/**
 * The restore cart's databases tab (shared RestoreCartLayout): the three
 * modes, a copy's new name, whole instances, and bundles from before
 * per-database snapshots.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RestoreCartLayout, type RestoreCartHooks, type BrowseDatabasesData } from '@insula/ui-restore-cart';

const D1 = '0b7e4c1e-0000-4000-8000-000000000001';
const D2 = '0b7e4c1e-0000-4000-8000-000000000002';
const mutate = vi.fn();
let browse: BrowseDatabasesData;
const q = <T,>(data: T) => ({ data: { data }, isLoading: false, isError: false, error: null });
const m = () => ({ mutate, isPending: false, error: null });

const hooks: RestoreCartHooks = {
  useCart: () => q({ id: 'c1', tenantId: 't1', status: 'draft', items: [], lastError: null }) as never,
  useCreateCart: () => m() as never,
  useAddItem: () => m() as never,
  useRemoveItem: () => m() as never,
  useExecuteCart: () => m() as never,
  useBrowseConfigTables: () => q({ bundleId: 'b1', tables: [] }) as never,
  useBrowseDeployments: () => q({ bundleId: 'b1', deployments: [] }) as never,
  useBrowseDomains: () => q({ bundleId: 'b1', domains: [] }) as never,
  useBrowseMailboxes: () => q({ bundleId: 'b1', addresses: [] }) as never,
  useBrowseDatabases: () => q(browse) as never,
  useBrowseFiles: () => q({ bundleId: 'b1', path: '', entries: [] }) as never,
};

function open() {
  render(<RestoreCartLayout hooks={hooks} bundleId="b1" tenantId="t1" cartId="c1" onCartCreated={() => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: /Databases/ }));
}

beforeEach(() => {
  mutate.mockClear();
  browse = {
    bundleId: 'b1',
    perDatabase: true,
    instances: [
      { deploymentId: D1, deploymentName: 'maria', engine: 'mariadb', available: true, unavailableReason: null, databases: [{ name: 'shop', sizeBytes: 2048, serverVersion: '10.11.9' }] },
      { deploymentId: D2, deploymentName: 'parked', engine: 'postgresql', available: false, unavailableReason: 'its data is detached: attach it first', databases: [{ name: 'x', sizeBytes: 1, serverVersion: null }] },
    ],
  };
});

describe('restore cart — databases', () => {
  it('a copy by default, under the name typed', () => {
    open();
    expect(screen.getByRole('radio', { name: 'As a copy' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/The original is not touched/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New database name for shop'), { target: { value: 'shop_old' } });
    const row = screen.getByText('shop').closest('li')!;
    fireEvent.click(within(row).getAllByRole('button').at(-1)!);
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'databases-by-id',
      selector: { kind: 'databases', deploymentId: D1, databases: [{ name: 'shop', targetName: 'shop_old' }], mode: 'copy' },
    }));
  });

  it('refuses a new name the server would not take', () => {
    open();
    fireEvent.change(screen.getByLabelText('New database name for shop'), { target: { value: 'shop-old' } });
    const row = screen.getByText('shop').closest('li')!;
    expect(within(row).getAllByRole('button').at(-1)).toBeDisabled();
  });

  it('in place warns, and adds a whole instance in the chosen mode', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'In place' }));
    expect(screen.getByText(/changes to them since the backup are lost/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New database name for shop')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add all' })[0]!);
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ selector: { kind: 'ids', deploymentIds: [D1], mode: 'replace' } }));
  });

  it('an instance that cannot be restored into says why, and offers nothing', () => {
    open();
    expect(screen.getByText('its data is detached: attach it first')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add all' })[1]).toBeDisabled();
  });

  it('a bundle from before per-database snapshots restores whole instances in place only', () => {
    browse = { ...browse, perDatabase: false };
    open();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/taken before databases were backed up one by one/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add all' })[0]!);
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ selector: { kind: 'ids', deploymentIds: [D1], mode: 'replace' } }));
  });
});
