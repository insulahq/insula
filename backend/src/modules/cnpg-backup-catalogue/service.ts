/**
 * cnpg-backup-catalogue — LIST barman-cloud backups directly from object
 * storage via the backup-rclone-shim, independent of the CNPG operator.
 *
 * Why exist (Phase 2 — 2026-05-22): CnpgBackupHealthCard reads CNPG Backup
 * CRs from the cluster API. If the CNPG operator is dead or wedged, the
 * Backup CR list is stale or missing. But the backup PAYLOAD lives in the
 * upstream object store and is reachable through the shim regardless of
 * cluster state. This module provides the operator's "show me what's
 * actually there" answer when the cluster's projection of reality has
 * diverged from the storage layer.
 *
 * Architecture (verified live, 2026-05-22 on staging):
 *   - ObjectStore CR carries `spec.configuration.destinationPath`
 *     (e.g. `s3://system/postgres`). The shim handles the actual
 *     upstream protocol — S3 / CIFS / NFS / SFTP — but exposes a
 *     uniform local S3 endpoint at SHIM_S3_ENDPOINT_URL.
 *   - Backup layout under destinationPath:
 *       <cluster>/base/<backupId>/backup.info  (text key=value)
 *       <cluster>/base/<backupId>/data.tar.gz  (payload — size from S3)
 *       <cluster>/wals/...                     (WAL archive)
 *   - <backupId> is `YYYYMMDDTHHMMSS` — sortable lexicographically.
 *
 * Strategy:
 *   1. ListObjectsV2 with Delimiter='/' under `<prefix>/<cluster>/base/`
 *      to enumerate backup IDs (CommonPrefixes).
 *   2. For each ID, GetObject `<id>/backup.info` (small, ~1.4KB) and
 *      parse `begin_time`, `end_time`, `status`, `begin_wal`, `end_wal`.
 *   3. HeadObject `<id>/data.tar.gz` to surface size on disk.
 *   4. Cache the whole result for 60s (LRU-style, keyed by objectStore).
 *
 * Failure modes (all return `source: 'unavailable'`, never throw):
 *   - ObjectStore CR not found → unavailable
 *   - Shim creds Secret not found → unavailable
 *   - LIST request times out / refused → unavailable
 *   - All ListObjectsV2 results empty → `source: 'object-store'`, [] (no
 *     error — bucket is empty, valid state for a freshly-bound cluster)
 *
 * Single-backup parse errors are logged + skipped — the entry is omitted
 * from the result but the other backups still surface.
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import {
  loadBackupTargetKey,
  SHIM_NAMESPACE,
} from '../backup-rclone-shim/service.js';
import {
  deriveShimAccessKey,
  deriveShimSecretKey,
} from '../backup-rclone-shim/crypto.js';
import { SHIM_S3_ENDPOINT_URL } from '../backup-rclone-shim/mail-restic.js';

export type CatalogueSource = 'object-store' | 'unavailable';

export interface CatalogueBackup {
  /** YYYYMMDDTHHMMSS barman backup id. Lexicographically sortable. */
  readonly backupId: string;
  /** Parsed from backup.info begin_time. ISO-8601 normalized. */
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly status: string | null;
  readonly beginWal: string | null;
  readonly endWal: string | null;
  /** Cluster total size at backup time, if parseable. */
  readonly clusterSizeBytes: number | null;
  /** S3 object size of data.tar.gz, in bytes. */
  readonly dataSizeBytes: number | null;
  /** When the data.tar.gz was uploaded (LastModified). */
  readonly uploadedAt: string | null;
  /** Empty string when backup.info parsed cleanly; otherwise the reason. */
  readonly parseError: string | null;
  /**
   * Phase 7b (2026-05-24): operator-supplied description from the
   * matching Backup CR's `insula.host/description`
   * label. Null when label absent.
   */
  description?: string | null;
  /**
   * Phase 7b (2026-05-24): derived from the matching CR's labels.
   * Null when the CR was already pruned.
   */
  kind?: 'scheduled' | 'on-demand' | 'pre-restore' | 'unknown' | null;
}

export interface CatalogueResult {
  readonly source: CatalogueSource;
  readonly objectStoreName: string;
  readonly namespace: string;
  /** Empty when source='unavailable'. */
  readonly backups: ReadonlyArray<CatalogueBackup>;
  /** When source='unavailable', the operator-facing reason. */
  readonly unavailableReason: string | null;
  /** Wall-clock latency of the LIST + GETs. */
  readonly queryDurationMs: number;
}

// ─── ObjectStore resolution ─────────────────────────────────────────────────

interface ObjectStoreCR {
  readonly spec?: {
    readonly configuration?: {
      readonly destinationPath?: string;
    };
  };
}

const OBJSTORE_GROUP = 'barmancloud.cnpg.io';
const OBJSTORE_VERSION = 'v1';
const OBJSTORE_PLURAL = 'objectstores';

interface ParsedDestPath {
  readonly bucket: string;
  readonly prefix: string;
}

export function parseDestinationPath(dest: string): ParsedDestPath | null {
  // `s3://<bucket>/<prefix...>` — the shim's local S3 endpoint expects
  // path-style with bucket as the first path segment. We ignore the s3://
  // scheme and split on the first `/` after the bucket.
  const m = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(dest);
  if (!m) return null;
  const bucket = m[1];
  if (!bucket) return null;
  const prefix = (m[2] ?? '').replace(/\/+$/, '');
  return { bucket, prefix };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  readonly at: number;
  readonly value: CatalogueResult;
}
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 32;
const cache = new Map<string, CacheEntry>();

function cacheKey(namespace: string, objectStoreName: string): string {
  return `${namespace}/${objectStoreName}`;
}

function pruneCache(): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  // Drop the oldest first — Map preserves insertion order.
  const overflow = cache.size - CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const k of cache.keys()) {
    cache.delete(k);
    removed += 1;
    if (removed >= overflow) break;
  }
}

export function __clearCatalogueCache(): void {
  cache.clear();
}

// ─── backup.info parsing ───────────────────────────────────────────────────

/**
 * Barman writes backup.info as `key=value\n` pairs. Values are unquoted
 * scalars or quoted strings; we treat everything after `=` as the value
 * verbatim. Robust to extra whitespace + comment-style noise.
 */
export function parseBackupInfo(text: string): {
  readonly begin_time: string | null;
  readonly end_time: string | null;
  readonly status: string | null;
  readonly begin_wal: string | null;
  readonly end_wal: string | null;
  readonly cluster_size: number | null;
} {
  const lines = text.split(/\r?\n/);
  const out: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  const sizeRaw = out.cluster_size;
  const cluster_size = sizeRaw && sizeRaw !== 'None' && /^\d+$/.test(sizeRaw)
    ? Number.parseInt(sizeRaw, 10)
    : null;
  return {
    begin_time: out.begin_time && out.begin_time !== 'None' ? normalizeIso(out.begin_time) : null,
    end_time: out.end_time && out.end_time !== 'None' ? normalizeIso(out.end_time) : null,
    status: out.status ?? null,
    begin_wal: out.begin_wal && out.begin_wal !== 'None' ? out.begin_wal : null,
    end_wal: out.end_wal && out.end_wal !== 'None' ? out.end_wal : null,
    cluster_size,
  };
}

function normalizeIso(t: string): string {
  // Barman writes `2026-05-22 03:00:01.199315+00:00`. Convert to ISO.
  // For unparseable input, return the original `t` verbatim (don't leak
  // the internal space→T substitution into the operator's UI).
  const cleaned = t.replace(' ', 'T');
  const d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) return t;
  return d.toISOString();
}

// ─── Main entrypoint ───────────────────────────────────────────────────────

export interface ListBackupsOpts {
  readonly log?: Pick<Logger, 'warn' | 'debug' | 'info'>;
  /** S3 LIST/GET timeout in ms. Default 15s — covers a slow upstream
   *  S3, NFS, or SMB without holding the request handler too long. */
  readonly timeoutMs?: number;
}

export async function listBackupsFromObjectStore(
  core: k8s.CoreV1Api,
  custom: k8s.CustomObjectsApi,
  namespace: string,
  objectStoreName: string,
  opts: ListBackupsOpts = {},
): Promise<CatalogueResult> {
  const log = opts.log ?? { warn: () => {}, debug: () => {}, info: () => {} };
  const t0 = Date.now();

  // Cache check.
  const ck = cacheKey(namespace, objectStoreName);
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const finalize = (value: CatalogueResult): CatalogueResult => {
    cache.set(ck, { at: Date.now(), value });
    pruneCache();
    return value;
  };

  // ── 1. Resolve ObjectStore CR → destinationPath → bucket + prefix
  let cr: ObjectStoreCR;
  try {
    cr = await custom.getNamespacedCustomObject({
      group: OBJSTORE_GROUP,
      version: OBJSTORE_VERSION,
      namespace,
      plural: OBJSTORE_PLURAL,
      name: objectStoreName,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as unknown as ObjectStoreCR;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    const reason = code === 404
      ? `ObjectStore ${namespace}/${objectStoreName} not found`
      : `ObjectStore lookup failed: ${err instanceof Error ? err.message : String(err)}`;
    return finalize({
      source: 'unavailable', objectStoreName, namespace,
      backups: [], unavailableReason: reason, queryDurationMs: Date.now() - t0,
    });
  }

  const dest = cr.spec?.configuration?.destinationPath;
  if (!dest) {
    return finalize({
      source: 'unavailable', objectStoreName, namespace,
      backups: [], unavailableReason: `ObjectStore ${namespace}/${objectStoreName} missing spec.configuration.destinationPath`,
      queryDurationMs: Date.now() - t0,
    });
  }
  const parsed = parseDestinationPath(dest);
  if (!parsed) {
    return finalize({
      source: 'unavailable', objectStoreName, namespace,
      backups: [], unavailableReason: `destinationPath '${dest}' is not in expected s3://<bucket>/<prefix> form`,
      queryDurationMs: Date.now() - t0,
    });
  }
  const { bucket, prefix } = parsed;

  // ── 2. Resolve shim creds (HKDF-derived from BACKUP_TARGET_KEY Secret)
  let accessKey: string;
  let secretKey: string;
  try {
    const ki = await loadBackupTargetKey(core, SHIM_NAMESPACE, { log });
    accessKey = deriveShimAccessKey(ki.rawKey);
    secretKey = deriveShimSecretKey(ki.rawKey);
  } catch (err) {
    return finalize({
      source: 'unavailable', objectStoreName, namespace,
      backups: [], unavailableReason: `shim creds unavailable: ${err instanceof Error ? err.message : String(err)}`,
      queryDurationMs: Date.now() - t0,
    });
  }

  // ── 3. Build S3 client pointed at the shim. The S3Client owns a
  // Keep-Alive socket pool that must be freed via .destroy() — without
  // this, every cache-miss call leaks sockets until process exit.
  // Mirror the pattern from backup-config/s3-probe.ts.
  const { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const { NodeHttpHandler } = await import('@smithy/node-http-handler');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const s3 = new S3Client({
    endpoint: SHIM_S3_ENDPOINT_URL,
    region: 'us-east-1', // shim ignores; required by SDK
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({
      requestTimeout: timeoutMs,
      connectionTimeout: Math.min(timeoutMs, 5_000),
    }),
  });

  try {
    // ── 4. Enumerate clusters under <prefix>/  (barman writes per-cluster)
    let clusterNames: ReadonlyArray<string>;
    try {
      clusterNames = await listAllCommonPrefixes(s3, ListObjectsV2Command, bucket, prefix ? `${prefix}/` : '');
    } catch (err) {
      return finalize({
        source: 'unavailable', objectStoreName, namespace,
        backups: [], unavailableReason: `shim LIST failed: ${err instanceof Error ? err.message : String(err)}`,
        queryDurationMs: Date.now() - t0,
      });
    }

    // ── 5. For each cluster, enumerate backupIds + parse backup.info (parallelized).
    const backups: CatalogueBackup[] = [];
    for (const cluster of clusterNames) {
      const basePrefix = prefix ? `${prefix}/${cluster}/base/` : `${cluster}/base/`;
      let ids: ReadonlyArray<string>;
      try {
        ids = await listAllCommonPrefixes(s3, ListObjectsV2Command, bucket, basePrefix);
      } catch (err) {
        log.warn?.({ err: err instanceof Error ? err.message : String(err), cluster }, 'catalogue: cluster LIST failed; continuing');
        continue;
      }

      // Fetch backup.info + HEAD data.tar.gz IN PARALLEL per backup id, with a
      // concurrency cap so a 200-backup cluster doesn't open 400 simultaneous
      // sockets to the shim. The shim is single-process; 5 concurrent ops keeps
      // it busy without back-pressure.
      const perId = async (id: string): Promise<CatalogueBackup> => {
        const infoKey = `${basePrefix}${id}/backup.info`;
        const dataKey = `${basePrefix}${id}/data.tar.gz`;
        const infoP = s3.send(new GetObjectCommand({ Bucket: bucket, Key: infoKey }))
          .then(async (obj) => streamToString(obj.Body as NodeJS.ReadableStream | null))
          .then(parseBackupInfo)
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.debug?.({ err: msg, key: infoKey }, 'catalogue: backup.info read failed');
            return { parseError: msg } as const;
          });
        const headP = s3.send(new HeadObjectCommand({ Bucket: bucket, Key: dataKey }))
          .then((h) => ({
            dataSizeBytes: h.ContentLength ?? null,
            uploadedAt: h.LastModified ? h.LastModified.toISOString() : null,
          }))
          .catch(() => ({ dataSizeBytes: null, uploadedAt: null }));
        const [info, headRes] = await Promise.all([infoP, headP]);
        const isError = 'parseError' in info;
        return {
          backupId: id,
          startedAt: isError ? null : info.begin_time,
          endedAt: isError ? null : info.end_time,
          status: isError ? null : info.status,
          beginWal: isError ? null : info.begin_wal,
          endWal: isError ? null : info.end_wal,
          clusterSizeBytes: isError ? null : info.cluster_size,
          dataSizeBytes: headRes.dataSizeBytes,
          uploadedAt: headRes.uploadedAt,
          parseError: isError ? info.parseError : null,
        };
      };
      const CONCURRENCY = 5;
      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const chunk = ids.slice(i, i + CONCURRENCY);
        const results = await Promise.all(chunk.map(perId));
        backups.push(...results);
      }
    }

    // Sort newest first by backupId (lexicographic === chronological for
    // YYYYMMDDTHHMMSS format).
    backups.sort((a, b) => (a.backupId < b.backupId ? 1 : -1));

    // Phase 7b (2026-05-24) — enrich each barman entry with the matching
    // CNPG Backup CR's labels + annotations. Surfaces operator description
    // and explicit kind so the frontend doesn't guess from backup ID.
    //
    // Two corrections from the typescript-reviewer round (2026-05-24):
    //
    //   1. Join key was wrong. CR `metadata.name` (e.g. `on-demand-...`)
    //      ≠ barman backup ID (e.g. `20260524T111857`). Verified on
    //      staging: kubectl shows `metadata.name=on-demand-1779621535664`
    //      but `status.backupId=20260524T111857`. The catalogue iterates
    //      S3 directories whose names are barman backup IDs, so the
    //      join MUST use `status.backupId`.
    //
    //   2. Unfiltered LIST returned every Backup CR in the namespace
    //      including ones from sibling clusters. Added the CNPG-emitted
    //      label `cnpg.io/cluster` as a server-side filter to bound
    //      the response size.
    //
    // Description is now read from an ANNOTATION (no k8s label
    // charset/length restrictions) — falls back to label for
    // pre-Phase-7c-fix backups so the catalogue stays consistent.
    let crByBackupId: Map<string, { kind: 'scheduled' | 'on-demand' | 'pre-restore' | 'unknown'; description: string | null }>
      = new Map();
    // 2026-05-24 verified on staging: CNPG does NOT auto-label Backup
    // CRs with `cnpg.io/cluster` — the cluster name only appears in
    // `spec.cluster.name`. So we LIST all Backup CRs in the namespace
    // (no labelSelector) and filter client-side by spec.cluster.name
    // matching one of the clusterNames we already discovered from S3.
    // Modern CNPG versions may grow a labelSelector; if so, switch to
    // it (cheaper). For now this is the only correct approach.
    const clusterNameSet = new Set(clusterNames);
    try {
      const crResp = await custom.listNamespacedCustomObject({
        group: 'postgresql.cnpg.io',
        version: 'v1',
        namespace,
        plural: 'backups',
      } as unknown as Parameters<typeof custom.listNamespacedCustomObject>[0]) as unknown as {
        items?: ReadonlyArray<{
          metadata?: {
            name?: string;
            labels?: Record<string, string>;
            annotations?: Record<string, string>;
            ownerReferences?: ReadonlyArray<{ kind?: string }>;
          };
          spec?: { cluster?: { name?: string } };
          status?: { backupId?: string };
        }>;
      };
      const items = crResp.items ?? [];
      crByBackupId = new Map(items.flatMap((item) => {
        const backupId = item.status?.backupId;
        if (!backupId) return [];
        // Skip CRs for clusters this catalogue isn't covering.
        const clusterName = item.spec?.cluster?.name;
        if (clusterName && !clusterNameSet.has(clusterName)) return [];
        const labels = item.metadata?.labels ?? {};
        const annotations = item.metadata?.annotations ?? {};
        // Prefer annotation (no charset/length restriction); fall back
        // to label for back-compat with pre-Phase-7c-fix backups.
        const description = annotations['insula.host/description']
          ?? labels['insula.host/description']
          ?? null;
        let kind: 'scheduled' | 'on-demand' | 'pre-restore' | 'unknown' = 'unknown';
        if (labels['insula.host/on-demand'] === 'true') kind = 'on-demand';
        else if (labels['insula.host/barman-pre-restore'] === 'true') kind = 'pre-restore';
        else if ((item.metadata?.ownerReferences ?? []).some((o) => o.kind === 'ScheduledBackup')) kind = 'scheduled';
        return [[backupId, { kind, description }] as const];
      }));
    } catch (err) {
      log.warn?.({ err: err instanceof Error ? err.message : String(err) },
        'catalogue: CNPG Backup CR list failed; description+kind will be null for all entries');
    }
    for (const b of backups) {
      const meta = crByBackupId.get(b.backupId);
      if (meta) {
        (b as { description: string | null }).description = meta.description;
        (b as { kind: 'scheduled' | 'on-demand' | 'pre-restore' | 'unknown' | null }).kind = meta.kind;
      } else {
        (b as { description: string | null }).description = null;
        (b as { kind: 'scheduled' | 'on-demand' | 'pre-restore' | 'unknown' | null }).kind = null;
      }
    }

    return finalize({
      source: 'object-store', objectStoreName, namespace,
      backups, unavailableReason: null,
      queryDurationMs: Date.now() - t0,
    });
  } finally {
    // CRITICAL: destroy the S3Client to free the Keep-Alive socket pool.
    // Without this, every cache-miss invocation leaks sockets until GC,
    // which holds the http.Agent reference forever in long-running pods.
    try { s3.destroy(); } catch { /* best-effort */ }
  }
}

/**
 * Issue paginated ListObjectsV2 calls (Delimiter='/') and concatenate
 * CommonPrefixes until IsTruncated is false. Without this the
 * 200-key default would silently drop the newest backups in 7+ month
 * old clusters.
 */
async function listAllCommonPrefixes(
  s3: import('@aws-sdk/client-s3').S3Client,
  ListObjectsV2Command: typeof import('@aws-sdk/client-s3').ListObjectsV2Command,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  // Hard ceiling on total pages — defence-in-depth against a misbehaving
  // upstream returning IsTruncated=true forever. 50 pages × 1000 keys =
  // 50k entries which is well beyond any realistic cluster count.
  for (let page = 0; page < 50; page += 1) {
    const r = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: 1000,
      ContinuationToken: token,
    }));
    for (const p of r.CommonPrefixes ?? []) {
      const name = p.Prefix?.replace(prefix, '').replace(/\/$/, '');
      if (name) out.push(name);
    }
    if (!r.IsTruncated) break;
    token = r.NextContinuationToken;
    if (!token) break;
  }
  return out;
}

async function streamToString(body: NodeJS.ReadableStream | null): Promise<string> {
  if (!body) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
