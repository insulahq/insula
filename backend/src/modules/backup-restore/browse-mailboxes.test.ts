/**
 * The restore cart's mailbox picker sources addresses from meta.json.
 *
 * Regression guard for ADR-061: the picker used to enumerate
 * `store.listArtifacts(handle, 'mailboxes')`, a listing that has been empty
 * since the component became restic-only — so a bundle that captured every
 * mailbox rendered "No mailboxes captured in this bundle".
 */
import { describe, it, expect, vi } from 'vitest';
import type { BackupStore, BundleHandle } from '../tenant-bundles/bundle-store.js';
import { readMailboxAddresses } from './shared.js';

const handle = { bundleId: 'bkp-test' } as unknown as BundleHandle;

function storeWith(opts: {
  addresses?: string[] | undefined;
  metaThrows?: boolean;
  artifacts?: string[];
}): { store: BackupStore; listArtifacts: ReturnType<typeof vi.fn> } {
  const listArtifacts = vi.fn(async () =>
    (opts.artifacts ?? []).map((name) => ({ name, sizeBytes: 1 })),
  );
  const getMeta = vi.fn(async () => {
    if (opts.metaThrows) throw new Error('meta.json unreadable');
    return {
      components: {
        mailboxes: opts.addresses === undefined ? undefined : { addresses: opts.addresses },
      },
    };
  });
  return {
    store: { getMeta, listArtifacts } as unknown as BackupStore,
    listArtifacts,
  };
}

describe('readMailboxAddresses', () => {
  it('returns the addresses meta.json recorded, sorted', async () => {
    const { store, listArtifacts } = storeWith({
      addresses: ['zoe@example.test', 'adam@example.test'],
    });
    await expect(readMailboxAddresses(store, handle)).resolves.toEqual([
      'adam@example.test',
      'zoe@example.test',
    ]);
    // The whole point: it must not depend on objects that no longer exist.
    expect(listArtifacts).not.toHaveBeenCalled();
  });

  it('falls back to the artifact listing when meta carries no addresses', async () => {
    const { store } = storeWith({
      addresses: undefined,
      artifacts: ['old@example.test.mbox.tar.gz'],
    });
    await expect(readMailboxAddresses(store, handle)).resolves.toEqual(['old@example.test']);
  });

  it('falls back when meta.json cannot be read at all', async () => {
    const { store } = storeWith({
      metaThrows: true,
      artifacts: ['legacy@example.test.mbox.tar.gz'],
    });
    await expect(readMailboxAddresses(store, handle)).resolves.toEqual(['legacy@example.test']);
  });

  it('returns an empty list only when the bundle really captured none', async () => {
    const { store } = storeWith({ addresses: [], artifacts: [] });
    await expect(readMailboxAddresses(store, handle)).resolves.toEqual([]);
  });
});
