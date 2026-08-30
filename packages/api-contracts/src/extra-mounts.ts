// Tenant-defined extra volume mounts for a deployment.
//
// A deployment already mounts whatever its catalog manifest declares (the
// document root, an app's data dir, …), all as subPaths of the tenant's single
// shared PVC. These are the mounts a TENANT adds on top: "take folder X on my
// storage and make it appear at path Y inside this container."
//
// Folders are relative to the TENANT PVC ROOT, not to the deployment's own
// storage path. That is deliberate — the point of the feature is that two
// deployments can mount the same folder (a shared media library, an import
// drop-box). It also means an extra mount is NOT removed when the deployment
// is deleted with "delete data": that only clears the deployment's own
// storagePath subtree, and a shared folder lives outside it.

import { z } from 'zod';

/** Max extra mounts per deployment. Each one is a subPath mount + an mkdir in
 *  the init container, so the cap keeps pod specs and startup bounded. */
export const MAX_EXTRA_MOUNTS = 10;

/** One path segment on the tenant PVC: lowercase, digit-or-letter bounded. */
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Deepest folder a tenant may address, e.g. `media/library/2026`. */
export const MAX_FOLDER_SEGMENTS = 4;

/**
 * Container paths a tenant may not mount over.
 *
 * Two different reasons, both worth being explicit about:
 *  - `/proc`, `/sys`, `/dev` are kernel interfaces. Mounting anything at or
 *    under them is meaningless and breaks the container outright.
 *  - The others are the image's own filesystem. Replacing one wholesale with
 *    an empty PVC folder guarantees a crashloop. This is tenant self-harm
 *    rather than a platform risk — the container and the PVC are both theirs —
 *    so we block only the catastrophic case (the directory ITSELF) and still
 *    allow deeper paths underneath, which is where the legitimate uses are
 *    (a php.ini drop-in at /usr/local/etc/php/conf.d/user, for instance).
 */
const KERNEL_PREFIXES = ['/proc', '/sys', '/dev'] as const;
const RESERVED_EXACT = [
  '/', '/bin', '/boot', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32',
  '/media', '/mnt', '/opt', '/root', '/run', '/sbin', '/srv', '/usr', '/var',
  '/usr/bin', '/usr/lib', '/usr/local', '/usr/sbin', '/usr/share',
  '/var/lib', '/var/log', '/var/run', '/var/www',
] as const;

/** Reject `.`/`..`, doubled slashes, trailing slash, and non-absolute paths. */
export function normalizeMountPath(input: string): string | null {
  if (!input.startsWith('/')) return null;
  if (input.includes('//') || input.includes('\0')) return null;
  // Root is a legal absolute path — it is rejected later as a reserved
  // directory, which is a far more useful message than "not a path".
  if (input === '/') return '/';
  const parts = input.split('/').slice(1);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop(); // trailing /
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return '/' + parts.join('/');
}

export function mountPathProblem(path: string): string | null {
  const norm = normalizeMountPath(path);
  if (norm === null) {
    return 'Mount path must be an absolute path with no "." or ".." segments (e.g. /var/www/html/media).';
  }
  if (KERNEL_PREFIXES.some((p) => norm === p || norm.startsWith(`${p}/`))) {
    return `${norm} is a kernel interface and cannot be used as a mount point.`;
  }
  if ((RESERVED_EXACT as readonly string[]).includes(norm)) {
    return `${norm} is part of the image's own filesystem — mounting over it would break the container. Use a path inside it instead, e.g. ${norm === '/' ? '/srv/data' : `${norm}/data`}.`;
  }
  return null;
}

export function folderProblem(folder: string): string | null {
  if (folder.startsWith('/')) return 'Folder is relative to your storage root, so it must not start with "/".';
  const segs = folder.split('/');
  if (segs.length > MAX_FOLDER_SEGMENTS) {
    return `Folder may be at most ${MAX_FOLDER_SEGMENTS} levels deep.`;
  }
  if (segs.some((s) => !SEGMENT.test(s))) {
    return 'Folder segments may use lowercase letters, digits, hyphens and underscores only, and must start with a letter or digit.';
  }
  return null;
}

export const extraMountSchema = z.object({
  /** Folder on the tenant's storage, relative to its root. Shared across
   *  deployments when two of them name the same folder. */
  folder: z.string().min(1).max(255).superRefine((v, ctx) => {
    const problem = folderProblem(v);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
  /** Absolute path inside the container. */
  mount_path: z.string().min(1).max(255).superRefine((v, ctx) => {
    const problem = mountPathProblem(v);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
  /** Mount read-only. Useful for shared reference data one deployment owns
   *  and others only consume. */
  read_only: z.boolean().default(false),
});

export type ExtraMount = z.infer<typeof extraMountSchema>;

/**
 * A deployment's full extra-mount list. Rejects duplicate mount paths here
 * rather than at apply time: Kubernetes refuses a container with two
 * volumeMounts on the same mountPath, and that surfaces as an opaque admission
 * error long after the user pressed Save.
 */
export const extraMountsSchema = z
  .array(extraMountSchema)
  .max(MAX_EXTRA_MOUNTS, `At most ${MAX_EXTRA_MOUNTS} extra mounts per deployment.`)
  .superRefine((mounts, ctx) => {
    const seen = new Set<string>();
    for (const m of mounts) {
      const norm = normalizeMountPath(m.mount_path);
      if (norm === null) continue; // already reported by the item schema
      if (seen.has(norm)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Two mounts both target ${norm}. Each mount path must be unique.`,
        });
      }
      seen.add(norm);
    }
  });
