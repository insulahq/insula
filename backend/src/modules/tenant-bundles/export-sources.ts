/**
 * What a bundle export is made of (ADR-061).
 *
 * The export was written when every component was an object under the
 * bundle's prefix, and it still enumerates the object store:
 *
 *     for (const component of ['files','mailboxes','config','secrets'])
 *       store.listArtifacts(handle, component)
 *
 * `files` stopped writing objects when it went restic-native, and
 * `mailboxes` never wrote any — it uploaded through the restic-stream
 * endpoint. Both listings are therefore empty, and `wrapBundleAsDataExport`
 * skips a missing artifact in silence (`if (!stat) continue`). A production
 * bundle's prefix holds exactly three objects — config, secrets, meta.json —
 * so an export today carries the tenant's DB rows and TLS keys and NEITHER
 * their files NOR their mail, and reports success.
 *
 * This module resolves a bundle into the full set of sources, object-store
 * and restic alike, so the export can carry what the bundle actually holds.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';

import { backupComponents, backupJobs } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { resolveShimBackupTarget } from './resolve-backup-target.js';
import { deriveResticPassword, runResticDump, type BackupTarget } from './restic-driver.js';
import { resolveBundleRepoLayout } from './repo-layout.js';
import { FILES_CAPTURE_ROOT } from './components/files.js';
import { MAILBOX_CAPTURE_ROOT, addressDirName } from './components/mailboxes-restic.js';
import type { Readable } from 'node:stream';

const SNAPSHOT_RE = /^[0-9a-f]{64}$/;

/**
 * The little the resolver needs. Deliberately NOT a FastifyInstance: the
 * bundle orchestrator has no `app`, and threading one through would put an
 * HTTP type into the capture path.
 */
export interface ExportSourceCtx {
  readonly db: Database;
  readonly k8s: K8sClients;
  /** PLATFORM_ENCRYPTION_KEY — the per-tenant restic password derives from it. */
  readonly secretsKeyHex: string;
}

/** Build a context from a Fastify app (the route surfaces). */
export function exportCtxFromApp(app: FastifyInstance, k8s: K8sClients): ExportSourceCtx {
  const secretsKeyHex = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!secretsKeyHex) {
    throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY is not configured; cannot open the restic repository', 500);
  }
  return { db: app.db, k8s, secretsKeyHex };
}

/** A component artifact that lives as an object under the bundle prefix. */
export interface ObjectExportSource {
  readonly kind: 'artifact';
  readonly component: 'files' | 'mailboxes' | 'config' | 'secrets';
  readonly name: string;
}

/** A component that exists only as a restic snapshot. */
export interface ResticExportSource {
  readonly kind: 'restic';
  readonly component: 'files' | 'mailboxes';
  /** Entry prefix inside the export, e.g. `archive` or an address. */
  readonly name: string;
  readonly snapshotId: string;
  /** Directory inside the snapshot to emit. */
  readonly dumpPath: string;
  /**
   * Leading path to strip from each emitted entry. A restic snapshot stores
   * ABSOLUTE paths, so without this the export reads
   * `components/mailboxes/<addr>/capture/<addr>/INBOX/...` — the address twice
   * and an internal mount point an operator has no use for. Mirrors how the
   * files browse strips its own `/source` prefix.
   */
  readonly stripPrefix: string;
}

export type ExportSource = ObjectExportSource | ResticExportSource;

/**
 * Resolve every source a bundle's export must carry.
 *
 * Object-store artifacts come from the listing (config + secrets today, plus
 * anything a pre-restic bundle still has). Restic-backed components come from
 * `backup_components.sha256`, which is where both the per-mailbox snapshots
 * (artifact name = address) and the files snapshot are recorded.
 */
export async function resolveExportSources(
  ctx: ExportSourceCtx,
  bundleId: string,
  listArtifacts: (component: 'files' | 'mailboxes' | 'config' | 'secrets') => Promise<Array<{ name: string }>>,
): Promise<ExportSource[]> {
  const sources: ExportSource[] = [];

  for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
    for (const ref of await listArtifacts(component)) {
      // The export wrapper writes its own product back into components/config;
      // including it would be circular.
      if (component === 'config' && ref.name.startsWith('data-export-')) continue;
      sources.push({ kind: 'artifact', component, name: ref.name });
    }
  }

  const rows = await ctx.db.select()
    .from(backupComponents)
    .where(and(
      eq(backupComponents.backupJobId, bundleId),
      eq(backupComponents.status, 'completed'),
    ));

  for (const row of rows) {
    if (row.component !== 'files' && row.component !== 'mailboxes') continue;
    if (typeof row.sha256 !== 'string' || !SNAPSHOT_RE.test(row.sha256)) continue;
    // An object artifact for the same component means a pre-restic bundle —
    // it is already covered above and must not be exported twice.
    if (sources.some((s) => s.kind === 'artifact' && s.component === row.component)) continue;

    if (row.component === 'files') {
      sources.push({
        kind: 'restic',
        component: 'files',
        name: 'archive',
        snapshotId: row.sha256,
        dumpPath: FILES_CAPTURE_ROOT,
        stripPrefix: FILES_CAPTURE_ROOT.replace(/^\/+/, ''),
      });
    } else if (row.artifactName.includes('@')) {
      // ADR-061 capture: one snapshot per mailbox, named by address.
      sources.push({
        kind: 'restic',
        component: 'mailboxes',
        name: row.artifactName,
        snapshotId: row.sha256,
        dumpPath: `${MAILBOX_CAPTURE_ROOT}/${addressDirName(row.artifactName)}`,
        stripPrefix: `${MAILBOX_CAPTURE_ROOT}/${addressDirName(row.artifactName)}`.replace(/^\/+/, ''),
      });
    } else {
      // Pre-ADR-061 capture: one snapshot holding the whole-tenant
      // `maildir.tar` written through `--stdin-filename`.
      sources.push({
        kind: 'restic',
        component: 'mailboxes',
        name: 'maildir.tar',
        snapshotId: row.sha256,
        dumpPath: '/maildir.tar',
        // A legacy whole-tenant tarball already has the addresses at its root.
        stripPrefix: '',
      });
    }
  }

  return sources;
}

/**
 * Open a restic source as a byte stream.
 *
 * A per-mailbox or files source is a DIRECTORY in the snapshot, emitted as a
 * tar stream (`restic dump --archive tar`) so it never lands on the API pod's
 * disk. A legacy whole-tenant source is already a single tar FILE, so it is
 * dumped as-is.
 */
export async function openResticExportSource(
  ctx: ExportSourceCtx,
  bundleId: string,
  source: ResticExportSource,
): Promise<Readable> {
  const [job] = await ctx.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);

  let target: BackupTarget;
  try {
    target = await resolveShimBackupTarget(ctx.k8s.core, 'tenant');
  } catch (err) {
    throw new ApiError('CONFIG_INVALID', `Backup target unavailable: ${(err as Error).message}`, 500);
  }

  return runResticDump({
    target,
    tenantId: job.tenantId,
    layout: await resolveBundleRepoLayout(ctx.db, bundleId),
    component: source.component,
    snapshotId: source.snapshotId,
    dumpPath: source.dumpPath,
    passwordHex: deriveResticPassword(ctx.secretsKeyHex, job.tenantId),
    // A single tar FILE is dumped verbatim; a directory is archived.
    ...(source.dumpPath.endsWith('.tar') ? {} : { archive: 'tar' as const }),
  });
}

/**
 * Entry source shape the export builder consumes. A restic source carries a
 * thunk rather than a stream so the export never opens a repo it does not end
 * up reading, and so `data-export.ts` stays free of cluster/credential
 * concerns.
 */
export type ExportEntrySource =
  | { readonly kind: 'artifact'; readonly component: 'files' | 'mailboxes' | 'config' | 'secrets'; readonly name: string }
  | {
    readonly kind: 'restic';
    readonly component: 'files' | 'mailboxes';
    readonly name: string;
    readonly stripPrefix: string;
    readonly open: () => Promise<Readable>;
  };

/** Bind each restic source to its opener. */
export function bindExportSources(
  ctx: ExportSourceCtx,
  bundleId: string,
  sources: ReadonlyArray<ExportSource>,
): ExportEntrySource[] {
  return sources.map((s) => (s.kind === 'artifact'
    ? s
    : {
      kind: 'restic' as const,
      component: s.component,
      name: s.name,
      stripPrefix: s.stripPrefix,
      open: () => openResticExportSource(ctx, bundleId, s),
    }));
}
