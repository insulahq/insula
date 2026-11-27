/**
 * The file-manager pod's protected database folder (roadmap R48).
 *
 * Every standalone database instance keeps its data at `database/<engine>/<name>`
 * on the tenant volume. In the file-manager pod:
 *
 *  - the `file-manager` container gets an empty READ-ONLY volume mounted over
 *    `/data/database`. Its HTTP API, `sftp-serve`, rsync and legacy scp all run
 *    in that container (the SFTP gateway execs into it by name), so every one of
 *    them sees an empty folder: writes and symlinks fail with EROFS, renaming or
 *    removing it with EBUSY, and the container holds no CAP_SYS_ADMIN, so
 *    nothing in it can unmount it. The kernel enforces it — there is no list of
 *    operations to keep in step.
 *  - `platform-files` is a second container on the same volume WITHOUT the
 *    mask. Only the platform execs into it (imports, exports, pre-dump listing,
 *    the volume-usage measure, folder moves). The SFTP gateway names the
 *    `file-manager` container, the tenant console only selects pods labelled
 *    `platform.io/managed` (this pod is not), and the pod does not share its
 *    process namespace — so no tenant-reachable process can enter this
 *    container's view of the volume.
 *  - the `protected-folder` init container makes sure `database` is a real
 *    directory before the mask is mounted. A symlink planted there would
 *    otherwise carry the mask somewhere else (the runtime resolves a mount
 *    target through symlinks) and leave the data it points at unmasked.
 *
 * Only a folder whose parent is the volume root is safe to mask: the parent of
 * a deeper masked folder can still be renamed, which carries the data out from
 * under the mask. That is why every instance lives under the one top-level
 * folder rather than being masked where it happens to sit.
 */
import type { V1Container } from '@kubernetes/client-node';
import { DATABASE_ROOT } from '@insula/api-contracts';

export const FM_PLATFORM_CONTAINER = 'platform-files';
export const PROTECTED_FOLDER_INIT = 'protected-folder';
export const DATABASE_MASK_VOLUME = 'database-mask';
export const DATABASE_MASK_PATH = `/data/${DATABASE_ROOT}`;

/** The read-only empty volume over the protected folder, for the file-manager container. */
export const databaseMaskMount = {
  name: DATABASE_MASK_VOLUME,
  mountPath: DATABASE_MASK_PATH,
  readOnly: true,
} as const;

/** An emptyDir mounted read-only: nothing is ever written to it. */
export const databaseMaskVolume = {
  name: DATABASE_MASK_VOLUME,
  emptyDir: { sizeLimit: '1Mi' },
} as const;

const NARROW_SECURITY_CONTEXT = {
  allowPrivilegeEscalation: false,
  seccompProfile: { type: 'RuntimeDefault' },
} as const;

/**
 * Moves anything that is not a real directory at `database` aside (to a
 * visible `database.moved-<time>`) and creates the directory.
 */
export const PROTECTED_FOLDER_SCRIPT = [
  'set -eu',
  `d=${DATABASE_MASK_PATH}`,
  'if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then',
  '  mv -- "$d" "$d.moved-$(date -u +%Y%m%d%H%M%S)"',
  'fi',
  'mkdir -p "$d"',
].join('\n');

export function protectedFolderInitContainer(image: string): V1Container {
  return {
    name: PROTECTED_FOLDER_INIT,
    image,
    imagePullPolicy: 'Always',
    command: ['sh', '-c', PROTECTED_FOLDER_SCRIPT],
    securityContext: {
      ...NARROW_SECURITY_CONTEXT,
      capabilities: { drop: ['ALL'], add: ['DAC_OVERRIDE'] },
    },
    resources: { requests: { cpu: '5m', memory: '16Mi' }, limits: { memory: '32Mi' } },
    volumeMounts: [{ name: 'tenant-storage', mountPath: '/data' }],
  };
}

/** Idles until the pod stops; the platform execs its file work into it. */
const IDLE_SCRIPT = 'trap "exit 0" TERM INT; while :; do sleep 3600 & wait $!; done';

export function platformFilesContainer(image: string): V1Container {
  return {
    name: FM_PLATFORM_CONTAINER,
    image,
    imagePullPolicy: 'Always',
    command: ['sh', '-c', IDLE_SCRIPT],
    securityContext: {
      ...NARROW_SECURITY_CONTEXT,
      // Move, copy (keeping owners and modes), measure and delete files owned
      // by any database's user; SETUID/SETGID only to drop to nobody, with no
      // capabilities, for unpacking a tenant's archive. No chroot, no mounts.
      capabilities: { drop: ['ALL'], add: ['DAC_OVERRIDE', 'FOWNER', 'CHOWN', 'SETUID', 'SETGID'] },
    },
    // Its own cgroup: the inode cache of a size walk and the dirty pages of an
    // import (a multi-GB dump decompressed into an instance's folder) are
    // charged here, not to the file-manager container — whose 256Mi a rsync's
    // dirty pages once filled. A limit is only a ceiling; the request is what
    // is reserved, and the pod runs outside the tenant's quota.
    resources: { requests: { cpu: '5m', memory: '16Mi' }, limits: { memory: '512Mi' } },
    volumeMounts: [{ name: 'tenant-storage', mountPath: '/data' }],
  };
}

interface SpecShape {
  shareProcessNamespace?: boolean;
  initContainers?: Array<{ name?: string; image?: string }>;
  containers?: Array<{
    name?: string;
    image?: string;
    volumeMounts?: Array<{ name?: string; mountPath?: string; readOnly?: boolean }>;
  }>;
  volumes?: Array<{ name?: string; emptyDir?: unknown }>;
}

/**
 * Why an existing file-manager pod template lacks the protected folder, or
 * null when it has it. Any reason recreates the Deployment.
 */
export function protectedFolderDrift(spec: SpecShape | undefined, image: string): string | null {
  if (!spec) return 'no pod template';
  if (spec.shareProcessNamespace) return 'the pod shares its process namespace';
  const fm = spec.containers?.[0];
  const masked = (fm?.volumeMounts ?? []).some((m) =>
    m.name === DATABASE_MASK_VOLUME && m.mountPath === DATABASE_MASK_PATH && m.readOnly === true);
  if (!masked) return 'the database folder is not masked';
  if (!(spec.volumes ?? []).some((v) => v.name === DATABASE_MASK_VOLUME && v.emptyDir)) return 'no mask volume';
  const platform = spec.containers?.find((c) => c.name === FM_PLATFORM_CONTAINER);
  if (!platform) return `no ${FM_PLATFORM_CONTAINER} container`;
  const init = spec.initContainers?.find((c) => c.name === PROTECTED_FOLDER_INIT);
  if (!init) return `no ${PROTECTED_FOLDER_INIT} init container`;
  if (image && (platform.image !== image || init.image !== image)) return 'image changed';
  return null;
}
