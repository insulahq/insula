/**
 * The export must carry what the bundle actually holds.
 *
 * Regression guard for ADR-061: `files` and `mailboxes` exist only as restic
 * snapshots, the export enumerated the object store, and a missing artifact
 * was skipped in silence — so an export shipped the tenant's DB rows and TLS
 * keys and neither their files nor their mail.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveExportSources, type ExportSourceCtx } from './export-sources.js';

const SNAP_A = 'a'.repeat(64);
const SNAP_B = 'b'.repeat(64);
const SNAP_F = 'f'.repeat(64);

function ctxWith(rows: Array<Record<string, unknown>>): ExportSourceCtx {
  return {
    db: {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    },
    k8s: {},
    secretsKeyHex: '0'.repeat(64),
  } as unknown as ExportSourceCtx;
}

const noArtifacts = vi.fn(async () => []);

describe('resolveExportSources', () => {
  it('emits one restic source per mailbox snapshot', async () => {
    const sources = await resolveExportSources(
      ctxWith([
        { component: 'mailboxes', status: 'completed', artifactName: 'a@example.test', sha256: SNAP_A },
        { component: 'mailboxes', status: 'completed', artifactName: 'b@example.test', sha256: SNAP_B },
      ]),
      'bkp-1',
      noArtifacts,
    );
    expect(sources).toEqual([
      { kind: 'restic', component: 'mailboxes', name: 'a@example.test', snapshotId: SNAP_A, dumpPath: '/capture/a@example.test', stripPrefix: 'capture/a@example.test' },
      { kind: 'restic', component: 'mailboxes', name: 'b@example.test', snapshotId: SNAP_B, dumpPath: '/capture/b@example.test', stripPrefix: 'capture/b@example.test' },
    ]);
  });

  it('emits the files snapshot with the capture root as its dump path', async () => {
    const sources = await resolveExportSources(
      ctxWith([{ component: 'files', status: 'completed', artifactName: 'archive.tar.gz', sha256: SNAP_F }]),
      'bkp-1',
      noArtifacts,
    );
    expect(sources).toEqual([
      { kind: 'restic', component: 'files', name: 'archive', snapshotId: SNAP_F, dumpPath: '/source', stripPrefix: 'source' },
    ]);
  });

  it('reads a pre-ADR-061 mailboxes row as the whole-tenant tarball', async () => {
    // Placeholder artifact name + a snapshot means the old stdin capture.
    const sources = await resolveExportSources(
      ctxWith([{ component: 'mailboxes', status: 'completed', artifactName: '__pending__', sha256: SNAP_A }]),
      'bkp-1',
      noArtifacts,
    );
    expect(sources).toEqual([
      { kind: 'restic', component: 'mailboxes', name: 'maildir.tar', snapshotId: SNAP_A, dumpPath: '/maildir.tar', stripPrefix: '' },
    ]);
  });

  it('keeps object artifacts and skips the export wrapper it would otherwise nest', async () => {
    const listArtifacts = vi.fn(async (c: string) => (
      c === 'config'
        ? [{ name: 'db-rows.json.gz' }, { name: 'data-export-bkp-1.tar.gz.enc' }]
        : c === 'secrets' ? [{ name: 'tls.json.gz.enc' }] : []
    ));
    const sources = await resolveExportSources(ctxWith([]), 'bkp-1', listArtifacts);
    expect(sources.map((s) => s.name)).toEqual(['db-rows.json.gz', 'tls.json.gz.enc']);
  });

  it('does not export a component twice when it has both an object and a snapshot', async () => {
    const listArtifacts = vi.fn(async (c: string) => (
      c === 'files' ? [{ name: 'archive.tar.gz' }] : []
    ));
    const sources = await resolveExportSources(
      ctxWith([{ component: 'files', status: 'completed', artifactName: 'archive.tar.gz', sha256: SNAP_F }]),
      'bkp-1',
      listArtifacts,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe('artifact');
  });

  it('ignores a component row with no usable snapshot', async () => {
    const sources = await resolveExportSources(
      ctxWith([
        { component: 'mailboxes', status: 'completed', artifactName: 'a@example.test', sha256: null },
        { component: 'mailboxes', status: 'completed', artifactName: 'b@example.test', sha256: 'deadbeef' },
      ]),
      'bkp-1',
      noArtifacts,
    );
    expect(sources).toEqual([]);
  });
});
