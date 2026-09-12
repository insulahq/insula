/**
 * How much write-ahead log is sitting at the backup target, and how far back it
 * reaches.
 *
 * WHY THIS IS ITS OWN CALL
 * -----------------------
 * The backup catalogue enumerates base backups: one LIST plus a GET and a HEAD
 * per backup. Through the rclone gofakes3 shim that is slow — measured on DEV
 * 2026-09-11 at over three minutes for 29 backups — and folding a WAL LIST into
 * it made the panel that shows storage usage wait on all of it. The WAL side
 * needs only paginated LISTs and answers in seconds, so it gets its own
 * endpoint, its own budget, and a longer cache: segment counts move slowly and
 * an operator does not need them fresh to the second.
 *
 * Every failure path returns a summary with `readError` set rather than
 * throwing, because "we could not measure it" is a thing the panel must be able
 * to SAY. A spinner that never resolves is what this replaces.
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import { loadBackupTargetKey, SHIM_NAMESPACE } from '../backup-rclone-shim/service.js';
import { deriveShimAccessKey, deriveShimSecretKey } from '../backup-rclone-shim/crypto.js';
import { SHIM_S3_ENDPOINT_URL } from '../backup-rclone-shim/mail-restic.js';
import { parseDestinationPath, accumulateWalObjects } from './service.js';

const OBJSTORE_GROUP = 'barmancloud.cnpg.io';
const OBJSTORE_VERSION = 'v1';
const OBJSTORE_PLURAL = 'objectstores';

/** Pages of 1000. 20 pages = 20 000 segments ≈ 320 GiB of WAL before we stop. */
const MAX_PAGES = 20;
/** Whole-call budget. Past it we report what we counted and say it is a floor. */
const DEFAULT_DEADLINE_MS = 20_000;
const CACHE_TTL_MS = 10 * 60_000;

export interface WalSummaryResult {
  readonly segmentCount: number;
  readonly totalBytes: number;
  readonly oldestAt: string | null;
  readonly newestAt: string | null;
  /** Counts are a floor: the page cap or the deadline cut the walk short. */
  readonly truncated: boolean;
  /** Set when nothing could be measured at all. */
  readonly readError: string | null;
  readonly queryDurationMs: number;
}

interface CacheEntry { readonly at: number; readonly value: WalSummaryResult }
const cache = new Map<string, CacheEntry>();

export function __clearWalSummaryCache(): void {
  cache.clear();
}

interface ObjectStoreCR {
  readonly spec?: { readonly configuration?: { readonly destinationPath?: string } };
}

export interface WalSummaryOpts {
  readonly log?: Pick<Logger, 'warn' | 'debug' | 'info'>;
  readonly deadlineMs?: number;
  /**
   * The CNPG cluster whose WAL to measure. Supplying it SKIPS the discovery
   * LIST at the top of the bucket, which on the rclone shim is the expensive
   * part — it walks every prefix including `base/`. Callers that know the
   * cluster (the panel always does) should pass it.
   */
  readonly clusterName?: string;
}

/**
 * Hard ceiling on the whole operation.
 *
 * The per-request timeout is NOT enough: the AWS SDK retries a timed-out
 * request (3 attempts by default), so a 20s request timeout became a >60s call
 * on DEV 2026-09-12. Retries are disabled below AND the whole walk races this
 * timer, so the endpoint cannot outlive its budget whatever the shim does.
 */
async function withDeadline<T>(ms: number, work: Promise<T>, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Public entry point: bounded end to end.
 *
 * EVERY step races the budget, not just the S3 walk — the ObjectStore read and
 * the shim-credential read go through the kube API and the Secret store, and
 * either can hang. A panel cell waiting on this must always get an answer.
 */
export async function summariseWalArchiveForStore(
  core: k8s.CoreV1Api,
  custom: k8s.CustomObjectsApi,
  namespace: string,
  objectStoreName: string,
  opts: WalSummaryOpts = {},
): Promise<WalSummaryResult> {
  const started = Date.now();
  const budget = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  return withDeadline(
    budget,
    walSummaryWork(core, custom, namespace, objectStoreName, opts),
    () => ({
      segmentCount: 0, totalBytes: 0, oldestAt: null, newestAt: null,
      truncated: true,
      readError: `timed out after ${budget}ms reading the archive`,
      queryDurationMs: Date.now() - started,
    }),
  );
}

async function walSummaryWork(
  core: k8s.CoreV1Api,
  custom: k8s.CustomObjectsApi,
  namespace: string,
  objectStoreName: string,
  opts: WalSummaryOpts = {},
): Promise<WalSummaryResult> {
  const t0 = Date.now();
  const log = opts.log ?? { warn: () => {}, debug: () => {}, info: () => {} };
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const ck = `${namespace}/${objectStoreName}`;

  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const fail = (reason: string): WalSummaryResult => {
    const value: WalSummaryResult = {
      segmentCount: 0, totalBytes: 0, oldestAt: null, newestAt: null,
      truncated: false, readError: reason, queryDurationMs: Date.now() - t0,
    };
    // Cache failures briefly too — a broken target should not mean a retry
    // storm from every panel refresh.
    cache.set(ck, { at: Date.now(), value });
    return value;
  };

  let cr: ObjectStoreCR;
  try {
    cr = await custom.getNamespacedCustomObject({
      group: OBJSTORE_GROUP, version: OBJSTORE_VERSION,
      namespace, plural: OBJSTORE_PLURAL, name: objectStoreName,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as unknown as ObjectStoreCR;
  } catch (err) {
    return fail(`ObjectStore lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const dest = cr.spec?.configuration?.destinationPath;
  const parsed = dest ? parseDestinationPath(dest) : null;
  if (!parsed) return fail(`ObjectStore ${namespace}/${objectStoreName} has no usable destinationPath`);
  const { bucket, prefix } = parsed;

  let accessKey: string;
  let secretKey: string;
  try {
    const ki = await loadBackupTargetKey(core, SHIM_NAMESPACE, { log });
    accessKey = deriveShimAccessKey(ki.rawKey);
    secretKey = deriveShimSecretKey(ki.rawKey);
  } catch (err) {
    return fail(`shim creds unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { NodeHttpHandler } = await import('@smithy/node-http-handler');
  const s3 = new S3Client({
    endpoint: SHIM_S3_ENDPOINT_URL,
    region: 'us-east-1',
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({ requestTimeout: deadlineMs, connectionTimeout: 5_000 }),
    // No retries: a timeout here means the shim is slow, and retrying it turns
    // a 20s budget into 60s of an operator staring at a spinner.
    maxAttempts: 1,
  });

  try {
    // Clusters are the first level under the prefix; WAL lives at
    // <prefix>/<cluster>/wals/. A caller that knows the cluster skips this
    // discovery LIST entirely — on the shim it is the slowest call of the lot.
    const clusters: string[] = [];
    if (opts.clusterName) {
      clusters.push(opts.clusterName);
    } else try {
      const top = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix ? `${prefix}/` : '', Delimiter: '/',
      })) as { CommonPrefixes?: ReadonlyArray<{ Prefix?: string }> };
      for (const cp of top.CommonPrefixes ?? []) {
        const p = (cp.Prefix ?? '').replace(/\/$/, '');
        const name = prefix ? p.slice(prefix.length + 1) : p;
        if (name) clusters.push(name);
      }
    } catch (err) {
      return fail(`shim LIST failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (clusters.length === 0) return fail('no clusters found under the object store prefix');

    const acc = { segmentCount: 0, totalBytes: 0, oldest: null as number | null, newest: null as number | null };
    let truncated = false;
    let anyPageRead = false;
    let lastError: string | null = null;

    const walk = async (): Promise<void> => {
    for (const cluster of clusters) {
      const walPrefix = prefix ? `${prefix}/${cluster}/wals/` : `${cluster}/wals/`;
      let token: string | undefined;
      let pages = 0;
      try {
        do {
          if (Date.now() - t0 > deadlineMs) { truncated = true; break; }
          const res = await s3.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: walPrefix, ContinuationToken: token, MaxKeys: 1000,
          })) as {
            Contents?: ReadonlyArray<{ Size?: number; LastModified?: Date }>;
            NextContinuationToken?: string;
            IsTruncated?: boolean;
          };
          anyPageRead = true;
          accumulateWalObjects(res.Contents ?? [], acc);
          token = res.IsTruncated ? res.NextContinuationToken : undefined;
          pages += 1;
          if (token && pages >= MAX_PAGES) { truncated = true; break; }
        } while (token);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.warn?.({ err: lastError, cluster }, 'wal-summary: LIST failed for cluster');
      }
    }
    };

    // Whatever the shim does, we answer within the budget: on timeout we keep
    // whatever pages were folded in and mark the figures as a floor.
    await withDeadline(Math.max(1_000, deadlineMs - (Date.now() - t0)), walk(), () => {
      truncated = true;
      log.warn?.({ deadlineMs, segments: acc.segmentCount }, 'wal-summary: deadline hit — reporting a floor');
    });

    if (!anyPageRead) return fail(lastError ?? 'WAL prefix could not be listed within the time budget');

    const value: WalSummaryResult = {
      segmentCount: acc.segmentCount,
      totalBytes: acc.totalBytes,
      oldestAt: acc.oldest === null ? null : new Date(acc.oldest).toISOString(),
      newestAt: acc.newest === null ? null : new Date(acc.newest).toISOString(),
      truncated,
      readError: null,
      queryDurationMs: Date.now() - t0,
    };
    cache.set(ck, { at: Date.now(), value });
    return value;
  } finally {
    // The S3Client owns a keep-alive socket pool; without this every call leaks
    // sockets until process exit (same trap as the catalogue's client).
    s3.destroy();
  }
}
