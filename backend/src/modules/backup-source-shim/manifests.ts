/**
 * The Kubernetes objects of a SOURCE SHIM: a temporary, read-only copy of the
 * backup-rclone-shim bound to one backup target that is not the one tenant
 * backups are bound to now.
 *
 * Every tenant bundle is read through the shim, and the shim serves only the
 * target each class is bound to NOW. A bundle written to another target — the
 * archive of a tenant archived before tenant backups moved, the bundles of a
 * cross-cluster migration source (R20), what a rebuilt cluster finds on its
 * old target — could not be read at all. A source shim serves that target as
 * the `tenant` bucket, for as long as restores need it, and is removed after
 * (see service.ts for when).
 *
 * Same image and the same rendered rclone.conf as the real shim (one
 * `tenant=<target>` pair from `renderShimConfig`), so every target kind the
 * shim reaches is reached the same way, and the target's credentials stay in
 * the platform namespace. What differs:
 *
 *   - `rclone serve s3 --read-only`: nothing a restore does can write to the
 *     source. Every restic read on the restore paths runs `--no-lock`.
 *   - a Deployment of one, not a DaemonSet, behind its own ClusterIP Service —
 *     `app: backup-source-shim`, never `app: backup-rclone-shim`, or the real
 *     shim's Service would send backups to it.
 *   - ServiceAccount `default` (platform-api-workload-scope admits no other
 *     for a workload platform-api creates in `platform`), no token.
 *   - Ready only once :9000 accepts connections: it always has a target.
 *
 * Pure builders — no I/O. Unit tested in manifests.test.ts.
 */
import { createHash } from 'node:crypto';

export const SOURCE_SHIM_NAMESPACE = 'platform';
export const SOURCE_SHIM_APP = 'backup-source-shim';
/** On the shim's objects and on every Job that reads through it. */
export const SOURCE_SHIM_LABEL = 'insula.host/source-shim';
export const SOURCE_SHIM_TARGET_LABEL = 'insula.host/source-target-id';
export const SOURCE_SHIM_LAST_USED_ANNOTATION = 'insula.host/last-used';
export const SOURCE_SHIM_CONFIG_HASH_ANNOTATION = 'insula.host/config-hash';
export const SOURCE_SHIM_PORT = 9000;
const MANAGED_BY = 'platform-api-backup-source-shim';

const UPSTREAM_ENV_KEY = 'upstream.env';
const RCLONE_CONF_KEY = 'rclone.conf';
const LAUNCHER_KEY = 'launcher.sh';

/** Short, stable id of a target: the same 8 hex the shim names its sections with. */
export function sourceShimId(targetId: string): string {
  return createHash('sha256').update(targetId).digest('hex').slice(0, 8);
}

export function sourceShimName(targetId: string): string {
  return `backup-source-${sourceShimId(targetId)}`;
}

export function sourceShimEndpoint(targetId: string): string {
  return `http://${sourceShimName(targetId)}.${SOURCE_SHIM_NAMESPACE}.svc.cluster.local:${SOURCE_SHIM_PORT}`;
}

/**
 * The launcher. Not the real shim's: that one is Flux-rendered (its `$` are
 * escaped for postBuild substitution) and serves read-write with a write
 * cache. This one is created by platform-api, so it is plain shell.
 */
export const SOURCE_SHIM_LAUNCHER = [
  'set -eu',
  'UPSTREAM_ENV=/etc/rclone-credentials/upstream.env',
  'RCLONE_CONF=/etc/rclone-credentials/rclone.conf',
  'set -a',
  '. "$UPSTREAM_ENV"',
  'set +a',
  'if [ -z "${ROOT_ACCESS_KEY:-}" ] || [ -z "${ROOT_SECRET_KEY:-}" ]; then',
  '  echo "[backup-source-shim] FATAL: ROOT_ACCESS_KEY / ROOT_SECRET_KEY missing" >&2',
  '  exit 2',
  'fi',
  'export HOME=/tmp',
  'mkdir -p /var/cache/rclone-shim',
  'exec rclone serve s3 \\',
  '  --config "$RCLONE_CONF" \\',
  `  --addr ":${SOURCE_SHIM_PORT}" \\`,
  '  --auth-key "${ROOT_ACCESS_KEY},${ROOT_SECRET_KEY}" \\',
  '  --read-only \\',
  '  --vfs-cache-mode off \\',
  '  --dir-cache-time 3s \\',
  '  --buffer-size 1M \\',
  '  --no-modtime \\',
  '  --no-checksum \\',
  '  --s3-disable-http2 \\',
  '  --cache-dir /var/cache/rclone-shim \\',
  '  --log-level NOTICE \\',
  '  combined:',
  '',
].join('\n');

export interface SourceShimRendered {
  /** `upstream.env` and `rclone.conf` from `renderShimConfig` (one `tenant` pair). */
  readonly upstreamEnv: string;
  readonly rcloneConf: string;
  /** The SFTP key files the rclone.conf names, if any. */
  readonly sshKeys: ReadonlyArray<{ readonly fileName: string; readonly pemContent: string }>;
}

export interface SourceShimInput {
  readonly targetId: string;
  /** The real shim's image, read from its DaemonSet — so both run one build. */
  readonly image: string;
  readonly rendered: SourceShimRendered;
  /** `sourceShimConfigHash` of what was rendered: a change means a new pod. */
  readonly configHash: string;
  readonly now: Date;
}

export interface SourceShimObjects {
  readonly credentials: Record<string, unknown>;
  readonly sshKeys: Record<string, unknown>;
  readonly launcher: Record<string, unknown>;
  readonly deployment: Record<string, unknown>;
  readonly service: Record<string, unknown>;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

export function sourceShimLabels(targetId: string): Record<string, string> {
  return {
    app: SOURCE_SHIM_APP,
    [SOURCE_SHIM_LABEL]: sourceShimId(targetId),
    [SOURCE_SHIM_TARGET_LABEL]: targetId,
    'app.kubernetes.io/part-of': 'hosting-platform',
    'app.kubernetes.io/component': 'backup',
    'app.kubernetes.io/managed-by': MANAGED_BY,
  };
}

/**
 * Over the INPUTS, not the rendered config: the renderer obscures SFTP and CIFS
 * passwords with a random IV, so the same target renders differently every
 * time (the real shim's reconciler hashes its inputs for the same reason).
 */
export function sourceShimConfigHash(input: {
  readonly keyFingerprint: string;
  readonly target: unknown;
  readonly image: string;
}): string {
  return createHash('sha256')
    .update(input.keyFingerprint).update('\n----\n')
    .update(JSON.stringify(input.target)).update('\n----\n')
    .update(input.image).update('\n----\n')
    .update(SOURCE_SHIM_LAUNCHER)
    .digest('hex');
}

export function buildSourceShimObjects(input: SourceShimInput): SourceShimObjects {
  const name = sourceShimName(input.targetId);
  const labels = sourceShimLabels(input.targetId);
  const { configHash } = input;
  const meta = (objectName: string): Record<string, unknown> => ({
    name: objectName,
    namespace: SOURCE_SHIM_NAMESPACE,
    labels,
  });

  const credentials = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: meta(`${name}-credentials`),
    type: 'Opaque',
    data: {
      [UPSTREAM_ENV_KEY]: b64(input.rendered.upstreamEnv),
      [RCLONE_CONF_KEY]: b64(input.rendered.rcloneConf),
    },
  };
  const sshKeys = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: meta(`${name}-ssh-keys`),
    type: 'Opaque',
    data: Object.fromEntries(
      input.rendered.sshKeys.filter((k) => k.pemContent.trim()).map((k) => [k.fileName, b64(k.pemContent)]),
    ),
  };
  const launcher = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: meta(`${name}-static`),
    data: { [LAUNCHER_KEY]: SOURCE_SHIM_LAUNCHER },
  };

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      ...meta(name),
      annotations: {
        [SOURCE_SHIM_LAST_USED_ANNOTATION]: input.now.toISOString(),
        [SOURCE_SHIM_CONFIG_HASH_ANNOTATION]: configHash,
      },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: SOURCE_SHIM_APP, [SOURCE_SHIM_LABEL]: sourceShimId(input.targetId) } },
      template: {
        metadata: { labels, annotations: { [SOURCE_SHIM_CONFIG_HASH_ANNOTATION]: configHash } },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            fsGroup: 65534,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [{
            name: 'shim',
            image: input.image,
            imagePullPolicy: 'IfNotPresent',
            command: ['/sbin/tini', '--', '/bin/sh', `/etc/rclone-static/${LAUNCHER_KEY}`],
            ports: [{ name: 's3', containerPort: SOURCE_SHIM_PORT, protocol: 'TCP' }],
            env: [
              { name: 'HOME', value: '/tmp' },
              { name: 'GOGC', value: '20' },
              { name: 'GOMEMLIMIT', value: '200MiB' },
            ],
            resources: {
              requests: { cpu: '50m', memory: '64Mi' },
              limits: { memory: '1Gi' },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              runAsNonRoot: true,
              runAsUser: 65534,
              runAsGroup: 65534,
              capabilities: { drop: ['ALL'] },
              seccompProfile: { type: 'RuntimeDefault' },
            },
            readinessProbe: {
              tcpSocket: { port: SOURCE_SHIM_PORT },
              initialDelaySeconds: 2,
              periodSeconds: 5,
              timeoutSeconds: 3,
              failureThreshold: 3,
            },
            volumeMounts: [
              { name: 'rclone-static', mountPath: '/etc/rclone-static', readOnly: true },
              { name: 'rclone-credentials', mountPath: '/etc/rclone-credentials', readOnly: true },
              { name: 'rclone-ssh-keys', mountPath: '/etc/rclone/ssh-keys', readOnly: true },
              { name: 'scratch', mountPath: '/tmp' },
              { name: 'rclone-cache', mountPath: '/var/cache/rclone-shim' },
            ],
          }],
          terminationGracePeriodSeconds: 30,
          volumes: [
            // The real shim's modes (0400, readable through fsGroup 65534).
            { name: 'rclone-static', configMap: { name: `${name}-static`, defaultMode: 0o400 } },
            { name: 'rclone-credentials', secret: { secretName: `${name}-credentials`, defaultMode: 0o400 } },
            { name: 'rclone-ssh-keys', secret: { secretName: `${name}-ssh-keys`, defaultMode: 0o400 } },
            { name: 'scratch', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
            { name: 'rclone-cache', emptyDir: { sizeLimit: '256Mi' } },
          ],
        },
      },
    },
  };

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta(name),
    spec: {
      type: 'ClusterIP',
      selector: { app: SOURCE_SHIM_APP, [SOURCE_SHIM_LABEL]: sourceShimId(input.targetId) },
      ports: [{ name: 's3', port: SOURCE_SHIM_PORT, targetPort: SOURCE_SHIM_PORT, protocol: 'TCP' }],
    },
  };

  return { credentials, sshKeys, launcher, deployment, service };
}
