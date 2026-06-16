/**
 * Restic-native files browse (shared by the admin + tenant browse
 * endpoints).
 *
 * Replaces the old `tree.jsonl.gz` sidecar read. The files component now
 * captures each on-disk file as a restic node (see
 * tenant-bundles/components/files.ts), so browsing is a lazy
 * `restic ls <snapshot> <dir>` per directory level.
 *
 * Snapshot-id resolution: the files component's restic snapshot id is
 * persisted on `backup_components.sha256` (component='files') by the
 * orchestrator's `markComponentDone({ sha256 })`. That's the same place
 * internal-download-route.ts reads it from.
 *
 * Path model (SHARED DECISION): restic stores absolute paths rooted at
 * the capture mount `/source` (FILES_CAPTURE_ROOT). We STRIP that prefix
 * so api-contracts paths are DISPLAY paths — relative, no leading
 * `/source`, no leading slash. The restore path RE-ADDS `/source`.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { backupComponents, backupJobs } from '../../db/schema.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import { resolveShimBackupTarget } from '../tenant-bundles/resolve-backup-target.js';
import {
  runResticLs,
  buildResticRepoUri,
  deriveResticPassword,
  type ResticLsNode,
} from '../tenant-bundles/restic-driver.js';
import { FILES_CAPTURE_ROOT } from '../tenant-bundles/components/files.js';
import type { BundleBrowseFileEntry } from '@insula/api-contracts';

const RESTIC_SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/;

// Browse fires one HTTP request per file-tree click, so memoise the
// K8sClients (just API-client objects, no eager connections) rather than
// constructing a fresh one per request.
let _k8sCache: { path: string | undefined; clients: K8sClients } | null = null;
function sharedK8sClients(kubeconfigPath: string | undefined): K8sClients {
  if (!_k8sCache || _k8sCache.path !== kubeconfigPath) {
    _k8sCache = { path: kubeconfigPath, clients: createK8sClients(kubeconfigPath) };
  }
  return _k8sCache.clients;
}

/** Validate + normalise the requested DISPLAY directory (query `path`). */
function normaliseDisplayDir(raw: string | undefined): string {
  let p = (raw ?? '').trim();
  // Strip any leading/trailing slashes — DISPLAY paths are relative.
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '') return '';
  if (p.split('/').includes('..')) {
    throw new ApiError('VALIDATION_ERROR', `browse: '..' segment rejected in path '${p}'`, 400);
  }
  // Real tenant filesystems hold filenames with `+ ( ) [ ] # ~ ! & = ,` etc.
  // (WordPress plugins/themes, numbered archives). The only thing we must
  // reject is control characters / NUL — `dir` is passed to restic as a
  // CLI array arg (no shell), and the restore side single-quote-escapes it,
  // so any printable byte is safe. (mirrors validateSelector in files-paths.ts)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) {
    throw new ApiError('VALIDATION_ERROR', `browse: path '${p}' contains control characters`, 400);
  }
  return p;
}

/** Convert a restic absolute node path (`/source/var/www`) to a DISPLAY
 *  path (`var/www`). Returns null if the node is outside the capture
 *  root (defensive — shouldn't happen). */
function toDisplayPath(absPath: string): string | null {
  if (absPath === FILES_CAPTURE_ROOT) return '';
  const prefix = `${FILES_CAPTURE_ROOT}/`;
  if (!absPath.startsWith(prefix)) return null;
  return absPath.slice(prefix.length);
}

export interface BrowseFilesTreeResult {
  bundleId: string;
  path: string;
  entries: BundleBrowseFileEntry[];
}

/**
 * Resolve the files snapshot id + shim target + per-tenant password,
 * run `restic ls` for `path`, strip `/source`, and return the DIRECT
 * CHILDREN of `path` sorted dirs-first then by name.
 *
 * `tenantId` is the bundle's tenant (already authorised by the caller).
 */
export async function browseFilesTree(
  app: FastifyInstance,
  bundleId: string,
  tenantId: string,
  rawPath: string | undefined,
): Promise<BrowseFilesTreeResult> {
  const displayDir = normaliseDisplayDir(rawPath);

  // Resolve the files restic snapshot id from backup_components.sha256.
  // Join backup_jobs + scope by tenantId — defence-in-depth so the
  // snapshot id can only come from THIS tenant's bundle even if a future
  // caller reaches here without the assertOwnership gate.
  const [comp] = await app.db.select({ sha256: backupComponents.sha256 })
    .from(backupComponents)
    .innerJoin(backupJobs, eq(backupJobs.id, backupComponents.backupJobId))
    .where(and(
      eq(backupComponents.backupJobId, bundleId),
      eq(backupJobs.tenantId, tenantId),
      eq(backupComponents.component, 'files'),
    ))
    .limit(1);
  if (!comp?.sha256 || !RESTIC_SNAPSHOT_ID_RE.test(comp.sha256)) {
    throw new ApiError('NOT_FOUND', `Bundle ${bundleId} has no files restic snapshot`, 404);
  }
  const snapshotId = comp.sha256;

  const secretsKeyHex = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!secretsKeyHex) {
    throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY not configured', 500);
  }

  const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
    ?? process.env.KUBECONFIG_PATH;
  const k8s = sharedK8sClients(kubeconfigPath);
  const target = await resolveShimBackupTarget(k8s.core, 'tenant', app.log);
  const passwordHex = deriveResticPassword(secretsKeyHex, tenantId);
  const repoUri = buildResticRepoUri(target, tenantId, 'files');

  // restic ls of the requested dir. `dir` is the ABSOLUTE in-snapshot
  // path (capture root + display dir). One directory level per call.
  const absDir = displayDir === '' ? FILES_CAPTURE_ROOT : `${FILES_CAPTURE_ROOT}/${displayDir}`;
  const nodes = await runResticLs({
    target,
    passwordHex,
    repoUri,
    snapshotId,
    dir: absDir,
    readOnly: true,
  });

  const entries = directChildren(nodes, displayDir);
  return { bundleId, path: displayDir, entries };
}

/**
 * Filter restic nodes to the DIRECT CHILDREN of `displayDir` and map to
 * api-contracts entries. `restic ls <snap> <dir>` returns the whole
 * subtree under `dir`; we keep only entries one level below `dir`.
 *
 * Exported for unit-testing the prefix-strip + child-filter + sort.
 */
export function directChildren(
  nodes: ReadonlyArray<ResticLsNode>,
  displayDir: string,
): BundleBrowseFileEntry[] {
  // Depth of a direct child of `displayDir`, counted in DISPLAY-path
  // segments. Root ('') → children have depth 1.
  const dirDepth = displayDir === '' ? 0 : displayDir.split('/').length;
  const out: BundleBrowseFileEntry[] = [];
  for (const node of nodes) {
    const display = toDisplayPath(node.path);
    if (display === null || display === '') continue; // outside root / the root itself
    // Must live under displayDir.
    if (displayDir !== '' && display !== displayDir && !display.startsWith(`${displayDir}/`)) continue;
    const segments = display.split('/');
    if (segments.length !== dirDepth + 1) continue; // only direct children
    out.push({
      name: segments[segments.length - 1]!,
      path: display,
      type: node.type,
      size: node.type === 'dir' ? 0 : node.size,
    });
  }
  // Dirs first, then by name (case-sensitive, stable).
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}
