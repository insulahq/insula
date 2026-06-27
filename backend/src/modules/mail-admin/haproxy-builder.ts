/**
 * stalwart-haproxy DaemonSet builder.
 *
 * 2026-05-14 streamline: the haproxy DS used to live in
 * k8s/base/stalwart-mail/haproxy/daemonset.yaml with a "disabled"
 * nodeSelector that platform-api flipped on/off via SSA. That setup
 * caused months of churn (PRs #43–#45) because Flux's kustomize-
 * controller and platform-api fought for ownership of the
 * `nodeSelector` field. Even with ssa:merge the failure modes were
 * subtle (MERGE_PATCH key-union, STRATEGIC_MERGE_PATCH field-removal
 * gotchas, "DS present but pinning zero pods").
 *
 * Cleaner ownership model: platform-api owns the DS entirely.
 *   - `thisNodeOnly` mode → DS is DELETED (Stalwart binds hostPort directly)
 *   - `allServerNodes` mode → DS is CREATED with server-role nodeSelector
 *
 * The ConfigMap (`stalwart-haproxy-config`) and NetworkPolicy stay
 * Flux-managed in `k8s/base/stalwart-mail/haproxy/`. Their content is
 * static and Flux is the natural source-of-truth for static config.
 *
 * The DS spec mirrors the previous YAML 1:1 (image, hostNetwork,
 * priorityClass, all six mail ports, runAsUser:0 + drop-all +
 * NET_BIND_SERVICE, livenessProbe, resources, configMap mount, /tmp
 * tmpfs). The verbatim port of the security commentary is in the
 * BUILDER_RATIONALE constant below to keep the same operational
 * documentation co-located with the code that emits the YAML.
 */

// Single-source-of-truth import — DO NOT redeclare these constants
// here. Reviewer caught the prior duplication: two independent `const`
// declarations would silently diverge if one was edited, causing the
// DS nodeSelector and the label reconciler to mismatch (DS schedules
// to zero nodes).
import { MAIL_HAPROXY_LABEL_KEY } from './port-exposure-modes.js';

const NAMESPACE = 'mail';
const NAME = 'stalwart-haproxy';
const MAIL_HAPROXY_LABEL_VALUE = 'true';

/**
 * The six mail ports haproxy forwards. Same set as the Stalwart
 * Deployment binds in `thisNodeOnly` mode. Keeping the structure
 * inline so a code reader sees exactly what gets exposed.
 */
const MAIL_PORTS = [
  { name: 'smtp', containerPort: 25 },
  { name: 'smtps', containerPort: 465 },
  { name: 'submission', containerPort: 587 },
  { name: 'imap', containerPort: 143 },
  { name: 'imaps', containerPort: 993 },
  { name: 'sieve', containerPort: 4190 },
] as const;

/**
 * Build the stalwart-haproxy DaemonSet manifest. Returns a plain JS
 * object suitable for `apps.createNamespacedDaemonSet({ namespace,
 * body })`. Single source of truth for the spec — port-exposure.ts,
 * unit tests, and the integration harness all reference the same
 * shape via this function.
 */
export function buildHaproxyDaemonSet(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: NAME,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/component': 'stalwart-haproxy',
        'app.kubernetes.io/part-of': 'hosting-platform',
        // Marker so the harness + future tooling can tell at a glance
        // that this object was platform-api-built and not Flux-managed.
        'insula.host/managed-by': 'platform-api',
      },
      annotations: {
        'configmap.reloader.stakater.com/reload': 'stalwart-haproxy-config',
      },
    },
    spec: {
      selector: {
        matchLabels: { 'app.kubernetes.io/component': 'stalwart-haproxy' },
      },
      updateStrategy: { type: 'RollingUpdate' },
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/component': 'stalwart-haproxy',
            'app.kubernetes.io/part-of': 'hosting-platform',
          },
        },
        spec: {
          hostNetwork: true,
          dnsPolicy: 'ClusterFirstWithHostNet',
          priorityClassName: 'system-node-critical',
          nodeSelector: { [MAIL_HAPROXY_LABEL_KEY]: MAIL_HAPROXY_LABEL_VALUE },
          tolerations: [
            {
              key: 'insula.host/server-only',
              operator: 'Exists',
              effect: 'NoSchedule',
            },
          ],
          terminationGracePeriodSeconds: 30,
          containers: [
            {
              name: 'haproxy',
              image: 'haproxy:2.9-alpine',
              imagePullPolicy: 'IfNotPresent',
              // SECURITY: runAsUser:0 + dropALL + NET_BIND_SERVICE. The
              // haproxy:2.9-alpine image ends with `USER haproxy` (uid 99);
              // K8s adds caps to bounding but NOT effective for non-root.
              // Verified on staging that uid 99 fails to bind <1024. Root
              // inside the container with dropALL gives an empty effective
              // cap set after the bind — defense-in-depth via readOnly
              // rootfs + allowPrivilegeEscalation:false + RuntimeDefault.
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: {
                  drop: ['ALL'],
                  add: ['NET_BIND_SERVICE'],
                },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              ports: MAIL_PORTS.map((p) => ({
                containerPort: p.containerPort,
                hostPort: p.containerPort,
                protocol: 'TCP',
                name: p.name,
              })),
              volumeMounts: [
                {
                  name: 'haproxy-config',
                  mountPath: '/usr/local/etc/haproxy/haproxy.cfg',
                  subPath: 'haproxy.cfg',
                  readOnly: true,
                },
                // Writable tmpfs for the haproxy stats socket.
                { name: 'haproxy-run', mountPath: '/tmp' },
              ],
              // 2026-05-15: the old probe used `socat` to query the
              // haproxy admin socket. socat isn't installed in the
              // haproxy:2.9-alpine image, so the probe was failing
              // from second 5 onward and kubelet was killing the pod
              // after 30s — manifesting as a stable-looking DS that
               // CrashLoopBackOffs over a 9-minute span on staging.
               //
               // Switch to a plain TCP-port-bound check: open a
               // connection to localhost:25 (frontend smtp_in). If
               // haproxy is alive and listening, TCP succeeds. No
               // extra tooling required.
              // 2026-06-27: the tcpSocket :25 liveness probe collides
              // with the externalIP→ClusterIP DNAT under hostNetwork.
              // Because each haproxy node IP is also in
              // Service.spec.externalIPs, kube-proxy's PREROUTING DNAT
              // preempts the hostPort and redirects the probe to the
              // Stalwart ClusterIP. During a Stalwart rollout (or a
              // mail-node migration) the backend endpoint slice empties
              // for ~10-30s → the probe gets connection-refused. With
              // the old timeoutSeconds:1 (default) + failureThreshold:3
              // + periodSeconds:10, kubelet killed haproxy within ~30s
              // and it crash-looped (24 restarts observed on staging)
              // on EVERY roll. Loosen the LIVENESS probe to tolerate a
              // ~90s backend gap (6 × 15s) so a transient rollout can't
              // kill a healthy haproxy. The READINESS probe stays tight
              // so a node IS pulled from the Service while its backend
              // is genuinely down (correct) — only liveness must not
              // restart the container for a transient gap.
              livenessProbe: {
                tcpSocket: { port: 25 },
                initialDelaySeconds: 5,
                periodSeconds: 15,
                timeoutSeconds: 5,
                failureThreshold: 6,
              },
              readinessProbe: {
                tcpSocket: { port: 25 },
                initialDelaySeconds: 2,
                periodSeconds: 5,
                failureThreshold: 3,
              },
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { cpu: '200m', memory: '128Mi' },
              },
            },
          ],
          volumes: [
            {
              name: 'haproxy-config',
              configMap: { name: 'stalwart-haproxy-config' },
            },
            {
              name: 'haproxy-run',
              emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
            },
          ],
        },
      },
    },
  };
}

export const HAPROXY_DS_NAMESPACE = NAMESPACE;
export const HAPROXY_DS_NAME = NAME;
