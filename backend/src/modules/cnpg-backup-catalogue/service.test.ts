import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  listBackupsFromObjectStore,
  parseBackupInfo,
  parseDestinationPath,
  __clearCatalogueCache,
} from './service.js';
import type * as k8s from '@kubernetes/client-node';

// Mock the shim creds loader — return a fixed 32B raw key so the HKDF
// derivations are deterministic. The actual derivation logic is exercised
// by backup-rclone-shim/crypto.test.ts.
vi.mock('../backup-rclone-shim/service.js', async () => ({
  loadBackupTargetKey: vi.fn(async () => ({ rawKey: Buffer.alloc(32, 7) })),
  SHIM_NAMESPACE: 'platform',
}));

// Mock @aws-sdk/client-s3 so the test never tries to hit the real shim.
// Use real constructor functions so `new S3Client(...)` works under
// vitest's mock factory.
const sendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: function S3Client() { return { send: sendMock }; },
    ListObjectsV2Command: function ListObjectsV2Command(args: unknown) { return { __cmd: 'List', args }; },
    GetObjectCommand: function GetObjectCommand(args: unknown) { return { __cmd: 'Get', args }; },
    HeadObjectCommand: function HeadObjectCommand(args: unknown) { return { __cmd: 'Head', args }; },
  };
});

function makeCustomApi(opts: {
  notFound?: boolean;
  missingDestPath?: boolean;
  badDestPath?: boolean;
} = {}): k8s.CustomObjectsApi {
  return {
    getNamespacedCustomObject: vi.fn().mockImplementation(async () => {
      if (opts.notFound) {
        const e = new Error('not found'); (e as Error & { code?: number }).code = 404;
        throw e;
      }
      if (opts.missingDestPath) {
        return { spec: { configuration: {} } };
      }
      if (opts.badDestPath) {
        return { spec: { configuration: { destinationPath: 'not-an-s3-url' } } };
      }
      return { spec: { configuration: { destinationPath: 's3://system/postgres' } } };
    }),
  } as unknown as k8s.CustomObjectsApi;
}

const fakeCore = {} as unknown as k8s.CoreV1Api;

// Real backup.info captured from staging staging1, 2026-05-22.
const SAMPLE_BACKUP_INFO = `backup_label='START WAL LOCATION: 4/9005C498\\n'
backup_name=backup-20260522030000
begin_time=2026-05-22 03:00:01.199315+00:00
begin_wal=000000020000000400000090
cluster_size=53043327
end_time=2026-05-22 03:00:07.194628+00:00
end_wal=000000020000000400000091
status=DONE
`;

function streamFrom(text: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(text, 'utf-8')]) as NodeJS.ReadableStream;
}

beforeEach(() => {
  __clearCatalogueCache();
  sendMock.mockReset();
});

describe('parseDestinationPath', () => {
  it('parses s3://bucket/prefix correctly', () => {
    expect(parseDestinationPath('s3://system/postgres')).toEqual({ bucket: 'system', prefix: 'postgres' });
  });
  it('handles deep prefix paths', () => {
    expect(parseDestinationPath('s3://bk/a/b/c')).toEqual({ bucket: 'bk', prefix: 'a/b/c' });
  });
  it('returns null for non-s3 schemes', () => {
    expect(parseDestinationPath('gs://bucket/p')).toBeNull();
    expect(parseDestinationPath('not-a-url')).toBeNull();
  });
  it('handles bucket-only paths (no prefix)', () => {
    expect(parseDestinationPath('s3://only-bucket')).toEqual({ bucket: 'only-bucket', prefix: '' });
  });
});

describe('parseBackupInfo', () => {
  it('extracts begin_time, end_time, status, WAL range, cluster_size', () => {
    const r = parseBackupInfo(SAMPLE_BACKUP_INFO);
    expect(r.begin_time).toBe('2026-05-22T03:00:01.199Z');
    expect(r.end_time).toBe('2026-05-22T03:00:07.194Z');
    expect(r.status).toBe('DONE');
    expect(r.begin_wal).toBe('000000020000000400000090');
    expect(r.end_wal).toBe('000000020000000400000091');
    expect(r.cluster_size).toBe(53043327);
  });

  it('treats `None` as null', () => {
    const r = parseBackupInfo(`begin_time=None\nend_time=None\nstatus=None\ncluster_size=None\nbegin_wal=None\nend_wal=None\n`);
    expect(r.begin_time).toBeNull();
    expect(r.end_time).toBeNull();
    expect(r.begin_wal).toBeNull();
    expect(r.cluster_size).toBeNull();
  });

  it('tolerates unparseable timestamps without throwing', () => {
    const r = parseBackupInfo(`begin_time=garbage value\n`);
    expect(r.begin_time).toBe('garbage value');
  });
});

describe('listBackupsFromObjectStore', () => {
  it('returns source=unavailable on ObjectStore 404', async () => {
    const r = await listBackupsFromObjectStore(fakeCore, makeCustomApi({ notFound: true }), 'platform', 'missing');
    expect(r.source).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/not found/);
    expect(r.backups).toEqual([]);
  });

  it('returns source=unavailable on missing destinationPath', async () => {
    const r = await listBackupsFromObjectStore(fakeCore, makeCustomApi({ missingDestPath: true }), 'platform', 'os');
    expect(r.source).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/destinationPath/);
  });

  it('returns source=unavailable on malformed destinationPath', async () => {
    const r = await listBackupsFromObjectStore(fakeCore, makeCustomApi({ badDestPath: true }), 'platform', 'os');
    expect(r.source).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/s3:\/\//);
  });

  it('returns source=unavailable when LIST throws', async () => {
    sendMock.mockRejectedValueOnce(new Error('connection refused'));
    const r = await listBackupsFromObjectStore(fakeCore, makeCustomApi(), 'platform', 'os');
    expect(r.source).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/connection refused/);
  });

  it('returns object-store with empty backups[] when LIST has no clusters', async () => {
    sendMock.mockResolvedValueOnce({ CommonPrefixes: [] });
    const r = await listBackupsFromObjectStore(fakeCore, makeCustomApi(), 'platform', 'os');
    expect(r.source).toBe('object-store');
    expect(r.backups).toEqual([]);
  });

  it('enumerates clusters → backupIds → parses backup.info', async () => {
    // LIST <prefix>/ for clusters
    sendMock.mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'postgres/system-db/' }] });
    // LIST <prefix>/system-db/base/ for backup IDs
    sendMock.mockResolvedValueOnce({
      CommonPrefixes: [
        { Prefix: 'postgres/system-db/base/20260522T030001/' },
        { Prefix: 'postgres/system-db/base/20260520T120000/' },
      ],
    });
    // GET 20260522T030001/backup.info
    sendMock.mockResolvedValueOnce({ Body: streamFrom(SAMPLE_BACKUP_INFO) });
    // HEAD 20260522T030001/data.tar.gz
    sendMock.mockResolvedValueOnce({ ContentLength: 6994280, LastModified: new Date('2026-05-22T03:00:07Z') });
    // GET 20260520T120000/backup.info
    sendMock.mockResolvedValueOnce({ Body: streamFrom('begin_time=2026-05-20 12:00:00+00:00\nstatus=DONE\nbegin_wal=A\nend_wal=B\n') });
    // HEAD 20260520T120000/data.tar.gz
    sendMock.mockResolvedValueOnce({ ContentLength: 6897282, LastModified: new Date('2026-05-20T12:00:05Z') });

    const r = await listBackupsFromObjectStore(fakeCore, makeCustomApi(), 'platform', 'system-postgres-objectstore');
    expect(r.source).toBe('object-store');
    expect(r.backups).toHaveLength(2);
    // Sorted newest-first.
    expect(r.backups[0].backupId).toBe('20260522T030001');
    expect(r.backups[0].status).toBe('DONE');
    expect(r.backups[0].clusterSizeBytes).toBe(53043327);
    expect(r.backups[0].dataSizeBytes).toBe(6994280);
    expect(r.backups[0].parseError).toBeNull();
    expect(r.backups[1].backupId).toBe('20260520T120000');
  });

  it('surfaces backup.info GET failures as per-entry parseError without dropping the row', async () => {
    sendMock.mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'postgres/system-db/' }] });
    sendMock.mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'postgres/system-db/base/20260522T030001/' }] });
    sendMock.mockRejectedValueOnce(new Error('NoSuchKey'));
    sendMock.mockResolvedValueOnce({ ContentLength: 1024, LastModified: new Date('2026-05-22T03:00:07Z') });

    const r = await listBackupsFromObjectStore(fakeCore, makeCustomApi(), 'platform', 'os');
    expect(r.source).toBe('object-store');
    expect(r.backups).toHaveLength(1);
    expect(r.backups[0].parseError).toMatch(/NoSuchKey/);
    expect(r.backups[0].dataSizeBytes).toBe(1024); // HEAD still ran
  });

  it('caches results within the TTL window', async () => {
    sendMock.mockResolvedValueOnce({ CommonPrefixes: [] });
    const r1 = await listBackupsFromObjectStore(fakeCore, makeCustomApi(), 'platform', 'os');
    const r2 = await listBackupsFromObjectStore(fakeCore, makeCustomApi(), 'platform', 'os');
    expect(r1).toBe(r2); // Same object reference proves cache hit.
    expect(sendMock).toHaveBeenCalledTimes(1); // Only the first call's LIST.
  });
});
