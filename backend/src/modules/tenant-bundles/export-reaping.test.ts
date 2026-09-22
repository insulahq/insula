/**
 * An abandoned export must not leave a restic process streaming.
 *
 * The export reads `files` and `mailboxes` by spawning `restic dump` and
 * piping it into the outer tar (ADR-061). If the operator closes the download
 * — or the connection drops — nothing else tears that child down: it holds a
 * slot on the per-pod restic semaphore and keeps reading from the backup
 * target until the pod restarts.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { streamEncryptedExport } from './data-export.js';
import type { BackupStore, BundleHandle } from './bundle-store.js';

const handle = { bundleId: 'bkp-reap' } as unknown as BundleHandle;

function fakeStore(): BackupStore {
  return {
    getMeta: async () => ({
      schemaVersion: 2,
      backupId: 'bkp-reap',
      capturedAt: new Date().toISOString(),
      components: {},
    }),
    stat: async () => null,
    readComponent: async () => Readable.from([]),
    listArtifacts: async () => [],
  } as unknown as BackupStore;
}

/** A stream that never ends on its own — stands in for a long restic dump. */
function neverEndingResticStream(): Readable {
  return new Readable({
    read() {
      // Yield to the loop between blocks — a synchronous push loop starves
      // the runner and the test never reports.
      setTimeout(() => {
        if (!this.destroyed) this.push(Buffer.alloc(512));
      }, 5);
    },
  });
}

describe('export reaping', () => {
  it('destroys the restic stream when the consumer abandons the download', async () => {
    const raw = neverEndingResticStream();
    const out = await streamEncryptedExport({
      store: fakeStore(),
      handle,
      components: [{
        kind: 'restic',
        component: 'mailboxes',
        name: 'a@example.test',
        open: async () => raw,
      }],
    });

    // Start consuming, then walk away — exactly what a closed browser tab or a
    // dropped connection does to the reply stream.
    out.on('data', () => undefined);
    out.on('error', () => undefined);
    await new Promise((r) => setImmediate(r));
    out.destroy(new Error('client disconnected'));

    // Give the teardown a few turns of the loop to propagate.
    for (let i = 0; i < 40 && !raw.destroyed; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(raw.destroyed).toBe(true);
  });
});
