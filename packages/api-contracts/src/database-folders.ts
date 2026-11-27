// The protected database folder on a tenant's storage (roadmap R48).
//
// Every standalone database instance keeps its data at
// `database/<engine>/<name>` on the tenant volume. The file manager mounts an
// empty read-only volume over that folder, so the file manager, SFTP, rsync and
// scp see it empty and cannot change it; the platform's own file work runs in a
// separate container that sees it. Raw access goes through Detach data (or a
// permanent delete that keeps the data), which moves the folder out to
// `kept-databases/<name>`.

import { z } from 'zod';

/** The protected top-level folder that holds every standalone instance's data. */
export const DATABASE_ROOT = 'database';

/** Where detached and kept database data lands, visible in the file manager. */
export const KEPT_DATABASES_ROOT = 'kept-databases';

/** Folder segments of a tenant path, without empty or `.` segments (`./database/x` is `database/x`). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '' && s !== '.');
}

/** True for `database` and anything under it (`database/mariadb/shop`, `/database/`). */
export function isUnderDatabaseRoot(path: string): boolean {
  return segmentsOf(path)[0] === DATABASE_ROOT;
}

/** The one place a standalone instance's data lives: `database/<catalog code>/<name>`. */
export function canonicalDatabasePath(catalogCode: string, name: string): string {
  return `${DATABASE_ROOT}/${catalogCode}/${name}`;
}

export const DATABASE_ROOT_PROBLEM =
  `The ${DATABASE_ROOT} folder holds your database instances' data and is managed by the platform. Choose another folder.`;

/**
 * One instance listed in the protected folder. `folder` is where its data is
 * now: under `database/` while attached, the kept folder while detached.
 */
export const databaseFolderEntrySchema = z.object({
  deploymentId: z.string(),
  name: z.string(),
  catalogCode: z.string(),
  /** running, stopped, deleted (Recently Deleted) … — the deployment's status. */
  status: z.string(),
  /** Set while the data is detached: the folder it was moved to. */
  detachedPath: z.string().nullable(),
  folder: z.string(),
  /** null when the size could not be measured (the folder is missing). */
  sizeBytes: z.number().nullable(),
});
export type DatabaseFolderEntry = z.infer<typeof databaseFolderEntrySchema>;

/**
 * A folder in the protected folder that belongs to no instance — data a
 * permanent delete left there before the folder was protected, or one whose
 * move out failed. Released to kept-databases/ on request.
 */
export const orphanDatabaseFolderSchema = z.object({
  folder: z.string(),
  sizeBytes: z.number().nullable(),
});
export type OrphanDatabaseFolder = z.infer<typeof orphanDatabaseFolderSchema>;

export const databaseFoldersResponseSchema = z.object({
  root: z.literal(DATABASE_ROOT),
  keptRoot: z.literal(KEPT_DATABASES_ROOT),
  instances: z.array(databaseFolderEntrySchema),
  orphans: z.array(orphanDatabaseFolderSchema),
});

export const releaseOrphanFoldersResponseSchema = z.object({
  moved: z.array(z.object({ from: z.string(), to: z.string() })),
});
export type ReleaseOrphanFoldersResponse = z.infer<typeof releaseOrphanFoldersResponseSchema>;
export type DatabaseFoldersResponse = z.infer<typeof databaseFoldersResponseSchema>;

export const attachDatabaseDataSchema = z.object({
  /** Folder to attach, relative to the storage root. Defaults to the detached folder. */
  path: z.string().min(1).max(500).optional(),
});
export type AttachDatabaseDataInput = z.infer<typeof attachDatabaseDataSchema>;

export const detachDatabaseDataResponseSchema = z.object({
  detachedPath: z.string(),
});
export type DetachDatabaseDataResponse = z.infer<typeof detachDatabaseDataResponseSchema>;
