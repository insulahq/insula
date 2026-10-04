import type * as k8s from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { loadBackupTargetKey, SHIM_NAMESPACE } from '../backup-rclone-shim/service.js';
import { deriveShimAccessKey, deriveShimSecretKey } from '../backup-rclone-shim/crypto.js';
import { SHIM_S3_ENDPOINT_URL } from '../backup-rclone-shim/mail-restic.js';
import { POSTGRES_OBJECT_STORE_NAME } from '../backup-rclone-shim/postgres-objectstore.js';
import { parseDestinationPath } from '../cnpg-backup-catalogue/service.js';
import { getClusterId } from '../system-settings/cluster-id.js';
import type { FootprintPart, SystemBackupFootprint } from './footprint-store.js';

/**
 * How many bytes the SYSTEM class keeps at its target: a plain paginated LIST
 * of each of its prefixes through the backup shim, summing object sizes.
 *
 * Only LISTs — no per-object GET/HEAD (that is what makes the base-backup
 * catalogue take minutes through the shim). Runs in the background on an
 * hourly lease, so its budget is generous and nobody waits on it.
 */

const OBJSTORE = { group: 'barmancloud.cnpg.io', version: 'v1', plural: 'objectstores' } as const;
/** 1000 keys a page; 200 pages ≈ 200 000 objects before the figure becomes a floor. */
const MAX_PAGES = 200;
const DEFAULT_DEADLINE_MS = 10 * 60_000;

export interface ListedPage {
  readonly contents: ReadonlyArray<{ readonly Size?: number }>;
  readonly next?: string;
}
export type ListPage = (bucket: string, prefix: string, token: string | undefined) => Promise<ListedPage>;

export interface PrefixToMeasure {
  readonly name: string;
  readonly bucket: string;
  readonly prefix: string;
}

/** Pure walk over injected LIST pages — the part worth testing. */
export async function walkPrefixes(
  targets: readonly PrefixToMeasure[],
  listPage: ListPage,
  opts: { readonly deadlineAt: number; readonly maxPages?: number; readonly now?: () => number },
): Promise<FootprintPart[]> {
  const now = opts.now ?? Date.now;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const parts: FootprintPart[] = [];
  for (const t of targets) {
    let bytes = 0;
    let objects = 0;
    let truncated = false;
    let error: string | null = null;
    let token: string | undefined;
    let pages = 0;
    try {
      do {
        if (now() > opts.deadlineAt) { truncated = true; break; }
        const page = await listPage(t.bucket, t.prefix, token);
        for (const o of page.contents) { bytes += Number(o.Size ?? 0); objects += 1; }
        token = page.next;
        pages += 1;
        if (token && pages >= maxPages) { truncated = true; break; }
      } while (token);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    parts.push({ name: t.name, prefix: `${t.bucket}/${t.prefix}`, bytes, objects, truncated, error });
  }
  return parts;
}

export function summarise(parts: readonly FootprintPart[], at: Date): SystemBackupFootprint {
  const listed = parts.filter((p) => p.error === null);
  return {
    measuredAt: at.toISOString(),
    totalBytes: parts.reduce((n, p) => n + p.bytes, 0),
    objectCount: parts.reduce((n, p) => n + p.objects, 0),
    // ANY part that failed leaves the total a floor — on its first page as
    // much as after a few: its bytes are simply not in the sum.
    truncated: parts.some((p) => p.truncated || p.error !== null),
    error: listed.length === 0
      ? `the system target could not be listed: ${parts.map((p) => `${p.name}: ${p.error}`).join('; ')}`
      : null,
    parts,
  };
}

/**
 * The prefixes the system class writes: the platform database's object store
 * (base backups + WAL), the etcd snapshots (`etcd/<cluster_id>/`) and the DR
 * bundles (`dr/` — the DR jobs write there without a cluster id, so that is
 * what a shared target holds for them too).
 *
 * `failed` carries a part that could not even be located: an object store
 * read error is NOT "backups never configured", and dropping the largest part
 * silently would publish a confident, too-small total.
 */
export async function systemPrefixes(db: Database, custom: k8s.CustomObjectsApi): Promise<{
  targets: PrefixToMeasure[];
  failed: FootprintPart[];
}> {
  const targets: PrefixToMeasure[] = [];
  const failed: FootprintPart[] = [];
  try {
    const cr = await custom.getNamespacedCustomObject({
      ...OBJSTORE, namespace: 'platform', name: POSTGRES_OBJECT_STORE_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as unknown as {
      spec?: { configuration?: { destinationPath?: string } };
    };
    const parsed = parseDestinationPath(cr.spec?.configuration?.destinationPath ?? '');
    if (parsed) targets.push({ name: 'postgres', bucket: parsed.bucket, prefix: parsed.prefix ? `${parsed.prefix}/` : '' });
    else failed.push(failedPart('postgres', 'the object store has no usable destinationPath'));
  } catch (err) {
    // 404 = database backups were never configured: nothing to measure.
    if (statusOf(err) !== 404) failed.push(failedPart('postgres', `object store unreadable: ${err instanceof Error ? err.message : String(err)}`));
  }
  targets.push({ name: 'etcd', bucket: 'system', prefix: `etcd/${await getClusterId(db)}/` });
  targets.push({ name: 'dr', bucket: 'system', prefix: 'dr/' });
  return { targets, failed };
}

function failedPart(name: string, error: string): FootprintPart {
  return { name, prefix: '', bytes: 0, objects: 0, truncated: false, error };
}

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return e?.code ?? e?.statusCode ?? e?.response?.statusCode;
}

export async function measureSystemFootprint(
  db: Database,
  clients: { readonly core: k8s.CoreV1Api; readonly custom: k8s.CustomObjectsApi },
  opts: { readonly deadlineMs?: number } = {},
): Promise<SystemBackupFootprint> {
  const started = Date.now();
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const { targets, failed } = await systemPrefixes(db, clients.custom);

  const key = await loadBackupTargetKey(clients.core, SHIM_NAMESPACE);
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { NodeHttpHandler } = await import('@smithy/node-http-handler');
  const s3 = new S3Client({
    endpoint: SHIM_S3_ENDPOINT_URL,
    region: 'us-east-1',
    credentials: { accessKeyId: deriveShimAccessKey(key.rawKey), secretAccessKey: deriveShimSecretKey(key.rawKey) },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({ requestTimeout: 120_000, connectionTimeout: 5_000 }),
    maxAttempts: 2,
  });
  try {
    const listPage: ListPage = async (bucket, prefix, token) => {
      const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })) as {
        Contents?: ReadonlyArray<{ Size?: number }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      return { contents: res.Contents ?? [], next: res.IsTruncated ? res.NextContinuationToken : undefined };
    };
    const parts = await walkPrefixes(targets, listPage, { deadlineAt: started + deadlineMs });
    return summarise([...failed, ...parts], new Date());
  } finally {
    s3.destroy();
  }
}
